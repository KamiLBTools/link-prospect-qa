/**
 * Turning whatever the user pasted into a Site — one domain, once.
 *
 * Input arrives as a mix of bare domains, full URLs with paths and query
 * strings, protocol-relative forms, and the same host with and without `www.`
 * Every one of those costs an Ahrefs row if it survives to the batch call, so
 * deduplication here is a spend control, not tidiness.
 */

export interface ParsedInput {
  /** The registrable host, lowercased, `www.` stripped. The Site's identity. */
  domain: string;
  /** Every raw input line that collapsed onto this domain. */
  inputs: string[];
}

export interface RejectedInput {
  input: string;
  reason: string;
}

export interface ParseResult {
  sites: ParsedInput[];
  rejected: RejectedInput[];
}

/**
 * Hosts that are never a Site of their own: a link on one of these is a page on
 * somebody else's platform. Checked as a suffix so `foo.blogspot.com` matches.
 */
const PLATFORM_HOSTS = [
  "blogspot.com",
  "wordpress.com",
  "medium.com",
  "wixsite.com",
  "weebly.com",
  "tumblr.com",
  "substack.com",
  "github.io",
];

export function normaliseDomain(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (!text) return null;

  // Strip a leading marker from pasted lists ("- example.com", "1. example.com").
  text = text.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "");
  // Trim quoting and prose punctuation from both ends. Both ends matters: a
  // value lifted from a CSV cell arrives as `"example.com"`, and stripping only
  // the closing quote leaves a leading one that makes the URL unparseable.
  text = text.replace(/^["'<(]+/, "").replace(/["'>),;.]+$/, "");
  if (!text) return null;

  // `new URL` needs a scheme; protocol-relative input already has the slashes.
  if (text.startsWith("//")) text = `https:${text}`;
  else if (!/^https?:\/\//.test(text)) text = `https://${text}`;

  let host: string;
  try {
    host = new URL(text).hostname;
  } catch {
    return null;
  }

  host = host.replace(/^www\./, "").replace(/\.$/, "");

  // A hostname with no dot is a typo or an intranet name, never a publisher.
  if (!host.includes(".")) return null;
  // Reject anything that isn't a plausible hostname — an IP, or stray characters
  // that survived the trimming above.
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (/^\d+(\.\d+)*$/.test(host)) return null;

  return host;
}

export function isPlatformHost(domain: string): boolean {
  return PLATFORM_HOSTS.some(
    (host) => domain === host || domain.endsWith(`.${host}`),
  );
}

/**
 * Parses a pasted list or an uploaded column into deduplicated Sites.
 *
 * Order is the order of first appearance, so the exported sheet reads in the
 * same sequence the user supplied — which is what makes it pasteable back into
 * their own spreadsheet.
 */
export function parseSiteList(text: string): ParseResult {
  const seen = new Map<string, ParsedInput>();
  const rejected: RejectedInput[] = [];

  for (const line of text.split(/[\r\n,;\t]+/)) {
    const input = line.trim();
    if (!input) continue;

    const domain = normaliseDomain(input);
    if (!domain) {
      rejected.push({ input, reason: "not a domain" });
      continue;
    }
    if (isPlatformHost(domain)) {
      rejected.push({ input, reason: "hosted platform, not a publisher" });
      continue;
    }

    const existing = seen.get(domain);
    if (existing) existing.inputs.push(input);
    else seen.set(domain, { domain, inputs: [input] });
  }

  return { sites: [...seen.values()], rejected };
}
