import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";
import { AhrefsClient } from "../ahrefs/ahrefsClient";
import type { SiteMetrics } from "../ahrefs/types";
import {
  applyGate,
  DEFAULT_THRESHOLDS,
  gateVerdict,
  outInRatio,
} from "../domain/gate";
import { parseSiteList } from "../domain/site";
import { summariseTopPages, type TopPage } from "../domain/topPages";
import { isVerdict, type Verdict } from "../domain/verdict";
import { fetchHomepage } from "../crawl/fetchHomepage";
import { anthropic } from "../llm/client";
import { buildExtractionRequest, SiteProfile } from "../llm/extract";
import { finalise, judgeSite, type JudgedSite } from "../pipeline/judgeSite";
import { triage } from "../pipeline/triage";
import { buildJudgeRequest, Judgement, type JudgeInput } from "../llm/judge";
import {
  collectBatch,
  jsonFromMessage,
  pollBatch,
  submitBatch,
} from "../llm/batch";
import { csvRow } from "./csv";
import { formatScores, score, type Prediction } from "./score";

/**
 * Runs the real pipeline over a raw list of domains, with no database.
 *
 * This is the calibration path, and it is deliberately separate from the
 * production worker rather than a mode of it. Calibration and production want
 * opposite things: production wants Message Batches (half price, arbitrary
 * latency) and durable state; calibration wants an answer inside the hour and
 * the freedom to re-judge the same sites ten times while a rubric is being
 * argued with. `src/eval/run.ts` cannot do this job either — it replays the
 * previous tool's stored metrics and never calls Ahrefs or a crawler.
 *
 *   npm run calibrate -- sites.txt            # parse and price it, spend nothing
 *   npm run calibrate -- sites.txt --run      # the whole pipeline, live
 *   npm run calibrate -- sites.txt --run --batch   # same, at half price
 *   npm run calibrate -- --rejudge            # re-judge from cache, no Ahrefs
 *   npm run calibrate -- --score              # score against your_verdict
 *
 * Everything Ahrefs and the crawler produce is written to
 * eval/calibration-cache/ the moment it arrives. That is what makes `--rejudge`
 * cost model tokens and nothing else, and it is the reason a crash mid-run
 * never costs the same Ahrefs units twice.
 */

// Overridable so an unlabelled production run does not overwrite the
// calibration artefacts. The cache is keyed by domain, so a shared cache
// would still be correct — but a shared RESULTS file would not, and keeping
// the three together means one env var switches a whole run.
const CACHE_DIR = process.env.QA_CACHE_DIR ?? "eval/calibration-cache";
const RESULTS = process.env.QA_RESULTS ?? "eval/calibration.csv";
const TOP_PAGE_LIMIT = 10;

/** Sites per Message Batch, and how often to ask whether one has finished. */
const BATCH_CHUNK = 1_000;
const BATCH_POLL_MS = 30_000;

/**
 * Submitted batches that have not been collected yet.
 *
 * A batch id is durable for 29 days and the work behind it is already paid
 * for, so losing the id to a crashed poll loop is the one way this path can
 * waste real money. Written before the first poll and cleared only once the
 * results are in hand.
 */
const BATCH_STATE = process.env.QA_BATCH_STATE ?? "eval/calibration-batches.json";

interface PendingBatch {
  id: string;
  /**
   * Which step submitted it. Without this a leftover extraction batch would be
   * rejoined by the judge and parsed against the wrong schema — every row an
   * error, and the work already paid for thrown away.
   */
  kind: "extract" | "judge";
  /** Domains in submission order; index i is custom_id `s${i}`. */
  domains: string[];
}

/**
 * One domain's paid-for facts. Every field is nullable because the pipeline
 * abandons a Site at whichever stage rejects it, and the record has to say
 * which stage that was — a Site with no profile because the gate stopped it
 * and a Site with no profile because Cloudflare stopped it are different
 * findings, and collapsing them would hide the second one.
 */
