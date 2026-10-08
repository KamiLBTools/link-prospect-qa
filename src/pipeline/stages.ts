import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import pLimit from "p-limit";
import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db/client";
import { metricsCache, runs, sites } from "../db/schema";
import { applyGate, type GateThresholds } from "../domain/gate";
import { summariseTopPages, type TopPage } from "../domain/topPages";
import { fetchHomepage } from "../crawl/fetchHomepage";
import { buildExtractionRequest, SiteProfile } from "../llm/extract";
import { buildJudgeRequest, type JudgeInput } from "../llm/judge";
import { Judgement } from "../llm/judge";
import { collectBatch, jsonFromMessage, pollBatch, submitBatch } from "../llm/batch";
import { finalise, type JudgedSite } from "./judgeSite";
import { triage } from "./triage";
import type { MetricsProvider } from "../ahrefs/types";

/**
 * A Run advances one stage per worker tick. Each stage is idempotent and picks
 * up from what is already in the database, so a crash costs at most the work in
 * flight — never a duplicated Ahrefs charge or a duplicated batch.
 */

export interface StageContext {
  db: Db;
  metrics: MetricsProvider;
  anthropic: Anthropic;
  userAgent: string;
  /** How long an Ahrefs result stays good. Publishers do not move fast. */
  cacheMaxAgeDays: number;
  concurrency: number;
  /** Jev decides first; the judge batch holds only what it was unsure of. */
  jevApiKey: string;
}

const TOP_PAGE_LIMIT = 10;

/** Ahrefs batch analysis, the metrics cache, and Gate 1. */
export async function stageMetrics(
  context: StageContext,
  runId: string,
  thresholds: GateThresholds,
): Promise<void> {
  const pending = await context.db
    .select({ id: sites.id, domain: sites.domain })
    .from(sites)
    .where(and(eq(sites.runId, runId), eq(sites.status, "pending")));
  if (pending.length === 0) return;

  const fresh = cutoff(context.cacheMaxAgeDays);
  const cached = new Map(
    (
      await context.db
        .select()
        .from(metricsCache)
        .where(
          and(
            inArray(metricsCache.domain, pending.map((site) => site.domain)),
            gte(metricsCache.fetchedAt, fresh),
          ),
        )
    ).map((row) => [row.domain, row]),
  );

  const missing = pending
    .map((site) => site.domain)
    .filter((domain) => !cached.has(domain));

  const measured = missing.length
    ? await context.metrics.batchAnalysis(missing)
    : new Map();

  for (const [domain, row] of measured) {
    await context.db
      .insert(metricsCache)
      .values({ domain, ...row, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: metricsCache.domain,
        set: { ...row, fetchedAt: new Date() },
      });
  }

  for (const site of pending) {
    const row = measured.get(site.domain) ?? cached.get(site.domain);
    const metrics = {
      domainRating: row?.domainRating ?? null,
      organicTraffic: row?.organicTraffic ?? null,
      organicKeywords: row?.organicKeywords ?? null,
      refdomainsDofollow: row?.refdomainsDofollow ?? null,
      linkedDomainsDofollow: row?.linkedDomainsDofollow ?? null,
    };
    const outcome = applyGate(metrics, thresholds);

    await context.db
      .update(sites)
      .set({
        ...metrics,
        outInRatio: outcome.outInRatio?.toFixed(3) ?? null,
        status: outcome.pass ? "pending" : "prefail",
        prefailReason: outcome.pass ? null : outcome.reason,
        checkedAt: outcome.pass ? null : new Date(),
      })
      .where(eq(sites.id, site.id));
  }

  await recordUnits(context, runId);
}

/**
 * Homepages to markdown, then one extraction batch.
 *
 * The markdown is never stored. It is used once, and re-fetching after a crash
 * costs time rather than money — unlike everything else in this pipeline.
 */
