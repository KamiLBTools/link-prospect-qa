import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { detectContributorSolicitation } from "./contributorSolicitation";

/**
 * Homepage HTML to markdown.
 *
 * Markdown rather than plain text because the structure *is* the evidence. The
 * signals a reviewer reads off a homepage are the navigation bar's breadth, the
 * presence of a "write for us" link, whether there is an about page, whether
 * article dates are all from two years ago, and whether the social icons go
 * anywhere. Flattening to text destroys every one of them: links lose their
 * destinations, headings lose their rank, and the nav becomes an
 * indistinguishable run of words.
 *
 * So this deliberately keeps navigation and footer content that a
 * readability-style extractor would throw away as boilerplate. Here the
 * boilerplate is the point.
 */

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Tables on a homepage are layout, not data, and their markdown is enormous.
turndown.addRule("stripTables", {
  filter: ["table"],
  replacement: (content) => `\n${content.replace(/\|/g, " ").trim()}\n`,
});

// Images carry no signal here, but their alt text sometimes names the brand.
turndown.addRule("imageAltOnly", {
  filter: "img",
  replacement: (_content, node) => {
    const alt = (node as unknown as { getAttribute(name: string): string | null })
      .getAttribute("alt")
      ?.trim();
    return alt ? `[image: ${alt}]` : "";
  },
});

/** Elements that are never content and inflate the token count enormously. */
const DROP =
  "script, style, noscript, svg, iframe, canvas, template, link, meta, form input, [aria-hidden='true']";

export interface MarkdownResult {
  markdown: string;
  title: string;
  /** True when the page was longer than the budget and had to be cut. */
  truncated: boolean;
  /**
   * The "Write for us" link found in the page furniture, verbatim, or null.
   *
   * Read off the DOM here rather than from the markdown downstream, because
   * this needs to know which element a link sits in — a heading is an article
   * title, a list item in the footer is an offer — and turndown flattens that
   * distinction away. Sharing this parse is also why it lives in this
   * function: a second cheerio load of the same 6,000 homepages is real time.
   */
  contributorSolicitation: string | null;
  /** `<html lang>`, verbatim, or null. */
  lang: string | null;
  /** The `og:locale` meta tag, verbatim, or null. */
  locale: string | null;
}

/**
 * ~20k characters is roughly 5–6k tokens, which is the extraction call's input
 * budget. The cut is at the end because a homepage front-loads what matters:
 * masthead, navigation, then recent posts.
 */
const MAX_CHARS = 20_000;

export function toMarkdown(html: string, maxChars = MAX_CHARS): MarkdownResult {
  const $ = cheerio.load(html);

  // Before the pruning below, not after: a mobile menu is routinely marked
  // aria-hidden, and DROP would take the "Write for us" link with it.
  const contributorSolicitation = detectContributorSolicitation($);
  // Also before DROP, which removes every meta tag.
  const lang = $("html").attr("lang")?.trim() || null;
  const locale = $('meta[property="og:locale"]').attr("content")?.trim() || null;

  $(DROP).remove();

  // Comment nodes survive `.remove()` selectors and some themes ship entire
  // commented-out templates.
  $("*")
    .contents()
    .filter((_, node) => node.type === "comment")
    .remove();

  const title = $("title").first().text().trim();
  const body = $("body").length ? $("body").html() : $.html();

  let markdown = turndown
    .turndown(body ?? "")
    // Collapse the long runs of blank lines that nav-heavy pages produce.
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();

  const truncated = markdown.length > maxChars;
  if (truncated) markdown = `${markdown.slice(0, maxChars)}\n\n[truncated]`;

  return { markdown, title, truncated, contributorSolicitation, lang, locale };
}
