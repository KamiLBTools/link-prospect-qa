import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import pLimit from "p-limit";
import { AhrefsClient } from "../src/ahrefs/ahrefsClient";
import type { SiteMetrics } from "../src/ahrefs/types";
import { fetchHomepage } from "../src/crawl/fetchHomepage";
import { anthropic } from "../src/llm/client";
import { buildExtractionRequest, SiteProfile } from "../src/llm/extract";
import {
  collectBatch,
  jsonFromMessage,
  pollBatch,
  submitBatch,
} from "../src/llm/batch";
import { csvRow } from "../src/eval/csv";

/**
 * Fills `lang`, `niche`, `dr` and `traffic` on a sales-sheet CSV.
 *
 * Deliberately narrower than the full QA pipeline: no gate, no top pages, no
 * judge. Every domain gets Ahrefs batch analysis and a homepage description;
 * nothing is rejected or scored.
 *
 *   npx tsx scripts/enrichSelection.ts selection.csv            # price it, spend nothing
 *   npx tsx scripts/enrichSelection.ts selection.csv --run       # the real thing
 *   npx tsx scripts/enrichSelection.ts selection.csv --run --limit=20   # sanity check
 */

const CACHE_DIR = process.env.ENRICH_CACHE_DIR ?? "eval/enrich-cache";
const BATCH_CHUNK = 1_000;
const BATCH_POLL_MS = 30_000;

interface CachedSite {
  domain: string;
  metrics: SiteMetrics | null;
  fetchReason: string | null;
  profile: SiteProfile | null;
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const inputFile = args.find((arg) => !arg.startsWith("--"));
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

const EXTRACTION_COST = 4_516 * 1e-6 + 6_963 * 0.1e-6 + 112 * 5e-6;

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  mkdirSync(CACHE_DIR, { recursive: true });

  if (!inputFile) {
    console.log(
      "Usage: npx tsx scripts/enrichSelection.ts <sheet.csv> [--run] [--limit=N]",
    );
    return;
  }

  const raw = readFileSync(inputFile, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true }) as Record<
    string,
    string
  >[];
  const columns = Object.keys(rows[0] ?? {});
  if (!columns.includes("website")) {
    throw new Error(`${inputFile} has no "website" column`);
  }

  const selected = limit ? rows.slice(0, limit) : rows;
  console.log(`Input file: ${inputFile}`);
  console.log(`Rows:       ${rows.length}${limit ? ` (${selected.length} selected via --limit)` : ""}`);

  const domains = selected.map((row) => row.website!.trim().toLowerCase());
  const cached = domains.filter((domain) => existsSync(cachePath(domain))).length;
  console.log(
    `Already cached: ${cached}. To fetch: ${domains.length - cached}.\n` +
      `Ahrefs:  ~${(domains.length * 19).toLocaleString("en-US")} units worst case\n` +
      `Models:  ~$${(domains.length * EXTRACTION_COST * 0.5).toFixed(2)} (Message Batches, half price)`,
  );

  if (!flags.has("--run")) {
    console.log("\nDry run. Add --run to spend money and write the output file.");
    return;
  }

  const ahrefsKey = required("AHREFS_API_KEY");
  required("ANTHROPIC_API_KEY");
  const ahrefs = new AhrefsClient({ apiKey: ahrefsKey });
  const client = anthropic();

  const sites = new Map<string, CachedSite>(
    domains.map((domain) => [
      domain,
      readCache(domain) ?? {
        domain,
        metrics: null,
        fetchReason: null,
        profile: null,
      },
    ]),
  );

  // ── Ahrefs batch analysis ───────────────────────────────────────────────
  const needMetrics = [...sites.values()].filter((site) => site.metrics === null);
  if (needMetrics.length) {
    console.log(`\nBatch analysis for ${needMetrics.length} domains...`);
    const metrics = await withRetry("ahrefs.batchAnalysis", () =>
      ahrefs.batchAnalysis(needMetrics.map((site) => site.domain)),
    );
    for (const site of needMetrics) {
      site.metrics = metrics.get(site.domain) ?? nullMetrics(site.domain);
      writeCache(site);
    }
    console.log(`Ahrefs units spent: ${ahrefs.unitsSpent().toLocaleString("en-US")}`);
  }

  // ── Homepage + extraction, via Message Batches ──────────────────────────
  const needProfile = [...sites.values()].filter(
    (site) => site.profile === null && site.fetchReason === null,
  );
  if (needProfile.length) {
    console.log(`\nFetching and describing ${needProfile.length} homepages...`);
    await describeViaBatch(client, needProfile);
  }

  const described = [...sites.values()].filter((site) => site.profile !== null).length;
  console.log(
    `\nDescribed: ${described}/${sites.size}. Unfetched or failed: ${sites.size - described}.`,
  );

  // ── Write the enriched sheet ─────────────────────────────────────────────
  const outPath = outputPath(inputFile);
  const lines = [columns.join(",")];
  for (const row of selected) {
    const site = sites.get(row.website!.trim().toLowerCase());
    const out = { ...row };
    if (site?.metrics) {
      out.dr = site.metrics.domainRating != null ? String(site.metrics.domainRating) : "";
      out.traffic = site.metrics.organicTraffic != null ? String(site.metrics.organicTraffic) : "";
    }
    if (site?.profile) {
      out.lang = languageName(site.profile.language);
      out.niche = nicheLabel(site.profile);
    }
    lines.push(csvRow(columns.map((column) => out[column] ?? "")));
  }
  writeFileSync(outPath, `${lines.join("\n")}\n`);
  console.log(`\nWrote ${selected.length} rows to ${outPath}`);
}

