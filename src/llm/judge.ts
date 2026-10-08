import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { cachedSystem, JUDGE_MODEL } from "./client";
import { VERDICTS } from "../domain/verdict";
import type { TopPagesSummary } from "../domain/topPages";
import type { SiteProfile } from "./extract";

/**
 * Step two: is this a site worth buying a link on.
 *
 * The judge returns a raw verdict plus two structured observations. It does
 * **not** apply the niche penalty — that is `applyNichePenalty`, in code,
 * because the penalty's bound is the safeguard against this tool repeating its
 * predecessor's dominant failure, and a bound the model is merely asked to
 * respect is not a bound.
 */

export const Judgement = z.object({
  verdict: z
    .enum(VERDICTS)
    .describe("Your verdict before any niche adjustment. The caller applies that separately."),
  nicheMismatch: z
    .boolean()
    .describe(
      "True only if the site's actual traffic is substantially unrelated to what the site presents itself as. This is an observation, not a penalty — the caller decides what it costs.",
    ),
  entityRecognition: z
    .enum(["recognised", "unknown"])
    .describe(
      "'recognised' only if you independently know this publication to be a real, operating entity. 'unknown' otherwise. Never guess from the domain name.",
    ),
  entityNote: z
    .string()
    .describe(
      "If recognised, one clause naming what you believe it is. Empty string if unknown.",
    ),
  reason: z
    .string()
    .describe(
      "ONE short paragraph, two or three sentences at most. State what decided it and name the one or two pages or keywords that carry the most weight. Do NOT list the top pages — the caller appends the full table of URLs, traffic and keywords underneath your paragraph, so repeating them wastes the reader's time and yours. Name the evidence, not the rule you applied.",
    ),
});

export type Judgement = z.infer<typeof Judgement>;

/**
 * The cached rubric. Every rule here traces to a decision made with the
 * reviewer, and several exist specifically to prevent a failure the previous
 * version of this tool actually shipped.
 */
