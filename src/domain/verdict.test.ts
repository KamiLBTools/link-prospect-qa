import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyNichePenalty, distance, isUsable, VERDICTS, applySolicitationCap } from "./verdict";
import { finalise } from "../pipeline/judgeSite";

describe("applyNichePenalty", () => {
  it("leaves a matching niche alone", () => {
    for (const verdict of VERDICTS) {
      assert.equal(
        applyNichePenalty(verdict, {
          nicheMismatch: false,
          isNewsOrMagazine: false,
        }),
        verdict,
      );
    }
  });

  it("costs exactly one step, never more", () => {
    assert.equal(
      applyNichePenalty("excellent", { nicheMismatch: true, isNewsOrMagazine: false }),
      "good",
    );
    assert.equal(
      applyNichePenalty("good", { nicheMismatch: true, isNewsOrMagazine: false }),
      "meh",
    );
  });

  it("never pushes a site below meh", () => {
    // The regression. The previous tool failed 142 sites and the reviewer
    // judged 105 of them usable, with topical fit cited as the reason on 39.
    // An unbounded penalty rebuilds that failure, so `meh` is a hard floor.
    assert.equal(
      applyNichePenalty("meh", { nicheMismatch: true, isNewsOrMagazine: false }),
      "meh",
    );
  });

  it("cannot create a bad or manipulation finding", () => {
    // Mismatch is evidence about topic. It says nothing about whether the
    // traffic is real or whether the keywords are worth anything.
    assert.equal(
      applyNichePenalty("bad", { nicheMismatch: true, isNewsOrMagazine: false }),
      "bad",
    );
    assert.equal(
      applyNichePenalty("manipulation", {
        nicheMismatch: true,
        isNewsOrMagazine: false,
      }),
      "manipulation",
    );
  });

  it("exempts news and magazines entirely", () => {
    // In the labelled set the mismatch flag fired on 66 of the 86 news sites
    // the reviewer approved, because a local paper's traffic is obituaries and
    // council meetings while its assigned niche reads "Politics".
    for (const verdict of VERDICTS) {
      assert.equal(
        applyNichePenalty(verdict, {
          nicheMismatch: true,
          isNewsOrMagazine: true,
        }),
        verdict,
      );
    }
  });
});

describe("isUsable", () => {
  it("treats meh as usable, because it is a price question not a quality one", () => {
    assert.equal(isUsable("meh"), true);
    assert.equal(isUsable("good"), true);
    assert.equal(isUsable("excellent"), true);
  });

  it("treats bad and manipulation as the only do-not-buy verdicts", () => {
    assert.equal(isUsable("bad"), false);
    assert.equal(isUsable("manipulation"), false);
  });
});

describe("distance", () => {
  it("is zero for agreement and symmetric", () => {
    assert.equal(distance("good", "good"), 0);
    assert.equal(distance("bad", "excellent"), distance("excellent", "bad"));
  });

  it("punishes calling a manipulated site excellent more than calling it meh", () => {
    assert.ok(
      distance("manipulation", "excellent") > distance("manipulation", "meh"),
    );
  });
});

describe("applySolicitationCap", () => {
  it("is off by default, so a solicitation changes no verdict", () => {
    // The reviewer's rule: a standing invitation to contribute is a flag, not
    // a penalty. Local and niche news sites routinely ask readers to submit
    // stories, and that is an editorial programme rather than an offer to sell
    // pages. On 969 live domains the cap demoted 13 sites the judge called
    // good, most of them exactly that kind of publication.
    for (const verdict of VERDICTS) {
      assert.equal(applySolicitationCap(verdict, true), verdict);
      assert.equal(applySolicitationCap(verdict, false), verdict);
    }
  });
});

describe("the two code-side rules together", () => {
  const judgement = {
    verdict: "excellent" as const,
    nicheMismatch: true,
    entityRecognition: "recognised" as const,
    entityNote: "",
    reason: "",
  };

  it("applies the niche penalty and records the flag without acting on it", () => {
    // Niche mismatch alone takes excellent to good. The solicitation is
    // reported for the reviewer and passed to the judge as evidence, but with
    // the cap off it moves nothing on its own.
    const both = finalise(judgement, "blog", "Write for Us");
    assert.equal(both.rawVerdict, "excellent");
    assert.equal(both.verdict, "good");
    assert.equal(both.nichePenaltyApplied, true);
    assert.equal(both.solicitationCapApplied, false);
    assert.equal(both.contributorSolicitation, "Write for Us");
  });

  it("leaves a site alone when its homepage was never inspected", () => {
    // The eval fixture and the database path both pass undefined. Neither has
    // a homepage, and neither may cap a verdict on an absence nobody checked.
    const unchecked = finalise(judgement, "blog");
    assert.equal(unchecked.verdict, "good");
    assert.equal(unchecked.solicitationCapApplied, false);
    assert.equal(unchecked.contributorSolicitation, undefined);
  });

  it("records the link even when it changed nothing", () => {
    const already = finalise({ ...judgement, verdict: "manipulation" }, "blog", "Guest Post");
    assert.equal(already.verdict, "manipulation");
    assert.equal(already.solicitationCapApplied, false);
    assert.equal(already.contributorSolicitation, "Guest Post");
  });
});
