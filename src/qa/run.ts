import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";
import { AhrefsClient } from "../ahrefs/ahrefsClient";
import type { SiteMetrics } from "../ahrefs/types";
import { applyGate, DEFAULT_THRESHOLDS, outInRatio } from "../domain/gate";
import { parseSiteList } from "../domain/site";
import { summariseTopPages, type TopPage } from "../domain/topPages";
import { fetchHomepage } from "../crawl/fetchHomepage";
import { closeRenderer } from "../crawl/renderPage";
import { CHEAP_MODEL, extractCheaply, extractionFrom, type CheapExtraction } from "../llm/cheapExtract";
import { askJev, BUY_CRITERIA } from "../llm/jev";
import { judgeUserPrompt, type JudgeInput } from "../llm/judge";
import { csvRow } from "../eval/csv";
import { anthropic, JUDGE_MODEL } from "../llm/client";
import { judgeSite } from "../pipeline/judgeSite";
import { isUsable, type Verdict } from "../domain/verdict";
import { pickCountry, pickLanguage, type PageLocale } from "../domain/siteLocale";

/**
 * The production QA run: a list of domains in, one CSV row per Site out, in
 * the columns the agency database imports.
 *
 *   Ahrefs batch analysis → Gate → homepage + gpt-oss-20b description
 *   → Ahrefs top pages → Jev buy / don't buy → the judge on the uncertain middle
 *
 * Jev decides the confident ends: P(buy) ≥ 0.75 passes, < 0.15 fails. The
 * judge (Sonnet 5) decides everything between, and every company or shop Site:
 * good/excellent passes, meh is Borderline, bad/manipulation fails only if Jev
 * also leaned no (P < 0.5), else Borderline. Measured on the reviewer's 630
 * labels (`npm run compare -- --approach`): Pass 68% of Sites, 95% usable;
 * Borderline 24%; Fail 8%, 83% really bad.
 *
 *   npm run qa -- sites.csv              # count, reuse and price it; spends nothing
 *   npm run qa -- sites.csv --run        # the whole pipeline
 *   npm run qa -- sites.csv --run --no-ahrefs   # from cache only: never spends a unit
 *   npm run qa -- sites.csv --run --limit=50
 *
 * Every paid-for result is cached per domain the moment it arrives, so a crash
 * or a stopped run resumes where it left off and never pays twice. The
 * columns people fill in (prices, review, outreach) are read back from the previous output before it is
 * rewritten, so a re-run never loses them.
 */

const CACHE_DIR = process.env.QA_CACHE_DIR ?? "qa/cache";
const OUT = process.env.QA_OUT ?? "qa/results.csv";
const PASS_THRESHOLD = Number(process.env.PASS_THRESHOLD ?? 0.75);
const FAIL_BELOW = Number(process.env.FAIL_BELOW ?? 0.15);
/** The judge's "don't buy" is a Fail only when Jev also leaned no; otherwise Borderline. */
const JUDGE_FAIL_BELOW = 0.5;
/** Company and shop Sites never pass on Jev alone: the reviewer rejects many that Jev passes. */
const JUDGE_ALWAYS = new Set(["corporate", "ecommerce"]);
const TOP_PAGE_LIMIT = 10;
/** Ahrefs data this recent is reused rather than bought again. */
const REUSE_DAYS = Number(process.env.METRICS_CACHE_DAYS ?? 14);
/** Earlier runs whose Ahrefs data is worth reusing. Only metrics and top pages are taken. */
const OLDER_CACHES = [
  "eval/enrich-cache",
  "eval/bad-sites/cache",
  "eval/pepo/cache",
  "eval/pepo/retry-cache",
  "eval/calibration-cache",
];

interface QaSite {
  domain: string;
  inputs: string[];
  metrics: SiteMetrics | null;
  gateReason: string | null;
  fetchError: string | null;
  /** The homepage's "Write for us" link, verbatim; null when it had none. */
  writeForUs?: string | null;
  /** The homepage's own language and locale tags; absent on Sites cached before they were kept. */
  page?: PageLocale;
  extraction: CheapExtraction | null;
  topPages: TopPage[] | null;
  buyProbability: number | null;
  /** Only for the Sites Jev was unsure of, and company Sites. */
  judge?: { verdict: Verdict; reason: string; model: string } | null;
  /** When Jev or the judge last answered, YYYY-MM-DD. */
  aiDate?: string;
  /** Where the description came from: the homepage, or knowledge when the homepage could not be read. */
  describedFrom?: "homepage" | "knowledge";
  checkedAt: string;
}

