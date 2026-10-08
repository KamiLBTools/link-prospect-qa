import pLimit from "p-limit";
import { isVerdict } from "../domain/verdict";
import { askJev, type JevAnswer } from "../llm/jev";
import { judgeUserPrompt, type JudgeInput } from "../llm/judge";
import { finalise, type JudgedSite } from "./judgeSite";

/**
 * Jev first, the judge only where Jev is unsure.
 *
 * Measured on the reviewer's 632 PEPO labels (src/eval/compare.ts), buy-decision
 * agreement against the share of Sites sent to the judge:
 *
 *   threshold   agreement   to judge
 *   0.50        90.7%       38%
 *   0.65        91.5%       72%     <- the reviewer's choice: quality first
 *   judge only  91.6%       100%
 *
 * 0.5 was fixed before the held-out split was scored; 0.65 was chosen after
 * seeing these figures, so its 91.5% is not a held-out number.
 *
 * What a Jev-decided Site does not have: a written reason, a niche observation
 * or an entity check. Its reason says so, so nobody mistakes it for a judged one.
 */
export const JEV_THRESHOLD = Number(process.env.JEV_THRESHOLD ?? 0.65);

/** Jev's answer as a verdict of record, or null to send the Site to the judge. */
export function jevDecision(
  answer: JevAnswer,
  siteType: string,
  contributorSolicitation: string | null | undefined,
): JudgedSite | null {
  if (answer.confidence < JEV_THRESHOLD || !isVerdict(answer.choice)) return null;
  return finalise(
    {
      verdict: answer.choice,
      // Jev was never asked, and "no" is the value that applies no penalty.
      nicheMismatch: false,
      entityRecognition: "unknown",
      entityNote: "",
      reason: `Decided by Jev at confidence ${answer.confidence.toFixed(2)}; not reviewed by the judge.`,
    },
    siteType,
    contributorSolicitation,
  );
}

export interface Triage<K> {
  decided: Map<K, JudgedSite>;
  /** Everything Jev was unsure of, or failed on: the judge's work. */
  escalated: Map<K, JudgeInput>;
}

/**
 * Asks Jev about every Site. A failed call escalates rather than drops the
 * Site: the judge is the fallback, so Jev being down costs money, not verdicts.
 */
export async function triage<K>(inputs: Map<K, JudgeInput>, apiKey: string): Promise<Triage<K>> {
  const limit = pLimit(Number(process.env.JEV_CONCURRENCY ?? 4));
  const decided = new Map<K, JudgedSite>();
  const escalated = new Map<K, JudgeInput>();
  let failed = 0;

  await Promise.all(
    [...inputs].map(([key, input]) =>
      limit(async () => {
        try {
          const answer = await askJev(judgeUserPrompt(input), apiKey);
          const decision = jevDecision(answer, input.profile.siteType, input.contributorSolicitation);
          if (decision) decided.set(key, decision);
          else escalated.set(key, input);
        } catch {
          failed++;
          escalated.set(key, input);
        }
      }),
    ),
  );

  console.log(
    `Jev decided ${decided.size} of ${inputs.size}; ${escalated.size} go to the judge` +
      (failed ? ` (${failed} of them because the Jev call failed).` : "."),
  );
  return { decided, escalated };
}
