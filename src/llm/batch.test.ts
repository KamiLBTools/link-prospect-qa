import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { submitBatch } from "./batch";

/** Never reached by these tests: every case must be rejected before the call. */
const client = {
  messages: {
    batches: {
      create: () => {
        throw new Error("submitBatch called the API when it should have refused");
      },
    },
  },
} as unknown as Anthropic;

const request = (customId: string) => ({
  customId,
  params: {} as Anthropic.MessageCreateParamsNonStreaming,
});

describe("submitBatch custom_id validation", () => {
  it("refuses a domain, which is the id everyone reaches for first", async () => {
    // The regression. custom_id must match ^[a-zA-Z0-9_-]{1,64}$ and every
    // domain contains a dot, so this cost a whole 6,000-site submission the
    // first time it was tried.
    await assert.rejects(
      () => submitBatch(client, [request("abruzzoweb.it")]),
      /custom_id.*abruzzoweb\.it/s,
    );
  });

  it("refuses an id longer than 64 characters", async () => {
    await assert.rejects(() => submitBatch(client, [request("a".repeat(65))]), /custom_id/);
  });

  it("refuses duplicates, which collapse silently in the results", async () => {
    await assert.rejects(
      () => submitBatch(client, [request("s1"), request("s1")]),
      /unique/,
    );
  });

  it("names how many are wrong, not just the first", async () => {
    await assert.rejects(
      () => submitBatch(client, [request("a.com"), request("b.com"), request("ok")]),
      /^Error: 2 custom_id/,
    );
  });
});
