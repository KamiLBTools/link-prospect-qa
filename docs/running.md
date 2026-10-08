# Running Link Prospect QA

## Production QA run (`npm run qa`)

The run that feeds the agency database. No judge: gpt-oss-20b (on Groq)
describes each Site in the agency niche tree (`data/niches.csv`), and Jev's
buy / don't-buy answer decides Pass or Check.

```sh
npm run qa -- sites.csv            # counts, reused Ahrefs data, unit estimate vs units left — spends nothing
npm run qa -- sites.csv --run      # the whole run; resumable, re-run to continue
```

Needs `AHREFS_API_KEY`, `GROQ_API_KEY` and `JEV_API_KEY` in `.env`. Output is
`qa/results.csv`, one row per domain, sorted by domain:

| `qa_status` | Meaning |
| --- | --- |
| `pass` | Jev's P(buy) ≥ 0.75 (`PASS_THRESHOLD`). Measured: ~98% right on held-out labels |
| `check` | Jev saw it and was not sure enough: a person decides |
| `prefail` | Stopped by the gate; `prefail_reason` says why |
| `unfetched` | Homepage could not be read; `fetch_error` says why |
| `pending` | Not finished (units ran out, or a call failed): re-run |

`top_pages` is JSON, `[{page, traffic, keyword}]`. The four review columns
(`human_verdict`, `human_notes`, `reviewed_by`, `reviewed_at`) are carried
forward whenever the file is rewritten.

Ahrefs data is cached per domain in `qa/cache/`, and data bought by earlier runs
in the last `METRICS_CACHE_DAYS` days is reused, so a re-run or an overlapping
list never pays twice. The calibration path below still uses the judge; it is
for measuring changes against the reviewer's labels, not for production.

## Measured results

The whole 277-site regression set has been scored end to end, gate and judge,
with nothing dropped.

| | Previous tool | This tool |
| --- | --- | --- |
| Buy-decision accuracy | 55.4% | **87.7%** |
| Sites wrongly discarded | 115 | **21** |
| Bad sites wrongly approved | 5 | 13 |
| Exact label match | 46.1% | 56.0% |
| Mean label distance | 0.95 | 0.53 |

84 of those decisions came from the gate and 193 from the judge. The trade is
94 recovered sites against 8 extra bad ones admitted, which is the direction the
reviewer asked for: a site wrongly rejected is invisible until someone re-reviews
the rejects by hand, and a site wrongly approved shows up the moment they look at
what they bought.

The remaining 21 false fails are mostly `good → bad` (11) and `meh → bad` (9),
and two of them are the traffic threshold rather than the judge: `lawgaze.com` at
66 visits and `sclawyersweekly.com` at 48 both prefail on traffic < 100 and the
reviewer would have used them. That is a threshold choice, not a defect.

## What is verified against the live APIs

- **Ahrefs batch analysis.** Envelope is `{"targets": [...]}`, 19 units per row
  with our field set (not 18 — `url` costs one). `subdomains` mode and `both`
  protocol both accepted.
- **Ahrefs top pages.** Envelope is `{"pages": [...]}`, 12 units per row, and it
  returns fewer than the requested limit when the site ranks for fewer pages.
- **Prompt caching reads.** Second and subsequent extraction calls show
  `cache_read_input_tokens: 6963`, and the judge shows `2548`. Both prompts are
  already entirely inside the cached system block; there is no further caching
  win available. If either number is ever 0 across repeated calls, the
  breakpoint has moved and every request is paying full price.
- **Structured output inside Message Batches.** Parsed 2 of 2 in about 30
  seconds. `src/llm/batch.ts` parses each result itself rather than relying on
  the synchronous SDK helper.
- **Prompt caching inside Message Batches.** Across six batched judge requests,
  one wrote 3,203 tokens and the other five read them. Caching is not something
  batching gives up, so cache writes stay a rounding error at any run size.
- **`--batch` end to end.** 30 sites submitted, polled and collected through
  `npm run calibrate -- --rejudge --batch`, producing verdicts identical to the
  synchronous path and clearing its state file on success.
