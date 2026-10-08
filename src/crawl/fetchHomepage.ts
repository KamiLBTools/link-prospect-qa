import { Impit, type ImpitResponse } from "impit";
import { detect } from "tinyld";
import type { PageLocale } from "../domain/siteLocale";
import { toMarkdown } from "./toMarkdown";
import { renderHtml } from "./renderPage";

/**
 * Fetches one Site's homepage, honestly.
 *
 * This follows the same rule as Link Monitoring's crawler (its ADR-0003) and
 * for the same reason: both tools run from one host under one bot identity, so
 * an evasive fetch here would put that tool's Cloudflare Verified Bots status
 * at risk. No proxies, no user-agent rotation, no retrying past a challenge.
 *
 * A Site we cannot fetch is reported as unfetched. It is never guessed at from
 * its domain name, and never quietly scored as though the page were empty —
 * that would send an unjudged Site into the pipeline wearing a real verdict.
 */

export type HomepageOutcome =
  | {
      kind: "ok";
      finalUrl: string;
      markdown: string;
      title: string;
      truncated: boolean;
      /** The "Write for us" link in the page furniture, verbatim, or null. */
      contributorSolicitation: string | null;
      page: PageLocale;
    }
  | { kind: "failed"; httpStatus: number | null; reason: string };

const client = new Impit({ browser: "chrome", http3: false });

export interface FetchOptions {
  userAgent: string;
  timeoutMs?: number;
}

export async function fetchHomepage(
  domain: string,
  options: FetchOptions,
): Promise<HomepageOutcome> {
  // https first. A publisher still on http will redirect, and following that is
  // cheaper than guessing wrong and paying two requests on the common case.
  // Only when nothing answers at all: www (bare domain never set up), then
  // plain http (no certificate). Measured on 40 sites that "did not answer",
  // these two recovered 15. A site that answers with an error is not retried.
  const timeoutMs = options.timeoutMs ?? 30_000;
  const urls = [`https://${domain}/`, ...(domain.startsWith("www.") ? [] : [`https://www.${domain}/`]), `http://${domain}/`];
  let response: ImpitResponse | null = null;
  let firstError = "";
  for (const url of urls) {
    try {
      response = await client.fetch(url, {
        headers: {
          "User-Agent": options.userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        // Both: impit has its own 30 s default that the signal alone does not lift.
        timeout: timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (error) {
      firstError ||= error instanceof Error ? error.message : String(error);
    }
  }
  if (!response) {
    return { kind: "failed", httpStatus: null, reason: firstError };
  }

  if (!response.ok) {
    return {
      kind: "failed",
      httpStatus: response.status,
      reason: `http ${response.status}`,
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("html")) {
    return {
      kind: "failed",
      httpStatus: response.status,
      reason: `not html (${contentType.split(";")[0]})`,
    };
  }

  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    // The connection can drop mid-body after headers already came back ok.
    // That is still a fetch failure, not a crash — one flaky site must never
    // take down a run of thousands of others alongside it.
    return {
      kind: "failed",
      httpStatus: response.status,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // A challenge interstitial is a 200 whose body is not the homepage. Passing
  // it to the extractor produces a confident description of a Cloudflare page.
  if (isChallenge(html)) {
    return {
      kind: "failed",
      httpStatus: 200,
      reason: "bot challenge interstitial",
    };
  }

  // turndown throws on some malformed documents; one bad page must not end a run.
  let converted: ReturnType<typeof toMarkdown>;
  try {
    converted = toMarkdown(html);
  } catch (error) {
    return {
      kind: "failed",
      httpStatus: response.status,
      reason: `unparseable page: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { markdown } = converted;

  // A page that renders entirely client-side yields almost nothing: load it in
  // a real browser, same user agent, and read what its scripts draw.
  if (markdown.length < 200) {
    const rendered = await renderHtml(response.url, options.userAgent, timeoutMs);
    if (rendered && !isChallenge(rendered)) {
      try {
        const again = toMarkdown(rendered);
        if (again.markdown.length >= 200) return ok(response.url, again);
      } catch {
        // Falls through to the failure below.
      }
    }
  }

  // Better to report an empty page than to hand the extractor an empty
  // document it will happily describe anyway.
  if (markdown.length < 200) {
    return {
      kind: "failed",
      httpStatus: response.status,
      reason: "page has no server-rendered content",
    };
  }

  return ok(response.url, converted);
}

function ok(finalUrl: string, converted: ReturnType<typeof toMarkdown>): HomepageOutcome {
  const { markdown, title, truncated, contributorSolicitation, lang, locale } = converted;
  return {
    kind: "ok",
    finalUrl,
    markdown,
    title,
    truncated,
    contributorSolicitation,
    // Link targets stripped: URLs read as English to a text detector.
    page: { lang, locale, detected: detect(markdown.replace(/\]\([^)]*\)/g, "]")) || null },
  };
}

function isChallenge(html: string): boolean {
  const head = html.slice(0, 4_000).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("cf-browser-verification") ||
    head.includes("challenge-platform") ||
    head.includes("enable javascript and cookies to continue") ||
    head.includes("checking your browser before accessing")
  );
}
