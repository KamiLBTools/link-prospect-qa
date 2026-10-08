import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyGate, DEFAULT_THRESHOLDS, outInRatio, type GateMetrics, gateVerdict } from "./gate";

const healthy: GateMetrics = {
  domainRating: 45,
  organicTraffic: 5_000,
  organicKeywords: 900,
  refdomainsDofollow: 800,
  linkedDomainsDofollow: 400,
};

describe("outInRatio", () => {
  it("is outbound domains per inbound domain", () => {
    assert.equal(
      outInRatio({ ...healthy, linkedDomainsDofollow: 4000, refdomainsDofollow: 800 }),
      5,
    );
  });

  it("is null rather than infinite when there are no referring domains", () => {
    // Undefined, not catastrophic. Rejecting on a missing denominator would
    // fail a brand-new site for arithmetic reasons.
    assert.equal(outInRatio({ ...healthy, refdomainsDofollow: 0 }), null);
    assert.equal(outInRatio({ ...healthy, refdomainsDofollow: null }), null);
  });
});

describe("applyGate", () => {
  it("passes a site that clears every threshold", () => {
    const outcome = applyGate(healthy);
    assert.equal(outcome.pass, true);
  });

  it("rejects on each threshold, and says which", () => {
    const cases: [Partial<GateMetrics>, RegExp][] = [
      [{ domainRating: 9 }, /DR 9/],
      [{ organicTraffic: 99 }, /traffic 99/],
      [{ organicKeywords: 29 }, /29 organic keywords/],
      [{ linkedDomainsDofollow: 8001 }, /out\/in ratio/],
    ];
    for (const [override, expected] of cases) {
      const outcome = applyGate({ ...healthy, ...override });
      assert.equal(outcome.pass, false, `expected a rejection for ${JSON.stringify(override)}`);
      assert.match((outcome as { reason: string }).reason, expected);
    }
  });

  it("treats every threshold as a boundary the site may sit exactly on", () => {
    assert.equal(applyGate({ ...healthy, domainRating: 10 }).pass, true);
    assert.equal(applyGate({ ...healthy, organicTraffic: 100 }).pass, true);
    assert.equal(applyGate({ ...healthy, organicKeywords: 30 }).pass, true);
    // ratio of exactly 10 is allowed; the rule is "greater than".
    assert.equal(
      applyGate({ ...healthy, linkedDomainsDofollow: 8000 }).pass,
      true,
    );
  });

  it("does not read a missing metric as a failing one", () => {
    // Ahrefs returns nulls for domains it has not crawled. Rejecting those as
    // "DR below 10" reports a gap in Ahrefs' index as a judgement about the site.
    assert.equal(applyGate({ ...healthy, domainRating: null }).pass, true);
    assert.equal(applyGate({ ...healthy, organicKeywords: null }).pass, true);
  });

  it("rejects a domain Ahrefs knows nothing about, and says so honestly", () => {
    const outcome = applyGate({
      domainRating: null,
      organicTraffic: null,
      organicKeywords: null,
      refdomainsDofollow: null,
      linkedDomainsDofollow: null,
    });
    assert.equal(outcome.pass, false);
    assert.match((outcome as { reason: string }).reason, /no Ahrefs data/);
  });

  it("honours caller-supplied thresholds", () => {
    const strict = { ...DEFAULT_THRESHOLDS, minDomainRating: 50 };
    assert.equal(applyGate(healthy, strict).pass, false);
    const loose = { ...DEFAULT_THRESHOLDS, minOrganicTraffic: 0 };
    assert.equal(applyGate({ ...healthy, organicTraffic: 1 }, loose).pass, true);
  });

  it("always reports the ratio, including on rejections", () => {
    // The export shows it for every row, so a reviewer can see how close a
    // prefailed site was to the line.
    const outcome = applyGate({ ...healthy, domainRating: 2 });
    assert.equal(outcome.outInRatio, 0.5);
  });
});

describe("gateVerdict", () => {
  const metrics = (organicKeywords: number | null, organicTraffic: number | null) => ({
    domainRating: 40,
    organicKeywords,
    organicTraffic,
    refdomainsDofollow: 100,
    linkedDomainsDofollow: 100,
  });

  it("calls few keywords on real traffic manufactured", () => {
    // aelftech.com and thegossipwire.com, both labelled manipulation by the
    // reviewer with the note "low number of organic keywords, relatively high
    // organic traffic".
    assert.equal(gateVerdict(metrics(13, 804)), "manipulation");
    assert.equal(gateVerdict(metrics(15, 6_126)), "manipulation");
  });

  it("calls few keywords on negligible traffic merely bad", () => {
    // punspoo.com at 21 visits on 21 keywords is a small site, not a fake one.
    assert.equal(gateVerdict(metrics(21, 21)), "bad");
  });

  it("is bad for every other reason a gate rejects", () => {
    assert.equal(gateVerdict(metrics(500, 50)), "bad");
    assert.equal(gateVerdict(metrics(null, 5_000)), "bad");
    assert.equal(gateVerdict(metrics(10, null)), "bad");
  });
});