interface CachedSite {
  domain: string;
  inputs: string[];
  metrics: SiteMetrics | null;
  gateReason: string | null;
  fetchReason: string | null;
  profile: SiteProfile | null;
  topPages: TopPage[] | null;
  /**
   * The homepage's "Write for us" link, verbatim; null when the page was
   * inspected and had none. Absent from records written before the detector
   * existed, which reads back as undefined — "never inspected" — and is why
   * the homepage step below backfills it rather than assuming an absence.
   */
  contributorSolicitation?: string | null;
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const listFile = args.find((arg) => !arg.startsWith("--"));
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const sampleSize = limitArg ? Number(limitArg.split("=")[1]) : undefined;

/**
 * Model cost per surviving Site.
 *
 * Input figures are read off `usage` on real calls over the 35 fetchable
 * calibration homepages, not estimated from character counts.
 *
 *   extraction  Haiku 4.5   4,516 fresh in + 6,963 cache read + 112 out
 *   judge       Sonnet 5    1,128 fresh in + 3,203 cache read + ~429 out
 *
 * Two caveats on the judge line, because it changed model and prompt at once:
 *
 *  - The input counts were measured on Opus 5. Sonnet 5 is a different model
 *    and may tokenise differently; re-baseline with `count_tokens` or a first
 *    live batch before treating these as exact.
 *  - The 429 output figure is inferred, not measured. Opus 5 returned 517, of
 *    which roughly 202 was visible JSON (a 633-character mean reason, the
 *    entity note, and the schema scaffolding) — leaving ~315 tokens of
 *    adaptive thinking, billed as output and never read. Shortening the reason
 *    to one paragraph removes ~90 of the visible tokens; the thinking is
 *    untouched. `output_config: { effort: "low" }` is the lever that reaches
 *    it and would take output to roughly 214, but it trades judgement quality
 *    and has not been scored against the reviewer's labels.
 *
 * Output is still the largest single line: ~59% of the judge's cost, and
 * caching cannot discount it because nothing about a response repeats. Only
 * `--batch` halves it.
 */
// Haiku 4.5 at $1/$5 per MTok, Sonnet 5 at $2/$10, cache reads at a tenth of
// input. Live rates; --batch halves everything below.
const EXTRACTION_COST = 4_516 * 1e-6 + 6_963 * 0.1e-6 + 112 * 5e-6;
const JUDGE_COST = 1_128 * 2e-6 + 3_203 * 0.2e-6 + 429 * 10e-6;
const MODEL_COST_PER_SITE = EXTRACTION_COST + JUDGE_COST;

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  mkdirSync(CACHE_DIR, { recursive: true });

  if (flags.has("--score")) return void scoreResults();
  if (flags.has("--rejudge")) return void rejudge();

  if (!listFile) {
    console.log(
      "Usage: npm run calibrate -- <file of domains> [--run] [--batch] [--no-jev] [--limit=N]\n" +
        "       npm run calibrate -- --rejudge [--no-jev]\n" +
        "       npm run calibrate -- --score",
    );
    return;
  }

  const parsed = parseSiteList(readFileSync(listFile, "utf8"));
  const all = parsed.sites;
  const selected = sampleSize ? all.slice(0, sampleSize) : all;

  console.log(`Input file:   ${listFile}`);
  console.log(`Domains:      ${all.length} after dedupe and normalisation`);
  if (sampleSize) console.log(`Selected:     ${selected.length} (--limit)`);
  const collapsed = all.filter((site) => site.inputs.length > 1);
  if (collapsed.length) {
    console.log(
      `Collapsed:    ${collapsed.length} domains had more than one input line`,
    );
  }
  if (parsed.rejected.length) {
    console.log(`\nRejected ${parsed.rejected.length} input lines:`);
    for (const rejected of parsed.rejected.slice(0, 20)) {
      console.log(`  ${rejected.input} — ${rejected.reason}`);
    }
    if (parsed.rejected.length > 20) {
      console.log(`  ... and ${parsed.rejected.length - 20} more`);
    }
  }

  const cached = selected.filter((site) =>
    existsSync(cachePath(site.domain)),
  ).length;
  const fresh = selected.length - cached;
  // The historical gate survival rate. Named rather than inlined because it
  // is the assumption the whole estimate turns on.
  const expectedSurvivors = Math.round(fresh * 0.8);
  console.log(
    `\nAlready cached: ${cached}. To fetch: ${fresh}.` +
      `\nAhrefs:         ~${(fresh * 19 + expectedSurvivors * 120).toLocaleString("en-US")} units worst case` +
      `\nModels:         ~$${(expectedSurvivors * MODEL_COST_PER_SITE).toFixed(2)} live, ` +
      `~$${(expectedSurvivors * MODEL_COST_PER_SITE * 0.5).toFixed(2)} with --batch`,
  );

  if (!flags.has("--run")) {
    console.log("\nDry run. Add --run to spend money and produce verdicts.");
    return;
  }

  const ahrefsKey = required("AHREFS_API_KEY");
  required("ANTHROPIC_API_KEY");
  const ahrefs = new AhrefsClient({ apiKey: ahrefsKey });
  const client = anthropic();

  const sites: CachedSite[] = selected.map(
    (site) =>
      readCache(site.domain) ?? {
        domain: site.domain,
        inputs: site.inputs,
        metrics: null,
        gateReason: null,
        fetchReason: null,
        profile: null,
        topPages: null,
      },
  );

