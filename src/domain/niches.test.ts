import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NICHE_PATHS, toNiche } from "./niches";

const news = (newsScope: "international" | "national" | "local", audienceCountry: string | null, newsRegion = "none") =>
  toNiche({ niche: "News", newsScope, newsRegion, audienceCountry });

describe("toNiche", () => {
  it("splits an industry path into its levels", () => {
    assert.deepEqual(toNiche({ niche: "Sports > Martial Arts > MMA", newsScope: "none", newsRegion: "none", audienceCountry: "US" }), {
      niche1: "Sports",
      niche2: "Martial Arts",
      niche3: "MMA",
    });
    assert.deepEqual(toNiche({ niche: "Sports > Martial Arts", newsScope: "none", newsRegion: "none", audienceCountry: null }), {
      niche1: "Sports",
      niche2: "Martial Arts",
      niche3: null,
    });
  });

  it("puts local news under the audience country and its listed state", () => {
    assert.deepEqual(news("local", "US", "Texas"), { niche1: "News", niche2: "United States", niche3: "Texas" });
  });

  it("drops a region that belongs to a different country", () => {
    assert.deepEqual(news("local", "GB", "Texas"), { niche1: "News", niche2: "United Kingdom", niche3: null });
  });

  it("stops national news, and countries without listed regions, at the country", () => {
    assert.deepEqual(news("national", "GB"), { niche1: "News", niche2: "United Kingdom", niche3: null });
    assert.deepEqual(news("local", "DE", "Bavaria"), { niche1: "News", niche2: "Germany", niche3: null });
  });

  it("files international news, or news with no audience country, as International", () => {
    assert.deepEqual(news("international", "US"), { niche1: "News", niche2: "International", niche3: null });
    assert.deepEqual(news("national", null), { niche1: "News", niche2: "International", niche3: null });
  });

  it("offers industry news under its industry, never under News", () => {
    assert.ok(NICHE_PATHS.includes("Lifestyle > Fashion > News"));
    assert.ok(!NICHE_PATHS.some((path) => path.startsWith("News")));
  });
});
