import { z } from "zod";
import { NEWS_REGIONS, NICHE_PATHS, toNiche, nicheLabel, type Niche } from "../domain/niches";
import type { SiteProfile } from "./extract";
import { CHEAP_MODEL, CHEAP_PROVIDER, chatJson, type Usage } from "./cheapChat";

/**
 * The extraction step on a cheap open model instead of Haiku, describing each
 * Site in the agency's own niche tree (data/niches.csv).
 *
 * The answer is checked here, not by the provider (see cheapChat). A bad
 * answer is retried, and a niche that still is not in the tree falls back to
 * the part of its path that is: on gpt-oss-20b, provider-side strict mode had
 * failed 122 of 532 Sites outright (a niche or region outside the list,
 * confidence as a string, broken JSON).
 */

export { CHEAP_MODEL } from "./cheapChat";
/** Names cache directories, so two models' (or two schemas') answers never mix. */
export const CHEAP_LABEL = `${CHEAP_PROVIDER}-${CHEAP_MODEL.replace(/[^a-z0-9.]+/gi, "-")}-niches`;

const SITE_TYPES = ["news", "magazine", "blog", "corporate", "ecommerce", "directory", "other"] as const;
const NEWS_REGION_NAMES = [...new Set([...NEWS_REGIONS.values()].flat())];

export const CheapProfile = z.strictObject({
  description: z
    .string()
    .describe("One sentence in English, whatever the language of the site: what it publishes and who it serves. Concrete, no marketing language."),
  language: z.string().describe("Primary language of the content as an ISO 639-1 code, lowercase, e.g. 'en'."),
  // Still nullable: a stray null should cost a blank cell, not a failed description.
  audienceCountry: z
    .string()
    .nullable()
    .describe(
      "The country most of this site's readers are in, as an ISO 3166-1 alpha-2 code, e.g. 'GB'. About readers, not the publisher. Always give the most likely country, even for an international site; never null.",
    ),
  // A type outside the list ("nonprofit") is "other", not a failed Site.
  siteType: z.preprocess((value) => (SITE_TYPES.includes(value as never) ? value : "other"), z.enum(SITE_TYPES)),
  // Checked against the tree in code, so an invented path can be retried and logged.
  niche: z
    .string()
    .describe("The site's main subject, the most specific path from the list that genuinely fits. 'News' only for general news outlets."),
  newsScope: z
    .enum(["international", "national", "local", "none"])
    .describe("Only when niche is 'News': the geography it covers. Otherwise 'none'."),
  // Any text: a region outside the tree's list is dropped by toNiche, not failed.
  newsRegion: z
    .string()
    .describe(`Only for local news: the state or region it covers. One of: ${NEWS_REGION_NAMES.join(", ")}. Otherwise 'none'.`),
  topicBreadth: z.enum(["focused", "broad", "everything"]),
  confidence: z.coerce.number().describe("0 to 1: how confident you are in the description and niche."),
});

export type CheapProfile = z.infer<typeof CheapProfile>;

function systemPrompt(): string {
  return `You read the homepage of a website and describe it. You do not evaluate it.

Someone is deciding whether to buy a link on this site. Your description is the only account of what the site *is* that the later step will see, so it must be accurate rather than generous. Describe what is actually on the page; if the homepage is a thin template with a list of unrelated posts, say that.

Niche: pick the single path that best describes the site's MAIN subject, as specific as genuinely fits.
- A path with two parts ("Sports > Martial Arts") means the site covers that area generally. Use three parts ("Sports > Martial Arts > MMA") only when the site is mostly about that one thing.
- "News" is ONLY for general news outlets: newspapers, local news sites, national or international news. Then set newsScope, and for local news the newsRegion if it is listed.
- A site reporting news about one industry is NOT "News": it goes under its industry with "News" as the last part, e.g. "Lifestyle > Fashion > News", "Crypto > Coins > News".
- Choose from these paths exactly:
News
${NICHE_PATHS.join("\n")}

topicBreadth: 'focused' = one subject. 'broad' = several related subjects, normal for news and magazines. 'everything' = unrelated verticals side by side, e.g. Health, Law, Casino, Travel, Tech in one navigation bar. A local newspaper covering council meetings, sport and restaurants is 'broad', not 'everything'.

audienceCountry is about readers, not the publisher's address. Never leave it null: for an international site, pick the country most of its readers are likely in (often US for English-language sites). Set confidence honestly: low when the homepage is thin, blocked or incoherent.

Answer with one JSON object and nothing else, matching this JSON schema:
${JSON.stringify(z.toJSONSchema(CheapProfile))}`;
}

