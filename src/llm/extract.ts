import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { cachedSystem, EXTRACT_MODEL } from "./client";
import { taxonomyBlock } from "./taxonomy";

/**
 * Step one: what is this site, in the reviewer's own vocabulary.
 *
 * This step describes; it never judges. Everything here is an observation
 * about the homepage, and every field is passed downstream marked as
 * model-produced rather than measured — because the previous version of this
 * tool fed a low-confidence category into a judge that then treated it as
 * ground truth and failed sites for not matching it.
 */

export const SiteProfile = z.object({
  description: z
    .string()
    .describe(
      "One sentence: what this site publishes and who it serves. Concrete, no marketing language.",
    ),
  language: z
    .string()
    .describe("Primary language of the content as an ISO 639-1 code, lowercase, e.g. 'en'."),
  audienceCountry: z
    .string()
    .nullable()
    .describe(
      "The country this site's audience is in, as an ISO 3166-1 alpha-2 code, e.g. 'GB'. This is about the intended audience, not where the publisher is. Null if the site is genuinely international with no country focus.",
    ),
  siteType: z
    .enum(["news", "magazine", "blog", "corporate", "ecommerce", "directory", "other"])
    .describe(
      "What the site presents itself as. 'news' covers newspapers and local news outlets; 'magazine' covers edited publications with a subject.",
    ),
  taxonomy: z
    .array(z.string())
    .describe(
      "Up to 3 category paths, copied EXACTLY from the taxonomy list, most relevant first. Use a shorter path when no deeper one genuinely fits.",
    ),
  specificNiche: z
    .string()
    .describe(
      "The precise subject in your own words, more specific than the taxonomy allows, e.g. 'kitchen remodeling and cabinetry'. Empty string if the site has no specific subject.",
    ),
  topicBreadth: z
    .enum(["focused", "broad", "everything"])
    .describe(
      "'focused' = one subject. 'broad' = several related subjects, which is normal for news and magazines. 'everything' = unrelated verticals side by side, e.g. Health, Law, Casino, Travel, Tech in one navigation bar.",
    ),
  confidence: z
    .number()
    .describe(
      "0 to 1: how confident you are in the taxonomy and description. Below 0.5 if the homepage was thin, blocked, or genuinely incoherent.",
    ),
});

export type SiteProfile = z.infer<typeof SiteProfile>;

/**
 * The cached half of the request. Byte-stable across every site in a run —
 * anything varying per site must live in the user message instead, or the
 * cache never reads.
 */
export function extractionSystemPrompt(): string {
  return `You read the homepage of a website and describe it. You do not evaluate it.

Someone is deciding whether to buy a link on this site. Your description is the only account of what the site *is* that the later judgement step will see, so it must be accurate rather than generous. Do not describe what the site claims to be if the page shows otherwise.

Rules:
- Describe what is actually on the page. If the homepage is a thin template with a list of unrelated posts, say that.
- topicBreadth is the single most useful thing you produce. A site whose navigation offers Health, Law, Casino, Travel and Business together is 'everything'. A local newspaper covering council meetings, obituaries, high-school sport and restaurant openings is 'broad', not 'everything' — that spread is what a local paper is.
- Copy taxonomy paths EXACTLY as they appear in the list below, including capitalisation and the ' > ' separator. Never invent a path or a category name.
- The taxonomy has no News category. A newspaper's nearest path is 'Politics > Civic affairs' and that is a poor fit by construction. Set siteType to 'news' and pick the best available paths; do not stretch the description to justify the category.
- Prefer a shorter, correct path to a longer, wrong one.
- audienceCountry is about readers, not the publisher's address. A site in English covering Nigerian business news serves NG.
- Set confidence honestly. A low confidence is useful downstream; a confident guess is not.

Taxonomy paths (use these exact strings):
${taxonomyBlock()}`;
}

/** The per-site half. Everything here is unique, so it sits after the breakpoint. */
export function extractionUserPrompt(input: {
  domain: string;
  title: string;
  markdown: string;
}): string {
  return `Domain: ${input.domain}
Page title: ${input.title || "(none)"}

Homepage content as markdown:

${input.markdown}`;
}

export type ExtractionRequest = Anthropic.MessageCreateParamsNonStreaming;

/** Built once and reused for both the live path and the batch path. */
export function buildExtractionRequest(input: {
  domain: string;
  title: string;
  markdown: string;
}): ExtractionRequest {
  return {
    model: EXTRACT_MODEL,
    max_tokens: 2_000,
    system: cachedSystem(extractionSystemPrompt()),
    messages: [{ role: "user", content: extractionUserPrompt(input) }],
    output_config: { format: zodOutputFormat(SiteProfile) },
  };
}