export async function stageFetch(
  context: StageContext,
  runId: string,
): Promise<string | null> {
  const survivors = await context.db
    .select({ id: sites.id, domain: sites.domain })
    .from(sites)
    .where(and(eq(sites.runId, runId), eq(sites.status, "pending")));
  if (survivors.length === 0) return null;

  const limit = pLimit(context.concurrency);
  const requests: { customId: string; params: ReturnType<typeof buildExtractionRequest> }[] = [];

  await Promise.all(
    survivors.map((site) =>
      limit(async () => {
        const outcome = await fetchHomepage(site.domain, {
          userAgent: context.userAgent,
        });

        if (outcome.kind === "failed") {
          // Unfetched, not judged. A site we could not read never gets a
          // verdict invented for it from its domain name.
          await context.db
            .update(sites)
            .set({
              status: "error",
              fetchError: outcome.reason,
              checkedAt: new Date(),
            })
            .where(eq(sites.id, site.id));
          return;
        }

        requests.push({
          customId: site.id,
          params: buildExtractionRequest({
            domain: site.domain,
            title: outcome.title,
            markdown: outcome.markdown,
          }),
        });
      }),
    ),
  );

  if (requests.length === 0) return null;
  return submitBatch(context.anthropic, requests);
}

/** Collects the extraction batch. Returns false while it is still running. */
export async function stageExtract(
  context: StageContext,
  batchId: string,
): Promise<boolean> {
  const state = await pollBatch(context.anthropic, batchId);
  if (!state.done) return false;

  const { parsed, errors } = await collectBatch(
    context.anthropic,
    batchId,
    (message) => SiteProfile.parse(jsonFromMessage(message)),
  );

  for (const [siteId, profile] of parsed) {
    await context.db
      .update(sites)
      .set({
        description: profile.description,
        language: profile.language,
        audienceCountry: profile.audienceCountry,
        siteType: profile.siteType,
        taxonomy: profile.taxonomy,
        specificNiche: profile.specificNiche,
        topicBreadth: profile.topicBreadth,
        profileConfidence: profile.confidence.toFixed(3),
      })
      .where(eq(sites.id, siteId));
  }

  for (const [siteId, message] of errors) {
    await context.db
      .update(sites)
      .set({ status: "error", error: `extraction: ${message}`, checkedAt: new Date() })
      .where(eq(sites.id, siteId));
  }

  return true;
}

