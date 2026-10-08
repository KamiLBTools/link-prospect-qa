import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { runs, sites } from "../db/schema";
import {
  stageExtract,
  stageFetch,
  stageJudge,
  stageMetrics,
  stageTopPages,
  type StageContext,
} from "../pipeline/stages";

/**
 * Advances one Run by one stage.
 *
 * Each stage is idempotent and reads its starting point from the database, so a
 * crash costs at most the work in flight. That matters unevenly: re-fetching a
 * homepage costs seconds, re-buying a top-pages report costs 130 Ahrefs units,
 * and re-submitting a model batch costs the whole batch. The two expensive ones
 * are protected by the metrics cache and by storing the batch id before
 * anything else happens.
 */
export async function advanceRun(
  context: StageContext,
  runId: string,
): Promise<void> {
  const [run] = await context.db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return;

  try {
    switch (run.stage) {
      case "metrics": {
        await stageMetrics(context, runId, run.thresholds);
        await setStage(context.db, runId, "fetch");
        return;
      }

      case "fetch": {
        const batchId = await stageFetch(context, runId);
        // Store the handle before advancing: a crash between submit and write
        // would otherwise orphan a paid batch and start another.
        await context.db
          .update(runs)
          .set({ extractBatchId: batchId, stage: batchId ? "extract" : "toppages" })
          .where(eq(runs.id, runId));
        return;
      }

      case "extract": {
        if (!run.extractBatchId) {
          await setStage(context.db, runId, "toppages");
          return;
        }
        const finished = await stageExtract(context, run.extractBatchId);
        if (finished) await setStage(context.db, runId, "toppages");
        return;
      }

      case "toppages": {
        const batchId = await stageTopPages(context, runId);
        await context.db
          .update(runs)
          .set({ judgeBatchId: batchId, stage: batchId ? "judge" : "done" })
          .where(eq(runs.id, runId));
        if (!batchId) await finish(context.db, runId);
        return;
      }

      case "judge": {
        if (!run.judgeBatchId) {
          await setStage(context.db, runId, "done");
          await finish(context.db, runId);
          return;
        }
        const finished = await stageJudge(context, run.judgeBatchId);
        if (finished) {
          await setStage(context.db, runId, "done");
          await finish(context.db, runId);
        }
        return;
      }

      case "done":
      case "failed":
        return;
    }
  } catch (error) {
    // A failed Run keeps every verdict it already produced. Nothing is rolled
    // back, because the spend is not recoverable and partial results are still
    // worth reading.
    await context.db
      .update(runs)
      .set({
        stage: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));
  }
}

async function setStage(
  db: Db,
  runId: string,
  stage: "metrics" | "fetch" | "extract" | "toppages" | "judge" | "done" | "failed",
): Promise<void> {
  await db.update(runs).set({ stage }).where(eq(runs.id, runId));
}

/**
 * Anything still `pending` when the Run ends never reached a verdict — a site
 * whose homepage was fetched but whose batch entry vanished, say. It is marked
 * `error` rather than left looking unfinished forever.
 */
async function finish(db: Db, runId: string): Promise<void> {
  await db
    .update(sites)
    .set({
      status: "error",
      error: "run finished without a verdict for this site",
      checkedAt: new Date(),
    })
    .where(and(eq(sites.runId, runId), eq(sites.status, "pending")));

  await db.update(runs).set({ finishedAt: new Date() }).where(eq(runs.id, runId));
}

/**
 * Claims Runs that are not finished and not already held by another worker.
 *
 * The lease is the part that must not be skimped: without the sweep, a crashed
 * worker holds a Run forever and it silently stops advancing. Stages are long
 * (a model batch can take an hour), so the lease is generous.
 */
const LEASE_MINUTES = 30;

export async function claimRuns(db: Db, limit: number): Promise<string[]> {
  const { rows } = await db.execute(sql`
    UPDATE runs SET lease_expires_at = now() + ${`${LEASE_MINUTES} minutes`}::interval
    WHERE id IN (
      SELECT id FROM runs
      WHERE stage NOT IN ('done', 'failed')
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  return (rows as { id: string }[]).map((row) => row.id);
}