  // ── Ahrefs batch analysis and Gate 1 ────────────────────────────────────
  const needMetrics = sites.filter((site) => site.metrics === null);
  if (needMetrics.length) {
    console.log(`\nBatch analysis for ${needMetrics.length} domains...`);
    const metrics = await ahrefs.batchAnalysis(
      needMetrics.map((site) => site.domain),
    );
    for (const site of needMetrics) {
      site.metrics = metrics.get(site.domain) ?? nullMetrics(site.domain);
      writeCache(site);
    }
  }

  for (const site of sites) {
    if (!site.metrics) continue;
    const outcome = applyGate(site.metrics, DEFAULT_THRESHOLDS);
    site.gateReason = outcome.pass ? null : outcome.reason;
    writeCache(site);
  }

  const survivors = sites.filter((site) => site.gateReason === null);
  console.log(
    `Gate: ${sites.length - survivors.length} prefailed, ${survivors.length} survive.`,
  );

  // ── Homepage, then extraction ───────────────────────────────────────────
  const needProfile = survivors.filter(
    (site) =>
      site.fetchReason === null &&
      (site.profile === null || site.contributorSolicitation === undefined),
  );
  if (needProfile.length) {
    console.log(`\nFetching and describing ${needProfile.length} homepages...`);
    if (flags.has("--batch")) {
      await describeViaBatch(client, needProfile);
    } else {
      await describeLive(client, needProfile);
    }
  }

  const described = survivors.filter((site) => site.profile !== null);
  const unfetched = survivors.length - described.length;
  if (unfetched)
    console.log(`${unfetched} survivors could not be fetched or described.`);

  // ── Ahrefs top pages ────────────────────────────────────────────────────
  const needPages = described.filter((site) => site.topPages === null);
  if (needPages.length) {
    console.log(`\nTop pages for ${needPages.length} sites...`);
    for (const site of needPages) {
      try {
        site.topPages = await ahrefs.topPages(site.domain, TOP_PAGE_LIMIT);
      } catch (error) {
        // An empty list is a real answer from Ahrefs and a failure is not, so
        // leaving topPages null keeps the site out of the judged set rather
        // than sending it in looking like a site that ranks for nothing.
        console.log(`  ${site.domain}: ${message(error)}`);
      }
      writeCache(site);
    }
  }

  console.log(
    `\nAhrefs units spent this run: ${ahrefs.unitsSpent().toLocaleString("en-US")}`,
  );
  await judgeAll(sites);
}

/** Judges everything in the cache that has both a profile and top pages. */
async function rejudge(): Promise<void> {
  required("ANTHROPIC_API_KEY");
  const sites = readdirSync(CACHE_DIR)
    .filter((file) => file.endsWith(".json"))
    .map(
      (file) =>
        JSON.parse(readFileSync(join(CACHE_DIR, file), "utf8")) as CachedSite,
    );
  console.log(
    `Cache holds ${sites.length} sites. No Ahrefs calls, no crawling.`,
  );
  await judgeAll(sites);
}

/**
 * Fetch a homepage and describe it immediately, one Site at a time.
 *
 * The markdown never outlives the call that uses it, which is the point: it is
 * the largest thing in this pipeline and it has no second use.
 */
async function describeLive(
  client: ReturnType<typeof anthropic>,
  sites: CachedSite[],
): Promise<void> {
  const userAgent = process.env.QA_USER_AGENT ?? "LinkProspectQA/1.0";
  const fetchLimit = pLimit(Number(process.env.FETCH_CONCURRENCY ?? 6));
  // 4, not 8: at 8 a 193-site run lost 49 sites to HTTP 529. See llm/client.
  const modelLimit = pLimit(Number(process.env.EVAL_CONCURRENCY ?? 4));
  let done = 0;

  await Promise.all(
    sites.map((site) =>
      fetchLimit(async () => {
        const page = await fetchHomepage(site.domain, { userAgent });
        if (page.kind === "failed") {
          site.fetchReason = `${page.httpStatus ?? "no response"}: ${page.reason}`;
          writeCache(site);
          return;
        }
        site.contributorSolicitation = page.contributorSolicitation;
        // Already described on an earlier run; this pass was only here to read
        // the solicitation link off the page, so do not pay for it again.
        if (site.profile) {
          writeCache(site);
          return;
        }
        try {
          site.profile = await modelLimit(() =>
            extract(client, site.domain, page.title, page.markdown),
          );
        } catch (error) {
          site.fetchReason = `extraction failed: ${message(error)}`;
        }
        writeCache(site);
        if (++done % 20 === 0) process.stderr.write(`  ${done}/${sites.length}\n`);
      }),
    ),
  );
}

