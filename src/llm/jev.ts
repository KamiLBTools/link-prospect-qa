import type { Verdict } from "../domain/verdict";
import { judgeSystemPrompt } from "./judge";

/**
 * Jev, TypeSafe's classifier: the judge's rubric as instructions, one Choice
 * over the five verdicts, and a confidence instead of a reason.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const CRITERIA: Record<Verdict, string> = {
  excellent:
    "A genuinely good site: real audience, real content, keywords a real publication would rank for.",
  good: "A solid site worth buying from.",
  meh: "A real site with real content that is simply unremarkable. Worth buying only if cheap. Not a hedge for uncertainty.",
  bad: "The traffic is real but worthless: genuine visitors on keywords nobody competes for. Do not buy.",
  manipulation: "The traffic is manufactured, not real readership. Do not buy.",
};

/**
 * The same judgement as one yes/no. Jev is built for simple decisions, and the
 * five-way choice is where it collapses: 540 of 632 PEPO sites came back
 * `good`, and one `meh`.
 */
export const BUY_CRITERIA = {
  buy: "Worth buying a link on: a real site with a real audience and genuine content — including an unremarkable one that is only worth it at the right price.",
  dont_buy:
    "Not worth buying: traffic that is real but worthless (keywords nobody competes for, nothing earned from them), or traffic that is manufactured rather than real readership.",
};

export interface JevAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export async function askJev(
  state: string,
  apiKey: string,
  criteria: Record<string, string> = CRITERIA,
): Promise<JevAnswer> {
  const answers = await askJevQuestions(state, apiKey, { verdict: choice(criteria) });
  return answers.verdict as JevAnswer;
}

/**
 * Both questions in one request: the yes/no, whose confidence is the more
 * decisive one to route on, and the five-way verdict the output needs.
 */
export async function askJevBoth(
  state: string,
  apiKey: string,
): Promise<{ verdict: JevAnswer; buy: JevAnswer }> {
  const answers = await askJevQuestions(state, apiKey, {
    verdict: choice(CRITERIA),
    buy: choice(BUY_CRITERIA),
  });
  return { verdict: answers.verdict as JevAnswer, buy: answers.buy as JevAnswer };
}

/**
 * The reviewer's own rejection reasons, one narrow yes/no each. Jev answers
 * narrow questions well and the single buy / don't buy poorly; a model trained
 * on the reviewer's labels decides how much each answer counts.
 *
 * Every question is phrased so that yes is the warning sign, except
 * `real_publication`, which is the one reason to buy.
 */
export const SIGNALS = {
  celebrity:
    "Are most of the top keywords about celebrities or famous people: net worth, age, height, spouses, children or biographies?",
  tools:
    "Are most of the top keywords about online tools, converters, downloaders, generators, calculators or software and APK downloads?",
  streaming:
    "Are most of the top keywords about streaming, where to watch, free movies, TV, anime or sports streams, or piracy?",
  vice: "Are many of the top keywords about adult content, horoscopes, dream meanings, numerology, gambling or casinos?",
  off_niche:
    "Do most of the top keywords fall outside the topic the site describes itself as covering?",
  scattered:
    "Are the top keywords scattered across many unrelated topics, with no coherent theme a real publication would have?",
  homepage_only:
    "Does almost all the traffic land on the homepage or come from searches for the site's own name, with little traffic reaching articles?",
  real_publication:
    "Does this look like a real publication with editorial content written for a real audience, rather than pages produced to capture search traffic?",
} as const;

export type Signals = Record<keyof typeof SIGNALS, number>;

/** Every signal in one request. Each value is Jev's probability of yes. */
export async function askJevSignals(state: string, apiKey: string): Promise<Signals> {
  const answers = await askJevQuestions(
    state,
    apiKey,
    Object.fromEntries(
      Object.entries(SIGNALS).map(([id, instructions]) => [id, { type: "noul", instructions }]),
    ),
  );
  return Object.fromEntries(
    Object.keys(SIGNALS).map((id) => [id, (answers[id] as { noul: number }).noul]),
  ) as Signals;
}

/** A Choice question carrying the judge's rubric as its instructions. */
function choice(criteria: Record<string, string>) {
  return { type: "choice", instructions: judgeSystemPrompt(), criteria };
}

async function askJevQuestions(
  state: string,
  apiKey: string,
  questions: Record<string, object>,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ model: "jev-latest", state, questions });

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
    });
    if ((response.status === 429 || response.status === 529) && attempt < 6) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const json = (await response.json()) as { answers: Record<string, unknown> };
    return json.answers;
  }
}