/**
 * The step that failed for a Site in this run. Not cached: a failed step is
 * retried on the next run, so its error only describes this one.
 */
const errors = new Map<string, "description" | "jev" | "judge">();

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const listFile = args.find((arg) => !arg.startsWith("--"));
const limitArg = args.find((arg) => arg.startsWith("--limit="));

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  if (!listFile) {
    console.log("Usage: npm run qa -- <file of domains> [--run] [--limit=N]");
    return;
  }
  mkdirSync(CACHE_DIR, { recursive: true });

  const parsed = parseSiteList(readFileSync(listFile, "utf8"));
  const selected = limitArg ? parsed.sites.slice(0, Number(limitArg.split("=")[1])) : parsed.sites;
  console.log(`Input:    ${listFile}`);
  console.log(`Domains:  ${parsed.sites.length} after dedupe${limitArg ? `, ${selected.length} selected` : ""}`);
  if (parsed.rejected.length) {
    console.log(`Rejected: ${parsed.rejected.length} lines, e.g. ${parsed.rejected.slice(0, 3).map((r) => `${r.input} (${r.reason})`).join("; ")}`);
  }

  const sites = selected.map((site) => readCache(site.domain) ?? reuseOlder(site.domain, site.inputs));
  const needMetrics = sites.filter((site) => !site.metrics).length;
  // Sites with metrics in hand are gated now, so the estimate skips their prefails.
  const needPages = sites.filter(
    (site) => !site.topPages && !site.fetchError && (!site.metrics || applyGate(site.metrics, DEFAULT_THRESHOLDS).pass),
  ).length;
  const reused = sites.filter((site) => site.metrics).length;
  // Measured on the September lists: about 80% of fresh Sites clear the gate.
  const pagesEstimate = Math.round((needMetrics * 0.8 + (needPages - needMetrics)) * TOP_PAGE_LIMIT * 12);
  const unitsEstimate = needMetrics * 19 + Math.max(0, pagesEstimate);
  console.log(
    `\nAhrefs data already held: ${reused} (from this run's cache or earlier runs up to ${REUSE_DAYS} days old).` +
      `\nAhrefs to buy:  ${needMetrics} metrics (${(needMetrics * 19).toLocaleString("en-US")} units)` +
      ` + top pages, ~${unitsEstimate.toLocaleString("en-US")} units worst case in all.`,
  );
  const left = await unitsLeft();
  if (left !== null) {
    console.log(`Ahrefs units left on this key: ${left.toLocaleString("en-US")}.`);
    if (unitsEstimate > left) console.log("  Not enough for the worst case: the run will stop when they run out, and resume later.");
  }

  if (!flags.has("--run")) {
    console.log("\nDry run. Add --run to spend.");
    return;
  }

  const ahrefs = new AhrefsClient({ apiKey: required("AHREFS_API_KEY") });
  const jevKey = required("JEV_API_KEY");
  required("ANTHROPIC_API_KEY");
  // --no-ahrefs: work only from what is already bought. Sites missing Ahrefs
  // data stay pending rather than costing units.
  const spend = !flags.has("--no-ahrefs");
  if (!spend) console.log("\n--no-ahrefs: using cached Ahrefs data only.");
  try {
    if (spend) await measure(ahrefs, sites);
    else gate(sites);
    await describe(sites);
    fromKnowledge(sites);
    if (spend) await topPages(ahrefs, sites);
  } catch (error) {
    // Most likely Ahrefs units ran out. Everything bought so far is cached;
    // still decide and write what can be, so the file reflects the progress.
    console.log(`\nStopped early: ${message(error)}`);
  } finally {
    console.log(`\nAhrefs units spent this run: ${ahrefs.unitsSpent().toLocaleString("en-US")}`);
  }
  // Decided before AI dates were kept: dated from this run, then kept.
  for (const site of sites) {
    if (site.buyProbability !== null && !site.aiDate) {
      site.aiDate = today();
      writeCache(site);
    }
  }
  await decide(sites, jevKey);
  await judge(sites);
  write(sites);
  await closeRenderer();
}