- **Batch envelope.** A judge request serialises to ~11.9 kB, so a 1,000-request
  chunk is 11.9 MB against the API's 256 MB and 100,000-request caps — 21×
  headroom. A 6,000-domain list is five chunks, all submitted before any is
  awaited.
- **`custom_id` format.** Must match `^[a-zA-Z0-9_-]{1,64}$`, which no domain
  satisfies, and the API rejects the entire submission rather than the offending
  row. `submitBatch` now refuses malformed and duplicate ids itself, naming the
  offender.

## What is still unverified

**The database layer and the interface.** No Postgres and no Docker exist on the
machine this was built on, so the schema, the migration, every query and every
page are typechecked and nothing more. The migration generates cleanly and the
production build passes; neither has touched a real database.

**HTTP 529 on the synchronous path.** A 193-site eval at concurrency 8 lost 49
sites to `overloaded_error` because the SDK retries twice by default. The fix is
in place — 8 retries in `src/llm/client.ts`, concurrency 4 in the eval — and
recovered 43 of 49 on the first retry pass and the rest on the second. Message
Batches, which is the production default, never exhibited it.

## First run

```sh
cp .env.example .env      # fill in AHREFS_API_KEY and ANTHROPIC_API_KEY
npm install
npm run db:migrate
npm run dev               # the interface, on /qa
npm run worker            # the pipeline, in a second terminal
```

Nothing happens without the worker: the interface only creates Runs and reads
results. A Run advances one stage per minute-tick.

## Checking it before spending on a real list

```sh
npm test                  # 48 unit tests, no network, no database
npm run typecheck
npm run eval              # baseline only — prints cost, spends nothing
```

`npm run eval` on its own is free. It loads 277 sites the reviewer labelled by
hand, prints how the previous tool scored on them, and stops.

## Calibrating on a new list

```sh
npm run calibrate -- sites.txt                 # parse, dedupe, price it — spends nothing
npm run calibrate -- sites.txt --run           # the whole pipeline, live
npm run calibrate -- sites.txt --run --batch   # same, judge at half price
npm run calibrate -- --rejudge                 # re-judge from cache — no Ahrefs, no crawling
npm run calibrate -- --score                   # score against the your_verdict column
```

Use `--batch` above a few hundred domains. It sends the judge through Message
Batches at half price, and on a list this size the money is not even the main
reason: 4,800 sites through the synchronous path at concurrency 4 is most of a
working day of requests nobody is watching.

Batch ids are written to `eval/calibration-batches.json` before the first poll
and removed once the results are collected. A batch id is durable for 29 days
and the work behind it is already paid for, so a crashed poll loop is the one
way this path can waste money — rerunning with `--batch` rejoins anything
outstanding before submitting anything new.

`--batch` covers **both** model steps. Extraction has to fetch a whole chunk of
homepages before it can submit one, so markdown is held in memory where the
live path discarded it immediately — bounded to one chunk, ~20 MB at
`BATCH_CHUNK = 1000`, rather than the ~96 MB a whole 6,000-domain list would
need. Each chunk is submitted before the next is fetched, so the crawler and
the batch queue run at the same time instead of taking turns.

This is the live path with no database: a file of domains in, `eval/calibration.csv`
out, one row per domain with the verdict, every input the judge saw, and two
empty columns — `your_verdict` and `your_reason` — for the reviewer.

It is separate from the production worker on purpose. Production wants Message
Batches (half price, arbitrary latency) and durable state. Calibration wants an
answer inside the hour and the freedom to re-judge the same sites ten times
while the rubric is being argued with.

Three things it guarantees, each of which cost something to learn:

- **Everything paid for is cached**, per domain, the moment it arrives —
  `eval/calibration-cache/`. `--rejudge` therefore costs model tokens and no
  Ahrefs units, and a crash mid-run never buys the same row twice.
- **Hand-typed labels survive a rewrite.** `your_verdict` is the only column a
  re-run cannot reproduce, so it is read back before the file is overwritten.
- **Rows never reshuffle.** Output is sorted by domain, so a reviewer working
  down a spreadsheet keeps their place between runs.

