import type { CheerioAPI } from "cheerio";

/**
 * Does this homepage advertise that anyone can publish on it.
 *
 * A "Write for us" link in the navigation or footer is the site telling its
 * own visitors that its pages are for sale. The reviewer treats it as close to
 * disqualifying on its own — mopoga.net was called `manipulation` on exactly
 * this evidence, in their words "there is no brand and the website has a write
 * for us" — so it is worth detecting deterministically rather than hoping the
 * judge notices it in the markdown.
 *
 * Detected in code, not by the model, for the same reason the niche penalty is:
 * this is a fact about the page, and a fact should not vary between two runs
 * over identical bytes.
 *
 * ## What counts, and what deliberately does not
 *
 * The signal is a *standing invitation to contribute*. Two neighbours are
 * excluded because real publications have them:
 *
 *  - "Advertise with us" / "Media kit" — every newspaper on earth sells ads.
 *  - "Submit a news tip", "Contact the editor" — that is local journalism
 *    working, not an open door.
 *
 * Only links are inspected, never body text. A magazine that publishes an
 * article *about* guest posting is not soliciting; a nav item that says
 * "Guest Post" is. Anchor text and href are both checked because plenty of
 * sites label the link "Contribute" and point it at /write-for-us/.
 */

/**
 * Anchor text and URL slugs, normalised to lowercase ASCII words.
 *
 * The languages here are the ones the reviewer's lists actually contain —
 * English, Dutch, German, French, Spanish, Italian, Portuguese. A pattern is
 * only included when it cannot also mean something innocent: "contribute" and
 * "submit" appear only bound to a noun, because "contribute" alone is a
 * donation button and "submit" alone is a news tip.
 */
const PATTERNS: RegExp[] = [
  // English
  /\bwrite (?:for|with) (?:us|me)\b/,
  /\bwriters? wanted\b/,
  /\bguest (?:post|posting|blog|blogging|article|author|writer|contribut\w*)/,
  /\b(?:become|be) an? (?:contributor|author|writer)\b/,
  /\bcontribut\w* (?:an?|your) (?:article|post|story|content)\b/,
  /\bsubmit (?:an?|your) (?:article|post|guest|blog|story|content)\b/,
  /\bsubmit (?:articles|posts|content)\b/,
  /\bpublish (?:with|on) us\b/,
  /\bsponsored (?:post|article|content)s?\b/,
  /\bpaid (?:post|guest post|article)s?\b/,
  // Dutch
  /\bschrijf (?:voor|mee met) ons\b/,
  /\bgast(?:blog|artikel|auteur|bijdrage)/,
  // German
  /\bgast(?:beitrag|artikel|autor|blog)/,
  /\bschreib(?:e|en sie)? fur uns\b/,
  // French
  /\becri(?:vez|re) pour nous\b/,
  /\barticle invite\b/,
  /\bdeven(?:ir|ez) (?:redacteur|contributeur|auteur)\b/,
  /\bproposer un article\b/,
  // Spanish
  /\bescrib[ae] (?:para|con) nosotros\b/,
  /\barticulo invitado\b/,
  /\bcolabora con nosotros\b/,
  // Italian
  /\bscrivi per noi\b/,
  /\barticolo ospite\b/,
  // Portuguese
  /\bescreva para nos\b/,
  /\bpost patrocinado\b/,
];

/**
 * Where a solicitation link may appear before it counts.
 *
 * Scoped to the page's furniture rather than the whole document: this is what
 * the reviewer described ("check the header and footer"), and it is also what
 * keeps a marketing blog's article on guest-post outreach from reading as an
 * offer to sell one. The class and id selectors are there because most themes
 * ship `<div class="site-footer">` rather than `<footer>`.
 */
const FURNITURE = [
  "header",
  "footer",
  "nav",
  "aside",
  "[role='navigation']",
  "[role='contentinfo']",
  "[role='banner']",
  "[class*='header' i]",
  "[class*='footer' i]",
  "[class*='nav' i]",
  "[class*='menu' i]",
  "[id*='header' i]",
  "[id*='footer' i]",
  "[id*='nav' i]",
  "[id*='menu' i]",
].join(", ");

/**
 * Lowercase, strip accents, and reduce everything else to single spaces, so
 * that "Écrivez pour nous", "ecrivez-pour-nous" and "/write_for_us/" all match
 * the same pattern. Hyphens and underscores become spaces because URL slugs
 * are the same words with different punctuation. Every pattern above is pure
 * ASCII for that reason: by the time one is tested, no accent survives.
 */
function normalise(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The matched phrase, or null. Returning the phrase rather than a boolean is
 * deliberate: it goes into the CSV so a reviewer can see what fired and
 * disagree with it, instead of being told "bad" by an invisible rule.
 */
export function detectContributorSolicitation($: CheerioAPI): string | null {
  const links = $(FURNITURE).find("a[href]");

  for (const element of links.toArray()) {
    const anchor = $(element);
    const path = pathOf(anchor.attr("href") ?? "");
    if (isArchive(path) || anchor.closest("h1, h2, h3, h4, h5, h6").length) continue;

    const text = normalise(anchor.text());
    // Only the path matters. A query string or host can contain anything, and
    // an ad network URL carrying "sponsored-post" is not the site's own offer.
    const href = normalise(path);

    for (const pattern of PATTERNS) {
      if (pattern.test(text)) return anchor.text().trim().slice(0, 60) || href;
      if (pattern.test(href) && isShortPath(href)) {
        return `link: /${href.replace(/ /g, "-")}`;
      }
    }
  }

  return null;
}

/**
 * A destination path, not a headline that happens to contain the words.
 *
 * A sitewide invitation lives at a short, purpose-built path — `/write-for-us`,
 * `/colabora-con-nosotros`, `/submit-your-story`. An article about a guest
 * contribution has a headline for a slug, and on a live run one reached the
 * furniture through a "latest stories" menu widget:
 *
 *   zambianfootball.co.zm  /guest-article-wawa-chongo-legacy-kept-alive
 *
 * Six words is measured, not guessed: it is above the longest genuine match
 * seen across 969 domains (`/devenez-redacteur-sur-stade-html`, five) and
 * below that headline's seven. It bounds only the href test — link *text* is
 * already short by nature and is matched without this restriction.
 */
function isShortPath(href: string): boolean {
  return href.split(" ").filter(Boolean).length <= 6;
}

/**
 * A `/category/` or `/tag/` link is the site's own taxonomy, never an offer.
 *
 * Both exclusions below were false positives on the reviewer's own approved
 * sites, found by running this detector over their homepages before it was
 * allowed to affect a verdict:
 *
 *  - meervanmir.eu, a Dutch parenting blog, files recurring guest columns
 *    under /category/persoonlijk/gastblog-oma and seven siblings. Those are
 *    sections of the magazine, not an invitation.
 *  - tomoson.com's recent-post cards put "...When It Beats Paid Posts" in an
 *    <h2>. An article about paid posts is not a page for sale, so links inside
 *    a heading are skipped: a nav label is never marked up as one.
 */
function isArchive(path: string): boolean {
  return /\/(?:category|categories|tag|tags|topic|topics|author|archives?)\//i.test(path);
}

function pathOf(href: string): string {
  try {
    // A base is required for relative hrefs and irrelevant to the result.
    return new URL(href, "https://x.invalid").pathname;
  } catch {
    return href;
  }
}