// ── Ahrefs batch analysis and the gate ─────────────────────────────────────
async function measure(ahrefs: AhrefsClient, sites: QaSite[]): Promise<void> {
  const need = sites.filter((site) => !site.metrics);
  if (need.length) {
    console.log(`\nAhrefs metrics for ${need.length} domains...`);
    const metrics = await ahrefs.batchAnalysis(need.map((site) => site.domain));
    for (const site of need) {
      site.metrics = metrics.get(site.domain) ?? nullMetrics(site.domain);
      writeCache(site);
    }
  }
  gate(sites);
}

function gate(sites: QaSite[]): void {
  for (const site of sites) {
    if (!site.metrics) continue;
    const outcome = applyGate(site.metrics, DEFAULT_THRESHOLDS);
    site.gateReason = outcome.pass ? null : outcome.reason;
    writeCache(site);
  }
  const survivors = sites.filter((site) => site.gateReason === null).length;
  console.log(`Gate: ${sites.length - survivors} prefail, ${survivors} continue.`);
}

// ── Homepage and description ───────────────────────────────────────────────
async function describe(sites: QaSite[]): Promise<void> {
  // Sites described before the page's tags were kept are fetched again for
  // those alone: free, and no second description.
  const need = sites.filter((site) => site.metrics && site.gateReason === null && !site.fetchError && (!site.extraction || !site.page));
  if (!need.length) return;
  const describing = need.filter((site) => !site.extraction).length;
  console.log(`\nFetching ${need.length} homepages, describing ${describing} with ${CHEAP_MODEL}...`);
  const userAgent = process.env.QA_USER_AGENT ?? "LinkProspectQA/1.0";
  const fetchLimit = pLimit(Number(process.env.FETCH_CONCURRENCY ?? 6));
  const modelLimit = pLimit(Number(process.env.CHEAP_CONCURRENCY ?? 4));
  let done = 0;

  await Promise.all(
    need.map((site) =>
      fetchLimit(async () => {
        const page = await fetchHomepage(site.domain, { userAgent });
        if (page.kind === "failed") {
          // A refetch that fails keeps the description it already has.
          if (!site.extraction) site.fetchError = `${page.httpStatus ?? "no response"}: ${page.reason}`;
        } else if (site.extraction) {
          site.page = page.page;
        } else {
          site.writeForUs = page.contributorSolicitation;
          site.page = page.page;
          try {
            site.extraction = await modelLimit(() =>
              extractCheaply({ domain: site.domain, title: page.title, markdown: page.markdown }),
            );
          } catch (error) {
            // Not saved as a fetch error: a model failure is worth retrying on
            // the next run, a dead homepage is not.
            errors.set(site.domain, "description");
            console.log(`  ${site.domain}: description failed, will retry next run: ${message(error).slice(0, 150)}`);
          }
        }
        writeCache(site);
        if (++done % 50 === 0) console.log(`  ${done}/${need.length}`);
      }),
    ),
  );
}

// ── Knowledge, for homepages that could not be read ────────────────────────
interface KnowledgeEntry {
  domain: string;
  basis: "knowledge" | "name" | "unknown";
  language: string | null;
  country: string | null;
  description: string | null;
  siteType: string | null;
  niche: string | null;
  confidence: number;
}

/**
 * QA_KNOWLEDGE: a JSON array of sites described from knowledge rather than
 * read. Only entries that genuinely know the site (basis "knowledge", with a
 * description) stand in for an unreadable homepage; a guess from the name
 * never does. The Site then goes through top pages, Jev and the judge as usual.
 */
function fromKnowledge(sites: QaSite[]): void {
  const path = process.env.QA_KNOWLEDGE;
  if (!path) return;
  const known = new Map(
    (JSON.parse(readFileSync(path, "utf8")) as KnowledgeEntry[])
      .filter((k) => k.basis === "knowledge" && k.description && k.language)
      .map((k) => [k.domain, k]),
  );
  let used = 0;
  for (const site of sites) {
    const k = known.get(site.domain);
    if (!k || !site.metrics || site.gateReason !== null || site.extraction) continue;
    const siteType = (["news", "magazine", "blog", "corporate", "ecommerce", "directory"].includes(k.siteType ?? "") ? k.siteType : "other") as CheapExtraction["raw"]["siteType"];
    // "News > <Country> > <State>": the country comes from k.country, as for the model.
    const [first, second, third] = (k.niche ?? "").split(" > ");
    const news = first === "News";
    site.extraction = extractionFrom({
      description: k.description!,
      language: k.language!,
      audienceCountry: k.country,
      siteType,
      niche: news ? "News" : (k.niche ?? ""),
      newsScope: !news ? "none" : second === "International" ? "international" : third ? "local" : "national",
      newsRegion: news && third ? third : "none",
      topicBreadth: siteType === "news" || siteType === "magazine" ? "broad" : "focused",
      confidence: k.confidence,
    });
    site.describedFrom = "knowledge";
    site.fetchError = null;
    writeCache(site);
    used++;
  }
  console.log(`\nDescribed ${used} unreadable Sites from knowledge (${known.size} known in ${path}).`);
}

