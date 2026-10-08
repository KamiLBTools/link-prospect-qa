import { z } from "zod";
import { isUsable, VERDICTS, type Verdict } from "../domain/verdict";
import { chatJson, type Usage } from "./cheapChat";
import { judgeSystemPrompt, judgeUserPrompt, type JudgeInput } from "./judge";

/**
 * A second opinion on the Sites Jev was unsure of, from the cheap model with
 * the judge's full rubric: every rejection rule agreed with the reviewer
 * (person-query farms, bad vs manipulation, hollow remainders) is in it. The
 * five-way verdict is asked for because that is what the rubric is written
 * around; only buy / don't buy is used.
 */

const CheapVerdict = z.object({
  verdict: z.enum(VERDICTS),
  reason: z.string(),
});

export interface SecondOpinion {
  verdict: Verdict;
  buy: boolean;
  reason: string;
  usage: Usage;
}

function systemPrompt(): string {
  return `${judgeSystemPrompt()}

## Answer

Answer with one JSON object and nothing else:
{"verdict": one of ${VERDICTS.map((v) => `"${v}"`).join(", ")}, "reason": "one or two sentences naming the evidence that decided it"}`;
}

const ATTEMPTS = 3;

export async function secondOpinion(input: JudgeInput, model?: string): Promise<SecondOpinion> {
  const usage: Usage = { input: 0, cachedInput: 0, output: 0 };
  let lastError = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const answer = await chatJson(systemPrompt(), judgeUserPrompt(input), { temperature: attempt === 0 ? 0 : 0.5, model }, usage);
    if (typeof answer === "string") {
      lastError = answer;
      continue;
    }
    const parsed = CheapVerdict.safeParse(answer.json);
    if (parsed.success) {
      return { verdict: parsed.data.verdict, buy: isUsable(parsed.data.verdict), reason: parsed.data.reason, usage };
    }
    lastError = `unparsable answer: ${parsed.error.message.slice(0, 200)}`;
  }
  throw new Error(lastError);
}
