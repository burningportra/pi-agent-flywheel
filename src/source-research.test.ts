import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { extractSourceResearchCard, isIntegrationHeavyBead, sourceResearchCardPrompt } from "./plan-quality.js";

describe("source research gate", () => {
  it("detects integration-heavy beads from descriptions and package names", () => {
    expect(isIntegrationHeavyBead({
      title: "Add D1 migration adapter",
      description: "Wire Effect SQL through @effect/sql-sqlite-do and Durable Object storage.",
    })).toBe(true);

    expect(isIntegrationHeavyBead({
      title: "Refactor local formatter",
      description: "Move pure string helpers into a smaller module.",
    })).toBe(false);
  });

  it("generates the required Source Research Card fields only for integration-heavy beads", () => {
    const prompt = sourceResearchCardPrompt({
      title: "Add SDK auth middleware",
      description: "Integrate the external package auth middleware.",
    });

    expect(prompt).toContain("Source Research Card Required");
    for (const field of [
      "Sources read",
      "API contracts found",
      "Alternatives considered",
      "Selected approach",
      "Open unknowns",
      "Evidence links/paths",
    ]) {
      expect(prompt).toContain(field);
    }

    expect(sourceResearchCardPrompt({
      title: "Rename local helper",
      description: "Small internal cleanup.",
    })).toBe("");
  });

  it("extracts a submitted Source Research Card for persisted review details", () => {
    const card = extractSourceResearchCard(`Implemented the adapter.

### Source Research Card
- Sources read: node_modules/@effect/sql/README.md
- API contracts found: SqlClient transactions
- Alternatives considered: raw sqlite client
- Selected approach: Effect SQL layer
- Open unknowns: none
- Evidence links/paths: node_modules/@effect/sql

### Verification
npm test passed`);

    expect(card).toContain("### Source Research Card");
    expect(card).toContain("Sources read");
    expect(card).not.toContain("### Verification");
  });

  it("review flow warns and stores Source Research Card evidence", () => {
    const reviewSource = readFileSync(new URL("./tools/review.ts", import.meta.url), "utf8");
    expect(reviewSource).toContain("isIntegrationHeavyBead(bead)");
    expect(reviewSource).toContain("extractSourceResearchCard(reviewEvidenceText)");
    expect(reviewSource).toContain("did not include a Source Research Card");
    expect(reviewSource).toContain("sourceResearchRequired");
    expect(reviewSource).toContain("sourceResearchCard");
  });
});
