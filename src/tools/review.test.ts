import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

describe("review source research card handling", () => {
  const reviewSource = readFileSync(new URL("./review.ts", import.meta.url), "utf8");

  it("builds actionable missing Source Research Card guidance", () => {
    expect(reviewSource).toContain("missingSourceResearchCardMessage(params.beadId)");
    expect(reviewSource).toContain("ctx.ui.notify(sourceResearchMissingMessage");
  });

  it("persists and returns source research card waiver state", () => {
    expect(reviewSource).toContain("extractSourceResearchWaiver(reviewEvidenceText)");
    expect(reviewSource).toContain("sourceResearchWaived");
    expect(reviewSource).toContain("...sourceResearchDetails");
  });
});
