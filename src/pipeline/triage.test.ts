import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySolicitationCap } from "../domain/verdict";
import { JEV_THRESHOLD, jevDecision } from "./triage";

const answer = (choice: string, confidence: number) => ({
  choice,
  confidence,
  probabilities: { [choice]: confidence },
});

describe("jevDecision", () => {
  it("takes Jev's verdict at or above the threshold", () => {
    const decided = jevDecision(answer("good", JEV_THRESHOLD), "blog", undefined);
    assert.equal(decided?.verdict, "good");
    assert.equal(decided?.rawVerdict, "good");
  });

  it("escalates below the threshold", () => {
    assert.equal(jevDecision(answer("good", JEV_THRESHOLD - 0.01), "blog", undefined), null);
  });

  it("escalates a choice outside the vocabulary", () => {
    assert.equal(jevDecision(answer("maybe", 0.99), "blog", undefined), null);
  });

  it("says in the reason that the judge never saw it", () => {
    const decided = jevDecision(answer("bad", 0.9), "blog", undefined);
    assert.match(decided!.reason, /^Decided by Jev at confidence 0\.90/);
  });

  it("claims no niche mismatch, so never applies the niche penalty", () => {
    const decided = jevDecision(answer("excellent", 0.9), "blog", undefined);
    assert.equal(decided?.nicheMismatch, false);
    assert.equal(decided?.nichePenaltyApplied, false);
  });

  it("applies the solicitation cap exactly as it would to a judged Site", () => {
    const capped = jevDecision(answer("excellent", 0.9), "blog", "Write for us");
    const uncapped = jevDecision(answer("excellent", 0.9), "blog", undefined);
    assert.equal(capped?.verdict, applySolicitationCap("excellent", true));
    assert.equal(uncapped?.verdict, "excellent");
  });
});
