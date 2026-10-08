/**
 * One JSON answer from a cheap open model. Every provider here speaks the
 * OpenAI chat API, so one client covers them:
 *
 *   CHEAP_PROVIDER=groq      CHEAP_MODEL=openai/gpt-oss-20b
 *   CHEAP_PROVIDER=deepseek  CHEAP_MODEL=deepseek-chat      (servers in China)
 *
 * JSON mode only. Groq's strict schema mode validates after generating rather
 * than constraining the tokens, so it turns a slightly-off answer into an
 * error; callers check the answer themselves and retry instead.
 */

const PROVIDERS = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", model: "openai/gpt-oss-20b" },
  deepseek: { baseUrl: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
} as const;

export const CHEAP_PROVIDER = (process.env.CHEAP_PROVIDER ?? "groq") as keyof typeof PROVIDERS;
const provider = PROVIDERS[CHEAP_PROVIDER];
if (!provider) throw new Error(`CHEAP_PROVIDER must be one of ${Object.keys(PROVIDERS).join(", ")}`);

export const CHEAP_MODEL = process.env.CHEAP_MODEL ?? provider.model;

export interface Usage {
  input: number;
  cachedInput: number;
  output: number;
}

/** gpt-oss cannot switch reasoning off, only keep it short; Qwen 3 can. */
function reasoning(model: string): object {
  if (model.startsWith("qwen/")) return { reasoning_effort: "none" };
  if (model.startsWith("openai/gpt-oss")) return { reasoning_effort: "low" };
  return {};
}

/**
 * The parsed JSON answer, or a string saying why there was none. Rate limits
 * wait; they are never counted as a failed answer. Token usage is added to
 * `usage`, so a caller that retries sees the whole cost.
 */
export async function chatJson(
  system: string,
  user: string,
  options: { temperature: number; model?: string },
  usage: Usage,
): Promise<{ json: unknown } | string> {
  const apiKey = process.env[provider.keyEnv];
  if (!apiKey) throw new Error(`${provider.keyEnv} is not set`);
  const model = options.model ?? CHEAP_MODEL;
  const body = JSON.stringify({
    model,
    max_tokens: 4_000,
    temperature: options.temperature,
    response_format: { type: "json_object" },
    ...reasoning(model),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  for (let wait = 0; ; wait++) {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
    });
    if ((response.status === 429 || response.status >= 500) && wait < 30) {
      // Groq says how long to wait; otherwise back off exponentially, capped.
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** wait)));
      continue;
    }
    // A 400 here is Groq rejecting malformed JSON: worth another try, not a crash.
    if (response.status === 400) return `HTTP 400: ${(await response.text()).slice(0, 300)}`;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);

    const json = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_cache_hit_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    usage.input += json.usage.prompt_tokens;
    usage.cachedInput += json.usage.prompt_cache_hit_tokens ?? json.usage.prompt_tokens_details?.cached_tokens ?? 0;
    usage.output += json.usage.completion_tokens;
    try {
      return { json: JSON.parse(json.choices[0]!.message.content) };
    } catch {
      return "unparsable JSON";
    }
  }
}