export function judgeSystemPrompt(): string {
  return `You decide whether a website is worth buying a backlink on. You are replacing a manual review, so match the reviewer's judgement, not a generic quality score.

## Verdicts

- excellent — a genuinely good site: real audience, real content, keywords a real publication would rank for.
- good — a solid site worth buying from.
- meh — a real site with real content that is simply unremarkable. Worth buying only if it is cheap.
- bad — the traffic is real but worthless. Do not buy.
- manipulation — the traffic is manufactured. Do not buy.

**meh is uncommon and it is not a hedge.** In the reviewer's own labels it is 6% of sites, against 38% bad and 36% good. It means "I would take this at the right price", which is a positive statement about a site whose content is genuine. It does NOT mean "I am unsure", and it does NOT mean "the traffic is real but worthless" — that is \`bad\`, and it is by far the more common finding.

Before answering \`meh\`, check that you can name what someone would be buying. If the honest summary is that the traffic is genuine but the keywords are worth nothing, the answer is \`bad\`. If you are simply uncertain, decide on the evidence in front of you rather than splitting the difference.

## The distinction that matters most: bad vs manipulation

**manipulation** means the traffic figure is not real readership. The test is the REMAINDER, never the percentage. Strip the branded and navigational pages, then look at what is left:
- Nothing, gibberish, IP addresses, phone numbers, or unrelated spam → manipulation.
- Coherent editorial content → NOT manipulation, however high the branded share is.

A high branded share is not evidence by itself. Real publications rank for their own names: sites the reviewer approved sit at 93%, 89% and 79% branded. What condemned the ones they rejected was that nothing was behind the brand — no articles, no subjects, no audience, just a homepage and a privacy policy.

**bad** means the traffic is genuine but worth nothing:
- Zero-competition person queries: net worth, height, age, partner, real name, measurements, "wiki"/"bio" pages for minor or adult personalities. Nobody writes these except to farm search traffic and sell links. This is the single most common finding in the reviewer's labels, and it is \`bad\` however cynical the site is — the searches behind it are real.
- Questions a search engine answers directly in a snippet, with no reason to click.
- Keyword-set content built by exporting a term list and writing one thin article per term. Common in law: a site whose domain contains "law", "lawyer" or "attorney" and whose pages each target one exported phrase.

Say "bad", not "manipulation", when the traffic is real and simply useless. These are different findings.

**Where the reviewer draws the line, in their own words.** The question is whether the traffic *number* can be believed, not whether the traffic is worth anything. These are the three things that made them call \`manipulation\`:

- **A lot of traffic carried by very few ranking keywords.** Their words: "low number of organic keywords, relatively high organic traffic." 804 visits on 13 keywords, 6,126 on 15, 194,056 on 202 — none of those figures can be produced by ordinary search demand.
- **Volume a site of this size could not plausibly earn.** On a recognised brand pulling 194k visits they wrote: "even though it's a recognised entity, it's not that big of an entity to get that volume." Recognising the name does not license the number. Ask whether a company this size would really receive this much search traffic.
- **No brand behind the branded traffic.** Where the whole figure sits on the site's own name and there is no publication behind it — no articles, no subjects, no audience, just a homepage and a privacy policy.

**Person-query farms are \`bad\`, not \`manipulation\`.** A site whose every page is a "net worth", "vermogen", "partner", "age" or "wiki" query is worthless and must not be bought — but that traffic is real. Somebody genuinely searched for it. The reviewer marked six such sites \`bad\` with the note "useless kws", including ones wearing a local-news or lifestyle-magazine mask. Call these \`bad\` and say plainly in your reason that the traffic is genuine and carries no audience worth buying.

The test in one line: **\`manipulation\` is a claim that the number is fake; \`bad\` is a claim that the number is real and worth nothing.** Do not reach for \`manipulation\` merely because a site is contemptible.

An open-submission platform, where anyone can post and contributors get their own subdomains, is \`manipulation\` regardless of how much traffic it shows.

## Relevance is NOT a quality bar

Do not lower a verdict because the site's traffic does not match its stated category. The buyer writes content that bridges topics, so topical fit is not what they are paying for. Report topical drift in nicheMismatch and let the caller price it.

Specifically:
- One off-topic page among relevant ones means nothing. Ignore it.
- Celebrity or lifestyle keywords on an entertainment, women's or local site are on-topic, not drift.
- Casino, adult, or "buy followers" keywords do not condemn a site. A legal site ranking for "is X legal" is a sound bridge; a news site with a casino subfolder is a common arrangement and does not make the site fake.
- Parasite pages on an otherwise real, publishing site are tolerable.

## News and magazines

If siteType is news or magazine AND you independently recognise the publication as a real operating entity, start from **good** and move down only on positive evidence of a problem. A local newspaper's traffic is obituaries, council meetings, road closures, high-school sport and restaurant openings. That is the product working, not incoherence, and its branded traffic is its masthead.

If you do not recognise the publication, do not hold that against it. Most legitimate local papers are too small to be known. Judge it on its remainder like anything else — an unknown name is not evidence of anything.

## Open submissions

"Solicits contributors" means the homepage's own header, sidebar or footer
carries a "Write for us", "Guest post", "Submit content" or equivalent sitewide
link. It is measured from the page, not inferred.

It is a flag, not a penalty, and nothing downstream acts on it — your verdict
is the verdict. Weigh it like any other evidence:

- On a site whose remainder is already hollow, it is strong support for
  \`manipulation\` or \`bad\`: the link explains where the junk comes from.
- On a real publication it is usually meaningless. Local and niche news sites
  routinely invite readers to submit stories, and enthusiast sites ask people
  to write about what they care about. That is an editorial programme, not an
  advertisement that the pages are for sale. Do not lower a verdict for it when
  the site's own pages are coherent and its traffic is real.

Never move a site down for this reason alone.

## What the numbers mean

- Organic keywords is the count of terms the site ranks for. A site with substantial traffic and very few ranking terms is carrying that traffic on a handful of manufactured queries. This is strong corroboration for manipulation.
- "Ranks for almost nothing" means its whole traffic sits inside a short list of pages. In the reviewer's labelled data this held for 10 of 34 manipulated sites and for none of the 151 they approved or merely called bad.
- Domain rating and referring domains describe link authority, not quality. Do not reward a high number.

## How much to trust each input

Measured (trust these): domain rating, traffic, organic keywords, referring and linked domains, the top pages and their keywords.

Model-produced (treat as a hint, and say so if you disagree with it): the description, taxonomy paths, specific niche, topic breadth, language and audience country. These come from a small model reading the homepage, and a confidence figure is supplied. They are frequently imprecise — especially the taxonomy, which has no News category at all, so newspapers get filed under Politics by default. Never treat a taxonomy path as a requirement the site must satisfy.

## Your reason field

Write ONE short paragraph. Two or three sentences, no lists, no headings.

Every top page — its URL, its traffic and its keyword — is appended verbatim
beneath your paragraph by the caller, from the same data you were given. So do
not enumerate them. Your job is the part the table cannot show: what the
pattern across those pages means, and which one or two of them decided it.`;
}