/**
 * The same work through Message Batches: half price on every token.
 *
 * Fetching and extracting have to come apart to do this, because a batch is
 * submitted as a whole. Markdown is therefore held in memory — but only one
 * chunk of it, and only until that chunk is submitted, which bounds the cost
 * at roughly 20 MB rather than the ~96 MB a whole 6,000-domain list would
 * need. Submitting each chunk before fetching the next also means the crawler
 * and the batch queue run at the same time instead of taking turns.
 */
async function describeViaBatch(
  client: ReturnType<typeof anthropic>,
  sites: CachedSite[],
): Promise<void> {
  const userAgent = process.env.QA_USER_AGENT ?? "LinkProspectQA/1.0";
  const fetchLimit = pLimit(Number(process.env.FETCH_CONCURRENCY ?? 6));
  const byDomain = new Map(sites.map((site) => [site.domain, site]));
  const submitted: PendingBatch[] = [...readPendingBatches("extract")];

  for (const pending of submitted) {
    console.log(`Rejoining extraction batch ${pending.id} from a previous run.`);
  }

  for (let start = 0; start < sites.length; start += BATCH_CHUNK) {
    const chunk = sites.slice(start, start + BATCH_CHUNK);
    const pages = new Map<string, { title: string; markdown: string }>();

    await Promise.all(
      chunk.map((site) =>
        fetchLimit(async () => {
          const page = await fetchHomepage(site.domain, { userAgent });
          if (page.kind === "failed") {
            site.fetchReason = `${page.httpStatus ?? "no response"}: ${page.reason}`;
            writeCache(site);
            return;
          }
          site.contributorSolicitation = page.contributorSolicitation;
          writeCache(site);
          // A Site described on an earlier run needed only the solicitation
          // link, which it now has. Nothing left to ask the model.
          if (!site.profile) {
            pages.set(site.domain, { title: page.title, markdown: page.markdown });
          }
        }),
      ),
    );

    if (!pages.size) continue;
    const domains = [...pages.keys()];
    const batchId = await submitBatch(
      client,
      domains.map((domain, offset) => ({
        customId: `s${offset}`,
        params: buildExtractionRequest({ domain, ...pages.get(domain)! }),
      })),
    );
    const pending: PendingBatch = { id: batchId, kind: "extract", domains };
    addPendingBatch(pending);
    submitted.push(pending);
    console.log(
      `Extraction batch ${batchId} submitted with ${domains.length} homepages ` +
        `(${Math.min(start + BATCH_CHUNK, sites.length)}/${sites.length} fetched).`,
    );
    // The markdown has been serialised into the request; let it go before the
    // next chunk is read in.
    pages.clear();
  }

  for (const pending of submitted) {
    console.log(`\nWaiting on ${pending.id} (${pending.domains.length} homepages)...`);
    for (;;) {
      const state = await pollBatch(client, pending.id);
      if (state.done) break;
      process.stderr.write(
        `  processing ${state.processing}, succeeded ${state.succeeded}, errored ${state.errored}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_MS));
    }

    const { parsed, errors } = await collectBatch(client, pending.id, (msg) =>
      SiteProfile.parse(jsonFromMessage(msg)),
    );
    for (const [customId, profile] of parsed) {
      const site = byDomain.get(domainOf(customId, pending) ?? "");
      if (!site) continue;
      site.profile = profile;
      writeCache(site);
    }
    for (const [customId, error] of errors) {
      const site = byDomain.get(domainOf(customId, pending) ?? "");
      if (!site) continue;
      site.fetchReason = `extraction failed: ${error}`;
      writeCache(site);
    }
    removePendingBatch(pending.id);
  }
}

/** Everything the judge needs about one Site, built once and used by both paths. */
function judgeInputFor(site: CachedSite): JudgeInput {
  return {
    domain: site.domain,
    profile: site.profile!,
    metrics: {
      domainRating: site.metrics?.domainRating ?? null,
      organicTraffic: site.metrics?.organicTraffic ?? null,
      organicKeywords: site.metrics?.organicKeywords ?? null,
      refdomainsDofollow: site.metrics?.refdomainsDofollow ?? null,
      linkedDomainsDofollow: site.metrics?.linkedDomainsDofollow ?? null,
      outInRatio: site.metrics ? outInRatio(site.metrics) : null,
    },
    topPages: summariseTopPages(
      site.topPages!,
      site.domain,
      site.metrics?.organicTraffic ?? 0,
    ),
    contributorSolicitation: site.contributorSolicitation,
  };
}

async function judgeAll(sites: CachedSite[]): Promise<void> {
  const client = anthropic();
  // Read the labels back BEFORE overwriting the file they live in. A hand-typed
  // your_verdict is the most expensive thing in this repo per row — it is the
  // only input a re-run cannot reproduce — and a rewrite that dropped it would
  // silently destroy the regression set the calibration exists to build.
  const labels = existingLabels();
  const judgeable = sites.filter((site) => site.profile && site.topPages);
  const inputs = new Map(
    judgeable.map((site) => [site.domain, judgeInputFor(site)]),
  );
  const rows = new Map<string, string>();
  const tally = new Map<string, number>();
  const failures: string[] = [];

  // Jev first; the judge only sees what Jev was unsure of. --no-jev judges
  // everything, which is how the judge itself gets scored.
  let toJudge = inputs;
  let jevDecided = new Map<string, JudgedSite>();
  if (!flags.has("--no-jev")) {
    const { decided, escalated } = await triage(inputs, required("JEV_API_KEY"));
    toJudge = escalated;
    jevDecided = decided;
  }

  const judged = flags.has("--batch")
    ? await judgeViaBatch(client, toJudge)
    : await judgeLive(client, toJudge, failures);
  for (const [domain, result] of jevDecided) judged.set(domain, result);

  for (const site of judgeable) {
    const result = judged.get(site.domain);
    if (!result) {
      if (!failures.some((line) => line.startsWith(`${site.domain}:`))) {
        failures.push(`${site.domain}: no result returned`);
      }
      continue;
    }
    bump(tally, result.verdict);
    rows.set(
      site.domain,
      resultRow(
        site,
        inputs.get(site.domain)!.topPages,
        result,
        labels.get(site.domain),
      ),
    );
  }

  // Sites that never reached the judge still belong in the output. A domain
  // missing from the report reads as an oversight; a domain present with
  // "prefail: DR 4 < 10" in its stage column is the answer.
  for (const site of sites) {
    if (rows.has(site.domain)) continue;
    const stage = site.gateReason
      ? `prefail: ${site.gateReason}`
      : site.fetchReason
        ? `unfetched: ${site.fetchReason}`
        : site.topPages === null
          ? "no top pages retrieved"
          : "not judged";
    bump(tally, site.gateReason ? "prefail" : "undecided");
    rows.set(site.domain, undecidedRow(site, stage, labels.get(site.domain)));
  }

  // Sorted by domain, so a row stays on the same line between runs. A reviewer
  // works down this file in a spreadsheet; rows that reshuffle whenever the
  // judge is re-run lose their place.
  const ordered = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  writeFileSync(
    RESULTS,
    `${HEADER}\n${ordered.map(([, row]) => row).join("\n")}\n`,
  );
  console.log(`\n${rows.size} rows written to ${RESULTS}`);
  console.log(
    [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([verdict, count]) => `  ${verdict.padEnd(12)} ${count}`)
      .join("\n"),
  );
  if (failures.length) {
    console.log(`\n${failures.length} failed to judge:`);
    for (const failure of failures.slice(0, 10)) console.log(`  ${failure}`);
    console.log(
      "Re-run with --rejudge to retry these; it costs no Ahrefs units.",
    );
  }
  console.log(
    "\nFill in your_verdict on the rows you disagree with, then:" +
      "\n  npm run calibrate -- --score",
  );
}

/**
 * The synchronous path: one request per Site, four at a time.
 *
 * Full price, but the answer arrives while you watch. This is what a
 * thirty-site calibration wants.
 */
async function judgeLive(
  client: ReturnType<typeof anthropic>,
  inputs: Map<string, JudgeInput>,
  failures: string[],
): Promise<Map<string, JudgedSite>> {
  // 4, not 8. At 8 a 193-site run lost 49 sites to HTTP 529.
  const limit = pLimit(Number(process.env.EVAL_CONCURRENCY ?? 4));
  const judged = new Map<string, JudgedSite>();
  let done = 0;

  console.log(`\nJudging ${inputs.size} sites...`);
  await Promise.all(
    [...inputs].map(([domain, input]) =>
      limit(async () => {
        try {
          judged.set(domain, await judgeSite(client, input));
        } catch (error) {
          failures.push(`${domain}: ${message(error)}`);
        } finally {
          if (++done % 25 === 0)
            process.stderr.write(`  ${done}/${inputs.size}\n`);
        }
      }),
    ),
  );
  return judged;
}

/**
 * The Message Batches path: half price, arbitrary latency.
 *
 * The judge is where this pipeline's model spend lives — measured at $0.0204
 * per Site against $0.0044 for extraction, because Opus output tokens are
 * $25/MTok and a reason runs to ~550 of them. Halving the judge alone
 * therefore captures 82% of the saving available from batching anything, and
 * it needs no homepage markdown held in memory to do it.
 *
 * Worth using above a few hundred domains, where the synchronous path's real
 * cost is not the money but the hours: 4,800 Sites at concurrency 4 is most of
 * a working day of requests that nobody is watching.
 */
async function judgeViaBatch(
  client: ReturnType<typeof anthropic>,
  inputs: Map<string, JudgeInput>,
): Promise<Map<string, JudgedSite>> {
  const judged = new Map<string, JudgedSite>();

  // Rejoin anything a previous invocation submitted and never collected,
  // before spending on it a second time.
  for (const pending of readPendingBatches("judge")) {
    console.log(`\nRejoining batch ${pending.id} from a previous run...`);
    await drainBatch(client, pending, inputs, judged);
  }
  if (judged.size)
    console.log(`Recovered ${judged.size} verdicts already paid for.`);

  const entries = [...inputs].filter(([domain]) => !judged.has(domain));

  // Every chunk is submitted before any is waited on. Draining each one before
  // submitting the next would make the total wait the *sum* of the batches
  // rather than roughly the longest of them — five sequential hours instead of
  // one for a 6,000-domain list, for no saving at all. It also puts every
  // batch id on disk before the first long wait.
  const submitted: PendingBatch[] = [];
  for (let start = 0; start < entries.length; start += BATCH_CHUNK) {
    const chunk = entries.slice(start, start + BATCH_CHUNK);

    // The id is the position in this chunk, not the domain. A custom_id must
    // match ^[a-zA-Z0-9_-]{1,64}$ and every domain contains a dot, so passing
    // domains here fails the *whole* submission; sanitising them is no better,
    // since "a.b.com" and "a-b.com" would collapse to one id. The position
    // resolves through `domains` below, which is on disk before the first
    // poll, so identity also survives a restart.
    const requests = chunk.map(([, input], offset) => ({
      customId: `s${offset}`,
      params: buildJudgeRequest(input),
    }));

    const batchId = await submitBatch(client, requests);
    const pending: PendingBatch = {
      id: batchId,
      kind: "judge",
      domains: chunk.map(([domain]) => domain),
    };
    // Recorded before the first poll, so a crash here is recoverable rather
    // than a bill for results nobody can fetch.
    addPendingBatch(pending);
    submitted.push(pending);
    console.log(
      `Batch ${batchId} submitted with ${chunk.length} sites ` +
        `(${start + chunk.length}/${entries.length}).`,
    );
  }

  for (const pending of submitted) {
    console.log(
      `\nWaiting on ${pending.id} (${pending.domains.length} sites)...`,
    );
    await drainBatch(client, pending, inputs, judged);
  }

  return judged;
}

/** Polls one batch to completion, collects it, and forgets it. */
async function drainBatch(
  client: ReturnType<typeof anthropic>,
  pending: PendingBatch,
  inputs: Map<string, JudgeInput>,
  judged: Map<string, JudgedSite>,
): Promise<void> {
  for (;;) {
    const state = await pollBatch(client, pending.id);
    if (state.done) break;
    process.stderr.write(
      `  processing ${state.processing}, succeeded ${state.succeeded}, errored ${state.errored}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_MS));
  }

  // Keyed by custom_id, never by position: batch results come back in
  // arbitrary order, and reading them positionally is the classic way to give
  // every site somebody else's verdict.
  const { parsed, errors } = await collectBatch(client, pending.id, (msg) =>
    Judgement.parse(jsonFromMessage(msg)),
  );
  for (const [customId, judgement] of parsed) {
    const domain = domainOf(customId, pending);
    const input = domain ? inputs.get(domain) : undefined;
    if (!domain || !input) continue;
    judged.set(
      domain,
      finalise(
        judgement,
        input.profile.siteType,
        input.contributorSolicitation,
      ),
    );
  }
  for (const [customId, error] of errors) {
    console.log(`  ${domainOf(customId, pending) ?? customId}: ${error}`);
  }
  removePendingBatch(pending.id);
}

