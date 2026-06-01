import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
  assessSourceResearchEvidence,
  extractSourceResearchCard,
  extractSourceResearchWaiver,
  isIntegrationHeavyBead,
  missingSourceResearchCardMessage,
  sourceResearchCardPrompt,
} from "./plan-quality.js";

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

    expect(isIntegrationHeavyBead({
      title: "Refactor local adapter helper",
      description: "Move the internal adapter class between in-repo modules; no external API or package contract is involved.",
    })).toBe(false);
  });

  it("generates the required Source Research Card fields only for integration-heavy beads", () => {
    const prompt = sourceResearchCardPrompt({
      title: "Add SDK auth middleware",
      description: "Integrate the external package auth middleware.",
    });

    expect(prompt).toContain("Source Research Card Required");
    expect(prompt).toContain("### Source Research Card");
    expect(prompt).toContain("Source Research Card: not required because");
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

  it("extracts an explicit false-positive waiver", () => {
    const waiver = extractSourceResearchWaiver(`Implemented local adapter cleanup.

Source Research Card: not required because this only moves an internal adapter helper and does not touch an external API.`);

    expect(waiver).toContain("not required because this only moves an internal adapter helper");
  });

  it("extracts a structured Source Research Card not-required rationale without duplicating because", () => {
    const waiver = extractSourceResearchWaiver(`### Source Research Card
- Not required: because this bead only renames an internal adapter.
- Evidence links/paths: src/local-adapter.ts`);

    expect(waiver).toBe("Source Research Card: not required because this bead only renames an internal adapter.");
  });

  it("formats missing-card guidance with a resolvable card and waiver path", () => {
    const message = missingSourceResearchCardMessage("topstepx-t1aba");

    expect(message).toContain("topstepx-t1aba");
    expect(message).toContain("### Source Research Card");
    expect(message).toContain("Sources read");
    expect(message).toContain("Source Research Card: not required because");
    expect(message).toContain("rerun review");
  });

  it("assesses review evidence with missing, submitted, waived, and false-positive states", () => {
    const bead = {
      title: "Add SDK auth middleware",
      description: "Integrate the external package auth middleware.",
    };

    expect(assessSourceResearchEvidence(bead, "pi-src", "Implemented and tested.")).toMatchObject({
      sourceResearchRequired: true,
      sourceResearchCard: undefined,
      sourceResearchWaived: undefined,
    });
    expect(assessSourceResearchEvidence(bead, "pi-src", "Implemented and tested.").sourceResearchMissingMessage).toContain("### Source Research Card");

    const submitted = assessSourceResearchEvidence(bead, "pi-src", `### Source Research Card
- Sources read: node_modules/sdk/README.md
- API contracts found: createMiddleware(options)
- Alternatives considered: local shim
- Selected approach: package middleware
- Open unknowns: none
- Evidence links/paths: node_modules/sdk/README.md`);
    expect(submitted.sourceResearchRequired).toBe(true);
    expect(submitted.sourceResearchCard).toContain("Sources read");
    expect(submitted.sourceResearchMissingMessage).toBeUndefined();

    const waived = assessSourceResearchEvidence(bead, "pi-src", "Source Research Card: not required because this was an internal-only adapter rename.");
    expect(waived.sourceResearchWaived).toContain("internal-only adapter rename");
    expect(waived.sourceResearchMissingMessage).toBeUndefined();

    const localOnly = assessSourceResearchEvidence({
      title: "Refactor local adapter helper",
      description: "Move the internal adapter class between in-repo modules; no external API or package contract is involved.",
    }, "pi-local", "Implemented and tested.");
    expect(localOnly).toEqual({ sourceResearchRequired: false });
  });

  it("implementation handoffs include a copy-paste card template and waiver", () => {
    const promptsSource = readFileSync(new URL("./prompts.ts", import.meta.url), "utf8");
    const swarmSource = readFileSync(new URL("./swarm.ts", import.meta.url), "utf8");

    expect(promptsSource).toContain("SOURCE_RESEARCH_CARD_TEMPLATE");
    expect(promptsSource).toContain("SOURCE_RESEARCH_WAIVER_TEMPLATE");
    expect(swarmSource).toContain("SOURCE_RESEARCH_CARD_TEMPLATE");
    expect(swarmSource).toContain("SOURCE_RESEARCH_WAIVER_TEMPLATE");
  });
});
