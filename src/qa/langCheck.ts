import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import pLimit from "p-limit";
import { fetchHomepage } from "../crawl/fetchHomepage";
import { closeRenderer } from "../crawl/renderPage";
import { parseSiteList } from "../domain/site";
import { englishCheck, pickLanguage } from "../domain/siteLocale";
import { chatJson, type Usage } from "../llm/cheapChat";
import { csvRow } from "../eval/csv";

/**
 * The free language pre-check: fetch each homepage and sort the list into
 * English, other and check, before any Ahrefs units or model calls are spent.
 * No Ahrefs, no models.
 *
 *   npm run lang-check -- sites.csv
 *   npm run lang-check -- sites.csv --tiebreak   # gpt-oss-20b settles "check" (~$0.001 a site)
 *
 * FETCH_TIMEOUT_MS and FETCH_CONCURRENCY slow it down for a retry of sites
 * that did not answer.
 *
 * Writes qa/lang-check/<list>.csv (every site and why) and
 * qa/lang-check/<list>-english.txt, the list to hand to `npm run qa`.
 * Each result is also appended to <list>.partial.jsonl as it arrives, so a
 * stopped run resumes where it left off.
 */

const OUT_DIR = "qa/lang-check";

interface Result {
  domain: string;
  result: string;
  tag: string | null;
  detected: string | null;
  /** gpt-oss-20b's vote, asked only with --tiebreak when the tag and the detector disagree. */
  model?: string | null;
  error: string | null;
}

const usage: Usage = { input: 0, cachedInput: 0, output: 0 };

/** The model's reading of the page's main language, as an ISO 639-1 code, or null. */
async function modelLanguage(title: string, markdown: string): Promise<string | null> {
  const answer = await chatJson(
    'You identify the main language of a website\'s homepage content: the language its articles and body text are written in, ignoring navigation, cookie banners and ads. Answer with one JSON object: {"language": "<ISO 639-1 code, lowercase>"}.',
    `Page title: ${title || "(none)"}\n\n${markdown.slice(0, 6_000)}`,
    { temperature: 0 },
    usage,
  );
  if (typeof answer === "string") return null;
  const language = (answer.json as { language?: unknown }).language;
  return typeof language === "string" ? language : null;
}

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const listFile = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const tiebreak = process.argv.includes("--tiebreak");
  if (!listFile) {
    console.log("Usage: npm run lang-check -- <file of domains>");
    return;
  }
  const { sites, rejected } = parseSiteList(readFileSync(listFile, "utf8"));
  mkdirSync(OUT_DIR, { recursive: true });
  const name = basename(listFile, extname(listFile));
  const partial = join(OUT_DIR, `${name}.partial.jsonl`);
  const earlier: Result[] = existsSync(partial)
    ? readFileSync(partial, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Result)
    : [];
  const seen = new Set(earlier.map((r) => r.domain));
  const todo = sites.filter((site) => !seen.has(site.domain));
  console.log(
    `${sites.length} domains${rejected.length ? `, ${rejected.length} lines rejected` : ""}` +
      `${earlier.length ? `, ${earlier.length} already checked` : ""}. Fetching ${todo.length} homepages...`,
  );

  const userAgent = process.env.QA_USER_AGENT ?? "LinkProspectQA/1.0";
  const limit = pLimit(Number(process.env.FETCH_CONCURRENCY ?? 6));
  let done = 0;
  let failed = 0;
  const fresh = await Promise.all(
    todo.map((site) =>
      limit(async () => {
        const page = await fetchHomepage(site.domain, { userAgent, timeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 30_000) });
        if (page.kind === "failed") failed++;
        // The failure count shows a fetcher breaking down mid-run, not only at the end.
        if (++done % 100 === 0) console.log(`  ${done}/${todo.length}, unfetched so far ${failed}`);
        let result: Result =
          page.kind === "failed"
            ? { domain: site.domain, result: "unfetched", tag: null, detected: null, error: `${page.httpStatus ?? "no response"}: ${page.reason}` }
            : { domain: site.domain, result: englishCheck(page.page), tag: page.page.lang, detected: page.page.detected, error: null };
        if (tiebreak && page.kind === "ok" && result.result === "check") {
          // The model is the third vote; the majority decides, as in the QA run's Language.
          const model = await modelLanguage(page.title, page.markdown);
          const language = pickLanguage(page.page, model);
          result = { ...result, model, result: language === "en" ? "english" : language ? "other" : "check" };
        }
        appendFileSync(partial, `${JSON.stringify(result)}\n`);
        return result;
      }),
    ),
  );
  const results = [...earlier, ...fresh];
  const order = ["english", "check", "unfetched", "other"];
  results.sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result) || a.domain.localeCompare(b.domain));
  const csv = join(OUT_DIR, `${name}.csv`);
  writeFileSync(
    csv,
    `Website,Result,Page Tag,Detected,Model,Error\n${results.map((r) => csvRow([r.domain, r.result, r.tag, r.detected, r.model ?? null, r.error])).join("\n")}\n`,
  );
  const english = join(OUT_DIR, `${name}-english.txt`);
  writeFileSync(english, `${results.filter((r) => r.result === "english").map((r) => r.domain).join("\n")}\n`);

  console.log(`\nWritten ${csv} and ${english}`);
  if (tiebreak) console.log(`Tiebreak tokens: ${usage.input.toLocaleString("en-US")} in, ${usage.output.toLocaleString("en-US")} out.`);
  await closeRenderer();
  for (const result of order) console.log(`  ${result.padEnd(10)} ${results.filter((r) => r.result === result).length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
