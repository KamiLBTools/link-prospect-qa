import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";
import type { SiteMetrics } from "../ahrefs/types";
import { outInRatio } from "../domain/gate";
import { summariseTopPages, type TopPage } from "../domain/topPages";
import { isUsable, isVerdict, type Verdict } from "../domain/verdict";
import { judgeUserPrompt, type JudgeInput } from "../llm/judge";
import type { SiteProfile } from "../llm/extract";
import { csvRow } from "./csv";
import { fetchHomepage } from "../crawl/fetchHomepage";
import { CHEAP_LABEL, CHEAP_MODEL, extractCheaply, type CheapExtraction } from "../llm/cheapExtract";
import { secondOpinion, type SecondOpinion } from "../llm/cheapJudge";
import { anthropic, JUDGE_MODEL } from "../llm/client";
import { judgeSite, type JudgedSite } from "../pipeline/judgeSite";
import { askJev, askJevBoth, askJevSignals, BUY_CRITERIA, SIGNALS, type JevAnswer, type Signals } from "../llm/jev";

/**
 * Judge vs Jev vs a trained model, on the reviewer's PEPO labels.
 *
 * The labels (eval/qa-training.csv) were given after the judge ran, and none of
 * them shaped the rubric, so this is the first held-out test the judge has had.
 * Only `domain` and `your_verdict` are read from that sheet: its model-output
 * columns are misaligned in about a third of rows. Everything the models see
 * comes from the run cache, which is what the judge actually saw.
 *
 * Only Sites the judge reached are compared; gate and fetch outcomes are the
 * same whichever model sits behind them. The trained model needs a split, so
 * the headline table is on the 30% test split. The split is by hash of the
 * domain within each verdict, so it is stable across runs.
 *
 *   npm run compare                # write eval/compare/sites.csv (features)
 *   npm run compare -- --jev       # also call Jev for every judged Site
 *   npm run compare -- --jev-buy   # and again, asked buy / don't buy
 *   npm run compare -- --jev-both  # and again, both questions in one request
 *   npm run compare -- --jev-signals  # the rejection reasons as narrow questions
 *   npm run compare -- --jev-no-description  # buy / don't buy without the description
 *   npm run compare -- --second-opinion  # cheap model on the Borderline band
 *   npm run compare -- --approach        # Jev + the judge on the uncertain Sites: Pass / Borderline / Fail
 *   CHEAP_PROVIDER=groq npm run compare -- --cheap-extract  # with a cheap model's description
 *   python3 scripts/train-signals.py
 *   python3 scripts/train-baseline.py
 *   npm run compare -- --score     # score everything present
 */

const LABELS = "eval/qa-training.csv";
const RESULTS = ["eval/pepo/results.csv", "eval/bad-sites/results.csv"];
const CACHES = ["eval/pepo/retry-cache", "eval/pepo/cache", "eval/bad-sites/cache"];
/**
 * A random 1,000 of the reviewer's list of guest-post sites they reject. Its
 * "Bad" covers `manipulation` too, so it is a don't-buy label: it trains the
 * buy / don't-buy model and is never in the test split, which keeps the test
 * split's mix — and so its scores — comparable with earlier runs.
 */
const EXTRA_BAD = "eval/bad-sites/domains.txt";
const OUT = "eval/compare";
const JEV_CACHE = "eval/jev-cache/pepo";
/** The same Sites asked buy / don't buy instead of the five verdicts. */
const JEV_BUY_CACHE = "eval/jev-cache/pepo-buy";
/** Both questions in one request, as production asks them. */
const JEV_BOTH_CACHE = "eval/jev-cache/pepo-both";
/** The reviewer's rejection reasons as narrow yes/no questions. */
const JEV_SIGNALS_CACHE = "eval/jev-cache/pepo-signals";
const SIGNAL_IDS = Object.keys(SIGNALS) as (keyof Signals)[];
/**
 * Buy / don't buy with the model-produced description removed from the state:
 * does Jev need the extraction step at all?
 */
const JEV_NO_DESCRIPTION_CACHE = "eval/jev-cache/pepo-buy-no-description";

function withoutDescription(state: string): string {
  const stripped = state.replace(/MODEL-PRODUCED[\s\S]*?\n\n/, "");
  if (stripped.includes("Description:")) throw new Error("description not stripped");
  return stripped;
}
/**
 * Buy / don't buy with the description written by a cheap open model
 * (src/llm/cheapExtract.ts) instead of Haiku.
 * The homepage text was never cached, so each Site is fetched again; a page
 * that changed since the Haiku run is a small, unavoidable difference.
 */
