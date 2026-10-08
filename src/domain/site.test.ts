import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPlatformHost, normaliseDomain, parseSiteList } from "./site";

describe("normaliseDomain", () => {
  it("accepts the forms a pasted list actually contains", () => {
    for (const input of [
      "example.com",
      "www.example.com",
      "http://example.com",
      "https://example.com/",
      "https://www.example.com/some/path?utm_source=x#frag",
      "//example.com",
      "  EXAMPLE.com  ",
      "example.com.",
    ]) {
      assert.equal(normaliseDomain(input), "example.com", `failed on ${input}`);
    }
  });

  it("strips list markers left by copy-paste", () => {
    assert.equal(normaliseDomain("- example.com"), "example.com");
    assert.equal(normaliseDomain("1. example.com"), "example.com");
    assert.equal(normaliseDomain("2) example.com"), "example.com");
    assert.equal(normaliseDomain("• example.com"), "example.com");
  });

  it("strips trailing punctuation from prose and CSV quoting", () => {
    assert.equal(normaliseDomain("example.com,"), "example.com");
    assert.equal(normaliseDomain('"example.com"'), "example.com");
  });

  it("keeps a subdomain, which is a different site to buy from", () => {
    assert.equal(normaliseDomain("blog.example.com"), "blog.example.com");
    assert.equal(normaliseDomain("news.bbc.co.uk"), "news.bbc.co.uk");
  });

  it("rejects things that are not domains", () => {
    for (const input of ["", "   ", "localhost", "not a domain", "192.168.1.1", "!!!"]) {
      assert.equal(normaliseDomain(input), null, `should reject ${input}`);
    }
  });
});

describe("isPlatformHost", () => {
  it("catches hosted platforms, including their subdomains", () => {
    assert.equal(isPlatformHost("someone.blogspot.com"), true);
    assert.equal(isPlatformHost("medium.com"), true);
    assert.equal(isPlatformHost("user.github.io"), true);
  });

  it("does not catch ordinary publishers", () => {
    assert.equal(isPlatformHost("tucsonweekly.com"), false);
    assert.equal(isPlatformHost("mediumroast.com"), false);
  });
});

describe("parseSiteList", () => {
  it("collapses duplicates onto one site and keeps every input that produced it", () => {
    // Deduplication is a spend control: each survivor costs ~130 Ahrefs units.
    const { sites } = parseSiteList(
      "example.com\nhttps://www.example.com/page\nEXAMPLE.COM\nother.com",
    );
    assert.equal(sites.length, 2);
    assert.equal(sites[0]!.domain, "example.com");
    assert.equal(sites[0]!.inputs.length, 3);
    assert.equal(sites[1]!.domain, "other.com");
  });

  it("preserves first-appearance order so the export pastes back cleanly", () => {
    const { sites } = parseSiteList("c.com\na.com\nb.com\na.com");
    assert.deepEqual(
      sites.map((s) => s.domain),
      ["c.com", "a.com", "b.com"],
    );
  });

  it("splits on the separators a paste can arrive with", () => {
    const { sites } = parseSiteList("a.com, b.com;c.com\td.com\ne.com");
    assert.equal(sites.length, 5);
  });

  it("reports what it dropped rather than silently shrinking the list", () => {
    const { sites, rejected } = parseSiteList(
      "good.com\nnonsense\nsomeone.blogspot.com",
    );
    assert.equal(sites.length, 1);
    assert.equal(rejected.length, 2);
    assert.equal(rejected[0]!.reason, "not a domain");
    assert.match(rejected[1]!.reason, /platform/);
  });

  it("ignores blank lines and trailing whitespace", () => {
    const { sites, rejected } = parseSiteList("\n\n  a.com  \n\n\nb.com\n\n");
    assert.equal(sites.length, 2);
    assert.equal(rejected.length, 0);
  });
});
