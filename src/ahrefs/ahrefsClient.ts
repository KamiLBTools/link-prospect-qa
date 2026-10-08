import type { TopPage } from "../domain/topPages";
import type { MetricsProvider, SiteMetrics } from "./types";

/**
 * Ahrefs API v3.
 *
 * Two endpoints, and the cost asymmetry between them shapes the whole
 * pipeline. Ahrefs bills `max(50, per_row_cost * rows)`, where each selected
 * field has its own price and `org_traffic` alone costs 10 units:
 *
 *   batch analysis   19 units per domain   (1 request per 100 domains)
 *   top pages        12 units per row      = up to 120 units per surviving Site
 *
 * Both figures are measured from Ahrefs' own `x-api-units-cost-row` header on
 * a live run, not read off the price list. So the top-pages call is ~80% of the
 * spend, which is why Gate 1 exists and why the keyword threshold pays for
 * itself: `org_keywords` costs 1 unit inside a call already being made, and
 * rejecting on it saves up to 120.
 */

const API = "https://api.ahrefs.com/v3";

/** Documented limit: 100 targets per batch-analysis request. */
export const BATCH_SIZE = 100;

/** Documented limit: 60 requests per minute, plus undocumented load-based throttling. */
const MIN_REQUEST_INTERVAL_MS = 1_100;

const BATCH_FIELDS = [
  "url",
  "domain_rating",
  "org_traffic",
  "org_keywords",
  "refdomains_dofollow",
  // Domains, not links. `outgoing_links_dofollow` counts links and would make
  // the out/in ratio incomparable with the referring-domains denominator.
  "linked_domains_dofollow",
] as const;

const TOP_PAGE_FIELDS = ["url", "sum_traffic", "top_keyword"] as const;

export interface AhrefsConfig {
  apiKey: string;
  /** Overridable so tests can point at a local stub. */
  baseUrl?: string;
}

export class AhrefsClient implements MetricsProvider {
  readonly name = "ahrefs";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private units = 0;
  private nextSlot = 0;

  constructor(config: AhrefsConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? API;
  }

  unitsSpent(): number {
    return this.units;
  }

  async batchAnalysis(domains: string[]): Promise<Map<string, SiteMetrics>> {
    const results = new Map<string, SiteMetrics>();

    for (let i = 0; i < domains.length; i += BATCH_SIZE) {
      const chunk = domains.slice(i, i + BATCH_SIZE);
      const payload = await this.request<Record<string, unknown>>(
        "/batch-analysis/batch-analysis",
        {
          method: "POST",
          body: JSON.stringify({
            select: BATCH_FIELDS,
            targets: chunk.map((domain) => ({
              url: domain,
              // Subdomains, because a publisher's content may live on one and
              // `both` protocols because plenty still answer on http.
              mode: "subdomains",
              protocol: "both",
            })),
          }),
        },
      );

      const rows = firstArray(payload);
      // Ahrefs echoes the target back in `url`, but not necessarily in the form
      // we sent, and not necessarily in order. Match on the normalised host so
      // a `https://` prefix or a `www.` never loses a row.
      const byHost = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const host = hostOf(String(row["url"] ?? ""));
        if (host) byHost.set(host, row);
      }

      for (const domain of chunk) {
        const row = byHost.get(hostOf(domain) ?? domain);
        results.set(domain, {
          domain,
          domainRating: numeric(row?.["domain_rating"]),
          organicTraffic: numeric(row?.["org_traffic"]),
          organicKeywords: numeric(row?.["org_keywords"]),
          refdomainsDofollow: numeric(row?.["refdomains_dofollow"]),
          linkedDomainsDofollow: numeric(row?.["linked_domains_dofollow"]),
        });
      }
    }

    return results;
  }

  async topPages(domain: string, limit: number): Promise<TopPage[]> {
    const query = new URLSearchParams({
      target: domain,
      // Required, and must be a date Ahrefs has data for. Today is the
      // documented way to ask for the current snapshot.
      date: new Date().toISOString().slice(0, 10),
      select: TOP_PAGE_FIELDS.join(","),
      order_by: "sum_traffic:desc",
      limit: String(limit),
      mode: "subdomains",
      protocol: "both",
    });

    const payload = await this.request<Record<string, unknown>>(
      `/site-explorer/top-pages?${query}`,
      { method: "GET" },
    );

    return firstArray(payload)
      .map((row) => ({
        url: String(row["url"] ?? ""),
        traffic: numeric(row["sum_traffic"]) ?? 0,
        topKeyword: String(row["top_keyword"] ?? ""),
      }))
      .filter((page) => page.url !== "");
  }

  /**
   * One request, paced and metered.
   *
   * 429 is retried because Ahrefs throttles dynamically on load as well as on
   * the published 60/minute, so a 429 is often about their capacity rather than
   * our rate. A 5xx and a dropped connection are retried too: each once
   * stopped a run of thousands. Nothing else is retried: units are
   * non-refundable, and a retry loop on a malformed request just spends them
   * twice.
   */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.pace();

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...init.headers,
          },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (attempt >= 4) throw error;
        await sleep(2 ** attempt * 2_000);
        continue;
      }

      this.units += Number(response.headers.get("x-api-units-cost-total")) || 0;

      // A 5xx is Ahrefs' own hiccup: one on a single site's top pages once
      // stopped a run of thousands. Backed off and retried like a rate limit.
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** attempt * 2_000,
        );
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Ahrefs ${response.status} on ${path}: ${body.slice(0, 300)}`,
        );
      }

      return (await response.json()) as T;
    }
  }

  /** Spaces requests rather than bursting into the published per-minute limit. */
  private async pace(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + MIN_REQUEST_INTERVAL_MS;
    if (wait > 0) await sleep(wait);
  }
}

/**
 * Ahrefs nests every response under a per-tool key (`pages`, `batch_analysis`).
 * Reading the first array value rather than a hardcoded name means a renamed
 * key degrades to an empty result instead of a crash, and keeps the client
 * honest about the one thing it actually needs from the envelope.
 */
function firstArray(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  for (const value of Object.values(payload ?? {})) {
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
}

/** Null, not zero. A missing metric is not a metric of zero — see the gate. */
function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hostOf(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
