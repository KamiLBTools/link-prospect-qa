import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { summariseTopPages, type TopPage } from "../domain/topPages";
import type { JudgeInput } from "../llm/judge";
import { isVerdict, type Verdict } from "../domain/verdict";

/**
 * The regression set: 277 sites the reviewer labelled by hand, extracted from
 * the spreadsheet the previous tool produced.
 *
 * What this can and cannot test. It holds the *previous* tool's extracted
 * description and category alongside the reviewer's verdict, so replaying it
 * exercises the judge in isolation while holding extraction fixed. That is the
 * right shape for an eval — it isolates the component we are actually worried
 * about — but two limits are worth stating plainly:
 *
 *  - `organicKeywords` was never in that sheet, so the keyword-count signal
 *    cannot be scored here. It reaches the judge as unknown.
 *  - The descriptions come from a different extractor than the one this tool
 *    ships, so a change in extraction quality is invisible to this eval.
 */

const dir = new URL("../../eval/", import.meta.url);

export interface LabelledSite {
  domain: string;
  domainRating: number | null;
  organicTraffic: number | null;
  outInRatio: number | null;
  refdomainsDofollow: number | null;
  linkedDomainsDofollow: number | null;
  country: string | null;
  language: string | null;
  description: string;
  niches: string[];
  isNewsSite: boolean;
  /** The previous tool's verdict, for a baseline to measure against. */
  oldVerdict: string;
  /** Ground truth. */
  humanVerdict: Verdict;
  humanReason: string;
  topPages: TopPage[];
}

function rows(file: string): Record<string, string>[] {
  return parse(readFileSync(fileURLToPath(new URL(file, dir)), "utf8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  });
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function loadLabelledSites(): LabelledSite[] {
  const pagesByDomain = new Map<string, TopPage[]>();
  for (const row of rows("top-pages.csv")) {
    const domain = (row["domain"] ?? "").trim().toLowerCase();
    if (!domain) continue;
    const list = pagesByDomain.get(domain) ?? [];
    list.push({
      url: row["url"] ?? "",
      traffic: numberOrNull(row["traffic"]) ?? 0,
      topKeyword: row["top_keyword"] ?? "",
    });
    pagesByDomain.set(domain, list);
  }

  const sites: LabelledSite[] = [];
  for (const row of rows("labelled-sites.csv")) {
    const domain = (row["domain"] ?? "").trim().toLowerCase();
    const human = (row["human_verdict"] ?? "").trim();
    if (!domain || !isVerdict(human)) continue;

    sites.push({
      domain,
      domainRating: numberOrNull(row["dr"]),
      organicTraffic: numberOrNull(row["traffic"]),
      outInRatio: numberOrNull(row["out_in_ratio"]),
      refdomainsDofollow: numberOrNull(row["refdomains_dofollow"]),
      linkedDomainsDofollow: numberOrNull(row["linked_domains_dofollow"]),
      country: (row["country"] ?? "").trim() || null,
      language: (row["language"] ?? "").trim() || null,
      description: (row["description"] ?? "").trim(),
      niches: (row["niches"] ?? "")
        .split(",")
        .map((niche) => niche.trim())
        .filter(Boolean),
      isNewsSite: (row["news_site"] ?? "").trim().toLowerCase() === "yes",
      oldVerdict: (row["old_verdict"] ?? "").trim().toLowerCase(),
      humanVerdict: human,
      humanReason: (row["human_reason"] ?? "").trim(),
      // Sorted descending, matching what the live pipeline asks Ahrefs for.
      topPages: (pagesByDomain.get(domain) ?? [])
        .slice()
        .sort((a, b) => b.traffic - a.traffic),
    });
  }
  return sites;
}

/** A fixture row as the judge sees it. Shared by every replay of this set. */
export function toJudgeInput(site: LabelledSite): JudgeInput {
  const topPages = summariseTopPages(
    site.topPages,
    site.domain,
    site.organicTraffic,
  );

  return {
    domain: site.domain,
    profile: {
      description: site.description,
      language: site.language ?? "en",
      audienceCountry: site.country,
      // The fixture records only news / not-news, so a magazine reaches the
      // judge as a blog. That understates the news branch rather than
      // flattering it, which is the safe direction for a regression set.
      siteType: site.isNewsSite ? ("news" as const) : ("blog" as const),
      taxonomy: site.niches,
      specificNiche: "",
      topicBreadth: "broad" as const,
      // The previous tool's own confidence is not in the sheet. 0.5 tells the
      // judge to treat these fields as the hints they are.
      confidence: 0.5,
    },
    metrics: {
      domainRating: site.domainRating,
      organicTraffic: site.organicTraffic,
      // Never captured by the previous tool. Unknown, not zero — zero would
      // read as the strongest possible manipulation signal.
      organicKeywords: null,
      refdomainsDofollow: site.refdomainsDofollow,
      linkedDomainsDofollow: site.linkedDomainsDofollow,
      outInRatio: site.outInRatio,
    },
    topPages,
    // The regression fixture stores the previous tool's metrics and no
    // homepage, so this was never inspected. Passing null instead would tell
    // the judge all 193 of these sites are free of solicitation links.
    contributorSolicitation: undefined,
  };
}
