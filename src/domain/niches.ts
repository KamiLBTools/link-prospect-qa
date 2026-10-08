import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

/**
 * The agency's niche tree (data/niches.csv), three levels, broad to specific.
 * Filter on niche 3; if nothing fits, widen to niche 2, then niche 1.
 *
 * News is only for Sites whose job is reporting news, and its levels are
 * geography: News > Country > State. A trade site's news sits under its
 * industry instead, e.g. Lifestyle > Fashion > News.
 */

export interface Niche {
  niche1: string;
  niche2: string | null;
  niche3: string | null;
}

const rows = parse(readFileSync(new URL("../../data/niches.csv", import.meta.url), "utf8"), {
  columns: true,
  skip_empty_lines: true,
}) as { niche_1: string; niche_2: string; niche_3: string }[];

/** Every non-News path the model may choose, as "A > B" or "A > B > C". */
export const NICHE_PATHS: string[] = rows
  .filter((row) => row.niche_1 !== "News")
  .map((row) => [row.niche_1, row.niche_2, row.niche_3].filter(Boolean).join(" > "));

/** States or regions the tree lists, by country name. Other countries stop at niche 2. */
export const NEWS_REGIONS = new Map<string, string[]>();
for (const row of rows) {
  if (row.niche_1 !== "News" || !row.niche_3) continue;
  NEWS_REGIONS.set(row.niche_2, [...(NEWS_REGIONS.get(row.niche_2) ?? []), row.niche_3]);
}

const countryName = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * The model's answer as the three columns.
 *
 * For News the model says only the scope and, for local news, the region; the
 * country comes from `audienceCountry`, so niche 2 cannot disagree with it.
 */
export function toNiche(answer: {
  niche: string;
  newsScope: "international" | "national" | "local" | "none";
  newsRegion: string;
  audienceCountry: string | null;
}): Niche {
  if (answer.niche !== "News") {
    const [niche1, niche2 = null, niche3 = null] = answer.niche.split(" > ");
    return { niche1: niche1!, niche2, niche3 };
  }
  if (answer.newsScope === "international" || !answer.audienceCountry) {
    return { niche1: "News", niche2: "International", niche3: null };
  }
  const country = countryName.of(answer.audienceCountry.toUpperCase()) ?? answer.audienceCountry;
  const region =
    answer.newsScope === "local" && NEWS_REGIONS.get(country)?.includes(answer.newsRegion)
      ? answer.newsRegion
      : null;
  return { niche1: "News", niche2: country, niche3: region };
}

export const nicheLabel = (niche: Niche) =>
  [niche.niche1, niche.niche2, niche.niche3].filter(Boolean).join(" > ");
