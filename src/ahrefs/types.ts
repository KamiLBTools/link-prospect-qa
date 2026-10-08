import type { TopPage } from "../domain/topPages";

/** One row of the batch-analysis response, in our vocabulary rather than Ahrefs'. */
export interface SiteMetrics {
  domain: string;
  domainRating: number | null;
  organicTraffic: number | null;
  /** Keywords ranking in the top 100. The gate's cheapest signal, at 1 unit. */
  organicKeywords: number | null;
  refdomainsDofollow: number | null;
  linkedDomainsDofollow: number | null;
}

/**
 * The metrics provider. An interface because Ahrefs is one vendor for a
 * commodity, and because the eval and the tests need to run without a key or a
 * bill.
 */
export interface MetricsProvider {
  readonly name: string;
  /**
   * Results are keyed by the domain that was requested, so a caller never has
   * to rely on response ordering. Domains Ahrefs has no data for come back with
   * null metrics rather than being absent.
   */
  batchAnalysis(domains: string[]): Promise<Map<string, SiteMetrics>>;
  /** Top pages by organic traffic, descending. */
  topPages(domain: string, limit: number): Promise<TopPage[]>;
  /** API units consumed since this provider was constructed. */
  unitsSpent(): number;
}
