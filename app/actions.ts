"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "../src/db/client";
import { createRun, recordHumanVerdict } from "../src/db/queries";
import { DEFAULT_THRESHOLDS } from "../src/domain/gate";
import { isVerdict } from "../src/domain/verdict";

export async function startRun(formData: FormData): Promise<void> {
  const text = String(formData.get("domains") ?? "");
  const label = String(formData.get("label") ?? "");

  const thresholds = {
    minDomainRating: number(formData, "minDomainRating", DEFAULT_THRESHOLDS.minDomainRating),
    minOrganicTraffic: number(formData, "minOrganicTraffic", DEFAULT_THRESHOLDS.minOrganicTraffic),
    maxOutInRatio: number(formData, "maxOutInRatio", DEFAULT_THRESHOLDS.maxOutInRatio),
    minOrganicKeywords: number(formData, "minOrganicKeywords", DEFAULT_THRESHOLDS.minOrganicKeywords),
  };

  const { runId } = await createRun(db, { text, label, thresholds });
  redirect(`/qa/runs/${runId}`);
}

/**
 * The reviewer's own verdict. This is how the regression set grows, so it is a
 * normal part of reading a run rather than an admin function.
 */
export async function saveHumanVerdict(formData: FormData): Promise<void> {
  const siteId = String(formData.get("siteId") ?? "");
  const runId = String(formData.get("runId") ?? "");
  const verdict = String(formData.get("humanVerdict") ?? "");
  const reason = String(formData.get("humanReason") ?? "");

  if (siteId && isVerdict(verdict)) {
    await recordHumanVerdict(db, siteId, verdict, reason);
  }
  revalidatePath(`/qa/runs/${runId}`);
}

function number(formData: FormData, key: string, fallback: number): number {
  const parsed = Number(formData.get(key));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
