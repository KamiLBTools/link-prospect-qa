import type { Verdict } from "./verdict";

/**
 * Gate 1: the cheap filter that decides which Sites are worth paying to look
 * at properly.
 *
 * Every threshold here is adjustable, because they are commercial preferences
 * rather than facts. The defaults come from the reviewer's own practice and
 * were checked against 277 hand-labelled Sites: the gate as configured
 * below rejected 85, of which they independently judged 78 unusable. The six
 * it wrongly rejected are the known, accepted cost.
 *
 * The gate is also the spend control. A Site that survives costs ~130 Ahrefs
 * units for its top-pages call plus two model calls; a Site that prefails costs
 * the ~18 units already spent on its batch row and nothing else.
 */

export interface GateThresholds {
  /** Below this the Site is too weak to pass authority on at all. */
  minDomainRating: number;
  /**
   * Traffic is not a quality bar — it is read as evidence that Google trusts
   * the Site enough to send it anyone. Hence a floor, not a target.
   */
  minOrganicTraffic: number;
  /**
   * Outbound dofollow domains divided by inbound dofollow domains. Above this
   * the Site is giving away far more authority than it receives, which is the
   * arithmetic signature of a link seller.
   */
  maxOutInRatio: number;
  /**
   * Keywords in the top 100. A Site with high traffic and almost no ranking
   * terms is carrying that traffic on a handful of manufactured queries. In the
   * labelled set, not one approved Site had its whole traffic inside its top
   * ten pages, while 18 of 34 manipulated ones did.
   */
  minOrganicKeywords: number;
}

export const DEFAULT_THRESHOLDS: GateThresholds = {
  minDomainRating: 10,
  minOrganicTraffic: 100,
  maxOutInRatio: 10,
  minOrganicKeywords: 30,
};

/** The subset of the Ahrefs batch row the gate reads. */
export interface GateMetrics {
  domainRating: number | null;
  organicTraffic: number | null;
  organicKeywords: number | null;
  refdomainsDofollow: number | null;
  linkedDomainsDofollow: number | null;
}

export type GateOutcome =
  | { pass: true; outInRatio: number | null }
  | { pass: false; reason: string; outInRatio: number | null };

/**
 * Outbound domains per inbound domain. Null when there is no denominator: a
 * Site with no dofollow referring domains has an undefined ratio, not an
 * infinite one, and must not be rejected by this particular rule.
 */
export function outInRatio(metrics: GateMetrics): number | null {
  const { linkedDomainsDofollow: out, refdomainsDofollow: incoming } = metrics;
  if (out === null || incoming === null || incoming === 0) return null;
  return out / incoming;
}

export function applyGate(
  metrics: GateMetrics,
  thresholds: GateThresholds = DEFAULT_THRESHOLDS,
): GateOutcome {
  const ratio = outInRatio(metrics);

  /**
   * A missing metric is not a failing metric. Ahrefs returns nulls for domains
   * it has never crawled, and rejecting those as "DR below 10" would report a
   * gap in Ahrefs' index as a judgement about the Site.
   */
  if (metrics.domainRating === null && metrics.organicTraffic === null) {
    return { pass: false, reason: "no Ahrefs data for this domain", outInRatio: ratio };
  }

  if (metrics.domainRating !== null && metrics.domainRating < thresholds.minDomainRating) {
    return {
      pass: false,
      reason: `DR ${metrics.domainRating} < ${thresholds.minDomainRating}`,
      outInRatio: ratio,
    };
  }

  if (
    metrics.organicTraffic !== null &&
    metrics.organicTraffic < thresholds.minOrganicTraffic
  ) {
    return {
      pass: false,
      reason: `traffic ${metrics.organicTraffic} < ${thresholds.minOrganicTraffic}`,
      outInRatio: ratio,
    };
  }

  if (
    metrics.organicKeywords !== null &&
    metrics.organicKeywords < thresholds.minOrganicKeywords
  ) {
    return {
      pass: false,
      reason: `${metrics.organicKeywords} organic keywords < ${thresholds.minOrganicKeywords}`,
      outInRatio: ratio,
    };
  }

  if (ratio !== null && ratio > thresholds.maxOutInRatio) {
    return {
      pass: false,
      reason: `out/in ratio ${ratio.toFixed(2)} > ${thresholds.maxOutInRatio}`,
      outInRatio: ratio,
    };
  }

  return { pass: true, outInRatio: ratio };
}

/**
 * Which do-not-buy verdict a gate rejection means.
 *
 * A prefail is always a do-not-buy decision, but the reviewer distinguishes
 * *why*, and their distinction is mechanical enough to make here rather than
 * asking a model that never sees these Sites. Their words on the two sites
 * this recovers — aelftech.com at 804 visits on 13 keywords and
 * thegossipwire.com at 6,126 on 15 — were "low number of organic keywords,
 * relatively high organic traffic", and they labelled both `manipulation`.
 *
 * The conjunction is the whole rule. Few keywords *and* traffic the site has
 * cleared the floor on cannot both be true of honest search demand. Few
 * keywords on negligible traffic is just a small site, so that stays `bad`.
 */
export function gateVerdict(
  metrics: GateMetrics,
  thresholds: GateThresholds = DEFAULT_THRESHOLDS,
): Verdict {
  const { organicKeywords: keywords, organicTraffic: traffic } = metrics;
  const fakeLooking =
    keywords !== null &&
    keywords < thresholds.minOrganicKeywords &&
    traffic !== null &&
    traffic >= thresholds.minOrganicTraffic;
  return fakeLooking ? "manipulation" : "bad";
}
