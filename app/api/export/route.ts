import { db } from "../../../src/db/client";
import { listSites } from "../../../src/db/queries";

/**
 * CSV export.
 *
 * The column order deliberately mirrors the spreadsheet the reviewer already
 * works in, including the two trailing columns for their own verdict — a run
 * they review by hand comes back as regression data only if there is somewhere
 * obvious to write it.
 */

const COLUMNS = [
  "domain",
  "verdict",
  "raw_verdict",
  "status",
  "dr",
  "traffic",
  "organic_keywords",
  "refdomains_dofollow",
  "linked_domains_dofollow",
  "out_in_ratio",
  "country",
  "language",
  "site_type",
  "description",
  "taxonomy",
  "specific_niche",
  "topic_breadth",
  "niche_mismatch",
  "niche_penalty_applied",
  "entity_recognition",
  "entity_note",
  "coverage",
  "branded_share",
  "ranks_for_almost_nothing",
  "top_pages",
  "reason",
  "prefail_reason",
  "error",
  "checked_at",
  "your_verdict",
  "your_reason",
] as const;

export async function GET(request: Request): Promise<Response> {
  const runId = new URL(request.url).searchParams.get("run");
  if (!runId) return new Response("missing ?run=", { status: 400 });

  const rows = await listSites(db, runId);

  const body = [
    COLUMNS.join(","),
    ...rows.map((site) =>
      [
        site.domain,
        site.verdict,
        site.rawVerdict,
        site.status,
        site.domainRating,
        site.organicTraffic,
        site.organicKeywords,
        site.refdomainsDofollow,
        site.linkedDomainsDofollow,
        site.outInRatio,
        site.audienceCountry,
        site.language,
        site.siteType,
        site.description,
        site.taxonomy?.join(" | "),
        site.specificNiche,
        site.topicBreadth,
        site.nicheMismatch,
        site.nichePenaltyApplied,
        site.entityRecognition,
        site.entityNote,
        site.coverage,
        site.brandedShare,
        site.ranksForAlmostNothing,
        // One cell, one line per page, matching how the reviewer reads them.
        site.topPages
          ?.map((page) => `${page.url} — ${page.traffic} — ${page.topKeyword}`)
          .join("\n"),
        site.reason,
        site.prefailReason,
        site.error,
        site.checkedAt?.toISOString(),
        site.humanVerdict,
        site.humanReason,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\n");

  return new Response(`${body}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="qa-${runId.slice(0, 8)}.csv"`,
    },
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Quote whenever the cell could otherwise break the row. Reasons routinely
  // contain commas and top-page cells contain newlines by design.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
