import type Anthropic from "@anthropic-ai/sdk";

/**
 * Message Batches: half price, asynchronous, and the default here.
 *
 * A QA run is not something anyone watches character by character, so the
 * only cost of batching is latency the user was never spending anyway. Two
 * properties of the API shape this module:
 *
 *  - Results come back in arbitrary order, so everything is keyed by the
 *    `custom_id` we submit. Reading by position is the classic way to give
 *    every site somebody else's verdict.
 *  - A batch id is durable for 29 days. Storing it means a worker restart
 *    rejoins the batch instead of paying for it twice.
 */

export interface BatchRequest {
  customId: string;
  params: Anthropic.MessageCreateParamsNonStreaming;
}

/**
 * What the API will accept as a custom_id.
 *
 * Not a formality. The rejection is a 400 on the *whole submission*, so one
 * malformed id loses every request batched with it — and the obvious id to
 * reach for, a domain, is malformed, because every domain contains a dot.
 * Checked here rather than at each call site so the failure names the offender
 * instead of arriving as an opaque error covering a thousand rows.
 */
const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export async function submitBatch(
  client: Anthropic,
  requests: BatchRequest[],
): Promise<string> {
  const illegal = requests.filter((request) => !CUSTOM_ID.test(request.customId));
  if (illegal.length) {
    throw new Error(
      `${illegal.length} custom_id(s) do not match ${CUSTOM_ID.source}, ` +
        `e.g. "${illegal[0]!.customId}". A domain cannot be a custom_id; map it to an index.`,
    );
  }

  const seen = new Set(requests.map((request) => request.customId));
  if (seen.size !== requests.length) {
    // Duplicates are accepted by the API and then collapse in the results,
    // which reads as sites silently going missing rather than as an error.
    throw new Error(
      `custom_ids must be unique: ${requests.length} requests, ${seen.size} distinct ids`,
    );
  }

  const batch = await client.messages.batches.create({
    requests: requests.map((request) => ({
      custom_id: request.customId,
      params: request.params,
    })),
  });
  return batch.id;
}

export type BatchState =
  | { done: false; processing: number; succeeded: number; errored: number }
  | { done: true };

export async function pollBatch(
  client: Anthropic,
  batchId: string,
): Promise<BatchState> {
  const batch = await client.messages.batches.retrieve(batchId);
  if (batch.processing_status === "ended") return { done: true };
  return {
    done: false,
    processing: batch.request_counts.processing,
    succeeded: batch.request_counts.succeeded,
    errored: batch.request_counts.errored,
  };
}

export interface BatchOutcome<T> {
  parsed: Map<string, T>;
  errors: Map<string, string>;
}

/**
 * Collects a finished batch, keyed by custom_id.
 *
 * `parse` is applied per result rather than relying on `messages.parse`,
 * because the batch API returns raw messages — the SDK's auto-parsing helper
 * only runs on the synchronous path. A result that fails to parse becomes an
 * error for that one site, never a silent absence.
 */
export async function collectBatch<T>(
  client: Anthropic,
  batchId: string,
  parse: (message: Anthropic.Message) => T,
): Promise<BatchOutcome<T>> {
  const parsed = new Map<string, T>();
  const errors = new Map<string, string>();

  for await (const entry of await client.messages.batches.results(batchId)) {
    const id = entry.custom_id;
    if (entry.result.type !== "succeeded") {
      errors.set(id, describeFailure(entry.result));
      continue;
    }
    try {
      parsed.set(id, parse(entry.result.message));
    } catch (error) {
      errors.set(id, error instanceof Error ? error.message : String(error));
    }
  }

  return { parsed, errors };
}

function describeFailure(result: { type: string }): string {
  if (result.type === "errored") {
    const errored = result as { error?: { error?: { message?: string } } };
    return errored.error?.error?.message ?? "errored";
  }
  return result.type; // canceled | expired
}

/**
 * Structured output arrives as ordinary JSON in a text block. Constrained
 * decoding makes it schema-valid, but a refusal or a hit `max_tokens` still
 * yields something unparseable, and that must surface rather than default.
 */
export function jsonFromMessage(message: Anthropic.Message): unknown {
  if (message.stop_reason === "refusal") {
    throw new Error("model declined to answer");
  }
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) {
    throw new Error(`empty response (stop_reason: ${message.stop_reason})`);
  }
  return JSON.parse(text);
}
