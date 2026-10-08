import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const RESULTS = "eval/last-run.csv";

/** Domains already scored in a previous pass, read back from the results file. */
function judgedDomains(): Set<string> {
  if (!existsSync(RESULTS)) return new Set();
  return new Set(
    readFileSync(RESULTS, "utf8")
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(",")[0]?.trim().toLowerCase())
      .filter((domain): domain is string => Boolean(domain)),
  );
}
import pLimit from "p-limit";
import { anthropic } from "../llm/client";
import { applyGate, DEFAULT_THRESHOLDS } from "../domain/gate";
import { isUsable, isVerdict, type Verdict } from "../domain/verdict";
import { judgeSite } from "../pipeline/judgeSite";
import { loadLabelledSites, toJudgeInput, type LabelledSite } from "./fixtures";
import { csvRow } from "./csv";
import { formatScores, score, type Prediction } from "./score";

/**
 * Replays the judge against the reviewer's own 277 labelled sites.
 *
 * This costs real money — roughly $0.02 per site on Opus 5 — so it does
 * nothing without `--run`. Default output is the estimate and nothing else.
 *
 *   npm run eval                    # what it would cost
 *   npm run eval -- --run --limit 25
 *   npm run eval -- --run           # the whole set
 */

const args = new Set(process.argv.slice(2));
const retryFailed = args.has("--retry-failed");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const sampleSize = limitArg ? Number(limitArg.split("=")[1]) : undefined;

/** Opus 5 at $5/$25 per MTok, ~5,500 input and ~400 output tokens per site. */
const COST_PER_SITE = 5_500 * 5e-6 + 400 * 25e-6;

