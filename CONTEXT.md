# Link Prospect QA

Decides whether a website is worth buying a backlink on. Takes a list of
domains, measures them, reads them, and returns a verdict per domain with the
evidence behind it. It replaces a manual review, so it is judged on whether it
agrees with the reviewer — not on whether its reasoning sounds sensible.

## Language

**Site**:
One domain under evaluation, the unit of everything here. Identified by its
normalised host, so `https://www.example.com/page` and `example.com` are one
Site. A subdomain is a different Site, because it is a different thing to buy.
_Avoid_: website, domain, prospect, publisher

**Run**:
One list of Sites processed together. Owns the thresholds it was started with,
so its verdicts stay explainable after the defaults change.
_Avoid_: batch, job, import

**Gate**:
The cheap filter that decides which Sites are worth paying to look at properly.
A Site that does not clear it is never judged.
_Avoid_: filter, prefilter, screen

**Prefail**:
A Site the Gate rejected. Says we did not look, which is a different claim from
having looked and disliked it — and is why it is a Status rather than a Verdict.
_Avoid_: rejected, failed, filtered out

**Verdict**:
The judgement on a Site: `excellent`, `good`, `meh`, `bad` or `manipulation`.
The reviewer's own five words.
_Avoid_: score, rating, grade, result

**Meh**:
A Site that is neither good nor bad, usable depending on price, client and need.
A real verdict and a common one, not an expression of uncertainty.
_Avoid_: borderline, ok, maybe, unsure

**Manipulation**:
A Verdict meaning the traffic figure is not real readership. A claim about the
numbers, not about taste.
_Avoid_: fake, spam, fraud

**Bad**:
A Verdict meaning the traffic is genuine but worthless — real people arriving on
queries nobody competes for and nothing is earned from.
_Avoid_: low quality, poor

**Status**:
How far a Site got: `pending`, `prefail`, `done` or `error`. Orthogonal to
Verdict; a Site has one of each, never one instead of the other.
_Avoid_: state, stage (a Stage belongs to a Run)

**Profile**:
What the extraction step observed about a Site from its homepage: description,
language, audience country, site type, taxonomy, breadth. Model-produced and
carries a confidence, so downstream it is a hint and never a fact.
_Avoid_: metadata, classification, category

**Remainder**:
The top pages left after branded and navigational ones are removed. What
Manipulation is decided on. A Site with a large Remainder of coherent content is
not manipulated however much of its traffic is branded.
_Avoid_: residual, other pages

**Branded page**:
A top page whose leading keyword is the Site searching for itself. Normal and
expected for a real publication; damning only when nothing sits behind it.
_Avoid_: navigational (that is a separate, narrower kind)

**Niche mismatch**:
An observation that a Site's traffic is unrelated to what it presents itself as.
Priced by the caller as a bounded penalty; never a reason to reject a Site.
_Avoid_: irrelevant, off-topic, bad fit

**Human verdict**:
The reviewer's own Verdict on a Site, recorded after the fact. The only source
of new regression data.
_Avoid_: override, correction, feedback

## Relationships

- A **Run** has many **Sites**. A Site belongs to exactly one Run, so the same
  domain in two Runs is two Sites with two Verdicts, and their history is
  comparable.
- Ahrefs measurements are cached per domain **across** Runs, because a
  publisher does not change fast enough to justify re-buying its metrics.
- **Link Monitoring** (`../index`) takes over after a link is bought. It shares
  the host, the proxy and the crawling posture, but no data: this tool decides
  whether to buy, that one checks what was bought is still there.