/** `s12` back to the domain submitted at position 12 of this batch. */
function domainOf(customId: string, pending: PendingBatch): string | undefined {
  const index = Number(customId.slice(1));
  return Number.isInteger(index) ? pending.domains[index] : undefined;
}

function readPendingBatches(kind?: PendingBatch["kind"]): PendingBatch[] {
  if (!existsSync(BATCH_STATE)) return [];
  try {
    const all = JSON.parse(readFileSync(BATCH_STATE, "utf8")) as PendingBatch[];
    return kind ? all.filter((pending) => pending.kind === kind) : all;
  } catch {
    return [];
  }
}

function addPendingBatch(pending: PendingBatch): void {
  writeFileSync(
    BATCH_STATE,
    `${JSON.stringify([...readPendingBatches(), pending], null, 2)}\n`,
  );
}

function removePendingBatch(id: string): void {
  const rest = readPendingBatches().filter((pending) => pending.id !== id);
  if (rest.length) {
    writeFileSync(BATCH_STATE, `${JSON.stringify(rest, null, 2)}\n`);
  } else if (existsSync(BATCH_STATE)) {
    rmSync(BATCH_STATE);
  }
}

const HEADER = [
  "domain",
  "verdict",
  "raw_verdict",
  "niche_mismatch",
  "penalty",
  "solicits_contributors",
  "entity",
  "stage",
  "dr",
  "traffic",
  "keywords",
  "refdomains",
  "linked_domains",
  "out_in_ratio",
  "site_type",
  "breadth",
  "language",
  "country",
  "description",
  "specific_niche",
  "taxonomy",
  "branded_share",
  "nav_share",
  "coverage",
  "remainder_pages",
  "ranks_for_almost_nothing",
  "top_keywords",
  "reason",
  "entity_note",
  "your_verdict",
  "your_reason",
].join(",");

