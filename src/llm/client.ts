import Anthropic from "@anthropic-ai/sdk";

/**
 * The two models, and why they are different sizes.
 *
 * Extraction is high volume and mechanical: read a homepage, fill in a schema.
 * Judgement carries every hard call in this system.
 *
 * The judge ran on Opus 5 through the September calibration and moved to
 * Sonnet 5 at the reviewer's instruction. Scored against their 31 labels the
 * two tied on buy-decision accuracy at 93.5%, but Sonnet produced this tool's
 * only false pass — mopoga.net, which they called `manipulation`, came back
 * `meh` — and drifted three approved sites to `meh`, the hedging the rubric is
 * written against. That trade is the reviewer's to make and they made it; the
 * env override below is how it gets re-measured, not re-argued.
 *
 * Both are overridable by environment variable so a cheaper pairing can be
 * *scored* rather than argued about:
 *
 *   JUDGE_MODEL=claude-sonnet-5 npm run calibrate -- --rejudge
 *   npm run calibrate -- --score
 *
 * That costs no Ahrefs units, because --rejudge runs off the cache.
 */
export const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? "claude-haiku-4-5";
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-sonnet-5";

/**
 * One hour, not the five-minute default.
 *
 * Both prompts carry a large fixed prefix — 635 taxonomy paths for the
 * extractor, the rubric for the judge — and both run inside Message Batches,
 * which spread their requests over an unpredictable window. A five-minute
 * entry expires mid-batch and every later request pays full price. The 1-hour
 * TTL doubles the write premium on a single ~6k-token write, which is under a
 * cent, and keeps 800 reads at a tenth of input price.
 */
export const CACHE_TTL = "1h" as const;

/**
 * Eight retries, not the SDK's default of two.
 *
 * Measured: a 193-site eval at concurrency 8 lost 49 sites to HTTP 529
 * `overloaded_error` — a quarter of the run — because two retries are not
 * enough when many requests to the strong model start at once. 529 is a
 * statement about the provider's capacity at that instant, not about the
 * request, so it deserves persistence.
 *
 * The synchronous path is where this bites. Message Batches, which is the
 * production default, absorbs capacity pressure on the server side and did not
 * exhibit it.
 */
const MAX_RETRIES = 8;

export function anthropic(): Anthropic {
  // The SDK resolves credentials itself: ANTHROPIC_API_KEY, then an auth token,
  // then an `ant auth login` profile. Constructing it with an explicit key would
  // break the profile path for no benefit.
  return new Anthropic({ maxRetries: MAX_RETRIES });
}

/**
 * A cached system block.
 *
 * The breakpoint belongs at the end of the *shared* text, never on the request
 * as a whole. Both prompts end in per-site content, so top-level automatic
 * caching would place the marker after that unique tail: every call would write
 * a fresh entry, none would ever be read, and the result is a pure surcharge
 * that looks like caching.
 */
export function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text,
      cache_control: { type: "ephemeral", ttl: CACHE_TTL },
    },
  ];
}
