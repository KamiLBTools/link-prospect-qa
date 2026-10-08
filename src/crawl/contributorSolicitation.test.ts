import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { detectContributorSolicitation } from "./contributorSolicitation";

/** Wraps a fragment in the furniture the detector is scoped to. */
const inFooter = (html: string) =>
  detectContributorSolicitation(cheerio.load(`<body><footer>${html}</footer></body>`));

const inBody = (html: string) =>
  detectContributorSolicitation(cheerio.load(`<body><main>${html}</main></body>`));

describe("detectContributorSolicitation", () => {
  it("catches the plain English invitations", () => {
    for (const text of [
      "Write for us",
      "WRITE FOR US",
      "Write for Us!",
      "Guest Post",
      "Guest posting guidelines",
      "Become a contributor",
      "Submit an article",
      "Submit your guest post",
      "Publish with us",
      "Sponsored posts",
      "Writers wanted",
    ]) {
      assert.ok(
        inFooter(`<a href="/x">${text}</a>`),
        `expected a match for "${text}"`,
      );
    }
  });

  it("catches it in the href when the anchor text is something else", () => {
    // Very common: the link says "Contribute" and points at the real page.
    assert.equal(
      inFooter('<a href="/write-for-us/">Contribute</a>'),
      "link: /write-for-us",
    );
    assert.equal(
      inFooter('<a href="https://example.com/blog/guest-post">Info</a>'),
      "link: /blog-guest-post",
    );
  });

  it("catches the non-English forms the reviewer's lists actually contain", () => {
    // Every one of these is a language present in the 36-domain calibration.
    for (const text of [
      "Schrijf voor ons",
      "Gastartikel",
      "Gastbeitrag einreichen",
      "Schreibe für uns",
      "Écrivez pour nous",
      "Devenir rédacteur",
      "Escribe para nosotros",
      "Artículo invitado",
      "Scrivi per noi",
      "Escreva para nós",
    ]) {
      assert.ok(
        inFooter(`<a href="/x">${text}</a>`),
        `expected a match for "${text}"`,
      );
    }
  });

  it("returns the matched text, so a reviewer can disagree with it", () => {
    // A boolean would tell the reviewer "bad" with no way to check the rule.
    assert.equal(inFooter('<a href="/x">Write For Us</a>'), "Write For Us");
  });

  it("ignores the things every real publication has", () => {
    for (const html of [
      '<a href="/advertise">Advertise with us</a>',
      '<a href="/media-kit">Media kit</a>',
      '<a href="/contact">Contact us</a>',
      '<a href="/tips">Submit a news tip</a>',
      '<a href="/donate">Contribute</a>',
      '<a href="/newsletter">Subscribe</a>',
      '<a href="/jobs">Careers</a>',
      '<a href="/about">About us</a>',
    ]) {
      assert.equal(inFooter(html), null, `expected no match for ${html}`);
    }
  });

  it("does not fire on an article that merely discusses guest posting", () => {
    // thebrandhopper.com and troopmessenger.com are marketing publications the
    // reviewer approved; both write about outreach. A headline in the body is
    // not the site offering to sell a page.
    assert.equal(
      inBody('<a href="/blog/2024/guest-posting-strategy">The guest post playbook in 2024</a>'),
      null,
    );
  });

  it("finds it in a themed div, not only in a semantic footer", () => {
    // Most WordPress themes ship <div class="site-footer"> and no <footer>.
    const $ = cheerio.load(
      '<body><div class="site-footer widget"><a href="/write-for-us">Write for us</a></div></body>',
    );
    assert.equal(detectContributorSolicitation($), "Write for us");
  });

  it("survives a page with no links and an unparseable href", () => {
    assert.equal(inFooter("<p>no links here</p>"), null);
    assert.equal(inFooter('<a href="">Home</a>'), null);
    assert.equal(inFooter('<a href="javascript:void(0)">Menu</a>'), null);
  });

  it("does not read a third-party url as the site's own offer", () => {
    // An ad-network or analytics URL carrying the phrase in its query string
    // says nothing about this publisher. Only the path is inspected.
    assert.equal(
      inFooter('<a href="https://ads.example.com/t?campaign=sponsored-posts">Ads</a>'),
      null,
    );
  });
});

describe("the exclusions found on the reviewer's own approved sites", () => {
  it("ignores a guest-blog category, which is a section and not an offer", () => {
    // meervanmir.eu files eight recurring guest columns under
    // /category/persoonlijk/gastblog-*. The reviewer called that site good.
    const $ = cheerio.load(
      '<body><nav><a href="/category/persoonlijk/gastblog-oma">Gastblog Oma</a>' +
        '<a href="/tag/gastblogs">Gastbloggers</a></nav></body>',
    );
    assert.equal(detectContributorSolicitation($), null);
  });

  it("ignores a headline in a recent-posts card", () => {
    // tomoson.com renders post titles as <h2> inside a footer widget. An
    // article about paid posts is not a page for sale.
    const $ = cheerio.load(
      '<body><footer><div class="card"><h2><a href="/what-is-product-seeding/">' +
        "What Is Product Seeding (And When It Beats Paid Posts)</a></h2></div></footer></body>",
    );
    assert.equal(detectContributorSolicitation($), null);
  });

  it("still catches a real footer link on a site with both", () => {
    const $ = cheerio.load(
      '<body><footer><h2><a href="/blog/guest-post-tips">Guest post tips for 2024</a></h2>' +
        '<ul><li><a href="/write-for-us/">Write for Us</a></li></ul></footer></body>',
    );
    assert.equal(detectContributorSolicitation($), "Write for Us");
  });
});

describe("article slugs that merely contain the words", () => {
  it("ignores a headline-length href reached through a menu widget", () => {
    // zambianfootball.co.zm, live run of 2026-09-04: a "latest stories" menu
    // in the furniture linked a news piece about a guest contribution. The
    // href pattern fired on the slug and flagged a site that solicits nothing.
    const $ = cheerio.load(`
      <nav class="menu">
        <a href="/guest-article-wawa-chongo-legacy-kept-alive">Latest</a>
      </nav>`);
    assert.equal(detectContributorSolicitation($), null);
  });

  it("still matches the real, short invitation paths", () => {
    // Every genuine href match seen across 969 domains stays under the bound.
    for (const path of [
      "/write-for-us",
      "/colabora-con-nosotros",
      "/submit-your-story",
      "/avisos-colabora-con-nosotros",
      "/devenez-redacteur-sur-stade-html",
    ]) {
      const $ = cheerio.load(`<footer><a href="${path}">Info</a></footer>`);
      assert.ok(
        detectContributorSolicitation($),
        `expected ${path} to still match`,
      );
    }
  });
});