Sites that never reach the judge still appear, with the reason in the `stage`
column — `prefail: 6 organic keywords < 30`, `unfetched: 403: challenge`. A
domain missing from the report reads as an oversight; a domain present with its
reason is the answer.

## What goes in the reason cell

The judge writes **one short paragraph** and nothing else. Every top page is
appended underneath it in code, from the same rows the judge was shown:

```
Traffic is genuine German long-tail search, but the ranking set is a harvest:
mirror-hour numerology pages and third-party login hijacks, with nothing a
reader would return for.

| URL | Traffic | KW |
| https://lexicanum.de/bolt-fleet-login/ | 1,043 | bolt fleet login |
| https://lexicanum.de/13-33-uhr/ | 812 | 13.33 uhr bedeutung |
```

The split is a cost decision as much as a formatting one. Output tokens are the
largest single line in this pipeline and the one thing caching can never
discount, so anything the model retypes from data already in hand is paid for
twice. It also removes the only error a generated table can have that a
built one cannot: a mistranscribed traffic figure the reviewer then acts on.

Newlines inside a CSV cell are legal when the cell is quoted, which `csvRow`
does whenever it sees one. Spreadsheets render it as a multi-line cell.

## The bad / manipulation boundary

The reviewer relabelled seven rows of the September calibration, and every one
of them moved across this single line. Their rule, in their words:

- **`manipulation`** — the traffic figure is not real. "Low number of organic
  keywords, relatively high organic traffic" (804 visits on 13 terms; 6,126 on
  15; 194,056 on 202), or volume a site this size could not plausibly earn:
  "even though it's a recognised entity, it's not that big of an entity to get
  that volume."
- **`bad`** — the traffic is real and worth nothing. Net-worth, partner, age and
  wiki farms live here, including the ones wearing a local-news or
  lifestyle-magazine mask. Their note on six of them was simply "useless kws".

The rubric previously said the opposite about person-query farms, on the
reading that traffic existing only to be sold is manufactured. It is not: the
searches behind it are real, and the reviewer buys on that distinction.

Two consequences in code. `judgeSystemPrompt` now states the line as above, and
`gateVerdict` in `src/domain/gate.ts` reports a keyword prefail as
`manipulation` rather than `bad` when the Site also cleared the traffic floor —
few keywords *and* real traffic cannot both be honest, while few keywords on
negligible traffic is just a small site.

Measured on the 31 labels, this took the confusion matrix on that axis to
**4 of 4 `manipulation` and 12 of 12 `bad` correct**, exact label match from
61.3% to 80.6%, and mean label distance from 0.48 to 0.29.

## The "Write for us" flag

`src/crawl/contributorSolicitation.ts` reads the homepage's **header, sidebar
and footer** — the sitewide furniture — for a standing invitation to
contribute: "Write for us", "Guest post", "Submit content", and the Dutch,
German, French, Spanish, Italian and Portuguese equivalents. It fires on links
only, never body text, and skips three things that were all measured false
positives: `/category/` archives, links inside headings, and hrefs longer than
six words, which are article slugs rather than destinations.

The matched phrase goes into the CSV's `solicits_contributors` column and into
the judge's prompt as evidence.

**It is a flag, not a penalty.** Nothing in the pipeline acts on it.

### Why it is not a rule

It shipped briefly as an automatic cap at `bad`. On a 969-domain run that cap
fired on 37 sites and demoted 33 of them — 16 the judge had called `good` and
17 it had called `meh`:

```
todaynews.co.uk           news   good -> bad   "Write for us"
yogonet.com               news   good -> bad   "Guest Post"
harodigital.com           news   good -> bad   "Colabora con nosotros"
collegesportsmadness.com  news   good -> bad   "Why Write for Us"
radardemedia.ro           news   good -> bad   "Sponsored Articles & SEO..."
northiowatoday.com        news   meh  -> bad   /submit-your-story
```

Those are not sites advertising that their pages are for sale. A local or niche
publication asking readers to submit stories is describing an editorial
programme, and enthusiast sites ask people to write about what they care about.
The same showed on the 31 hand-labelled sites:

