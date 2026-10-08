/**
 * A Site's Language and Country, from the most reliable evidence available.
 *
 * Each source fails somewhere. Themes leave lang="en-US" and og:locale
 * "en_GB" on sites in any language and country; the text detector misreads
 * mixed pages; the model misreads an English paper about a non-English
 * country. Measured on 195 homepages, so:
 *
 *   Language: the majority of the page's tag, the detector and the model;
 *             with no majority, the model.
 *   Country:  a real country domain, then the model, then the locale tag.
 */

/** What the homepage says about itself, recorded when it is fetched. */
export interface PageLocale {
  /** `<html lang>`, verbatim, e.g. "en-GB". */
  lang: string | null;
  /** `og:locale`, verbatim, e.g. "en_NG". */
  locale: string | null;
  /** ISO 639-1 code from a text detector run on the page. */
  detected: string | null;
}

/**
 * Two-letter domains sold as brands rather than for their country: .ai, .io,
 * .ly and the rest say nothing about where a site is.
 */
const VANITY_TLDS = new Set([
  "ac", "ag", "ai", "am", "cc", "cf", "co", "cx", "do", "fm", "ga", "gg", "gl", "gq", "gs",
  "im", "io", "is", "la", "ly", "me", "ml", "ms", "nu", "pw", "sh", "so", "st", "sx", "tk",
  "to", "tv", "vc", "ws",
  // Regions, not countries.
  "eu",
]);

/** The second-level labels countries sell under: com.ng, co.uk, net.au… */
const SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gob", "gov", "net", "or", "org"]);

const LANGUAGE = /^[a-z]{2}$/;
const COUNTRY = /^[A-Z]{2}$/;

export function pickLanguage(page: PageLocale | undefined, model: string | null | undefined): string | null {
  const [tag, detected, guess] = [page?.lang?.split(/[-_]/)[0], page?.detected, model].map((candidate) => {
    const code = candidate?.trim().toLowerCase();
    return code && LANGUAGE.test(code) ? code : null;
  });
  if (tag && (tag === detected || tag === guess)) return tag;
  if (detected && detected === guess) return detected;
  return guess ?? detected ?? tag ?? null;
}

export function pickCountry(domain: string, page: PageLocale | undefined, model: string | null | undefined): string | null {
  return countryDomain(domain) ?? valid(model) ?? localeCountry(page);
}

function countryDomain(domain: string): string | null {
  const labels = domain.toLowerCase().split(".");
  const tld = labels.at(-1)!;
  if (tld.length !== 2) return null;
  // "com.do" is the Dominican Republic even though "any.do" is a brand.
  const sold = labels.length >= 3 && SECOND_LEVEL.has(labels.at(-2)!);
  if (!sold && VANITY_TLDS.has(tld)) return null;
  return tld === "uk" ? "GB" : tld.toUpperCase();
}

function localeCountry(page: PageLocale | undefined): string | null {
  for (const tag of [page?.locale, page?.lang]) {
    const [language, region] = (tag ?? "").split(/[-_]/);
    const code = valid(region);
    // en_US is WordPress's and Yoast's default, left in place on sites everywhere.
    if (code && !(code === "US" && language?.toLowerCase() === "en")) return code;
  }
  return null;
}

function valid(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && COUNTRY.test(code) && code !== "EU" ? code : null;
}

/**
 * The free pre-check before any credits are spent: is this homepage English?
 * The page's tag and the text detector only; "check" when they disagree about
 * English, since a theme's default lang="en-US" and a mixed page each fool one
 * of them.
 */
export function englishCheck(page: PageLocale): "english" | "other" | "check" {
  const tag = page.lang?.split(/[-_]/)[0]?.trim().toLowerCase() || null;
  const detected = page.detected;
  if (!detected) return "check";
  if (detected === "en") return !tag || tag === "en" ? "english" : "check";
  return tag === "en" ? "check" : "other";
}