// ── Ahrefs top pages, only for Sites that were described ───────────────────
async function topPages(ahrefs: AhrefsClient, sites: QaSite[]): Promise<void> {
  const need = sites.filter((site) => site.extraction && !site.topPages);
  if (!need.length) return;
  console.log(`\nAhrefs top pages for ${need.length} Sites...`);
  let done = 0;
  for (const site of need) {
    try {
      site.topPages = await ahrefs.topPages(site.domain, TOP_PAGE_LIMIT);
    } catch (error) {
      // Still failing after the client's retries: skip this Site, it stays
      // pending for the next run. Anything else (units gone) stops the step.
      if (!/^Ahrefs 5\d\d /.test(message(error))) throw error;
      console.log(`  ${site.domain}: top pages failed, will retry next run: ${message(error).slice(0, 120)}`);
      continue;
    }
    writeCache(site);
    if (++done % 100 === 0) console.log(`  ${done}/${need.length}`);
  }
}

// ── Jev: buy or don't buy ──────────────────────────────────────────────────
async function decide(sites: QaSite[], apiKey: string): Promise<void> {
  const need = sites.filter((site) => site.extraction && site.topPages && site.buyProbability === null);
  if (!need.length) return;
  console.log(`\nAsking Jev about ${need.length} Sites...`);
  const limit = pLimit(Number(process.env.JEV_CONCURRENCY ?? 4));
  let failed = 0;
  await Promise.all(
    need.map((site) =>
      limit(async () => {
        try {
          const answer = await askJev(judgeUserPrompt(jevInput(site)), apiKey, BUY_CRITERIA);
          site.buyProbability = answer.probabilities["buy"] ?? 0;
          site.aiDate = today();
          writeCache(site);
        } catch (error) {
          failed++;
          errors.set(site.domain, "jev");
          console.log(`  ${site.domain}: Jev failed, will retry next run: ${message(error).slice(0, 150)}`);
        }
      }),
    ),
  );
  if (failed) console.log(`Jev failed on ${failed}; they stay pending until a re-run.`);
}

// ── The judge, on what Jev was unsure of ───────────────────────────────────
function needsJudge(site: QaSite): boolean {
  const p = site.buyProbability;
  if (p === null || p < FAIL_BELOW) return false;
  return p < PASS_THRESHOLD || JUDGE_ALWAYS.has(site.extraction!.raw.siteType);
}

async function judge(sites: QaSite[]): Promise<void> {
  const need = sites.filter((site) => needsJudge(site) && !site.judge);
  if (!need.length) return;
  console.log(`\nJudging ${need.length} Sites with ${JUDGE_MODEL}...`);
  const client = anthropic();
  const limit = pLimit(Number(process.env.EVAL_CONCURRENCY ?? 4));
  let failed = 0;
  await Promise.all(
    need.map((site) =>
      limit(async () => {
        // Twice: a rare over-long reason breaks the structured answer, and a
        // second ask almost always comes back whole.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const judged = await judgeSite(client, jevInput(site));
            site.judge = { verdict: judged.verdict, reason: judged.reason, model: JUDGE_MODEL };
            site.aiDate = today();
            writeCache(site);
            return;
          } catch (error) {
            if (attempt === 1) {
              failed++;
              errors.set(site.domain, "judge");
              console.log(`  ${site.domain}: judge failed, will retry next run: ${message(error).slice(0, 150)}`);
            }
          }
        }
      }),
    ),
  );
  if (failed) console.log(`The judge failed on ${failed}; they stay pending until a re-run.`);
}