function resultRow(
  site: CachedSite,
  summary: ReturnType<typeof summariseTopPages>,
  judged: Awaited<ReturnType<typeof judgeSite>>,
  label: Label | undefined,
): string {
  const profile = site.profile!;
  return csvRow([
    site.domain,
    judged.verdict,
    judged.rawVerdict,
    judged.nicheMismatch,
    judged.nichePenaltyApplied,
    describeSolicitation(
      judged.contributorSolicitation,
      judged.solicitationCapApplied,
    ),
    judged.entityRecognition,
    "judged",
    site.metrics?.domainRating ?? null,
    site.metrics?.organicTraffic ?? null,
    site.metrics?.organicKeywords ?? null,
    site.metrics?.refdomainsDofollow ?? null,
    site.metrics?.linkedDomainsDofollow ?? null,
    site.metrics ? (outInRatio(site.metrics)?.toFixed(2) ?? null) : null,
    profile.siteType,
    profile.topicBreadth,
    profile.language,
    profile.audienceCountry,
    profile.description,
    profile.specificNiche,
    profile.taxonomy.join(" | "),
    summary.brandedShare.toFixed(2),
    summary.navigationalShare.toFixed(2),
    summary.coverage.toFixed(2),
    summary.remainder.length,
    summary.ranksForAlmostNothing,
    summary.pages
      .map((page) => `${page.kind[0]}:${page.topKeyword}`)
      .join(" | "),
    reasonWithTopPages(judged.reason, summary),
    judged.entityNote,
    label?.verdict ?? "",
    label?.reason ?? "",
  ]);
}

