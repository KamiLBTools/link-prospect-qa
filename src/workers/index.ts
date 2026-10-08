import cron from "node-cron";
import { db } from "../db/client";
import { AhrefsClient } from "../ahrefs/ahrefsClient";
import { anthropic } from "../llm/client";
import type { StageContext } from "../pipeline/stages";
import { advanceRun, claimRuns } from "./runWorker";

/** Worker entry point. Its own process, never inside a request. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const context: StageContext = {
  db,
  metrics: new AhrefsClient({ apiKey: required("AHREFS_API_KEY") }),
  anthropic: anthropic(),
  /**
   * Must not look generic. The same host runs Link Monitoring's crawler under
   * Cloudflare's Verified Bots programme, and an anonymous-looking fetcher from
   * this address undermines that application.
   */
  userAgent: required("QA_USER_AGENT"),
  cacheMaxAgeDays: Number(process.env.METRICS_CACHE_DAYS ?? 14),
  concurrency: Number(process.env.FETCH_CONCURRENCY ?? 6),
  jevApiKey: required("JEV_API_KEY"),
};

// Every minute. Stages are long and mostly spent waiting on a batch, so a tick
// usually does nothing but poll — and `noOverlap` keeps a slow tick from
// stacking on the next.
cron.schedule(
  "* * * * *",
  async () => {
    const runIds = await claimRuns(db, 3);
    for (const runId of runIds) {
      await advanceRun(context, runId).catch((error) => {
        console.error(`run ${runId} failed to advance:`, error);
      });
    }
  },
  { noOverlap: true },
);

console.log("qa worker started");