/** Jev's state, in exactly the shape it was measured with. */
function jevInput(site: QaSite): JudgeInput {
  const metrics = site.metrics!;
  return {
    domain: site.domain,
    profile: site.extraction!.profile,
    metrics: {
      domainRating: metrics.domainRating,
      organicTraffic: metrics.organicTraffic,
      organicKeywords: metrics.organicKeywords,
      refdomainsDofollow: metrics.refdomainsDofollow,
      linkedDomainsDofollow: metrics.linkedDomainsDofollow,
      outInRatio: outInRatio(metrics),
    },
    topPages: summariseTopPages(site.topPages!, site.domain, metrics.organicTraffic ?? 0),
    contributorSolicitation: site.writeForUs,
  };
}

// ── Output ─────────────────────────────────────────────────────────────────
const PRICE_COLUMNS = ["Normal", "Grey", "Insertion"] as const;
const REVIEW_COLUMNS = ["QA", "QA Reason", "QA By", "QA At"] as const;
const OUTREACH_COLUMNS = ["Email", "Requirements", "Notes", "ThreadID", "LastReply", "Relationship"] as const;
/** Filled in by people, never by the run: carried over from the last output. */
const HUMAN_COLUMNS = [...PRICE_COLUMNS, ...REVIEW_COLUMNS, ...OUTREACH_COLUMNS] as const;
const COLUMNS = [
  "Website", "DR", "Traffic", "Niche", "Country", "Language", ...PRICE_COLUMNS, "Description", "Description Source", "WFS",
  "JEV", "JEV(P)", "AIJudge", "AI Reason", "Branded Share", "AI Date",
  "Keywords", "Out/In Ratio", "Top Page",
  ...REVIEW_COLUMNS,
  ...OUTREACH_COLUMNS,
] as const;

/**
 * pass / borderline / fail are the decision; a gate stop is a fail, with
 * prefail_reason saying why. pending means the run has not finished this Site
 * (units ran out, or a call failed) and a re-run will pick it up.
 */
function qaStatus(site: QaSite): string {
  if (site.gateReason) return "fail";
  if (site.fetchError) return "unfetched";
  if (!site.metrics || site.buyProbability === null) return "pending";
  if (site.buyProbability < FAIL_BELOW) return "fail";
  if (!needsJudge(site)) return "pass";
  if (!site.judge) return "pending";
  if (site.judge.verdict === "meh") return "borderline";
  if (isUsable(site.judge.verdict)) return "pass";
  return site.buyProbability < JUDGE_FAIL_BELOW ? "fail" : "borderline";
}

function write(sites: QaSite[]): void {
  const human = previousHumanColumns();
  const rows = [...sites]
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .map((site) => {
      const m = site.metrics;
      const e = site.extraction;
      const error = errors.get(site.domain);
      // "Error" in the cells a failed step should have filled.
      const describeFailed = Boolean(site.fetchError) || error === "description";
      const orError = <T,>(failed: boolean, value: T) => (failed ? "Error" : value);
      const summary = site.topPages ? summariseTopPages(site.topPages, site.domain, m?.organicTraffic ?? 0) : null;
      const reasons = [
        site.gateReason && `Prefail: ${site.gateReason}`,
        site.judge?.reason,
      ].filter(Boolean);
      const cells: Record<(typeof COLUMNS)[number], string | number | null> = {
        Website: site.domain,
        DR: m?.domainRating ?? null,
        Traffic: m?.organicTraffic ?? null,
        // Comma-separated, the way a Google Sheets multi-select dropdown stores its chips.
        Niche: orError(describeFailed, e?.niche ? [e.niche.niche1, e.niche.niche2, e.niche.niche3].filter(Boolean).join(", ") : null),
        Country: orError(describeFailed, e ? pickCountry(site.domain, site.page, e.raw.audienceCountry) : null),
        Language: orError(describeFailed, e ? pickLanguage(site.page, e.raw.language) : null),
        Description: orError(describeFailed, e?.raw.description ?? null),
        "Description Source": e ? (site.describedFrom ?? "homepage") : null,
        // undefined: the homepage was never read; null: read, and it had no such link.
        WFS: orError(Boolean(site.fetchError), site.writeForUs ? "Yes" : site.writeForUs === null ? "No" : "IDK"),
        JEV: orError(error === "jev", qaStatus(site)),
        "JEV(P)": orError(error === "jev", site.buyProbability === null ? null : site.buyProbability.toFixed(3)),
        AIJudge: orError(error === "judge", site.judge?.verdict ?? null),
        "AI Reason": orError(error === "judge", reasons.length ? reasons.join(" | ") : null),
        "Branded Share": summary ? summary.brandedShare.toFixed(2) : null,
        "AI Date": site.aiDate ?? null,
        Keywords: m?.organicKeywords ?? null,
        "Out/In Ratio": m ? (outInRatio(m)?.toFixed(2) ?? null) : null,
        // One line per page: page | traffic | keyword.
        "Top Page": site.topPages?.length
          ? site.topPages.map((p) => `${p.url} | ${p.traffic} | ${p.topKeyword}`).join("\n")
          : null,
        QA: null,
        "QA Reason": null,
        "QA By": null,
        "QA At": null,
        Normal: null,
        Grey: null,
        Insertion: null,
        Email: null,
        Requirements: null,
        Notes: null,
        ThreadID: null,
        LastReply: null,
        Relationship: null,
      };
      for (const column of HUMAN_COLUMNS) cells[column] = human.get(site.domain)?.[column] ?? null;
      return csvRow(COLUMNS.map((column) => cells[column]));
    });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${COLUMNS.join(",")}\n${rows.join("\n")}\n`);
  const tally = new Map<string, number>();
  for (const site of sites) tally.set(qaStatus(site), (tally.get(qaStatus(site)) ?? 0) + 1);
  console.log(`\n${sites.length} rows written to ${OUT}`);
  for (const [status, count] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${status.padEnd(10)} ${count}`);
}

