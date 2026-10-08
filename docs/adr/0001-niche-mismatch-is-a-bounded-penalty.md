# Niche mismatch is a bounded penalty, applied in code

A Site whose traffic does not match what it presents itself as loses **one**
verdict step, floored at `meh`, and news and magazine Sites are exempt entirely.
The penalty is applied by `applyNichePenalty`, not by the judge model: the model
returns a raw verdict and a `nicheMismatch` boolean, and the arithmetic happens
afterwards.

This is the single most consequential decision in the tool, because getting it
wrong is what destroyed the previous version.

## What the predecessor did

It scored topical fit as a quality criterion. Measured against 277 sites the
reviewer labelled by hand, it rejected 142, of which **the reviewer judged 105
usable**. Its own stated reason cited topical fit on 39 of those and dismissed
branded traffic on 69. On the 86 news sites the reviewer approved it passed
**zero** — 82 `bad`, 3 `manipulation`, 1 `needs review`.

The mechanism was not a bug. Each rejection read plausibly. The category was
simply being treated as a specification the site had to satisfy, when it was
only ever a guess about the site — and a low-confidence one, flagged as such on
184 of 424 rows.

## Considered Options

**Drop topical fit entirely**, which the error analysis appears to argue for. It
was rejected by the reviewer, and they were right: the evidence establishes that
the feature *caused* the errors, not that it carries no signal. An over-weighted
correct signal and a genuinely wrong signal produce identical error tables. Their
instruction was that a niche match is a real bonus and only its strength was
wrong.

**Let the judge apply the penalty itself**, prompted with the cap. Rejected: a
bound a model is asked to respect is not a bound. This one exists specifically to
make the predecessor's failure mode structurally impossible, and a rule that
lives only in a prompt fails silently and invisibly.

**Apply it to news sites too.** Rejected on measurement. The mismatch flag fired
on 66 of the 86 news sites the reviewer approved, because IAB Content Taxonomy
3.1 has no News category at all — a local paper's nearest path is
`Politics > Civic affairs`, and its actual traffic is obituaries and restaurant
closures. The mismatch is an artefact of the vocabulary, not an observation about
the site.

## Consequences

A niche mismatch can move `excellent` to `good` and `good` to `meh`, and can do
nothing else. It can never produce `bad` or `manipulation`, so topical drift can
never on its own cause a Site to be discarded — which is the specific outcome
that cost the previous tool three quarters of its usable inventory.

The raw verdict is stored alongside the adjusted one, so every demotion is
visible in the export rather than being folded invisibly into the result.

The cost of the bound is real: a Site that genuinely deserves rejection on
grounds the judge can only express as topical drift will come out `meh` instead
of `bad`. That is the intended trade. `meh` means "usable depending on price",
and a reviewer glancing at a cheap `meh` loses less than a reviewer never seeing
105 sites they would have bought.