async function main(): Promise<void> {
  const all = loadLabelledSites();
  let sites = sampleSize ? stratifiedSample(all, sampleSize) : all;

  if (retryFailed) {
    const already = judgedDomains();
    sites = all.filter((site) => !already.has(site.domain));
    console.log(`Retrying ${sites.length} sites absent from eval/last-run.csv.`);
  }

  console.log(`Regression set: ${all.length} labelled sites`);
  console.log(`Selected:       ${sites.length}`);
  console.log(`Estimated cost: $${(sites.length * COST_PER_SITE).toFixed(2)}\n`);
  console.log(describeBias(all));
  console.log(formatScores("baseline: the previous tool", baseline(all)));

  if (!args.has("--run")) {
    console.log("\nDry run. Add --run to spend money and score the new judge.");
    return;
  }

  const client = anthropic();
  // 4, not 8. At 8 a full run lost 49 of 193 sites to HTTP 529; the retry
  // budget in llm/client.ts is the other half of that fix.
  const limit = pLimit(Number(process.env.EVAL_CONCURRENCY ?? 4));
  const predictions: Prediction[] = [];
  const failures: string[] = [];
  const rows: string[] = [
    "domain,human,predicted,raw,niche_mismatch,penalty,entity,stage,reason",
  ];

  /**
   * The gate runs first, exactly as it does in production, so a Site it
   * rejects never reaches the judge. Scoring gate rejections as though the
   * judge had seen them was wrong twice over: it credited the judge with the
   * gate's work, and it fed the judge rows with no top pages at all — 85 of
   * them, because the previous tool prefailed those and never bought their
   * top-pages report.
   */
  const toJudge: LabelledSite[] = [];
  let unjudgeable = 0;

  for (const site of sites) {
    const outcome = applyGate(
      {
        domainRating: site.domainRating,
        organicTraffic: site.organicTraffic,
        // Never captured by the previous tool, so the gate here runs on three
        // of its four rules. The keyword threshold cannot be scored at all.
        organicKeywords: null,
        refdomainsDofollow: site.refdomainsDofollow,
        linkedDomainsDofollow: site.linkedDomainsDofollow,
      },
      DEFAULT_THRESHOLDS,
    );

    if (!outcome.pass) {
      // A prefail is a do-not-buy decision; that is what it means operationally.
      predictions.push({
        domain: site.domain,
        predicted: "bad",
        actual: site.humanVerdict,
      });
      rows.push(
        csvRow([site.domain, site.humanVerdict, "bad", "", "", "", "", "gate", outcome.reason]),
      );
      continue;
    }

    if (site.topPages.length === 0) {
      // Survived the gate but has no top pages in the fixture, so there is
      // nothing for the judge to reason about. Excluded rather than guessed at.
      unjudgeable++;
      continue;
    }
    toJudge.push(site);
  }

  console.log(
    `\nGate rejected ${predictions.length}; ${unjudgeable} survivors have no top pages in the fixture and are excluded; ${toJudge.length} go to the judge.`,
  );

  let done = 0;
  await Promise.all(
    toJudge.map((site) =>
      limit(async () => {
        try {
          const judged = await judgeSite(client, toJudgeInput(site));
          predictions.push({
            domain: site.domain,
            predicted: judged.verdict,
            actual: site.humanVerdict,
          });
          rows.push(
            csvRow([
              site.domain,
              site.humanVerdict,
              judged.verdict,
              judged.rawVerdict,
              String(judged.nicheMismatch),
              String(judged.nichePenaltyApplied),
              judged.entityRecognition,
              "judge",
              judged.reason,
            ]),
          );
        } catch (error) {
          failures.push(
            `${site.domain}: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          done++;
          if (done % 25 === 0) process.stderr.write(`  ${done}/${toJudge.length}\n`);
        }
      }),
    ),
  );

  console.log(`\n${formatScores("new judge", score(predictions))}`);

  if (failures.length) {
    console.log(`\n${failures.length} sites failed to judge:`);
    for (const failure of failures.slice(0, 10)) console.log(`  ${failure}`);
  }

  // Appending on a retry pass keeps the earlier results, which is the whole
  // point of being able to complete a partial run.
  if (retryFailed && existsSync(RESULTS)) {
    appendFileSync(RESULTS, `${rows.slice(1).join("\n")}\n`);
    console.log(`\nAppended ${rows.length - 1} rows to ${RESULTS}`);
  } else {
    writeFileSync(RESULTS, `${rows.join("\n")}\n`);
    console.log(`\nPer-site results written to ${RESULTS}`);
  }
}

/**
 * How the regression set was assembled, printed every run.
 *
 * This matters more than it looks. The reviewer labelled sites in order to
 * check the previous tool's *rejections*, so the set is enriched with them —
 * they are the overwhelming majority of it. Two consequences, and neither is a
 * reason to distrust the set, only to read it correctly:
 *
 *  - No rate computed here is a population rate. The baseline's false-fail
 *    figure is near-total because these rows were selected for being rejected,
 *    not because the tool rejected everything it ever saw.
 *  - It is nonetheless the right set to tune against, because it is dense in
 *    exactly the error that mattered: sites wrongly thrown away.
 *
 * The number to watch is the new judge's false-fail count against the
 * baseline's on these same rows, not either one as a percentage of anything.
 */
function describeBias(sites: LabelledSite[]): string {
  const rejected = sites.filter(
    (site) => site.oldVerdict === "bad" || site.oldVerdict === "prefail" || site.oldVerdict === "manipulation",
  ).length;
  const share = sites.length ? rejected / sites.length : 0;
  const usable = sites.filter((site) => isUsable(site.humanVerdict)).length;

  return [
    "── how to read these numbers ─────────────────────",
    `  ${rejected} of ${sites.length} rows (${(share * 100).toFixed(0)}%) were rejected by the previous tool.`,
    "  The reviewer labelled these to audit its rejections, so the set is",
    "  deliberately dense in false fails and no rate below is a population rate.",
    `  ${usable} of these sites the reviewer would have bought. Compare the`,
    "  false-fail COUNT between baseline and new judge; ignore the percentages.",
    "",
  ].join("\n");
}

/**
 * The previous tool's own numbers on the same rows, so an improvement is
 * measured rather than asserted. `prefail` counts as a do-not-buy decision,
 * because that is what it meant operationally; `needs review` is not a decision
 * at all and is excluded.
 */
function baseline(sites: LabelledSite[]): ReturnType<typeof score> {
  const predictions: Prediction[] = [];
  for (const site of sites) {
    const mapped =
      site.oldVerdict === "prefail"
        ? "bad"
        : isVerdict(site.oldVerdict)
          ? (site.oldVerdict as Verdict)
          : null;
    if (!mapped) continue;
    predictions.push({
      domain: site.domain,
      predicted: mapped,
      actual: site.humanVerdict,
    });
  }
  return score(predictions);
}


/** Keeps the label mix of a sample close to the full set's. */
function stratifiedSample(sites: LabelledSite[], size: number): LabelledSite[] {
  const byVerdict = new Map<Verdict, LabelledSite[]>();
  for (const site of sites) {
    const list = byVerdict.get(site.humanVerdict) ?? [];
    list.push(site);
    byVerdict.set(site.humanVerdict, list);
  }

  const picked: LabelledSite[] = [];
  for (const [, list] of byVerdict) {
    const take = Math.max(1, Math.round((list.length / sites.length) * size));
    picked.push(...list.slice(0, take));
  }
  return picked.slice(0, size);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
