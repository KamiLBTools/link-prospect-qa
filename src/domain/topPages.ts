/**
 * Reading a Site's top pages.
 *
 * The single most important idea here is the *remainder*. A high branded share
 * is not evidence of anything on its own: in the labelled set the reviewer
 * approved Sites at 93%, 89% and 79% branded, and rejected others at 61%. What
 * separates them is what is left once the branded and navigational pages are
 * removed. Nothing, gibberish or unrelated spam is manufactured traffic; real
 * editorial content is just a brand with a strong name.
 *
 * So this module's job is to classify each page mechanically and hand the
 * judge a clean remainder, rather than to compute a percentage and threshold
 * it.
 */

export interface TopPage {
  url: string;
  /** Estimated monthly organic traffic to this page. */
  traffic: number;
  /** The keyword bringing most of that traffic. */
  topKeyword: string;
}

export type PageKind = "branded" | "navigational" | "editorial";

export interface ClassifiedPage extends TopPage {
  kind: PageKind;
  /** This page's share of the Site's total organic traffic. */
  share: number;
}

export interface TopPagesSummary {
  pages: ClassifiedPage[];
  /** How many ranking pages Ahrefs could find, capped by the request limit. */
  pageCount: number;
  /**
   * Share of the Site's whole organic traffic sitting in these pages. Near 1.0
   * means the Site ranks for essentially nothing else.
   */
  coverage: number;
  brandedShare: number;
  navigationalShare: number;
  /** The pages the judge should actually reason about. */
  remainder: ClassifiedPage[];
  /**
   * The two conditions that, together, identified 10 of 34 manipulated Sites in
   * the labelled set and zero of the 151 the reviewer approved or called merely
   * bad. Corroboration for a manipulation finding, never a verdict by itself.
   */
  ranksForAlmostNothing: boolean;
}

/** The distinctive part of a domain: `los-cerritos-news.net` -> `loscerritosnews`. */
export function brandToken(domain: string): string {
  const withoutTld = domain.toLowerCase().replace(/^www\./, "").split(".")[0] ?? "";
  return withoutTld.replace(/[^a-z0-9]/g, "");
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a query is the Site searching for itself.
 *
 * Containment runs one way freely and the other way only when the keyword
 * covers most of the brand. Without that asymmetry `buffalonews.com` would
 * treat the generic query "news" as branded, because "news" is a substring of
 * "buffalonews" — which would hide exactly the editorial traffic we need to see.
 */
export function isBrandedKeyword(keyword: string, domain: string): boolean {
  const brand = brandToken(domain);
  const query = squash(keyword);
  if (!brand || !query || brand.length < 4) return false;

  if (query.includes(brand)) return true;
  if (brand.includes(query) && query.length >= brand.length * 0.6) return true;
  return false;
}

/**
 * Whether the *query* is someone looking for the site's plumbing rather than
 * for a subject.
 *
 * This is the second half of the navigational test, and it exists because the
 * URL alone gets it wrong. Tucson Weekly's `/Archives` ranks for "steve jobs
 * tucson" and its `/tag` for "matthew mcconaughey tucson": both are real
 * editorial demand that happens to land on a listing page. Stripping them as
 * plumbing would shrink the remainder on exactly the archive-heavy local papers
 * whose remainder is the evidence that saves them.
 */
export function isNavigationalQuery(keyword: string): boolean {
  const query = keyword.toLowerCase().trim();
  if (!query) return true;

  return [
    /\b(privacy|terms|conditions|disclaimer|dmca|copyright)\b/,
    /\b(contact|about) ?(us)?\b/,
    /\bhome ?page\b/,
    /\b(login|log in|sign in|sitemap|rss|feed|subscribe)\b/,
    /^(www\.|https?:)/,
  ].some((pattern) => pattern.test(query));
}

/**
 * Pages that exist for the site's own plumbing rather than to answer anyone.
 * Necessary for the navigational classification but not sufficient — see
 * `isNavigationalQuery`.
 */
export function isNavigationalUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return false;
  }

  if (path === "" || path === "/") return true;

  const NAVIGATIONAL = [
    /^\/(privacy|privacy-policy|terms|terms-of-(use|service)|disclaimer|dmca)\b/,
    /^\/(contact|contact-us|about|about-us|team|our-team|advertise|write-for-us)\b/,
    /^\/(category|categories|tag|tags|topic|topics|author|archives?)\b/,
    /^\/(sitemap|feed|rss|search)\b/,
    // A bare year or year/month archive index.
    /^\/(19|20)\d{2}(\/\d{1,2})?$/,
  ];
  return NAVIGATIONAL.some((pattern) => pattern.test(path));
}

/**
 * `siteTraffic` is the Site's total organic traffic from the batch call, not
 * the sum of these pages. Coverage is meaningless computed against itself.
 */
export function summariseTopPages(
  pages: TopPage[],
  domain: string,
  siteTraffic: number | null,
): TopPagesSummary {
  const pageTraffic = pages.reduce((total, page) => total + page.traffic, 0);

  // Ahrefs' site total and its per-page estimates come from different models
  // and the pages can slightly exceed the total. Clamp, so coverage stays a
  // share and a rounding artefact never reads as a signal.
  const denominator = siteTraffic && siteTraffic > 0 ? siteTraffic : pageTraffic;
  const coverage =
    denominator > 0 ? Math.min(1, pageTraffic / denominator) : 0;

  const classified: ClassifiedPage[] = pages.map((page) => {
    const branded = isBrandedKeyword(page.topKeyword, domain);
    // Branded beats navigational: a homepage ranking for the brand name is the
    // signal we care about, and calling it navigational would hide it.
    //
    // Navigational needs BOTH halves to agree — a plumbing URL and a plumbing
    // query. Either alone over-strips: a homepage ranking for a real topic is
    // editorial demand, and so is an archive page ranking for a real name.
    // Erring toward `editorial` grows the remainder, which makes a manipulation
    // finding harder rather than easier. That is the safe direction.
    const kind: PageKind = branded
      ? "branded"
      : isNavigationalUrl(page.url) && isNavigationalQuery(page.topKeyword)
        ? "navigational"
        : "editorial";
    return {
      ...page,
      kind,
      share: denominator > 0 ? page.traffic / denominator : 0,
    };
  });

  const shareOf = (kind: PageKind) =>
    pageTraffic > 0
      ? classified
          .filter((page) => page.kind === kind)
          .reduce((total, page) => total + page.traffic, 0) / pageTraffic
      : 0;

  return {
    pages: classified,
    pageCount: pages.length,
    coverage,
    brandedShare: shareOf("branded"),
    navigationalShare: shareOf("navigational"),
    remainder: classified.filter((page) => page.kind === "editorial"),
    ranksForAlmostNothing: coverage >= 0.999 && pages.length < 10,
  };
}