/** Ahrefs top pages for everything that got a profile, then Jev, then the judge batch. */
export async function stageTopPages(
  context: StageContext,
  runId: string,
): Promise<string | null> {
  const ready = await context.db
    .select()
    .from(sites)
    .where(
      and(
        eq(sites.runId, runId),
        eq(sites.status, "pending"),
        isNotNull(sites.description),
      ),
    );
  if (ready.length === 0) return null;

  const fresh = cutoff(context.cacheMaxAgeDays);
  const inputs = new Map<string, JudgeInput>();

  // Sequential: Ahrefs paces itself internally and the top-pages call is the
  // expensive one, so there is nothing to gain from racing it.
  for (const site of ready) {
    let pages: TopPage[];
    const [cachedRow] = await context.db
      .select()
      .from(metricsCache)
      .where(eq(metricsCache.domain, site.domain));

    if (
      cachedRow?.topPages &&
      cachedRow.topPagesFetchedAt &&
      cachedRow.topPagesFetchedAt >= fresh
    ) {
      pages = cachedRow.topPages;
    } else {
      try {
        pages = await context.metrics.topPages(site.domain, TOP_PAGE_LIMIT);
      } catch (error) {
        await context.db
          .update(sites)
          .set({
            status: "error",
            error: `top pages: ${error instanceof Error ? error.message : String(error)}`,
            checkedAt: new Date(),
          })
          .where(eq(sites.id, site.id));
        continue;
      }
      await context.db
        .update(metricsCache)
        .set({ topPages: pages, topPagesFetchedAt: new Date() })
        .where(eq(metricsCache.domain, site.domain));
    }

    const summary = summariseTopPages(pages, site.domain, site.organicTraffic);

    await context.db
      .update(sites)
      .set({
        topPages: summary.pages,
        coverage: summary.coverage.toFixed(4),
        brandedShare: summary.brandedShare.toFixed(4),
        ranksForAlmostNothing: summary.ranksForAlmostNothing,
      })
      .where(eq(sites.id, site.id));

    inputs.set(site.id, {
      domain: site.domain,
      profile: {
        description: site.description ?? "",
        language: site.language ?? "en",
        audienceCountry: site.audienceCountry,
        siteType: (site.siteType ?? "other") as SiteProfile["siteType"],
        taxonomy: site.taxonomy ?? [],
        specificNiche: site.specificNiche ?? "",
        topicBreadth: (site.topicBreadth ?? "broad") as SiteProfile["topicBreadth"],
        confidence: Number(site.profileConfidence ?? 0.5),
      },
      // The database has no column for the homepage's solicitation link yet,
      // so this path cannot report one either way. Undefined says exactly
      // that; null would assert an absence nobody checked for.
      contributorSolicitation: undefined,
      metrics: {
        domainRating: site.domainRating,
        organicTraffic: site.organicTraffic,
        organicKeywords: site.organicKeywords,
        refdomainsDofollow: site.refdomainsDofollow,
        linkedDomainsDofollow: site.linkedDomainsDofollow,
        outInRatio: site.outInRatio === null ? null : Number(site.outInRatio),
      },
      topPages: summary,
    });
  }

  await recordUnits(context, runId);
  if (inputs.size === 0) return null;

  const { decided, escalated } = await triage(inputs, context.jevApiKey);
  for (const [siteId, judged] of decided) await recordVerdict(context, siteId, judged);

  if (escalated.size === 0) return null;
  return submitBatch(
    context.anthropic,
    [...escalated].map(([customId, input]) => ({ customId, params: buildJudgeRequest(input) })),
  );
}

/** Collects the judge batch. Returns false while it is still running. */
export async function stageJudge(
  context: StageContext,
  batchId: string,
): Promise<boolean> {
  const state = await pollBatch(context.anthropic, batchId);
  if (!state.done) return false;

  const { parsed, errors } = await collectBatch(
    context.anthropic,
    batchId,
    (message) => Judgement.parse(jsonFromMessage(message)),
  );

  for (const [siteId, judgement] of parsed) {
    const [row] = await context.db
      .select({ siteType: sites.siteType })
      .from(sites)
      .where(eq(sites.id, siteId));

    // The niche penalty is applied here, in code, never by the model.
    await recordVerdict(context, siteId, finalise(judgement, row?.siteType ?? "other"));
  }

  for (const [siteId, message] of errors) {
    await context.db
      .update(sites)
      .set({ status: "error", error: `judge: ${message}`, checkedAt: new Date() })
      .where(eq(sites.id, siteId));
  }

  return true;
}

/** One verdict of record, whether Jev or the judge reached it. */
async function recordVerdict(context: StageContext, siteId: string, judged: JudgedSite): Promise<void> {
  await context.db
    .update(sites)
    .set({
      status: "done",
      verdict: judged.verdict,
      rawVerdict: judged.rawVerdict,
      nicheMismatch: judged.nicheMismatch,
      nichePenaltyApplied: judged.nichePenaltyApplied,
      entityRecognition: judged.entityRecognition,
      entityNote: judged.entityNote,
      reason: judged.reason,
      checkedAt: new Date(),
    })
    .where(eq(sites.id, siteId));
}

/** Ahrefs meters units in its response headers; this is spend, not an estimate. */
async function recordUnits(context: StageContext, runId: string): Promise<void> {
  await context.db
    .update(runs)
    .set({ ahrefsUnits: sql`${runs.ahrefsUnits} + ${context.metrics.unitsSpent()}` })
    .where(eq(runs.id, runId));
}

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}
