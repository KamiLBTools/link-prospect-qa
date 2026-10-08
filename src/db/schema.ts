import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ClassifiedPage } from "../domain/topPages";
import type { GateThresholds } from "../domain/gate";

/** The reviewer's own vocabulary. See src/domain/verdict.ts. */
export const verdict = pgEnum("verdict", [
  "manipulation",
  "bad",
  "meh",
  "good",
  "excellent",
]);

/**
 * Where a Site got to. Deliberately separate from `verdict`: `prefail` means we
 * never looked, and collapsing it into `bad` would destroy the ability to
 * re-run a gate rejection after a threshold change without re-paying for the
 * steps beyond the gate.
 */
export const siteStatus = pgEnum("site_status", [
  "pending",
  "prefail",
  "done",
  "error",
]);

/**
 * A Run advances stage by stage rather than each Site holding its own state
 * machine, because two of the stages are inherently batched: Ahrefs takes 100
 * domains per request, and the model calls go through Message Batches.
 */
export const runStage = pgEnum("run_stage", [
  "metrics", // Ahrefs batch analysis + Gate 1
  "fetch", // homepages to markdown
  "extract", // model batch: describe each Site
  "toppages", // Ahrefs top pages for survivors
  "judge", // model batch: the verdict
  "done",
  "failed",
]);

/** Batch is half price and asynchronous; standard is for a short urgent list. */
export const serviceTier = pgEnum("service_tier", ["batch", "standard"]);

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),

  stage: runStage("stage").notNull().default("metrics"),
  serviceTier: serviceTier("service_tier").notNull().default("batch"),
  /** Snapshotted, not referenced: a Run's verdicts must stay explainable after
   *  the defaults change. */
  thresholds: jsonb("thresholds").$type<GateThresholds>().notNull(),

  /** Anthropic batch handles, so a restarted worker rejoins rather than resubmits. */
  extractBatchId: text("extract_batch_id"),
  judgeBatchId: text("judge_batch_id"),

  inputCount: integer("input_count").notNull().default(0),
  /** Lines that never became a Site, kept so the count reconciles on screen. */
  rejectedInputs: jsonb("rejected_inputs").$type<{ input: string; reason: string }[]>(),
  /** Metered from Ahrefs' own response headers, not estimated. */
  ahrefsUnits: integer("ahrefs_units").notNull().default(0),
  error: text("error"),

  /** Lease, so a crashed worker's Run is picked up rather than stranded. */
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
});

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),

    domain: text("domain").notNull(),
    /** Every raw input line that collapsed onto this domain. */
    inputs: jsonb("inputs").$type<string[]>().notNull(),
    status: siteStatus("status").notNull().default("pending"),

    // --- Ahrefs batch analysis, and Gate 1 -------------------------------
    domainRating: integer("domain_rating"),
    organicTraffic: integer("organic_traffic"),
    organicKeywords: integer("organic_keywords"),
    refdomainsDofollow: integer("refdomains_dofollow"),
    linkedDomainsDofollow: integer("linked_domains_dofollow"),
    outInRatio: numeric("out_in_ratio", { precision: 10, scale: 3 }),
    prefailReason: text("prefail_reason"),

    // --- homepage extraction ---------------------------------------------
    fetchError: text("fetch_error"),
    description: text("description"),
    language: text("language"),
    audienceCountry: text("audience_country"),
    siteType: text("site_type"),
    taxonomy: jsonb("taxonomy").$type<string[]>(),
    specificNiche: text("specific_niche"),
    topicBreadth: text("topic_breadth"),
    profileConfidence: numeric("profile_confidence", { precision: 4, scale: 3 }),

    // --- top pages --------------------------------------------------------
    topPages: jsonb("top_pages").$type<ClassifiedPage[]>(),
    coverage: numeric("coverage", { precision: 5, scale: 4 }),
    brandedShare: numeric("branded_share", { precision: 5, scale: 4 }),
    ranksForAlmostNothing: boolean("ranks_for_almost_nothing"),

    // --- judgement --------------------------------------------------------
    verdict: verdict("verdict"),
    /** Before the niche penalty, so a demotion is auditable rather than silent. */
    rawVerdict: verdict("raw_verdict"),
    nicheMismatch: boolean("niche_mismatch"),
    nichePenaltyApplied: boolean("niche_penalty_applied"),
    entityRecognition: text("entity_recognition"),
    entityNote: text("entity_note"),
    reason: text("reason"),

    error: text("error"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),

    /**
     * The reviewer's own verdict, entered after the fact. This is the only
     * source of new regression data, so the column exists from day one — a
     * review loop nobody can record is a review loop that teaches nothing.
     */
    humanVerdict: verdict("human_verdict"),
    humanReason: text("human_reason"),
  },
  (t) => [
    // One row per domain per run: re-running a list must not duplicate spend.
    uniqueIndex("sites_run_domain_idx").on(t.runId, t.domain),
    index("sites_run_status_idx").on(t.runId, t.status),
    index("sites_verdict_idx").on(t.verdict),
    // Feeds the cache below.
    index("sites_domain_checked_idx").on(t.domain, t.checkedAt),
  ],
);

/**
 * Ahrefs results, cached across Runs.
 *
 * A domain that appeared in last week's list costs 18 units to re-measure and
 * 130 to re-read its top pages. Publishers do not change fast enough to justify
 * that, so a Run reuses anything recent and pays only for what it has not seen.
 */
export const metricsCache = pgTable(
  "metrics_cache",
  {
    domain: text("domain").primaryKey(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    domainRating: integer("domain_rating"),
    organicTraffic: integer("organic_traffic"),
    organicKeywords: integer("organic_keywords"),
    refdomainsDofollow: integer("refdomains_dofollow"),
    linkedDomainsDofollow: integer("linked_domains_dofollow"),
    /** Null until the domain survives a gate and its top pages are bought. */
    topPages: jsonb("top_pages").$type<
      { url: string; traffic: number; topKeyword: string }[]
    >(),
    topPagesFetchedAt: timestamp("top_pages_fetched_at", { withTimezone: true }),
  },
  (t) => [index("metrics_cache_fetched_idx").on(t.fetchedAt)],
);
