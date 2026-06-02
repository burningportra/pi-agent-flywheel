import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { assessSourceResearchEvidence } from "../plan-quality.js";

describe("review worker provider preflight gating", () => {
  const reviewSource = readFileSync(new URL("./review.ts", import.meta.url), "utf8");

  it("preflights automatic review workers before launch and reports degraded capacity", () => {
    expect(reviewSource).toContain("preflightWorkerProviders");
    expect(reviewSource).toContain("decideReviewWorkerLaunchSafety");
    expect(reviewSource).toContain("if (!reviewLaunchSafety.canProceed)");
    expect(reviewSource).toContain("No peer reviewers were launched");
    expect(reviewSource).toContain("Degraded Review Capacity");
    expect(reviewSource).toContain("Skipped reviewers:");
    expect(reviewSource).toContain("providerPreflight: reviewProviderPreflight");
  });
});

describe("review source research card handling", () => {
  const reviewSource = readFileSync(new URL("./review.ts", import.meta.url), "utf8");

  it("uses the real source-research evidence assessment before notifying", () => {
    expect(reviewSource).toContain("assessSourceResearchEvidence(bead, params.beadId, reviewEvidenceText)");
    expect(reviewSource).toContain("ctx.ui.notify(sourceResearchDetails.sourceResearchMissingMessage");
  });

  it("assesses the persisted state review will store and return", () => {
    const details = assessSourceResearchEvidence({
      title: "Add SDK adapter",
      description: "Integrate the package SDK adapter.",
    }, "pi-src", "Source Research Card: not required because this patch only updates internal tests.");

    expect(details).toEqual({
      sourceResearchRequired: true,
      sourceResearchCard: undefined,
      sourceResearchWaived: "Source Research Card: not required because this patch only updates internal tests.",
      sourceResearchMissingMessage: undefined,
    });
    expect(reviewSource).toContain("...sourceResearchDetails");
  });
});
