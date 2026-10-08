# Manipulation is decided on the remainder, not the branded share

A Site is `manipulation` when its branded and navigational pages are stripped
away and what remains is nothing, gibberish, or unrelated spam. It is **not**
`manipulation` because a large share of its traffic is branded, however large
that share is.

## Why the obvious rule is wrong

Branded dominance is the intuitive test and it is what the previous tool used.
It does not separate the classes. Measured on the reviewer's labelled set:

| Branded share of top-10 traffic | Sites |
| --- | --- |
| Approved by the reviewer, above 50% | 14, including 93%, 89% and 79% |
| Rejected by the reviewer at 61% | irvingweekly.com |

`buffalonews.com` sits at 89% branded and is a real newspaper. `latimes.com` is
at 79%. A rule keyed on the percentage condemns both.

What actually separated them, in the reviewer's own words about the site they
rejected, was that "there is no value, on anything" — not the ratio, but that
nothing sat behind the brand. Strip the masthead traffic from a real paper and
local news remains; strip it from a manufactured site and a privacy policy
remains.

## Considered Options

**Threshold the branded share**, with a higher bar for recognised brands. This is
the previous tool's rule with a patch, and the patch depends on brand
recognition, which fails exactly where it is needed. A model reliably knows
`latimes.com`; it does not know `northiowatoday.com`, `gilaherald.com` or
`albertleatribune.com` — all small papers the reviewer approved, all above 63%
branded. Roughly eleven approved sites would have been called manipulated.

**Require model recognition of the entity.** Rejected as a gate for the same
reason, and kept as a bonus instead: recognition rescues the famous names and
its absence proves nothing, because most legitimate local papers are too small
to be known. The judge reports `entityRecognition` explicitly so a claim of
recognition is auditable rather than buried in prose.

## Corroborating signals

Two mechanical measures support a manipulation finding without deciding it, both
free from calls already being made:

- **Organic keywords**, at 1 unit inside the batch-analysis request. Substantial
  traffic on very few ranking terms is traffic carried by a handful of
  manufactured queries.
- **Ranks for almost nothing**: total top-10 coverage *and* fewer than ten
  ranking pages. On the labelled set this pair held for 10 of 34 manipulated
  sites and for **none** of the 151 the reviewer approved or merely called `bad`.

A refinement that sounded better and was not: traffic divided by ranking pages.
Measured, it separates the classes the wrong way round — manipulated sites sit at
661 per page against 1,541 for approved ones, because large legitimate sites
simply have high-traffic pages. It is not implemented.

## Consequences

Manipulation and `bad` stay distinct findings, which is what the reviewer asked
for: worthless-but-real traffic is `bad`, manufactured traffic is
`manipulation`, and "it's not manipulation, they are just bad keywords" is a
sentence the tool can now express.

Classification of branded and navigational pages is mechanical
(`src/domain/topPages.ts`) so the judge reasons about a clean remainder rather
than re-deriving it. Brand matching is asymmetric on purpose: a keyword
containing the brand is branded, but the brand containing a short generic
keyword is not — otherwise `buffalonews.com` ranking for "news" would be
classified as branded and the editorial evidence would disappear.