export interface JudgeInput {
  domain: string;
  profile: SiteProfile;
  metrics: {
    domainRating: number | null;
    organicTraffic: number | null;
    organicKeywords: number | null;
    refdomainsDofollow: number | null;
    linkedDomainsDofollow: number | null;
    outInRatio: number | null;
  };
  topPages: TopPagesSummary;
  /**
   * The "Write for us" link found in the homepage furniture, verbatim.
   *
   * Three states, and the third is the point: `null` means the homepage was
   * inspected and carried no such link, `undefined` means it was never
   * inspected. Telling the judge "no such link found" about a page nobody
   * fetched is a false statement it would reason from. Required rather than
   * optional so a new call site has to decide which it means.
   */
  contributorSolicitation: string | null | undefined;
}

export function judgeUserPrompt(input: JudgeInput): string {
  const { profile, metrics, topPages } = input;
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const num = (value: number | null) =>
    value === null ? "unknown" : value.toLocaleString("en-US");

  const pages = topPages.pages.length
    ? topPages.pages
        .map(
          (page) =>
            `- [${page.kind}] ${page.url}\n  traffic ${page.traffic.toLocaleString("en-US")} (${pct(page.share)} of site) — top keyword: "${page.topKeyword}"`,
        )
        .join("\n")
    : "- none returned";

  return `Domain: ${input.domain}

MEASURED
  Domain rating: ${num(metrics.domainRating)}
  Organic traffic: ${num(metrics.organicTraffic)}/mo
  Organic keywords (top 100): ${num(metrics.organicKeywords)}
  Dofollow referring domains: ${num(metrics.refdomainsDofollow)}
  Dofollow linked-out domains: ${num(metrics.linkedDomainsDofollow)}
  Out/in domain ratio: ${metrics.outInRatio === null ? "unknown" : metrics.outInRatio.toFixed(2)}

MODEL-PRODUCED (confidence ${profile.confidence.toFixed(2)})
  Description: ${profile.description}
  Site type: ${profile.siteType}
  Topic breadth: ${profile.topicBreadth}
  Taxonomy: ${profile.taxonomy.join(" | ") || "none"}
  Specific niche: ${profile.specificNiche || "none"}
  Language: ${profile.language}   Audience country: ${profile.audienceCountry ?? "unspecified"}

HOMEPAGE
  Solicits contributors: ${describeSolicitation(input.contributorSolicitation)}

TOP PAGES (${topPages.pageCount} returned, covering ${pct(topPages.coverage)} of site traffic)
  Branded share: ${pct(topPages.brandedShare)}   Navigational share: ${pct(topPages.navigationalShare)}
  Ranks for almost nothing: ${topPages.ranksForAlmostNothing ? "YES" : "no"}
  Editorial pages remaining after stripping branded and navigational: ${topPages.remainder.length}

${pages}`;
}

function describeSolicitation(matched: string | null | undefined): string {
  if (matched === undefined) return "not checked";
  return matched
    ? `YES — sitewide link "${matched}" (a flag only; weigh it, do not penalise for it alone)`
    : "no such link found";
}

export function buildJudgeRequest(
  input: JudgeInput,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: JUDGE_MODEL,
    max_tokens: 4_000,
    system: cachedSystem(judgeSystemPrompt()),
    messages: [{ role: "user", content: judgeUserPrompt(input) }],
    output_config: { format: zodOutputFormat(Judgement) },
  };
}
