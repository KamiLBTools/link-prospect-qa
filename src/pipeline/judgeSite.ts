import type Anthropic from "@anthropic-ai/sdk";
import { buildJudgeRequest, type JudgeInput, type Judgement } from "../llm/judge";
import {
  applyNichePenalty,
  applySolicitationCap,
  type Verdict,
} from "../domain/verdict";

/**
 * One judgement, with the niche penalty applied afterwards in code.
 *
 * The split is deliberate. The model is asked to *observe* whether the traffic
 * drifts from what the site claims to be; the cost of that drift is arithmetic
 * the model never performs. A bound the model is merely asked to respect is not
 * a bound, and this particular bound is the guard against the failure that
 * defined the previous tool: it failed 142 sites and the reviewer judged 105 of
 * them usable, with topical fit named as the reason on 39.
 */

export interface JudgedSite {
  /** After the niche penalty. This is the verdict of record. */
  verdict: Verdict;
  /** Before the penalty, kept so a demotion is auditable rather than invisible. */
  rawVerdict: Verdict;
  nicheMismatch: boolean;
  nichePenaltyApplied: boolean;
  /** The matched link, null if none was found, undefined if never inspected. */
  contributorSolicitation: string | null | undefined;
  /** True when that link is what held the verdict down. */
  solicitationCapApplied: boolean;
  entityRecognition: "recognised" | "unknown";
  entityNote: string;
  reason: string;
}

export async function judgeSite(
  client: Anthropic,
  input: JudgeInput,
): Promise<JudgedSite> {
  const response = await client.messages.parse(buildJudgeRequest(input));

  const parsed = response.parsed_output as Judgement | null;
  if (!parsed) {
    // Structured output is constrained decoding, so this is rare — but a
    // silent null here would become a verdict-shaped hole in the export.
    throw new Error(
      `judge returned no parsable output for ${input.domain} (stop_reason: ${response.stop_reason})`,
    );
  }

  return finalise(parsed, input.profile.siteType, input.contributorSolicitation);
}

/** Pure, so the penalty interaction is testable without an API call. */
export function finalise(
  judgement: Judgement,
  siteType: string,
  contributorSolicitation: string | null | undefined = undefined,
): JudgedSite {
  const isNewsOrMagazine = siteType === "news" || siteType === "magazine";
  const afterNiche = applyNichePenalty(judgement.verdict, {
    nicheMismatch: judgement.nicheMismatch,
    isNewsOrMagazine,
  });
  // The cap runs last so that it is a ceiling on the final answer rather than
  // on an intermediate one, and so the two rules cannot compound into a
  // two-step demotion neither of them asked for.
  // `!= null` rather than `!== null`: an uninspected homepage must never cap
  // a verdict, and undefined is exactly that case.
  const verdict = applySolicitationCap(afterNiche, contributorSolicitation != null);

  return {
    verdict,
    rawVerdict: judgement.verdict,
    nicheMismatch: judgement.nicheMismatch,
    nichePenaltyApplied: afterNiche !== judgement.verdict,
    contributorSolicitation,
    solicitationCapApplied: verdict !== afterNiche,
    entityRecognition: judgement.entityRecognition,
    entityNote: judgement.entityNote,
    reason: judgement.reason,
  };
}