/** Fetches homepages live, describes them through Message Batches. */
async function describeViaBatch(
  client: ReturnType<typeof anthropic>,
  sites: CachedSite[],
): Promise<void> {
  const userAgent = process.env.QA_USER_AGENT ?? "LinkProspectQA/1.0";
  const fetchLimit = pLimit(Number(process.env.FETCH_CONCURRENCY ?? 6));

  for (let start = 0; start < sites.length; start += BATCH_CHUNK) {
    const chunk = sites.slice(start, start + BATCH_CHUNK);
    const pages = new Map<string, { title: string; markdown: string }>();

    let fetched = 0;
    await Promise.all(
      chunk.map((site) =>
        fetchLimit(async () => {
          const page = await fetchHomepage(site.domain, { userAgent });
          if (page.kind === "failed") {
            site.fetchReason = `${page.httpStatus ?? "no response"}: ${page.reason}`;
            writeCache(site);
          } else {
            pages.set(site.domain, { title: page.title, markdown: page.markdown });
          }
          if (++fetched % 100 === 0) {
            process.stderr.write(`  fetched ${fetched}/${chunk.length}\n`);
          }
        }),
      ),
    );

    if (!pages.size) continue;
    const domains = [...pages.keys()];
    const batchId = await withRetry("submitBatch", () =>
      submitBatch(
        client,
        domains.map((domain, offset) => ({
          customId: `s${offset}`,
          params: buildExtractionRequest({ domain, ...pages.get(domain)! }),
        })),
      ),
    );
    console.log(
      `Extraction batch ${batchId} submitted with ${domains.length} homepages ` +
        `(${Math.min(start + BATCH_CHUNK, sites.length)}/${sites.length} fetched).`,
    );

    console.log(`Waiting on ${batchId}...`);
    for (;;) {
      const state = await withRetry("pollBatch", () => pollBatch(client, batchId));
      if (state.done) break;
      process.stderr.write(
        `  processing ${state.processing}, succeeded ${state.succeeded}, errored ${state.errored}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_MS));
    }

    const { parsed, errors } = await withRetry("collectBatch", () =>
      collectBatch(client, batchId, (msg) => SiteProfile.parse(jsonFromMessage(msg))),
    );
    const byDomain = new Map(chunk.map((site) => [site.domain, site]));
    for (const [customId, profile] of parsed) {
      const domain = domains[Number(customId.slice(1))];
      const site = domain ? byDomain.get(domain) : undefined;
      if (!site) continue;
      site.profile = profile;
      writeCache(site);
    }
    for (const [customId, error] of errors) {
      const domain = domains[Number(customId.slice(1))];
      const site = domain ? byDomain.get(domain) : undefined;
      if (!site) continue;
      site.fetchReason = `extraction failed: ${error}`;
      writeCache(site);
    }
  }
}

/** ISO 639-1 -> English name, for the common languages this list actually has. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German",
  it: "Italian", nl: "Dutch", pl: "Polish", ro: "Romanian", tr: "Turkish",
  ru: "Russian", uk: "Ukrainian", ar: "Arabic", he: "Hebrew", fa: "Persian",
  hi: "Hindi", ur: "Urdu", bn: "Bengali", id: "Indonesian", ms: "Malay",
  vi: "Vietnamese", th: "Thai", ko: "Korean", ja: "Japanese", zh: "Chinese",
  el: "Greek", cs: "Czech", sk: "Slovak", hu: "Hungarian", sv: "Swedish",
  no: "Norwegian", da: "Danish", fi: "Finnish", bg: "Bulgarian", hr: "Croatian",
  sr: "Serbian", sl: "Slovenian", lt: "Lithuanian", lv: "Latvian", et: "Estonian",
  sq: "Albanian", mk: "Macedonian", is: "Icelandic", ga: "Irish", cy: "Welsh",
  ca: "Catalan", eu: "Basque", gl: "Galician", sw: "Swahili", af: "Afrikaans",
  am: "Amharic", ne: "Nepali", si: "Sinhala", km: "Khmer", lo: "Lao",
  my: "Burmese", ka: "Georgian", hy: "Armenian", az: "Azerbaijani", kk: "Kazakh",
  uz: "Uzbek", mn: "Mongolian", ta: "Tamil", te: "Telugu", ml: "Malayalam",
  kn: "Kannada", gu: "Gujarati", pa: "Punjabi", mr: "Marathi",
};

function languageName(code: string): string {
  const key = code.trim().toLowerCase();
  return LANGUAGE_NAMES[key] ?? code;
}

/**
 * IAB Tier-1 -> the short single-word vocabulary already used on this sheet
 * (News, Lifestyle, Business, Tech, Sports, Gaming, Travel, Home,
 * Health & Fitness, Recipe, Crypto, Casino, Pets, Science). A normalisation
 * of the model's own taxonomy pick, not a re-classification — unmapped tiers
 * pass through as-is rather than being forced into the wrong bucket.
 */
const TIER1_TO_NICHE: Record<string, string> = {
  "Business and Finance": "Business",
  "Personal Finance": "Business",
  Careers: "Business",
  "Technology & Computing": "Tech",
  Communication: "Tech",
  "Video Gaming": "Gaming",
  "Healthy Living": "Health & Fitness",
  "Medical Health": "Health & Fitness",
  "Home & Garden": "Home",
  "Style & Fashion": "Lifestyle",
  "Family and Relationships": "Lifestyle",
  "Personal Celebrations & Life Events": "Lifestyle",
  "Pop Culture": "Lifestyle",
  "Fine Art": "Lifestyle",
  "Books and Literature": "Lifestyle",
  Entertainment: "Lifestyle",
  "Hobbies & Interests": "Lifestyle",
  Events: "Lifestyle",
  Holidays: "Lifestyle",
  Shopping: "Lifestyle",
  "Religion & Spirituality": "Lifestyle",
  Genres: "Entertainment",
  "Food & Drink": "Recipe",
  Sports: "Sports",
  Travel: "Travel",
  Attractions: "Travel",
  Pets: "Pets",
  Science: "Science",
  "War and Conflicts": "News",
  Disasters: "News",
};

function nicheLabel(profile: SiteProfile): string {
  if (profile.siteType === "news") return "News";

  const haystack = `${profile.specificNiche} ${profile.taxonomy.join(" ")}`.toLowerCase();
  if (/\b(crypto|cryptocurrency|bitcoin|blockchain|nft)\b/.test(haystack)) return "Crypto";
  if (/\b(casino|gambling|betting|poker|sportsbook)\b/.test(haystack)) return "Casino";

  const tier1 = profile.taxonomy[0]?.split(" > ")[0]?.trim();
  if (!tier1) return "";
  return TIER1_TO_NICHE[tier1] ?? tier1;
}

function outputPath(inputFile: string): string {
  return inputFile.replace(/\.csv$/i, "-enriched.csv");
}

function cachePath(domain: string): string {
  return join(CACHE_DIR, `${domain.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

function readCache(domain: string): CachedSite | null {
  const path = cachePath(domain);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CachedSite;
  } catch {
    return null;
  }
}

function writeCache(site: CachedSite): void {
  writeFileSync(cachePath(site.domain), `${JSON.stringify(site, null, 2)}\n`);
}

function nullMetrics(domain: string): SiteMetrics {
  return {
    domain,
    domainRating: null,
    organicTraffic: null,
    organicKeywords: null,
    refdomainsDofollow: null,
    linkedDomainsDofollow: null,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Retries a flaky network call rather than letting one dropped connection
 * kill an unattended multi-hour run. Five attempts, capped exponential
 * backoff — generous, because a batch job like this one is not watched
 * character by character and a slow retry costs nothing a restart wouldn't.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 5) throw error;
      const wait = Math.min(60_000, 2 ** attempt * 2_000);
      console.log(
        `  ${label} failed (attempt ${attempt}): ${message(error)} — retrying in ${wait / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