/** The reviewer's columns from the last output, so a re-run never wipes them. */
function previousHumanColumns(): Map<string, Record<string, string>> {
  const kept = new Map<string, Record<string, string>>();
  if (!existsSync(OUT)) return kept;
  const rows = parse(readFileSync(OUT, "utf8"), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  for (const row of rows) {
    if (HUMAN_COLUMNS.some((column) => row[column]?.trim())) kept.set(row["Website"]!, row);
  }
  if (kept.size) console.log(`Carrying forward the filled-in columns on ${kept.size} rows.`);
  return kept;
}

// ── Cache ──────────────────────────────────────────────────────────────────
function cachePath(dir: string, domain: string): string {
  return join(dir, `${domain.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

function readCache(domain: string): QaSite | null {
  const path = cachePath(CACHE_DIR, domain);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as QaSite;
  } catch {
    return null; // A truncated write is worth less than a re-fetch.
  }
}

function writeCache(site: QaSite): void {
  site.checkedAt = new Date().toISOString();
  writeFileSync(cachePath(CACHE_DIR, site.domain), `${JSON.stringify(site, null, 2)}\n`);
}

/**
 * A fresh record, seeded with Ahrefs data an earlier run already bought, if
 * it is recent enough. Only Ahrefs data: the description and decision are
 * redone, because both changed model since.
 */
function reuseOlder(domain: string, inputs: string[]): QaSite {
  const site: QaSite = {
    domain, inputs, metrics: null, gateReason: null, fetchError: null,
    extraction: null, topPages: null, buyProbability: null, checkedAt: new Date().toISOString(),
  };
  const cutoff = Date.now() - REUSE_DAYS * 86_400_000;
  for (const dir of OLDER_CACHES) {
    const path = cachePath(dir, domain);
    if (!existsSync(path) || statSync(path).mtimeMs < cutoff) continue;
    try {
      const old = JSON.parse(readFileSync(path, "utf8")) as { metrics?: SiteMetrics | null; topPages?: TopPage[] | null };
      site.metrics ??= old.metrics ?? null;
      site.topPages ??= old.topPages ?? null;
    } catch {
      continue;
    }
  }
  return site;
}

async function unitsLeft(): Promise<number | null> {
  const key = process.env.AHREFS_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch("https://api.ahrefs.com/v3/subscription-info/limits-and-usage", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    const json = (await response.json()) as { limits_and_usage: { units_limit_api_key: number; units_usage_api_key: number } };
    return json.limits_and_usage.units_limit_api_key - json.limits_and_usage.units_usage_api_key;
  } catch {
    return null;
  }
}

function nullMetrics(domain: string): SiteMetrics {
  return { domain, domainRating: null, organicTraffic: null, organicKeywords: null, refdomainsDofollow: null, linkedDomainsDofollow: null };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