const HOMEPAGE_CACHE = "eval/homepage-cache";
const CHEAP_CACHE = `eval/cheap-extract-cache/${CHEAP_LABEL}`;
const JEV_CHEAP_CACHE = `eval/jev-cache/pepo-buy-${CHEAP_LABEL}`;
/** Pass cut-offs on P(buy) from the Jev-only Pass / Check design. */
const PASS_THRESHOLDS = [0.75, 0.8];
const ML_PREDICTIONS = `${OUT}/ml-predictions.csv`;
const TEST_SHARE = 0.3;
/** Fixed before the test split was scored; chosen on the 277-site set. */
const HYBRID_THRESHOLDS = [0.5, 0.65];

interface CachedSite {
  domain: string;
  metrics: SiteMetrics | null;
  profile: SiteProfile | null;
  topPages: TopPage[] | null;
  contributorSolicitation?: string | null;
}

interface Site {
  domain: string;
  human: Verdict;
  split: "train" | "test" | "extra";
  judge: Verdict;
  input: JudgeInput;
}

function rows(file: string): Record<string, string>[] {
  return parse(readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, bom: true });
}

function readCached(domain: string): CachedSite | null {
  for (const dir of CACHES) {
    const path = join(dir, `${domain.replace(/[^a-z0-9.-]/gi, "_")}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as CachedSite;
  }
  return null;
}

function inputFor(site: CachedSite): JudgeInput {
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
    topPages: summariseTopPages(site.topPages!, site.domain, site.metrics?.organicTraffic ?? 0),
    contributorSolicitation: site.contributorSolicitation,
  };
}

const hash = (domain: string) => createHash("sha1").update(domain).digest("hex");

function loadSites(): Site[] {
  const judged = new Map<string, Verdict>();
  for (const file of RESULTS.filter((path) => existsSync(path))) {
    for (const row of rows(file)) {
      const verdict = row["verdict"] ?? "";
      if (row["stage"] === "judged" && isVerdict(verdict)) judged.set(row["domain"]!, verdict);
    }
  }

  const labelled: { domain: string; human: Verdict }[] = [];
  for (const row of rows(LABELS)) {
    const domain = (row["domain"] ?? "").trim().toLowerCase();
    const human = (row["your_verdict"] ?? "").trim().toLowerCase();
    if (domain && isVerdict(human) && judged.has(domain)) labelled.push({ domain, human });
  }

  // Stratified: within each verdict, the first 30% by hash are the test split.
  const test = new Set<string>();
  const byVerdict = new Map<Verdict, string[]>();
  for (const { domain, human } of labelled) byVerdict.set(human, [...(byVerdict.get(human) ?? []), domain]);
  for (const group of byVerdict.values()) {
    const sorted = group.sort((a, b) => hash(a).localeCompare(hash(b)));
    for (const domain of sorted.slice(0, Math.round(sorted.length * TEST_SHARE))) test.add(domain);
  }

  const extra = new Set<string>();
  if (existsSync(EXTRA_BAD)) {
    for (const domain of readFileSync(EXTRA_BAD, "utf8").split(/\s+/).filter(Boolean)) {
      if (judged.has(domain)) {
        extra.add(domain);
        labelled.push({ domain, human: "bad" });
      }
    }
  }

  return labelled.flatMap(({ domain, human }) => {
    const cached = readCached(domain);
    if (!cached?.profile || !cached.topPages) return [];
    return [
      {
        domain,
        human,
        split: extra.has(domain) ? ("extra" as const) : test.has(domain) ? ("test" as const) : ("train" as const),
        judge: judged.get(domain)!,
        input: inputFor(cached),
      },
    ];
  });
}

/** One row per Site: the label, the split, and what a numbers-only model may see. */
function writeFeatures(sites: Site[]): void {
  const header = [
    "domain", "human", "split",
    "dr", "traffic", "keywords", "refdomains", "linked_domains", "out_in_ratio",
    "page_count", "coverage", "branded_share", "nav_share", "remainder_pages",
    "ranks_for_almost_nothing", "site_type", "topic_breadth", "profile_confidence",
    "solicits_contributors", "language", "country", "taxonomy_top",
    "description", "top_keywords",
    "jev_buy", "jev_buy_no_description", ...SIGNAL_IDS.map((id) => `sig_${id}`),
  ];
  const lines = [header.join(",")];
  for (const { domain, human, split, input } of sites) {
    const { metrics: m, topPages: t, profile: p } = input;
    lines.push(
      csvRow([
        domain, human, split,
        String(m.domainRating ?? ""), String(m.organicTraffic ?? ""), String(m.organicKeywords ?? ""),
        String(m.refdomainsDofollow ?? ""), String(m.linkedDomainsDofollow ?? ""),
        m.outInRatio === null ? "" : m.outInRatio.toFixed(3),
        String(t.pageCount), t.coverage.toFixed(3), t.brandedShare.toFixed(3),
        t.navigationalShare.toFixed(3), String(t.remainder.length),
        t.ranksForAlmostNothing ? "1" : "0",
        p.siteType, p.topicBreadth, p.confidence.toFixed(2),
        input.contributorSolicitation === undefined ? "" : input.contributorSolicitation ? "1" : "0",
        p.language, p.audienceCountry ?? "",
        (p.taxonomy[0] ?? "").split(">")[0]!.trim(),
        p.description, t.pages.map((page) => page.topKeyword).join(" | "),
        readJev(domain, JEV_BUY_CACHE)?.probabilities["buy"]?.toFixed(3) ?? "",
        readJev(domain, JEV_NO_DESCRIPTION_CACHE)?.probabilities["buy"]?.toFixed(3) ?? "",
        ...SIGNAL_IDS.map((id) => readSignals(domain)?.[id]?.toFixed(3) ?? ""),
      ]),
    );
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/sites.csv`, `${lines.join("\n")}\n`);
}

async function runJev(
  sites: Site[],
  cache: string,
  ask: (state: string, apiKey: string) => Promise<unknown>,
): Promise<void> {
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) throw new Error("JEV_API_KEY is not set");
  mkdirSync(cache, { recursive: true });
  const limit = pLimit(Number(process.env.JEV_CONCURRENCY ?? 4));
  const todo = sites.filter((site) => !existsSync(`${cache}/${site.domain}.json`));
  console.log(`Jev: ${sites.length - todo.length} cached, ${todo.length} to ask.`);
  let failed = 0;
  await Promise.all(
    todo.map((site) =>
      limit(async () => {
        try {
          const answer = await ask(judgeUserPrompt(site.input), apiKey);
          writeFileSync(`${cache}/${site.domain}.json`, JSON.stringify(answer, null, 2));
        } catch (error) {
          failed++;
          console.error(`  ${site.domain}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    ),
  );
  if (failed) console.log(`Jev: ${failed} failed; re-run to retry them.`);
}

/** Re-fetches each homepage and describes it with the cheap model. Both steps cache. */
async function describeCheaply(sites: Site[]): Promise<void> {
  const userAgent = process.env.QA_USER_AGENT ?? "LinkProspectQA/1.0";
  mkdirSync(HOMEPAGE_CACHE, { recursive: true });
  mkdirSync(CHEAP_CACHE, { recursive: true });
  const fetchLimit = pLimit(Number(process.env.FETCH_CONCURRENCY ?? 6));
  const modelLimit = pLimit(Number(process.env.CHEAP_CONCURRENCY ?? 4));
  const todo = sites.filter((site) => !existsSync(`${CHEAP_CACHE}/${site.domain}.json`));
  console.log(`${CHEAP_MODEL}: ${sites.length - todo.length} cached, ${todo.length} to describe.`);
  let unfetched = 0, failed = 0;

  await Promise.all(
    todo.map((site) =>
      fetchLimit(async () => {
        const pagePath = `${HOMEPAGE_CACHE}/${site.domain}.json`;
        let page = existsSync(pagePath) ? JSON.parse(readFileSync(pagePath, "utf8")) : null;
        if (!page) {
          page = await fetchHomepage(site.domain, { userAgent });
          writeFileSync(pagePath, JSON.stringify(page));
        }
        if (page.kind !== "ok") {
          unfetched++;
          return;
        }
        try {
          const extraction = await modelLimit(() =>
            extractCheaply({ domain: site.domain, title: page.title, markdown: page.markdown }),
          );
          writeFileSync(`${CHEAP_CACHE}/${site.domain}.json`, JSON.stringify(extraction, null, 2));
        } catch (error) {
          failed++;
          console.error(`  ${site.domain}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    ),
  );
  if (unfetched) console.log(`${unfetched} homepages could not be fetched this time; skipped.`);
  if (failed) console.log(`${CHEAP_MODEL}: ${failed} failed; re-run to retry them.`);
}

function readCheap(domain: string): CheapExtraction | null {
  const path = `${CHEAP_CACHE}/${domain}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CheapExtraction) : null;
}

/** The same Sites, carrying the cheap model's profile in place of Haiku's. */
function withCheapProfile(sites: Site[]): Site[] {
  return sites.flatMap((site) => {
    const extraction = readCheap(site.domain);
    return extraction ? [{ ...site, input: { ...site.input, profile: extraction.profile } }] : [];
  });
}

/** Area under the ROC curve: the chance a usable Site outranks an unusable one. */
function auc(scored: { score: number; usable: boolean }[]): number {
  const good = scored.filter((s) => s.usable).map((s) => s.score);
  const bad = scored.filter((s) => !s.usable).map((s) => s.score);
  let wins = 0;
  for (const g of good) for (const b of bad) wins += g > b ? 1 : g === b ? 0.5 : 0;
  return wins / (good.length * bad.length);
}

/** Haiku's description against the cheap model's, on the Sites both have. */
function reportCheap(sites: Site[]): void {
  const both = sites.filter((site) => readJev(site.domain, JEV_BUY_CACHE) && readJev(site.domain, JEV_CHEAP_CACHE));
  const pBuy = (site: Site, cache: string) => readJev(site.domain, cache)!.probabilities["buy"] ?? 0;
  const methods = [
    ["Haiku description", JEV_BUY_CACHE],
    [CHEAP_MODEL, JEV_CHEAP_CACHE],
  ] as const;

  const pepo = both.filter((site) => site.split !== "extra");
  const test = both.filter((site) => site.split === "test");
  const train = both.filter((site) => site.split !== "test");
  const testBad = test.filter((site) => !isUsable(site.human)).length;
  console.log(`\nHAIKU vs ${CHEAP_MODEL} DESCRIPTION — ${both.length} Sites with both (${test.length} test, ${testBad} bad)`);
  console.log(`${"".padEnd(24)} ranking   cut   train right-when-pass   test passed   test right-when-pass   bad let through`);
  for (const [name, cache] of methods) {
    const ranking = auc(pepo.map((site) => ({ score: pBuy(site, cache), usable: isUsable(site.human) })));
    for (const cut of PASS_THRESHOLDS) {
      const trainPassed = train.filter((site) => pBuy(site, cache) >= cut);
      const testPassed = test.filter((site) => pBuy(site, cache) >= cut);
      const trainRight = trainPassed.filter((site) => isUsable(site.human)).length;
      const testRight = testPassed.filter((site) => isUsable(site.human)).length;
      console.log(
        `  ${(cut === PASS_THRESHOLDS[0] ? name : "").padEnd(22)} ${cut === PASS_THRESHOLDS[0] ? ranking.toFixed(3) : "     "}   ${cut.toFixed(2)}` +
          `   ${`${((trainRight / trainPassed.length) * 100).toFixed(1)}%`.padStart(20)}` +
          `   ${`${((testPassed.length / test.length) * 100).toFixed(0)}%`.padStart(11)}` +
          `   ${`${((testRight / testPassed.length) * 100).toFixed(1)}%`.padStart(20)}` +
          `   ${`${testPassed.length - testRight} of ${testBad}`.padStart(15)}`,
      );
    }
  }

  const extractions = both.map((site) => readCheap(site.domain)!);
  const byNiche1 = new Map<string, number>();
  for (const e of extractions) byNiche1.set((e.niche?.niche1 ?? ""), (byNiche1.get((e.niche?.niche1 ?? "")) ?? 0) + 1);
  const depth3 = extractions.filter((e) => e.niche?.niche3).length;
  const invented = both.filter((site) => readCheap(site.domain)!.inventedNiche);
  writeFileSync(
    `${OUT}/niches-${CHEAP_LABEL}.csv`,
    [
      "domain,human,niche_1,niche_2,niche_3,invented_niche,site_type,audience_country,description",
      ...both.map((site) => {
        const e = readCheap(site.domain)!;
        return csvRow([
          site.domain, site.human, (e.niche?.niche1 ?? ""), e.niche?.niche2 ?? "", e.niche?.niche3 ?? "",
          e.inventedNiche ?? "", e.raw.siteType, e.raw.audienceCountry ?? "", e.raw.description,
        ]);
      }),
    ].join("\n") + "\n",
  );
  const input = extractions.reduce((sum, e) => sum + e.usage.input, 0) / extractions.length;
  const cached = extractions.reduce((sum, e) => sum + e.usage.cachedInput, 0) / extractions.length;
  const output = extractions.reduce((sum, e) => sum + e.usage.output, 0) / extractions.length;
  console.log(
    `\nNiche 1: ${[...byNiche1].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ")}.` +
      `\nNiche 3 filled on ${depth3} of ${extractions.length} Sites.` +
      `\nNot in the tree, so cut back to the nearest path, on ${invented.length} Sites: ` +
      invented.map((site) => readCheap(site.domain)!.inventedNiche).join("; ") +
      `\nEvery Site's niches: ${OUT}/niches-${CHEAP_LABEL}.csv` +
      `\nTokens per Site: ${input.toFixed(0)} in (${cached.toFixed(0)} cached), ${output.toFixed(0)} out.`,
  );
}

/** The Borderline band: Jev's P(buy) at or above FAIL_BELOW and below the Pass cut. */
const FAIL_BELOW = 0.15;
const SECOND_OPINION_CACHE = (model: string) => `eval/second-opinion/${model.replace(/[^a-z0-9.]+/gi, "-")}`;

/**
 * The cheap model with the judge's rubric, on the labelled Sites Jev put in
 * the Borderline band. Measured against the reviewer and against the Sonnet
 * judge on the same Sites.
 */
async function runSecondOpinion(sites: Site[], model: string): Promise<void> {
  const cache = SECOND_OPINION_CACHE(model);
  mkdirSync(cache, { recursive: true });
  const borderline = sites.filter((site) => {
    if (site.split === "extra") return false;
    const p = readJev(site.domain, JEV_BUY_CACHE)?.probabilities["buy"];
    return p !== undefined && p >= FAIL_BELOW && p < PASS_THRESHOLDS[0]!;
  });
  const todo = borderline.filter((site) => !existsSync(`${cache}/${site.domain}.json`));
  console.log(`\nSecond opinion (${model}): ${borderline.length} Borderline Sites, ${todo.length} to ask.`);
  const limit = pLimit(Number(process.env.CHEAP_CONCURRENCY ?? 4));
  await Promise.all(
    todo.map((site) =>
      limit(async () => {
        try {
          writeFileSync(`${cache}/${site.domain}.json`, JSON.stringify(await secondOpinion(site.input, model), null, 2));
        } catch (error) {
          console.error(`  ${site.domain}: ${error instanceof Error ? error.message.slice(0, 150) : String(error)}`);
        }
      }),
    ),
  );

  const answered = borderline.flatMap((site) => {
    const path = `${cache}/${site.domain}.json`;
    return existsSync(path) ? [{ site, opinion: JSON.parse(readFileSync(path, "utf8")) as SecondOpinion }] : [];
  });
  const usable = (v: Verdict) => isUsable(v);
  const bad = answered.filter(({ site }) => !usable(site.human)).length;
  const row = (name: string, says: (a: (typeof answered)[number]) => boolean) => {
    const buys = answered.filter(says);
    const nots = answered.filter((a) => !says(a));
    const right = answered.filter((a) => says(a) === usable(a.site.human)).length;
    const buyRight = buys.filter((a) => usable(a.site.human)).length;
    const notRight = nots.filter((a) => !usable(a.site.human)).length;
    console.log(
      `  ${name.padEnd(26)} ${`${((right / answered.length) * 100).toFixed(1)}%`.padStart(7)}` +
        `   buy ${String(buys.length).padStart(3)}, ${`${((buyRight / Math.max(1, buys.length)) * 100).toFixed(0)}%`.padStart(4)} right` +
        `   don't buy ${String(nots.length).padStart(3)}, ${`${((notRight / Math.max(1, nots.length)) * 100).toFixed(0)}%`.padStart(4)} right, catches ${notRight}/${bad} bad`,
    );
  };
  console.log(`${answered.length} answered; ${bad} of them really bad.\n  ${"".padEnd(26)} buy-acc`);
  row("buy everything", () => true);
  row(`${model}`, (a) => a.opinion.buy);
  row("judge (Sep 4 run)", (a) => usable(a.site.judge));
  const tokens = answered.reduce((sum, a) => sum + a.opinion.usage.input, 0) / Math.max(1, answered.length);
  const out = answered.reduce((sum, a) => sum + a.opinion.usage.output, 0) / Math.max(1, answered.length);
  console.log(`  tokens per Site: ${tokens.toFixed(0)} in, ${out.toFixed(0)} out`);
}

/** Company and shop Sites never pass on Jev alone: the reviewer rejects many that Jev passes. */
const JUDGE_ALWAYS = new Set(["corporate", "ecommerce"]);

type Status = "pass" | "borderline" | "fail";

/** Jev decides the confident ends; everything else goes to the judge. */
function needsJudge(site: Site): boolean {
  const p = readJev(site.domain, JEV_BUY_CACHE)!.probabilities["buy"] ?? 0;
  if (p < FAIL_BELOW) return false;
  return p < PASS_THRESHOLDS[0]! || JUDGE_ALWAYS.has(site.input.profile.siteType);
}

function approachStatus(site: Site, judged: JudgedSite | undefined): Status | null {
  const p = readJev(site.domain, JEV_BUY_CACHE)!.probabilities["buy"] ?? 0;
  if (p < FAIL_BELOW) return "fail";
  if (!needsJudge(site)) return "pass";
  if (!judged) return null;
  if (judged.verdict === "meh") return "borderline";
  return isUsable(judged.verdict) ? "pass" : "fail";
}

/**
 * The proposed production decision, scored on every labelled PEPO Site:
 * Jev at the confident ends, the production judge (JUDGE_MODEL) in between
 * and on company Sites, meh as Borderline.
 */
async function runApproach(sites: Site[]): Promise<void> {
  const cache = `eval/second-opinion/judge-${JUDGE_MODEL.replace(/[^a-z0-9.]+/gi, "-")}`;
  mkdirSync(cache, { recursive: true });
  const pepo = sites.filter((site) => site.split !== "extra" && readJev(site.domain, JEV_BUY_CACHE));
  const toJudge = pepo.filter(needsJudge);
  const todo = toJudge.filter((site) => !existsSync(`${cache}/${site.domain}.json`));
  console.log(`\nApproach: ${pepo.length} labelled Sites, ${toJudge.length} go to the judge (${JUDGE_MODEL}), ${todo.length} to ask.`);
  const client = anthropic();
  const limit = pLimit(Number(process.env.EVAL_CONCURRENCY ?? 4));
  await Promise.all(
    todo.map((site) =>
      limit(async () => {
        try {
          writeFileSync(`${cache}/${site.domain}.json`, JSON.stringify(await judgeSite(client, site.input), null, 2));
        } catch (error) {
          console.error(`  ${site.domain}: ${error instanceof Error ? error.message.slice(0, 150) : String(error)}`);
        }
      }),
    ),
  );
  const judged = (site: Site) => {
    const path = `${cache}/${site.domain}.json`;
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as JudgedSite) : undefined;
  };

  // The judge alone, on the Sites it was asked about: is this model as good as the September one?
  const asked = toJudge.filter((site) => judged(site));
  const agree = (verdict: (s: Site) => Verdict) => asked.filter((s) => isUsable(verdict(s)) === isUsable(s.human)).length;
  console.log(
    `  On those ${asked.length}, buy-decision right: ${JUDGE_MODEL} ${((agree((s) => judged(s)!.verdict) / asked.length) * 100).toFixed(1)}%,` +
      ` September judge ${((agree((s) => s.judge) / asked.length) * 100).toFixed(1)}%.`,
  );

  for (const [label, subset] of [
    ["ALL LABELLED PEPO SITES", pepo],
    ["TEST SPLIT ONLY (cut-offs were not chosen on it)", pepo.filter((site) => site.split === "test")],
  ] as const) {
    const rows = subset.flatMap((site) => {
      const status = approachStatus(site, judged(site));
      return status ? [{ site, status }] : [];
    });
    const bad = rows.filter((r) => !isUsable(r.site.human)).length;
    console.log(`\n${label}: ${rows.length} Sites, ${bad} really bad`);
    for (const status of ["pass", "borderline", "fail"] as const) {
      const group = rows.filter((r) => r.status === status);
      const usable = group.filter((r) => isUsable(r.site.human)).length;
      const mix = [...VERDICT_ORDER].map((v) => `${v} ${group.filter((r) => r.site.human === v).length}`).join(", ");
      console.log(
        `  ${status.padEnd(10)} ${String(group.length).padStart(4)} (${((group.length / rows.length) * 100).toFixed(0).padStart(2)}%)` +
          `  ${status === "fail" ? `${((1 - usable / Math.max(1, group.length)) * 100).toFixed(0)}% really bad` : `${((usable / Math.max(1, group.length)) * 100).toFixed(0)}% usable`}` +
          `   [${mix}]`,
      );
    }
  }
}

const VERDICT_ORDER = ["excellent", "good", "meh", "bad", "manipulation"] as const;

function readSignals(domain: string): Signals | null {
  const path = `${JEV_SIGNALS_CACHE}/${domain}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Signals) : null;
}

function readJev(domain: string, cache = JEV_CACHE): JevAnswer | null {
  const path = `${cache}/${domain}.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as JevAnswer) : null;
}

/** Buy-decision tallies. Exact match only where the method returns all five words. */
function tally(pairs: { predicted: Verdict; actual: Verdict }[], fiveWay: boolean): string {
  let right = 0, falseFail = 0, falsePass = 0, exact = 0;
  const usable = pairs.filter((pair) => isUsable(pair.actual)).length;
  for (const { predicted, actual } of pairs) {
    if (predicted === actual) exact++;
    if (isUsable(predicted) === isUsable(actual)) right++;
    else if (isUsable(actual)) falseFail++;
    else falsePass++;
  }
  const n = pairs.length;
  const pct = (value: number, of: number) => (of ? `${((value / of) * 100).toFixed(1)}%` : "–");
  return [
    String(n).padStart(4),
    pct(right, n).padStart(8),
    `${falseFail} (${pct(falseFail, usable)})`.padStart(13),
    `${falsePass} (${pct(falsePass, n - usable)})`.padStart(13),
    (fiveWay ? pct(exact, n) : "n/a").padStart(8),
  ].join("  ");
}

function report(sites: Site[]): void {
  const ml = new Map<string, Verdict>();
  if (existsSync(ML_PREDICTIONS)) {
    for (const row of rows(ML_PREDICTIONS)) {
      // The trained model answers buy / don't buy; mapped onto the verdict scale
      // so the buy-decision arithmetic is shared.
      ml.set(row["domain"]!, row["buy"] === "1" ? "good" : "bad");
    }
  }

  const header = `${"".padEnd(34)}   n  buy-acc   false fails  false passes    exact`;
  for (const [label, subset] of [
    ["TEST SPLIT (30%) — the fair comparison", sites.filter((site) => site.split === "test")],
    ["ALL PEPO SITES — no trained model", sites.filter((site) => site.split !== "extra")],
    ["EXTRA BAD SITES — every pass is a false pass", sites.filter((site) => site.split === "extra")],
  ] as const) {
    const withJev = subset.filter((site) => readJev(site.domain));
    const line = (name: string, pairs: { predicted: Verdict; actual: Verdict }[], fiveWay = true) =>
      `  ${name.padEnd(32)}${tally(pairs, fiveWay)}`;

    console.log(`\n${label}\n${header}`);
    console.log(line("buy everything", withJev.map((s) => ({ predicted: "good" as Verdict, actual: s.human })), false));
    console.log(line("judge (Sep 4 run)", withJev.map((s) => ({ predicted: s.judge, actual: s.human }))));
    console.log(line("Jev", withJev.map((s) => ({ predicted: readJev(s.domain)!.choice as Verdict, actual: s.human }))));
    for (const threshold of HYBRID_THRESHOLDS) {
      const pairs = withJev.map((s) => {
        const answer = readJev(s.domain)!;
        return { predicted: (answer.confidence >= threshold ? answer.choice : s.judge) as Verdict, actual: s.human };
      });
      const toJudge = withJev.filter((s) => readJev(s.domain)!.confidence < threshold).length;
      console.log(line(`Jev ≥${threshold}, else judge (${toJudge})`, pairs));
    }

    // Buy / don't buy, mapped onto the verdict scale so the arithmetic is shared.
    const withBuy = withJev.filter((site) => readJev(site.domain, JEV_BUY_CACHE));
    if (withBuy.length === withJev.length) {
      const buyVerdict = (s: Site): Verdict =>
        readJev(s.domain, JEV_BUY_CACHE)!.choice === "buy" ? "good" : "bad";
      console.log(line("Jev buy/don't buy", withBuy.map((s) => ({ predicted: buyVerdict(s), actual: s.human })), false));
      for (const threshold of HYBRID_THRESHOLDS) {
        const pairs = withBuy.map((s) => ({
          predicted: readJev(s.domain, JEV_BUY_CACHE)!.confidence >= threshold ? buyVerdict(s) : s.judge,
          actual: s.human,
        }));
        const toJudge = withBuy.filter((s) => readJev(s.domain, JEV_BUY_CACHE)!.confidence < threshold).length;
        console.log(line(`  ≥${threshold}, else judge (${toJudge})`, pairs, false));
      }
    }
    const withMl = withJev.filter((site) => ml.has(site.domain));
    // Only on the test split: elsewhere it would be scored on its own training rows.
    if (withMl.length && label.startsWith("TEST")) {
      console.log(line("trained model (numbers only)", withMl.map((s) => ({ predicted: ml.get(s.domain)!, actual: s.human })), false));
    }
    // Combined: route on the yes/no's confidence, take the five-way verdict, and
    // escalate whenever the two answers disagree about buying.
    const both = (s: Site) => {
      const path = `${JEV_BOTH_CACHE}/${s.domain}.json`;
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { verdict: JevAnswer; buy: JevAnswer }) : null;
    };
    const withBoth = withJev.filter((site) => both(site));
    if (withBoth.length === withJev.length) {
      const disagree = withBoth.filter((s) => {
        const answer = both(s)!;
        return isUsable(answer.verdict.choice as Verdict) !== (answer.buy.choice === "buy");
      }).length;
      console.log(line(`Jev combined, verdict alone`, withBoth.map((s) => ({ predicted: both(s)!.verdict.choice as Verdict, actual: s.human }))));
      for (const threshold of HYBRID_THRESHOLDS) {
        const trusted = (s: Site) => {
          const answer = both(s)!;
          return (
            answer.buy.confidence >= threshold &&
            isVerdict(answer.verdict.choice) &&
            isUsable(answer.verdict.choice) === (answer.buy.choice === "buy")
          );
        };
        const pairs = withBoth.map((s) => ({
          predicted: trusted(s) ? (both(s)!.verdict.choice as Verdict) : s.judge,
          actual: s.human,
        }));
        const toJudge = withBoth.filter((s) => !trusted(s)).length;
        console.log(line(`  ≥${threshold} and agree, else judge (${toJudge})`, pairs));
      }
      console.log(`  (the two answers disagree about buying on ${disagree} of ${withBoth.length})`);
    }
    console.log(`  (bracketed: Sites sent to the judge; ${subset.length - withJev.length} without a Jev answer are left out)`);
  }

  const lines = ["domain,split,human,judge,jev,jev_confidence,jev_buy,jev_buy_confidence,ml_buy"];
  for (const site of sites) {
    const answer = readJev(site.domain);
    const buy = readJev(site.domain, JEV_BUY_CACHE);
    lines.push(
      csvRow([
        site.domain, site.split, site.human, site.judge,
        answer?.choice ?? "", answer ? answer.confidence.toFixed(3) : "",
        buy?.choice ?? "", buy ? buy.confidence.toFixed(3) : "",
        ml.has(site.domain) ? (isUsable(ml.get(site.domain)!) ? "1" : "0") : "",
      ]),
    );
  }
  writeFileSync(`${OUT}/results.csv`, `${lines.join("\n")}\n`);
  console.log(`\nPer-site results written to ${OUT}/results.csv`);
}

async function main(): Promise<void> {
  const sites = loadSites();
  const test = sites.filter((site) => site.split === "test").length;
  const extra = sites.filter((site) => site.split === "extra").length;
  console.log(`${sites.length} labelled Sites reached the judge: ${sites.length - test - extra} train, ${test} test, ${extra} extra bad (train only).`);
  if (process.argv.includes("--jev")) await runJev(sites, JEV_CACHE, askJev);
  if (process.argv.includes("--jev-buy")) {
    await runJev(sites, JEV_BUY_CACHE, (state, apiKey) => askJev(state, apiKey, BUY_CRITERIA));
  }
  if (process.argv.includes("--jev-both")) await runJev(sites, JEV_BOTH_CACHE, askJevBoth);
  if (process.argv.includes("--jev-signals")) await runJev(sites, JEV_SIGNALS_CACHE, askJevSignals);
  if (process.argv.includes("--jev-no-description")) {
    await runJev(sites, JEV_NO_DESCRIPTION_CACHE, (state, apiKey) =>
      askJev(withoutDescription(state), apiKey, BUY_CRITERIA),
    );
  }
  if (process.argv.includes("--approach")) await runApproach(sites);
  if (process.argv.includes("--second-opinion")) {
    for (const model of (process.env.SECOND_OPINION_MODELS ?? CHEAP_MODEL).split(",")) await runSecondOpinion(sites, model);
  }
  if (process.argv.includes("--cheap-extract")) {
    await describeCheaply(sites);
    await runJev(withCheapProfile(sites), JEV_CHEAP_CACHE, (state, apiKey) =>
      askJev(state, apiKey, BUY_CRITERIA),
    );
    reportCheap(sites);
  }
  // After the Jev calls, so the features carry whatever they just cached.
  writeFeatures(sites);
  console.log(`Features written to ${OUT}/sites.csv`);
  if (process.argv.includes("--score")) report(sites);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
