import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { englishCheck, pickCountry, pickLanguage } from "./siteLocale";

const page = (lang: string | null, locale: string | null = null, detected: string | null = null) => ({ lang, locale, detected });

describe("pickLanguage", () => {
  it("takes the majority of the page's tag, the text detector and the model", () => {
    // Themes leave lang="en-US" on non-English sites.
    assert.equal(pickLanguage(page("en-US", null, "mk"), "mk"), "mk");
    // The model misreads an English paper about a non-English country.
    assert.equal(pickLanguage(page("en", null, "en"), "ar"), "en");
    assert.equal(pickLanguage(page("es-MX", null, "es"), "en"), "es");
  });

  it("trusts the model when all three disagree", () => {
    assert.equal(pickLanguage(page("en-US", null, "hi"), "sw"), "sw");
  });

  it("falls back to whatever is usable", () => {
    assert.equal(pickLanguage(page(null, null, "de"), undefined), "de");
    assert.equal(pickLanguage(page("x-default", null, null), "PT"), "pt");
    assert.equal(pickLanguage(page("fr-FR"), null), "fr");
  });

  it("is blank rather than wrong when nothing usable is there", () => {
    assert.equal(pickLanguage(undefined, "null"), null);
    assert.equal(pickLanguage(page(null, null, null), undefined), null);
  });
});

describe("pickCountry", () => {
  it("trusts a real country domain first", () => {
    assert.equal(pickCountry("punchng.com.ng", page("en-US", "en_US"), "US"), "NG");
    assert.equal(pickCountry("bbc.co.uk", undefined, "US"), "GB");
    assert.equal(pickCountry("abc.net.au", undefined, null), "AU");
    assert.equal(pickCountry("spiegel.de", page("de-DE"), "US"), "DE");
    assert.equal(pickCountry("casadecampo.com.do", undefined, null), "DO");
  });

  it("ignores vanity and regional domains", () => {
    assert.equal(pickCountry("kenji.ai", undefined, "US"), "US");
    assert.equal(pickCountry("any.do", undefined, "US"), "US");
    assert.equal(pickCountry("mother.ly", undefined, "US"), "US");
    assert.equal(pickCountry("livenewschat.eu", undefined, "GB"), "GB");
  });

  it("then the model, over the page's locale tag", () => {
    // Themes ship en_GB and en_US as defaults, so a locale tag is weak evidence.
    assert.equal(pickCountry("dailytrust.com", page("en-GB", "en_GB"), "NG"), "NG");
    assert.equal(pickCountry("example.com", page("en"), "ca"), "CA");
  });

  it("uses the locale tag only when the model gave nothing usable", () => {
    assert.equal(pickCountry("example.com", page("en", "en_NG"), null), "NG");
    assert.equal(pickCountry("example.com", page("en-GB"), "EU"), "GB");
    // en_US is WordPress's and Yoast's default, left in place everywhere.
    assert.equal(pickCountry("example.com", page("en-US", "en_US"), null), null);
  });

  it("is blank when nothing usable is there", () => {
    assert.equal(pickCountry("example.com", undefined, null), null);
  });
});

describe("englishCheck", () => {
  it("is english when the tag and the detector agree, or there is no tag", () => {
    assert.equal(englishCheck(page("en-US", null, "en")), "english");
    assert.equal(englishCheck(page(null, null, "en")), "english");
  });

  it("is other when the detector finds another language the tag does not contradict", () => {
    assert.equal(englishCheck(page("es-ES", null, "es")), "other");
    assert.equal(englishCheck(page(null, null, "vi")), "other");
    assert.equal(englishCheck(page("hr", null, "sr")), "other");
  });

  it("asks a person when the tag and the detector disagree about English", () => {
    // A theme's default lang="en-US" on a Macedonian site, or an English site the detector misreads.
    assert.equal(englishCheck(page("en-US", null, "mk")), "check");
    assert.equal(englishCheck(page("ar", null, "en")), "check");
    assert.equal(englishCheck(page("en", null, null)), "check");
  });
});
