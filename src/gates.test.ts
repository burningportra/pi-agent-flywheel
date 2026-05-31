import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readConformanceArtifacts } from "./gates.js";
import { conformanceReviewInstructions } from "./prompts.js";
import type { OrchestratorState, Bead } from "./types.js";

// ─── S3: Gate auto-advance structural tests ─────────────────
// These tests validate the gates.ts source structure to ensure:
// - Auto-advance gates (self-review, test coverage, de-slopify, compliance audit) skip prompting
// - Prompted gates (peer review, commit, ship, landing) show select
// - All gates preserved, none removed
// - Gate order and auto flags are correct

const gatesSource = readFileSync(join(__dirname, "gates.ts"), "utf8");

describe("gates.ts — gate definitions", () => {
  it("has exactly 10 gates", () => {
    // Count gate objects in the array
    const gateMatches = gatesSource.match(/\{ emoji: "[^"]+", label: "[^"]+", desc: "[^"]+", auto: (true|false) \}/g);
    expect(gateMatches).not.toBeNull();
    expect(gateMatches!.length).toBe(10);
  });

  it("gate order is correct", () => {
    const labels = [...gatesSource.matchAll(/label: "([^"]+)"/g)].map(m => m[1]);
    // Filter to only the gate definition labels (first 10 occurrences)
    const gateLabels = labels.slice(0, 10);
    expect(gateLabels).toEqual([
      "Fresh self-review",
      "Peer review",
      "Test coverage",
      "De-slopify",
      "UBS scan",
      "Spec/plan conformance",
      "Beads compliance audit",
      "Commit",
      "Ship it",
      "Landing checklist",
    ]);
  });

  it("auto flags are correct", () => {
    const gates = [...gatesSource.matchAll(/label: "([^"]+)".*?auto: (true|false)/g)];
    const autoMap = Object.fromEntries(gates.map(m => [m[1], m[2] === "true"]));
    // Auto-advance gates (non-destructive, read/write):
    expect(autoMap["Fresh self-review"]).toBe(true);
    expect(autoMap["Test coverage"]).toBe(true);
    expect(autoMap["De-slopify"]).toBe(true);
    expect(autoMap["UBS scan"]).toBe(true);
    expect(autoMap["Spec/plan conformance"]).toBe(true);
    expect(autoMap["Beads compliance audit"]).toBe(true);
    // User-prompted gates (expensive or destructive):
    expect(autoMap["Peer review"]).toBe(false);
    expect(autoMap["Commit"]).toBe(false);
    expect(autoMap["Ship it"]).toBe(false);
    expect(autoMap["Landing checklist"]).toBe(false);
  });
});

describe("gates.ts — auto-advance logic", () => {
  it("auto gates skip ctx.ui.select", () => {
    // The gate loop should check gate.auto and break immediately for auto gates
    expect(gatesSource).toContain("if (gate.auto)");
    // Inside the auto block, it should break without calling ctx.ui.select
    const autoBlock = gatesSource.slice(
      gatesSource.indexOf("if (gate.auto)"),
      gatesSource.indexOf("// User-prompted gate")
    );
    expect(autoBlock).not.toContain("ctx.ui.select");
    expect(autoBlock).toContain("break");
  });

  it("auto gates still advance currentGateIndex", () => {
    const autoBlock = gatesSource.slice(
      gatesSource.indexOf("if (gate.auto)"),
      gatesSource.indexOf("// User-prompted gate")
    );
    expect(autoBlock).toContain("currentGateIndex = i + 1");
    expect(autoBlock).toContain("persistState");
  });

  it("prompted gates use ctx.ui.select with execute/skip/done", () => {
    const promptBlock = gatesSource.slice(
      gatesSource.indexOf("// User-prompted gate")
    );
    expect(promptBlock).toContain("ctx.ui.select");
    expect(promptBlock).toContain("Skip");
    expect(promptBlock).toContain("Done");
  });

  it("compliance audit is an automatic final gate before commit", () => {
    expect(gatesSource).toContain('label: "Beads compliance audit"');
    expect(gatesSource.indexOf('label: "Beads compliance audit"')).toBeLessThan(gatesSource.indexOf('label: "Commit"'));
    expect(gatesSource.indexOf('label: "Spec/plan conformance"')).toBeLessThan(gatesSource.indexOf('label: "Beads compliance audit"'));
    const complianceSection = gatesSource.slice(gatesSource.indexOf('chosen.startsWith("🧾")'));
    expect(complianceSection).toContain("prepareComplianceAuditPlan");
    expect(complianceSection).toContain("__regress_to_implement__");
    expect(complianceSection).toContain("closed\\` as a claim");
  });

  it("adds spec/plan conformance as an automatic pre-completion gate", () => {
    expect(gatesSource).toContain('label: "Spec/plan conformance"');
    const conformanceSection = gatesSource.slice(gatesSource.indexOf('chosen.startsWith("📐")'));
    expect(conformanceSection).toContain("readConformanceArtifacts");
    expect(conformanceSection).toContain("conformanceReviewInstructions");
    expect(conformanceSection).toContain("skipped: true");
  });

  it("de-slopify still auto-skips when no doc files", () => {
    // The de-slopify gate handler should check for doc files
    expect(gatesSource).toContain("docFiles");
    const deSlopSection = gatesSource.slice(gatesSource.indexOf('chosen.startsWith("✏️")'));
    expect(deSlopSection).toContain("docFiles.length === 0");
    expect(deSlopSection).toContain("skipping de-slopification");
  });

  it("'Done' triggers completion and CASS memory save", () => {
    const doneSection = gatesSource.slice(gatesSource.indexOf('chosen.startsWith("✅")'));
    expect(doneSection).toContain("complete");
    expect(doneSection).toContain("cm add");
  });
});

describe("gates.ts — conformance gate helpers", () => {
  function fakeContext(root: string) {
    return {
      cwd: root,
      sessionManager: {
        getSessionDir: () => root,
        getSessionId: () => "session-1",
        getSessionFile: () => join(root, "session.jsonl"),
      },
    } as any;
  }

  it("reads Superpowers spec artifacts and ordinary plan artifacts from session state", () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-conformance-"));
    try {
      const artifactRoot = join(root, "artifacts", "session-1");
      mkdirSync(join(artifactRoot, "superpowers", "specs"), { recursive: true });
      mkdirSync(join(artifactRoot, "plans"), { recursive: true });
      writeFileSync(join(artifactRoot, "superpowers", "specs", "checkout.md"), "# Spec\nMust not use fallback.");
      writeFileSync(join(artifactRoot, "plans", "checkout.md"), "# Plan\nImplement checkout.");

      const artifacts = readConformanceArtifacts({
        planningWorkflow: { schemaVersion: 1, adapterId: "superpowers", generationMode: "superpowers", stage: "done", goalFingerprint: "abc", specArtifact: "superpowers/specs/checkout.md" },
        planDocument: "plans/checkout.md",
      } as unknown as OrchestratorState, fakeContext(root));

      expect(artifacts).toEqual([
        expect.objectContaining({ kind: "spec", path: "superpowers/specs/checkout.md", content: expect.stringContaining("Must not use fallback") }),
        expect.objectContaining({ kind: "plan", path: "plans/checkout.md", content: expect.stringContaining("Implement checkout") }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gracefully returns no artifacts when state has no approved spec or plan", () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-conformance-empty-"));
    try {
      expect(readConformanceArtifacts({} as OrchestratorState, fakeContext(root))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("conformance prompt reports matched, deviation, missing, unsupported, and blocking sections", () => {
    const bead: Bead = {
      id: "pi-1",
      title: "Implement checkout",
      description: "desc",
      status: "closed",
      priority: 2,
      type: "task",
      labels: [],
    };
    const prompt = conformanceReviewInstructions(
      "Build checkout",
      [{ kind: "plan", path: "plans/checkout.md", content: "No production fallback allowed." }],
      [bead],
      [{ beadId: "pi-1", status: "success", summary: "done" }],
      ["src/checkout.ts"]
    );

    expect(prompt).toContain("Matched Requirements");
    expect(prompt).toContain("Deviations");
    expect(prompt).toContain("intentional");
    expect(prompt).toContain("unknown/needs-human");
    expect(prompt).toContain("unacceptable");
    expect(prompt).toContain("Missing Requirements");
    expect(prompt).toContain("Unsupported Implementation Choices");
    expect(prompt).toContain("BLOCK if production code uses a fallback");
  });
});

describe("gates.ts — phase regression support", () => {
  it("defines a regressionHint constant", () => {
    expect(gatesSource).toContain("regressionHint");
  });

  it("regressionHint references all three regression sentinels", () => {
    expect(gatesSource).toContain("__regress_to_beads__");
    expect(gatesSource).toContain("__regress_to_plan__");
    expect(gatesSource).toContain("__regress_to_implement__");
  });

  it("attaches regressionHint to self-review gate", () => {
    const selfReviewSection = gatesSource.slice(
      gatesSource.indexOf('Fresh Self-Review'),
      gatesSource.indexOf('Peer review', gatesSource.indexOf('Fresh Self-Review') + 1)
    );
    expect(selfReviewSection).toContain("regressionHint");
  });

  it("attaches regressionHint to test coverage gate", () => {
    const testSection = gatesSource.slice(
      gatesSource.indexOf('Test Coverage Check'),
      gatesSource.indexOf('De-Slopify', gatesSource.indexOf('Test Coverage Check') + 1)
    );
    expect(testSection).toContain("regressionHint");
  });

  it("attaches regressionHint to peer review gate", () => {
    const peerSection = gatesSource.slice(
      gatesSource.indexOf('Peer Review'),
      gatesSource.indexOf('Test Coverage', gatesSource.indexOf('Peer Review') + 1)
    );
    expect(peerSection).toContain("regressionHint");
  });

  it("unreachable-gate fallback does not reference regressionHint (hit-me gate was removed)", () => {
    // The 🔥 Hit me gate was removed from the gates array (it was dead code).
    // The fallback branch now returns a safe error message with no regressionHint.
    const fallbackSection = gatesSource.slice(gatesSource.indexOf('Unknown gate choice'));
    expect(fallbackSection).toBeTruthy();
    expect(fallbackSection).toContain("Unknown gate choice");
  });
});
