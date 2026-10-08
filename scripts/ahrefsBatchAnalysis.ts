import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { AhrefsClient } from "../src/ahrefs/ahrefsClient";
import { normaliseDomain } from "../src/domain/site";
import { csvRow } from "../src/eval/csv";

/**
 * Ahrefs batch analysis only. No crawling, no niche, no language, no judge.
 *
 *   npx tsx scripts/ahrefsBatchAnalysis.ts sites.csv          # price it, spend nothing
 *   npx tsx scripts/ahrefsBatchAnalysis.ts sites.csv --run     # the real thing
 *
 * Input: a CSV with a "domain" column (or a plain one-domain-per-line file).
 * Output: <input>-ahrefs.csv with domain, dr, traffic, keywords, refdomains,
 * linked_domains — the full row `batchAnalysis` returns, at 19 units/domain.
 */

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const inputFile = args.find((arg) => !arg.startsWith("--"));

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");

  if (!inputFile) {
    console.log("Usage: npx tsx scripts/ahrefsBatchAnalysis.ts <file.csv> [--run]");
    return;
  }

  const raw = readFileSync(inputFile, "utf8");
  const rawDomains = readDomains(raw);
  const domains: string[] = [];
  const rejected: string[] = [];
  for (const input of rawDomains) {
    const normalised = normaliseDomain(input);
    if (normalised) domains.push(normalised);
    else rejected.push(input);
  }

  console.log(`Input file: ${inputFile}`);
  console.log(`Domains:    ${domains.length}`);
  if (rejected.length) {
    console.log(`Rejected:   ${rejected.length} (${rejected.join(", ")})`);
  }
  console.log(`Ahrefs:     ~${(domains.length * 19).toLocaleString("en-US")} units`);

  if (!flags.has("--run")) {
    console.log("\nDry run. Add --run to spend money and write the output file.");
    return;
  }

  const ahrefsKey = required("AHREFS_API_KEY");
  const ahrefs = new AhrefsClient({ apiKey: ahrefsKey });

  console.log(`\nBatch analysis for ${domains.length} domains...`);
  const metrics = await ahrefs.batchAnalysis(domains);
  console.log(`Ahrefs units spent: ${ahrefs.unitsSpent().toLocaleString("en-US")}`);

  const outPath = inputFile.replace(/\.csv$/i, "-ahrefs.csv");
  const header = "domain,dr,traffic,keywords,refdomains,linked_domains";
  const lines = [header];
  for (const domain of domains) {
    const m = metrics.get(domain);
    lines.push(
      csvRow([
        domain,
        m?.domainRating ?? null,
        m?.organicTraffic ?? null,
        m?.organicKeywords ?? null,
        m?.refdomainsDofollow ?? null,
        m?.linkedDomainsDofollow ?? null,
      ]),
    );
  }
  writeFileSync(outPath, `${lines.join("\n")}\n`);
  console.log(`\nWrote ${domains.length} rows to ${outPath}`);
}

/** A CSV with a "domain" column, or a bare one-domain-per-line file. */
function readDomains(raw: string): string[] {
  const rows = parse(raw, { columns: true, skip_empty_lines: true }) as Record<
    string,
    string
  >[];
  if (rows.length && rows[0]!.domain !== undefined) {
    return rows.map((row) => row.domain!.trim().toLowerCase()).filter(Boolean);
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
