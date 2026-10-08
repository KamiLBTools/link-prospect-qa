/**
 * The QA vocabulary, and the two rules that constrain what the judge is
 * allowed to return.
 *
 * The vocabulary is the reviewer's own, taken from 277 hand-labelled sites:
 * `meh` is what that sheet spelled "ok". Keeping their words matters because
 * those labels are the regression set (src/eval).
 */

/** What the judge decided about a Site. Ordered worst to best. */
export const VERDICTS = [
  "manipulation",
  "bad",
  "meh",
  "good",
  "excellent",
] as const;

export type Verdict = (typeof VERDICTS)[number];

/**
 * Where a Site got to in the pipeline. Deliberately not a Verdict: `prefail`
 * means we never looked, which is a different claim from having looked and
 * disliked what we saw — and it is the difference that lets a threshold change
 * re-run the gate without re-running the paid steps.
 */
export type RunStatus = "pending" | "prefail" | "done" | "error";

/**
 * A Site whose traffic is real but worthless is `bad`; a Site whose traffic is
 * manufactured is `manipulation`. Only these two mean "do not buy".
 */
export function isUsable(verdict: Verdict): boolean {
  return verdict !== "bad" && verdict !== "manipulation";
}

/** Position on the five-point scale, for the eval's ordinal distance metric. */
export function rank(verdict: Verdict): number {
  return VERDICTS.indexOf(verdict);
}

export function distance(a: Verdict, b: Verdict): number {
  return Math.abs(rank(a) - rank(b));
}

/**
 * Applies the niche-mismatch penalty to whatever the judge returned.
 *
 * Two rules, and the bound on the second is the important half. The reviewer's
 * instruction was "no site can be excellent with a niche mismatch" plus a
 * penalty of unstated size. It is capped at one step with a floor of `meh`
 * because niche mismatch is what wrecked the previous version of this tool: it
 * failed 142 sites, of which the reviewer judged 105 usable, and the tool's
 * own stated reason cited topical fit on 39 of them. An unbounded penalty
 * rebuilds that failure exactly.
 *
 * News and magazine Sites are exempt entirely. A local paper covering
 * obituaries, council meetings and restaurant closures has no vertical to
 * violate — that breadth is the product working. In the labelled set the
 * mismatch flag fired on 66 of the 86 news Sites the reviewer approved, so
 * applying the penalty there would demote the best segment wholesale.
 */
export function applyNichePenalty(
  verdict: Verdict,
  options: { nicheMismatch: boolean; isNewsOrMagazine: boolean },
): Verdict {
  if (!options.nicheMismatch || options.isNewsOrMagazine) return verdict;

  // Mismatch is evidence about topic, never about authenticity or worth, so it
  // can neither create a `manipulation` finding nor push a Site into `bad`.
  if (verdict === "manipulation" || verdict === "bad") return verdict;

  const floored = Math.max(rank("meh"), rank(verdict) - 1);
  return VERDICTS[floored]!;
}

export function isVerdict(value: string): value is Verdict {
  return (VERDICTS as readonly string[]).includes(value);
}

/**
 * The ceiling a homepage soliciting contributors is allowed to reach.
 *
 * Off by default. A standing invitation to contribute is a *flag*, not a
 * verdict: it is reported to the judge as evidence and carried into the CSV
 * for the reviewer, and it changes no score on its own.
 *
 * ## Why it was turned off, measured on 969 live domains
 *
 * As an automatic cap it fired on 37 sites and demoted 32 of them to `bad`,
 * 13 of which the judge had independently called `good`. Those 13 were mostly
 * news sites — todaynews.co.uk, yogonet.com, harodigital.com,
 * collegesportsmadness.com, radardemedia.ro — and they are the reviewer's
 * stated objection: a niche or local publication asking readers to submit
 * stories is describing an editorial programme, not advertising that its pages
 * are for sale. The same held on the 31 calibration labels, where the cap took
 * buy-decision accuracy from 100.0% to 83.9% and turned 3 of 11 approved sites
 * into `bad`.
 *
 * The flag itself earns its place: with it in the prompt as evidence the judge
 * moved mopoga.net from `bad` to `manipulation`, which was the reviewer's call.
 * Evidence to weigh, not a rule to apply.
 *
 * Set `SOLICITATION_CAP=bad` (or any verdict) to put the ceiling back.
 */
export const SOLICITATION_CAP: Verdict | null =
  process.env.SOLICITATION_CAP && process.env.SOLICITATION_CAP !== "none"
    ? (process.env.SOLICITATION_CAP as Verdict)
    : null;

/**
 * Caps a verdict at SOLICITATION_CAP when the homepage sells its own pages.
 *
 * Applied in code rather than asked of the model, for the same reason the
 * niche penalty is: the presence of a link is a fact about the page, and a
 * fact must not vary between two runs over identical bytes.
 */
export function applySolicitationCap(
  verdict: Verdict,
  solicitsContributors: boolean,
): Verdict {
  if (!solicitsContributors || SOLICITATION_CAP === null) return verdict;
  return rank(verdict) > rank(SOLICITATION_CAP) ? SOLICITATION_CAP : verdict;
}