export interface CheapExtraction {
  raw: CheapProfile;
  /** Null when the model's answer and every retry fell outside the tree. */
  niche: Niche | null;
  /** A path the model insisted on that is not in the tree: a candidate to add. */
  inventedNiche: string | null;
  /** The same answer in the shape Jev's state was measured with. */
  profile: SiteProfile;
  usage: Usage;
}

const KNOWN = new Set(["News", ...NICHE_PATHS]);
const NICHE_1 = new Set(NICHE_PATHS.map((path) => path.split(" > ")[0]!));

/** The longest start of an invented path that is in the tree, or null. */
function nearestKnown(path: string): string | null {
  const parts = path.split(">").map((part) => part.trim());
  for (let n = parts.length - 1; n >= 2; n--) {
    const prefix = parts.slice(0, n).join(" > ");
    if (KNOWN.has(prefix)) return prefix;
  }
  return NICHE_1.has(parts[0]!) ? parts[0]! : null;
}

/** Three tries: the first deterministic, the others with a little variety. */
const ATTEMPTS = 3;

export async function extractCheaply(input: {
  domain: string;
  title: string;
  markdown: string;
}): Promise<CheapExtraction> {
  const usage: Usage = { input: 0, cachedInput: 0, output: 0 };
  let invented: CheapProfile | null = null;
  let lastError = "";

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const answer = await complete(input, attempt === 0 ? 0 : 0.5, usage);
    if (typeof answer === "string") {
      lastError = answer;
      continue;
    }
    if (KNOWN.has(answer.niche)) return result(answer, null, usage);
    invented = answer;
  }

  // Still outside the tree after every try: keep the rest of the description,
  // which Jev needs far more than the niche, and leave the niche blank.
  if (invented) return result({ ...invented, niche: nearestKnown(invented.niche) ?? "" }, invented.niche, usage);
  throw new Error(lastError);
}

/**
 * An extraction written from outside the model: a description recalled from
 * knowledge for a homepage that could not be read. A niche outside the tree is
 * dropped to its nearest known part, as for a model answer.
 */
export function extractionFrom(raw: CheapProfile): CheapExtraction {
  const known = KNOWN.has(raw.niche) ? raw.niche : (nearestKnown(raw.niche) ?? "");
  return result({ ...raw, niche: known }, known === raw.niche ? null : raw.niche, { input: 0, cachedInput: 0, output: 0 });
}

function result(raw: CheapProfile, inventedNiche: string | null, usage: Usage): CheapExtraction {
  const niche = !raw.niche
    ? null
    : raw.niche.includes(">") || raw.niche === "News"
      ? toNiche(raw)
      : { niche1: raw.niche, niche2: null, niche3: null };
  return {
    raw,
    niche,
    inventedNiche,
    profile: {
      description: raw.description,
      language: raw.language,
      audienceCountry: raw.audienceCountry,
      siteType: raw.siteType,
      taxonomy: niche ? [nicheLabel(niche)] : [],
      specificNiche: "",
      topicBreadth: raw.topicBreadth,
      confidence: raw.confidence,
    },
    usage,
  };
}

/** One parsed profile, or the reason there was none. */
async function complete(
  input: { domain: string; title: string; markdown: string },
  temperature: number,
  usage: Usage,
): Promise<CheapProfile | string> {
  const answer = await chatJson(
    systemPrompt(),
    `Domain: ${input.domain}\nPage title: ${input.title || "(none)"}\n\nHomepage content as markdown:\n\n${input.markdown}`,
    { temperature },
    usage,
  );
  if (typeof answer === "string") return answer;
  const parsed = CheapProfile.safeParse(answer.json);
  return parsed.success ? parsed.data : `unparsable answer: ${parsed.error.message.slice(0, 200)}`;
}
