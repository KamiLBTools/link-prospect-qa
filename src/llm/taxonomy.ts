import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The IAB Content Taxonomy 3.1, flattened to three-level paths.
 *
 * Why three and not the reviewer's requested four or five: no public taxonomy
 * that fits in a prompt actually goes that deep on the verticals this agency
 * sells into. IAB 3.1 advertises four tiers but `Home & Garden > Home
 * Improvement` is a childless leaf, and Google's topic list stops at three
 * there too. Rather than pretend, the extractor emits a taxonomy path for the
 * first three levels — a real, queryable vocabulary — and writes the specific
 * niche as free text below it.
 *
 * 704 categories, roughly 7k tokens as paths. That is the whole reason this
 * lives in the cached system prompt rather than being re-sent per request.
 */

const TSV_PATH = fileURLToPath(
  new URL("../../data/iab-content-taxonomy-3.1.tsv", import.meta.url),
);

let cached: string[] | null = null;

/** Distinct `Tier 1 > Tier 2 > Tier 3` paths, sorted, deepest form of each branch. */
export function taxonomyPaths(): string[] {
  if (cached) return cached;

  const lines = readFileSync(TSV_PATH, "utf8").split(/\r?\n/);
  const paths = new Set<string>();

  // Two header rows: a spanning label, then the column names.
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue;
    const columns = line.split("\t");
    const tiers = [columns[3], columns[4], columns[5]]
      .map((tier) => (tier ?? "").trim())
      .filter((tier) => tier !== "");
    if (tiers.length === 0) continue;
    paths.add(tiers.join(" > "));
  }

  // A parent path is kept alongside its children: a site really can be just
  // "Home & Garden" when nothing more specific fits, and forcing a third level
  // is how a classifier ends up confidently wrong.
  cached = [...paths].sort();
  return cached;
}

/** The block that goes in the extractor's cached system prompt. */
export function taxonomyBlock(): string {
  return taxonomyPaths().join("\n");
}

/** Whether a model-proposed path is really in the vocabulary. */
export function isKnownPath(path: string): boolean {
  return taxonomyPaths().includes(path.trim());
}