/**
 * A row for a Site that never reached the judge, filled in by column name.
 *
 * By name rather than by index because this used to be a list of positional
 * assignments into a fixed-width array, and every column added to HEADER
 * silently shifted the reviewer's own two columns off the end of it.
 */
/**
 * The judge's paragraph, then every top page as a table underneath it.
 *
 * Written here rather than asked of the model. The URLs, traffic figures and
 * keywords are already in hand — they are the same rows the judge was shown —
 * so having it retype them costs output tokens at the judge's rate, is the
 * most expensive part of the response, and introduces the one failure a table
 * built from the source data cannot have: a transcription error in a number
 * the reviewer is about to act on.
 *
 * Newlines inside a CSV cell are legal as long as the cell is quoted, which
 * `csvRow` does whenever it sees one. Spreadsheets render it as a multi-line
 * cell; the reason and its evidence stay in the same place a reviewer looks.
 */
function reasonWithTopPages(
  reason: string,
  summary: ReturnType<typeof summariseTopPages>,
): string {
  if (!summary.pages.length) return `${reason}\n\n(no top pages returned)`;

  const rows = summary.pages.map(
    (page) =>
      `| ${page.url} | ${page.traffic.toLocaleString("en-US")} | ${page.topKeyword} |`,
  );
  return [reason, "", "| URL | Traffic | KW |", ...rows].join("\n");
}

function undecidedRow(
  site: CachedSite,
  stage: string,
  label: Label | undefined,
): string {
  const cells: Record<string, string | number | boolean | null> = {
    domain: site.domain,
    // A prefail is a do-not-buy decision either way; which of the two it is
    // depends on whether the numbers look manufactured. See gateVerdict.
    verdict: site.gateReason && site.metrics ? gateVerdict(site.metrics) : "",
    stage,
    dr: site.metrics?.domainRating ?? null,
    traffic: site.metrics?.organicTraffic ?? null,
    keywords: site.metrics?.organicKeywords ?? null,
    refdomains: site.metrics?.refdomainsDofollow ?? null,
    linked_domains: site.metrics?.linkedDomainsDofollow ?? null,
    out_in_ratio: site.metrics
      ? (outInRatio(site.metrics)?.toFixed(2) ?? null)
      : null,
    solicits_contributors: describeSolicitation(
      site.contributorSolicitation,
      false,
    ),
    your_verdict: label?.verdict ?? "",
    your_reason: label?.reason ?? "",
  };
  return csvRow(HEADER.split(",").map((column) => cells[column] ?? ""));
}

