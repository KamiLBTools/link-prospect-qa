import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";
import { applyGate, DEFAULT_THRESHOLDS } from "../domain/gate";
import { isUsable, isVerdict, VERDICTS, type Verdict } from "../domain/verdict";
import { judgeUserPrompt } from "../llm/judge";
import { askJev, type JevAnswer } from "../llm/jev";
import { loadLabelledSites, toJudgeInput } from "./fixtures";
import { csvRow } from "./csv";
import { formatScores, score, type Prediction } from "./score";

/**
 * Jev (TypeSafe's classifier) against the judge's last eval, on the same sites.
 *
 * Jev gets exactly what the judge gets — the rubric as instructions, the judge's
 * user prompt as state — and answers one Choice over the five verdicts. It
 * returns no niche observation, so no penalty is applied to its answer; the
 * judge's column is its verdict of record from eval/last-run.csv.
 *
 * Only sites that reached the judge are compared. Gate rejections are the
 * gate's decision whichever model sits behind it.
 *
 * Responses are cached per domain, so a re-run re-scores for free.
 *
 *   npm run jev                # what it would send
 *   npm run jev -- --run       # call Jev and score
 */

const CACHE = "eval/jev-cache";
const RESULTS = "eval/jev-run.csv";

/** The judge's verdicts of record from the last full eval, by domain. */
function judgeVerdicts(): Map<string, Verdict> {
  const rows: Record<string, string>[] = parse(readFileSync("eval/last-run.csv", "utf8"), {
    columns: true,
    skip_empty_lines: true,
  });
  const map = new Map<string, Verdict>();
  for (const row of rows) {
    const predicted = row["predicted"] ?? "";
    if (row["stage"] === "judge" && isVerdict(predicted)) map.set(row["domain"]!, predicted);
  }
  return map;
}

async function main(): Promise<void> {
  const judged = judgeVerdicts();
  const sites = loadLabelledSites().filter(
    (site) =>
      judged.has(site.domain) &&
      site.topPages.length > 0 &&
      applyGate(
        {
          domainRating: site.domainRating,
          organicTraffic: site.organicTraffic,
          organicKeywords: null,
          refdomainsDofollow: site.refdomainsDofollow,
          linkedDomainsDofollow: site.linkedDomainsDofollow,
        },
        DEFAULT_THRESHOLDS,
      ).pass,
  );

  console.log(`${sites.length} sites reached the judge in eval/last-run.csv and will go to Jev.`);
  if (!process.argv.includes("--run")) {
    console.log("Dry run. Add --run to call Jev.");
    return;
  }

  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) throw new Error("JEV_API_KEY is not set");
  mkdirSync(CACHE, { recursive: true });

  const limit = pLimit(Number(process.env.JEV_CONCURRENCY ?? 4));
  const failures: string[] = [];
  const answers = new Map<string, JevAnswer>();

  await Promise.all(
    sites.map((site) =>
      limit(async () => {
        const file = `${CACHE}/${site.domain}.json`;
        try {
          const answer: JevAnswer = existsSync(file)
            ? JSON.parse(readFileSync(file, "utf8"))
            : await askJev(judgeUserPrompt(toJudgeInput(site)), apiKey);
          if (!existsSync(file)) writeFileSync(file, JSON.stringify(answer, null, 2));
          answers.set(site.domain, answer);
        } catch (error) {
          failures.push(`${site.domain}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    ),
  );

  const jev: Prediction[] = [];
  const sonnet: Prediction[] = [];
  const rows = ["domain,human,jev,confidence,judge"];
  const scored: { confidence: number; right: boolean }[] = [];

  for (const site of sites) {
    const answer = answers.get(site.domain);
    if (!answer || !isVerdict(answer.choice)) continue;
    const judge = judged.get(site.domain)!;
    jev.push({ domain: site.domain, predicted: answer.choice, actual: site.humanVerdict });
    sonnet.push({ domain: site.domain, predicted: judge, actual: site.humanVerdict });
    scored.push({
      confidence: answer.confidence,
      right: isUsable(answer.choice) === isUsable(site.humanVerdict),
    });
    rows.push(
      csvRow([site.domain, site.humanVerdict, answer.choice, answer.confidence.toFixed(3), judge]),
    );
  }

  writeFileSync(RESULTS, `${rows.join("\n")}\n`);
  console.log(`\n${formatScores("Jev", score(jev))}`);
  console.log(`\n${formatScores("judge from eval/last-run.csv (same sites)", score(sonnet))}`);

  console.log("\nJev buy-decision accuracy by confidence");
  for (const [lo, hi] of [[0, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 1.01]] as const) {
    const bucket = scored.filter((s) => s.confidence >= lo && s.confidence < hi);
    const right = bucket.filter((s) => s.right).length;
    const pct = bucket.length ? ((right / bucket.length) * 100).toFixed(1) : "–";
    console.log(`  ${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}  n=${String(bucket.length).padStart(3)}  ${pct}%`);
  }

  if (failures.length) {
    console.log(`\n${failures.length} sites failed:`);
    for (const failure of failures.slice(0, 10)) console.log(`  ${failure}`);
  }
  console.log(`\nPer-site results written to ${RESULTS} (verdicts: ${VERDICTS.join(", ")})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
