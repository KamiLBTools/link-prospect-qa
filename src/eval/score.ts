import { distance, isUsable, VERDICTS, type Verdict } from "../domain/verdict";

/**
 * Scoring.
 *
 * The primary metric is deliberately coarse. Exact agreement on five labels
 * would make the tool chase the `good` / `meh` boundary, which is fuzzy in the
 * reviewer's own labels — they used `excellent` only 5 times in 277 rows. The
 * decision that spends money is binary: buy or don't.
 *
 * Within that, the two errors are not symmetric. A false fail throws away
 * inventory the reviewer would have bought and is invisible unless someone
 * re-reviews the rejects by hand; a false pass surfaces the moment they look at
 * what they bought. The previous tool's false-fail rate on this set was 74%,
 * which is the number to beat.
 */

export interface Prediction {
  domain: string;
  predicted: Verdict;
  actual: Verdict;
}

export interface Scores {
  n: number;
  /** Both agree the site is worth buying. */
  truePass: number;
  /** Both agree it is not. */
  trueFail: number;
  /** We rejected a site the reviewer would have used. The expensive error. */
  falseFail: number;
  /** We approved a site the reviewer rejected. */
  falsePass: number;
  /** falseFail / (sites the reviewer found usable). */
  falseFailRate: number;
  /** falsePass / (sites the reviewer rejected). */
  falsePassRate: number;
  /** Agreement on the binary buy decision. */
  usableAccuracy: number;
  exactMatch: number;
  meanDistance: number;
  /** actual -> predicted -> count. */
  confusion: Map<Verdict, Map<Verdict, number>>;
}

export function score(predictions: Prediction[]): Scores {
  const confusion = new Map<Verdict, Map<Verdict, number>>(
    VERDICTS.map((verdict) => [verdict, new Map(VERDICTS.map((v) => [v, 0]))]),
  );

  let truePass = 0;
  let trueFail = 0;
  let falseFail = 0;
  let falsePass = 0;
  let exact = 0;
  let totalDistance = 0;

  for (const { predicted, actual } of predictions) {
    confusion.get(actual)!.set(predicted, confusion.get(actual)!.get(predicted)! + 1);
    if (predicted === actual) exact++;
    totalDistance += distance(predicted, actual);

    const shouldBuy = isUsable(actual);
    const wouldBuy = isUsable(predicted);
    if (shouldBuy && wouldBuy) truePass++;
    else if (!shouldBuy && !wouldBuy) trueFail++;
    else if (shouldBuy && !wouldBuy) falseFail++;
    else falsePass++;
  }

  const n = predictions.length;
  const usableActual = truePass + falseFail;
  const unusableActual = trueFail + falsePass;

  return {
    n,
    truePass,
    trueFail,
    falseFail,
    falsePass,
    falseFailRate: usableActual ? falseFail / usableActual : 0,
    falsePassRate: unusableActual ? falsePass / unusableActual : 0,
    usableAccuracy: n ? (truePass + trueFail) / n : 0,
    exactMatch: n ? exact / n : 0,
    meanDistance: n ? totalDistance / n : 0,
    confusion,
  };
}

export function formatScores(label: string, scores: Scores): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `── ${label} ${"─".repeat(Math.max(0, 46 - label.length))}`,
    `  sites scored          ${scores.n}`,
    `  buy-decision accuracy ${pct(scores.usableAccuracy)}`,
    `  false fails           ${scores.falseFail}  (${pct(scores.falseFailRate)} of usable sites discarded)`,
    `  false passes          ${scores.falsePass}  (${pct(scores.falsePassRate)} of bad sites approved)`,
    `  exact label match     ${pct(scores.exactMatch)}`,
    `  mean label distance   ${scores.meanDistance.toFixed(2)}`,
    "",
    `  confusion (rows = reviewer, cols = tool)`,
    `${" ".repeat(16)}${VERDICTS.map((v) => v.slice(0, 6).padStart(7)).join("")}`,
  ];

  for (const actual of VERDICTS) {
    const row = VERDICTS.map((predicted) =>
      String(scores.confusion.get(actual)!.get(predicted)!).padStart(7),
    ).join("");
    lines.push(`  ${actual.padEnd(14)}${row}`);
  }

  return lines.join("\n");
}