/**
 * What the reviewer sees in the solicits_contributors column.
 *
 * The matched phrase, not a boolean, and marked when it is what decided the
 * verdict — a reviewer disagreeing with this rule needs to see which link
 * triggered it, not just that something did.
 */
function describeSolicitation(
  matched: string | null | undefined,
  capped: boolean,
): string {
  if (matched === undefined) return "not checked";
  if (!matched) return "";
  return capped ? `CAPPED: ${matched}` : matched;
}

interface Label {
  verdict: string;
  reason: string;
}

/** Labels already typed into the results file, keyed by domain. */
function existingLabels(): Map<string, Label> {
  const labels = new Map<string, Label>();
  if (!existsSync(RESULTS)) return labels;
  for (const row of readResults()) {
    const verdict = row.your_verdict?.trim() ?? "";
    const reason = row.your_reason?.trim() ?? "";
    if (row.domain && (verdict || reason)) {
      labels.set(row.domain, { verdict, reason });
    }
  }
  if (labels.size)
    console.log(`Carrying ${labels.size} of your labels forward.`);
  return labels;
}

function readResults(): Record<string, string>[] {
  return parse(readFileSync(RESULTS, "utf8"), {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
}

/**
 * Scores the tool against the labels in the your_verdict column.
 *
 * A prefail counts as a `bad` prediction, because that is what it means
 * operationally: the site is not bought. Rows left blank are not scored — an
 * unreviewed row is not agreement, and counting it as one would make the
 * tool's accuracy rise every time somebody stopped reviewing early.
 */
function scoreResults(): void {
  if (!existsSync(RESULTS)) {
    console.log(`No ${RESULTS} yet. Run a calibration first.`);
    return;
  }
  const rows = readResults();

  const predictions: Prediction[] = [];
  const disagreements: string[] = [];
  let unlabelled = 0;
  let unpredicted = 0;

  for (const row of rows) {
    const human = row.your_verdict?.trim().toLowerCase() ?? "";
    if (!human) {
      unlabelled++;
      continue;
    }
    if (!isVerdict(human)) {
      console.log(
        `  ${row.domain}: "${row.your_verdict}" is not a verdict — skipped`,
      );
      continue;
    }
    const predicted = row.verdict?.trim().toLowerCase() ?? "";
    if (!isVerdict(predicted)) {
      unpredicted++;
      continue;
    }
    predictions.push({
      domain: row.domain ?? "",
      predicted: predicted as Verdict,
      actual: human as Verdict,
    });
    if (predicted !== human) {
      disagreements.push(
        `  ${(row.domain ?? "").padEnd(34)} tool: ${predicted.padEnd(12)} you: ${human.padEnd(12)} ${row.stage}`,
      );
    }
  }

  console.log(
    `${rows.length} rows, ${predictions.length} labelled and scored, ` +
      `${unlabelled} unlabelled, ${unpredicted} with no verdict to score.\n`,
  );
  if (!predictions.length) {
    console.log("Nothing to score. Fill in the your_verdict column first.");
    return;
  }
  console.log(formatScores("this tool, on your labels", score(predictions)));
  if (disagreements.length) {
    console.log(`\n${disagreements.length} disagreements:`);
    console.log(disagreements.join("\n"));
  }
}

async function extract(
  client: ReturnType<typeof anthropic>,
  domain: string,
  title: string,
  markdown: string,
): Promise<SiteProfile> {
  const response = await client.messages.parse(
    buildExtractionRequest({ domain, title, markdown }),
  );
  const parsed = response.parsed_output as SiteProfile | null;
  if (!parsed)
    throw new Error(
      `no parsable profile (stop_reason: ${response.stop_reason})`,
    );
  return parsed;
}

function cachePath(domain: string): string {
  return join(CACHE_DIR, `${domain.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

function readCache(domain: string): CachedSite | null {
  const path = cachePath(domain);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CachedSite;
  } catch {
    // A truncated file from an interrupted write is worth less than a re-fetch.
    return null;
  }
}

function writeCache(site: CachedSite): void {
  writeFileSync(cachePath(site.domain), `${JSON.stringify(site, null, 2)}\n`);
}

function nullMetrics(domain: string): SiteMetrics {
  return {
    domain,
    domainRating: null,
    organicTraffic: null,
    organicKeywords: null,
    refdomainsDofollow: null,
    linkedDomainsDofollow: null,
  };
}

function bump(tally: Map<string, number>, key: string): void {
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