| | buy accuracy | false fails | false passes |
| --- | --- | --- | --- |
| flag as evidence (current default) | 93.5% | 2 | 0 |
| flag as evidence + cap at `bad` | 83.9-87.1% | 4-5 | 0 |
| no solicitation signal at all | 100.0% | 0 | 0 |

Three of those false fails were the cap, every run: fictionhorizon.com,
thebrandhopper.com and troymedia.com all run genuine contributor programmes and
the reviewer called all three good.

### Why the flag stays

With it in the prompt as evidence the judge moved mopoga.net from `bad` to
`manipulation`, matching the reviewer's call and their stated reason — "there
is no brand and the website has a write for us". Note the conjunction. The
solicitation was half of what they were reading; the absent brand was the other
half. That is the shape the flag is for: corroboration on a site whose
remainder is already hollow, and nothing at all on a real publication.

`SOLICITATION_CAP=bad` (or any verdict) puts the ceiling back.

## The eval

```sh
npm run eval -- --run --limit=25     # ~$0.94, stratified sample
npm run eval -- --run                # all 277; the gate handles 84 for free
npm run eval -- --run --retry-failed # judge only what a previous pass dropped
```

`--retry-failed` reads `eval/last-run.csv`, finds which labelled sites are
missing from it, judges only those, and appends. It exists because a partial run
should cost the price of what it dropped rather than a whole re-run.

Two things to know before reading its output.

**The set is not a random sample.** 264 of its 277 rows were rejected by the
previous tool, because the reviewer labelled them to audit those rejections. So
no percentage it prints is a population rate. The number that means something is
the **false-fail count** against the baseline's on the same rows.

**It scores the gate and the judge, not extraction.** The gate runs first,
exactly as in production, so a site it rejects never reaches the judge — scoring
gate rejections as judgements credited the judge with the gate's work and fed it
193 rows plus 84 it would never see. Extraction is held fixed at the previous
tool's descriptions and categories, so a change in extraction quality is
invisible here.

The organic-keywords signal cannot be scored at all: that column was never in
the original sheet, so it reaches the judge as unknown. Live, it is one of the
strongest signals available — grosswheel.com returns 6 keywords on 3,099 traffic
and prefails for 19 units instead of costing 96 more to judge.

Per-site results land in `eval/last-run.csv`, including the raw verdict before
the niche penalty, so a demotion is visible rather than folded into the result.

## Cost

Per 1,000 input domains, at the historical 80% gate survival rate:

| | |
| --- | --- |
| Ahrefs, gate | 19 units × 1,000 |
| Ahrefs, top pages | up to 120 units × 800 |
| Ahrefs total | ~115,000 units |
| Models, live | ~$10 |
| Models, `--batch` | ~$5 |

Per **1,000 sites that actually reach the judge** (i.e. after the gate), with
prompts cached throughout:

| | fresh in | cache read | output | cache write | total |
| --- | --- | --- | --- | --- | --- |
| judge, batched (Sonnet 5) | $1.13 | $0.32 | $2.15 | $0.06 | **$3.66** |
| judge, live | $2.26 | $0.64 | $4.29 | $0.13 | $7.32 |
| extraction, batched (Haiku 4.5) | $2.26 | $0.35 | $0.28 | $0.07 | **$2.96** |
| extraction, live | $4.52 | $0.70 | $0.56 | $0.14 | $5.91 |

Everything batched: **$6.62 per 1,000 judged sites**, or **$31.10 for a
6,000-domain list**. The judge ran on Opus 5 through September at $10.24 per
thousand; moving to Sonnet 5 and cutting the reason to one paragraph is where
the difference went.

### Caching and batching are different discounts, and they multiply

They act on different things, so neither cancels the other:

- **Batching** takes 50% off *every* token — input, output, cache reads, cache
  writes alike. It is a discount on the whole request.
- **Caching** takes 90% off the *repeated input prefix* only. It cannot touch
  output tokens, because nothing about a response repeats.

A cached read inside a batch therefore costs 0.1 × 0.5 = **5%** of list input
price. Measured on a real run of both steps:

| batch | requests | cache writes | cache reads | hit rate | caching saves |
| --- | --- | --- | --- | --- | --- |
| extraction (Haiku 4.5) | 8 | 6,963 tok in 1 | 48,741 tok in 7 | 88% | 36% of input |
| judge (Opus 5) | 30 | 6,406 tok in 2 | 89,684 tok in 28 | 93% | 58% of input |

The hit rate rises with batch size, because the same one or two writes are
amortised over more reads — 1,000 requests share a prefix written a handful of
times.

The reason caching *feels* inert here is real, but it is not batching: 63% of
the judge's cost is **output** tokens, which no cache can discount, because
nothing about a response repeats. Caching is doing its job on the 37% it can
reach, and doing it well.

At list prices of **$2/$10 per MTok for Sonnet 5** and $1/$5 for Haiku 4.5,
with cache reads at a tenth of input and 1-hour cache writes at double. The
token counts are measured; the dollar conversion is only as current as those
rates.

Two things about the judge line are estimates rather than measurements, because
the model and the prompt changed at the same time. The input counts were taken
on Opus 5 and Sonnet 5 may tokenise differently. And the 429 output figure is
inferred: Opus 5 returned 517 output tokens, of which only ~202 was visible
JSON — a 633-character mean reason plus the schema scaffolding — leaving ~315
tokens of adaptive thinking, billed as output and never read. The first live
batch settles both.

So a 6,000-domain list is **~690,000 Ahrefs units and $77 of model calls
batched**, or $126 live. `npm run calibrate -- list.txt` prints both before
spending anything.

### Where the model money actually goes

Measured from `usage` on live calls, per surviving site:

| | fresh in | cache read | out | cost |
| --- | --- | --- | --- | --- |
| extraction (Haiku 4.5) | 4,516 | 6,963 | 112 | $0.0058 |
| judge (Opus 5) | 1,059 | 2,548 | 553 | $0.0204 |

The judge is 78% of it, and its **553 output tokens at $25/MTok are 53% of the
total on their own** — the reason field is the most expensive thing this
pipeline produces, and it is also the thing that makes a run reviewable. That
is the trade `--batch` sidesteps by halving both sides.

Three levers were measured and rejected, so they do not have to be measured
again:

- **A 5-minute cache TTL.** Cheaper per write (1.25× base against 2×) and worse
  overall: writes happen a handful of times per run either way, while a
  5-minute entry expires inside a batch window and turns thousands of $0.0013
  reads into full-price input. The 1-hour TTL in `src/llm/client.ts` stays.
- **More prompt caching.** There is none left to win. Both system prompts are
  already the whole cached prefix, and the per-site half cannot be cached
  because it is different every time.
- **Sonnet 5 as the judge.** Saves ~26% and scored the same 93.5% buy-decision
  accuracy on the 31 labelled sites, but produced this tool's first false pass
  (mopoga.net, a site the reviewer called `manipulation`, came back `meh`) and
  drifted three approved sites to `meh` — the hedging the rubric is explicitly
  written against. `JUDGE_MODEL=claude-sonnet-5 npm run calibrate -- --rejudge`
  re-scores it from cache for about $0.40 if that judgement should be revisited.

The one lever left unpriced is `toMarkdown`'s 20,000-character ceiling. Half
the corpus hits it, so extraction input is capped rather than typical, and
lowering it would cut real tokens — at an unknown cost to the description.

The top-pages call is roughly 80% of the Ahrefs spend, which is why the gate is
an economic control and not only a quality one, and why the keyword threshold
pays: `org_keywords` costs 1 unit inside a request already being made and
rejecting on it saves up to 120. Both per-row figures are measured from Ahrefs'
own `x-api-units-cost-row` header, not estimated.

Repeated domains are free. `metrics_cache` holds Ahrefs results for
`METRICS_CACHE_DAYS` across Runs, so a domain seen last week costs nothing.

## Growing the regression set

Every run's table has a "your call" column, and the CSV export ends with
`your_verdict` and `your_reason`. Filling those in while reviewing a run is the
only way new regression data enters the system. A run reviewed without recording
the verdicts teaches nothing.
