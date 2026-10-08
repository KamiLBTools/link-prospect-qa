import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  brandToken,
  isBrandedKeyword,
  isNavigationalUrl,
  summariseTopPages,
  type TopPage,
} from "./topPages";

describe("brandToken", () => {
  it("takes the distinctive part and drops punctuation", () => {
    assert.equal(brandToken("los-cerritos-news.net"), "loscerritosnews");
    assert.equal(brandToken("www.tucsonweekly.com"), "tucsonweekly");
    assert.equal(brandToken("news.bbc.co.uk"), "news");
  });
});

describe("isBrandedKeyword", () => {
  it("matches the site searching for itself, however it is spelled", () => {
    assert.equal(isBrandedKeyword("tucson weekly", "tucsonweekly.com"), true);
    assert.equal(isBrandedKeyword("grosswheel.com", "grosswheel.com"), true);
    assert.equal(isBrandedKeyword("TucsonWeekly", "tucsonweekly.com"), true);
  });

  it("matches a brand shortened to most of its name", () => {
    assert.equal(isBrandedKeyword("bulletin time", "thebulletintime.com"), true);
  });

  it("does not swallow a generic word that happens to sit inside the brand", () => {
    // The regression this asymmetry exists for. "news" is a substring of
    // "buffalonews", so naive containment would classify a real editorial query
    // as branded and hide the very traffic the remainder rule needs to see.
    assert.equal(isBrandedKeyword("news", "buffalonews.com"), false);
    assert.equal(isBrandedKeyword("weekly", "tucsonweekly.com"), false);
  });

  it("is false for unrelated queries", () => {
    assert.equal(isBrandedKeyword("kitchen remodeling cost", "tucsonweekly.com"), false);
  });

  it("refuses to guess from a very short brand", () => {
    assert.equal(isBrandedKeyword("abc", "abc.com"), false);
  });
});

describe("isNavigationalUrl", () => {
  // Half the navigational test. A page is only navigational when the query
  // agrees — see isNavigationalQuery and the archive-page regression below.
  it("catches the homepage and the site's own plumbing", () => {
    for (const url of [
      "https://example.com",
      "https://example.com/",
      "https://example.com/privacy-policy",
      "https://example.com/contact-us",
      "https://example.com/about",
      "https://example.com/write-for-us",
      "https://example.com/category/business",
      "https://example.com/tag/casino",
      "https://example.com/author/jane",
      "https://example.com/2023/04",
    ]) {
      assert.equal(isNavigationalUrl(url), true, `expected navigational: ${url}`);
    }
  });

  it("does not catch articles", () => {
    for (const url of [
      "https://example.com/kili-paul-biography/",
      "https://example.com/2023/04/snapchat-planets-in-order.html",
      "https://example.com/aboutness-of-things",
    ]) {
      assert.equal(isNavigationalUrl(url), false, `expected editorial: ${url}`);
    }
  });

  it("returns false rather than throwing on an unparseable url", () => {
    assert.equal(isNavigationalUrl("not a url"), false);
  });
});

const page = (url: string, traffic: number, topKeyword: string): TopPage => ({
  url,
  traffic,
  topKeyword,
});

describe("summariseTopPages", () => {
  it("computes coverage against the site total, not against itself", () => {
    const summary = summariseTopPages(
      [page("https://example.com/a", 200, "thing one")],
      "example.com",
      1_000,
    );
    assert.equal(summary.coverage, 0.2);
  });

  it("clamps coverage at 1 when Ahrefs' two estimates disagree", () => {
    // Site totals and per-page estimates come from different models and can
    // cross. A coverage of 1.4 would read as a signal; it is a rounding artefact.
    const summary = summariseTopPages(
      [page("https://example.com/a", 1_400, "thing")],
      "example.com",
      1_000,
    );
    assert.equal(summary.coverage, 1);
  });

  it("keeps an archive page ranking for a real topic in the remainder", () => {
    // The regression, found on live data. tucsonweekly.com's /Archives ranks
    // for "steve jobs tucson" and its /tag for "matthew mcconaughey tucson".
    // Classifying those as plumbing because of the URL empties the remainder
    // on exactly the archive-heavy local papers whose remainder is what proves
    // they are real.
    const summary = summariseTopPages(
      [
        page("https://tucsonweekly.com/Archives", 175, "steve jobs tucson"),
        page("https://tucsonweekly.com/tag", 138, "matthew mcconaughey tucson"),
        page("https://tucsonweekly.com/privacy-policy", 10, "privacy policy"),
      ],
      "tucsonweekly.com",
      1_000,
    );
    assert.deepEqual(
      summary.pages.map((p) => p.kind),
      ["editorial", "editorial", "navigational"],
    );
    assert.equal(summary.remainder.length, 2);
  });

  it("separates the remainder from branded and navigational pages", () => {
    const summary = summariseTopPages(
      [
        page("https://example.com/", 900, "example"),
        page("https://example.com/privacy-policy", 50, "privacy policy"),
        page("https://example.com/council-budget-vote", 50, "city budget vote"),
      ],
      "example.com",
      1_000,
    );
    assert.deepEqual(
      summary.pages.map((p) => p.kind),
      ["branded", "navigational", "editorial"],
    );
    assert.equal(summary.remainder.length, 1);
    assert.equal(summary.remainder[0]!.topKeyword, "city budget vote");
    assert.equal(summary.brandedShare, 0.9);
  });

  it("classifies a homepage ranking for the brand as branded, not navigational", () => {
    // Branded has to win, because it is the signal; folding it into
    // navigational would hide the thing worth looking at.
    const summary = summariseTopPages(
      [page("https://grosswheel.com/", 2_975, "grosswheel.com")],
      "grosswheel.com",
      3_283,
    );
    assert.equal(summary.pages[0]!.kind, "branded");
  });

  it("flags a site that ranks for almost nothing", () => {
    // Both conditions together held for 10 of 34 manipulated sites in the
    // labelled set and for none of the 151 the reviewer approved or called bad.
    const summary = summariseTopPages(
      [
        page("https://grosswheel.com/", 2_975, "grosswheel.com"),
        page("https://grosswheel.com/privacy", 308, "grosswheel privacy"),
      ],
      "grosswheel.com",
      3_283,
    );
    assert.equal(summary.ranksForAlmostNothing, true);
  });

  it("does not flag a site whose top ten is only part of its traffic", () => {
    const summary = summariseTopPages(
      Array.from({ length: 10 }, (_, i) =>
        page(`https://example.com/article-${i}`, 100, `topic ${i}`),
      ),
      "example.com",
      50_000,
    );
    assert.equal(summary.ranksForAlmostNothing, false);
  });

  it("does not flag a full top ten even when it covers everything", () => {
    // Ten pages covering all traffic is a small site, not a manufactured one.
    // Only the pairing of total coverage with a short list is diagnostic.
    const summary = summariseTopPages(
      Array.from({ length: 10 }, (_, i) =>
        page(`https://example.com/article-${i}`, 100, `topic ${i}`),
      ),
      "example.com",
      1_000,
    );
    assert.equal(summary.coverage, 1);
    assert.equal(summary.ranksForAlmostNothing, false);
  });

  it("survives a site with no top pages at all", () => {
    const summary = summariseTopPages([], "example.com", 1_000);
    assert.equal(summary.coverage, 0);
    assert.equal(summary.brandedShare, 0);
    assert.equal(summary.remainder.length, 0);
  });
});
