import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const reviewSource = readFileSync(join(__dir, "tools/review.ts"), "utf8");

describe("review.ts — automatic review decisions", () => {
  it("auto-decides hit-me versus looks-good instead of prompting the user", () => {
    const hitMeSection = reviewSource.slice(
      reviewSource.indexOf("// Hit-me flow uses two flags"),
      reviewSource.indexOf("// Auto-accepted")
    );

    expect(hitMeSection).toContain("shouldSpawnReviewPass");
    expect(hitMeSection).toContain("maxReviewPasses");
    expect(hitMeSection).toContain("Auto review pass");
    expect(hitMeSection).toContain("Auto accept");
    expect(hitMeSection).not.toContain("ctx.ui.select");
    expect(hitMeSection).not.toContain("Looks good");
  });

  it("two clean guided rounds finish automatically without a continue-review prompt", () => {
    const cleanRoundSection = reviewSource.slice(
      reviewSource.indexOf("consecutiveCleanRounds >= 2"),
      reviewSource.indexOf("return await runGuidedGates")
    );

    expect(cleanRoundSection).toContain("Auto-finish");
    expect(cleanRoundSection).toContain("autoDecided: true");
    expect(cleanRoundSection).not.toContain("ctx.ui.select");
    expect(cleanRoundSection).not.toContain("Continue reviewing");
  });

  it("allows the post-review pass call through even after the bead was marked successful", () => {
    expect(reviewSource).toContain(
      'alreadyCompleted?.status === "success" && !oc.state.beadHitMeTriggered?.[params.beadId]'
    );
  });
});
