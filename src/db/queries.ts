import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { runs, sites } from "./schema";
import { DEFAULT_THRESHOLDS, type GateThresholds } from "../domain/gate";
import { parseSiteList } from "../domain/site";

/** Creates a Run and its Sites from whatever the user pasted. */
export async function createRun(
  db: Db,
  input: { text: string; label?: string; thresholds?: GateThresholds },
): Promise<{ runId: string; siteCount: number; rejected: number }> {
  const parsed = parseSiteList(input.text);
  if (parsed.sites.length === 0) {
    throw new Error("No usable domains in that list.");
  }

  const [run] = await db
    .insert(runs)
    .values({
      label: input.label?.trim() || null,
      // Snapshotted deliberately: a Run's verdicts must stay explainable after
      // someone edits the defaults.
      thresholds: input.thresholds ?? DEFAULT_THRESHOLDS,
      inputCount: parsed.sites.length,
      rejectedInputs: parsed.rejected,
    })
    .returning({ id: runs.id });

  const runId = run!.id;

  await db.insert(sites).values(
    parsed.sites.map((site) => ({
      runId,
      domain: site.domain,
      inputs: site.inputs,
    })),
  );

  return {
    runId,
    siteCount: parsed.sites.length,
    rejected: parsed.rejected.length,
  };
}

export async function listRuns(db: Db, limit = 30) {
  return db
    .select({
      id: runs.id,
      label: runs.label,
      createdAt: runs.createdAt,
      finishedAt: runs.finishedAt,
      stage: runs.stage,
      inputCount: runs.inputCount,
      ahrefsUnits: runs.ahrefsUnits,
      error: runs.error,
      done: sql<number>`count(*) filter (where ${sites.status} = 'done')`,
      prefailed: sql<number>`count(*) filter (where ${sites.status} = 'prefail')`,
      errored: sql<number>`count(*) filter (where ${sites.status} = 'error')`,
      usable: sql<number>`count(*) filter (where ${sites.verdict} in ('meh','good','excellent'))`,
    })
    .from(runs)
    .leftJoin(sites, eq(sites.runId, runs.id))
    .groupBy(runs.id)
    .orderBy(desc(runs.createdAt))
    .limit(limit);
}

export type RunSummary = Awaited<ReturnType<typeof listRuns>>[number];

export interface SiteFilters {
  verdict?: string;
  status?: string;
  q?: string;
}

export async function listSites(db: Db, runId: string, filters: SiteFilters = {}) {
  const conditions = [eq(sites.runId, runId)];

  // Guarded against the enum, not passed through. An unknown value from a
  // stale bookmark must drop out of the query rather than reach Postgres,
  // where it either errors or silently matches nothing.
  const VERDICTS = ["manipulation", "bad", "meh", "good", "excellent"] as const;
  const STATUSES = ["pending", "prefail", "done", "error"] as const;

  const verdict = VERDICTS.find((value) => value === filters.verdict);
  if (verdict) conditions.push(eq(sites.verdict, verdict));

  const status = STATUSES.find((value) => value === filters.status);
  if (status) conditions.push(eq(sites.status, status));

  const q = filters.q?.trim();
  if (q) conditions.push(sql`${sites.domain} ilike ${`%${q}%`}`);

  return db
    .select()
    .from(sites)
    .where(and(...conditions))
    .orderBy(sites.domain);
}

export async function getRun(db: Db, runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  return run ?? null;
}

/**
 * Records the reviewer's own verdict on a Site.
 *
 * This is the only way new regression data enters the system, so it is a
 * first-class write rather than a note field.
 */
export async function recordHumanVerdict(
  db: Db,
  siteId: string,
  verdict: "manipulation" | "bad" | "meh" | "good" | "excellent",
  reason: string,
): Promise<void> {
  await db
    .update(sites)
    .set({ humanVerdict: verdict, humanReason: reason.trim() || null })
    .where(eq(sites.id, siteId));
}
