import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import {
  approvalValidationBlocksStart,
  diffBeadSnapshots,
  formatApprovalValidationWarning,
  formatDiffSummary,
  formatSpecPreview,
  isSuperpowersSpecApprovalStage,
  superpowersSpecApprovalOptions,
  verificationContractFailureLines,
  type DiffSummary,
} from "./approve.js";
import { computeConvergenceScore } from "../prompts.js";
import { createInitialState } from "../types.js";
import type { OrchestratorState } from "../types.js";
import { SUPERPOWERS_ADAPTER_ID } from "../workflows/superpowers.js";
import type { PlanningWorkflowState } from "../workflows/types.js";

// ─── Re-export tests from convergence.test.ts and diff-beads.test.ts ────
// Those files contain the bulk of tests. This file adds approve-specific
// integration tests and tests for internal helpers via public interfaces.

// ─── Structured mutation handoff guard ───────────────────────
describe("approval structured mutation handoff", () => {
  it("does not tell agents to create initial beads with raw br shell commands", () => {
    const source = readFileSync(new URL("./approve.ts", import.meta.url), "utf8");

    expect(source).toContain("staged bead mutation plan");
    expect(source).toContain("validate/apply");
    expect(source).not.toContain("using `br create` and `br dep add` in bash NOW");
    expect(source).not.toContain("create beads with `br create` first");
  });
});

// ─── descFingerprint consistency (tested indirectly via diffBeadSnapshots) ──────
describe("descFingerprint consistency via diffBeadSnapshots", () => {
  function makeSnap(entries: Record<string, { title: string; descLength: number; descFingerprint: string; files: string[] }>) {
    return new Map(Object.entries(entries));
  }

  it("identical descriptions produce no modification", () => {
    const snap = makeSnap({
      a: { title: "A", descLength: 100, descFingerprint: "100:Hello world this is a test description that is ", files: [] },
    });
    const diff = diffBeadSnapshots(snap, snap);
    expect(diff.modified).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("descriptions differing only in chars after position 50 still differ by length", () => {
    const prefix = "x".repeat(50);
    const prev = makeSnap({
      a: { title: "A", descLength: 60, descFingerprint: `60:${prefix}`, files: [] },
    });
    const curr = makeSnap({
      a: { title: "A", descLength: 70, descFingerprint: `70:${prefix}`, files: [] },
    });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].changes[0]).toContain("+10 chars");
  });

  it("descriptions with same length but different content are detected", () => {
    const prev = makeSnap({
      a: { title: "A", descLength: 10, descFingerprint: "10:aaaaaaaaaa", files: [] },
    });
    const curr = makeSnap({
      a: { title: "A", descLength: 10, descFingerprint: "10:bbbbbbbbbb", files: [] },
    });
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.modified).toHaveLength(1);
  });
});

// ─── countChanges accuracy (tested indirectly via convergence logic) ─────
describe("countChanges accuracy via convergence tracking", () => {
  it("empty snapshots produce 0 changes", () => {
    const empty = new Map();
    const diff = diffBeadSnapshots(empty, empty);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });

  it("all new beads counted as additions", () => {
    const prev = new Map();
    const curr = new Map(Object.entries({
      a: { title: "A", descLength: 10, descFingerprint: "10:a", files: [] },
      b: { title: "B", descLength: 20, descFingerprint: "20:b", files: [] },
      c: { title: "C", descLength: 30, descFingerprint: "30:c", files: [] },
    }));
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.added).toHaveLength(3);
  });

  it("all beads removed counted as removals", () => {
    const prev = new Map(Object.entries({
      a: { title: "A", descLength: 10, descFingerprint: "10:a", files: [] },
      b: { title: "B", descLength: 20, descFingerprint: "20:b", files: [] },
    }));
    const curr = new Map();
    const diff = diffBeadSnapshots(prev, curr);
    expect(diff.removed).toHaveLength(2);
  });
});

// ─── Auto-approve integration: meetsAutoApprove mirrors approve.ts logic ─
describe("auto-approve meetsAutoApprove", () => {
  function meetsAutoApprove(state: OrchestratorState): boolean {
    const autoApproveEnabled = state.autoApproveOnConvergence !== false;
    const round = state.polishRound;
    const converged = state.polishConverged;
    const convergenceScore = state.polishConvergenceScore;
    return autoApproveEnabled && round > 0 && (
      converged || (convergenceScore !== undefined && convergenceScore >= 0.90)
    );
  }

  it("does not trigger with default initial state", () => {
    const state = createInitialState();
    expect(meetsAutoApprove(state)).toBe(false);
  });

  it("triggers when both converged AND high score", () => {
    const state = createInitialState();
    state.polishRound = 4;
    state.polishConverged = true;
    state.polishConvergenceScore = 0.95;
    expect(meetsAutoApprove(state)).toBe(true);
  });

  it("convergenceScore alone is sufficient without polishConverged", () => {
    const state = createInitialState();
    state.polishRound = 2;
    state.polishConvergenceScore = 0.91;
    state.polishConverged = false;
    expect(meetsAutoApprove(state)).toBe(true);
  });

  it("polishConverged alone is sufficient without convergenceScore", () => {
    const state = createInitialState();
    state.polishRound = 5;
    state.polishConverged = true;
    // no convergenceScore set
    expect(meetsAutoApprove(state)).toBe(true);
  });
});

// ─── formatDiffSummary edge cases ────────────────────────────
describe("formatDiffSummary edge cases", () => {
  it("handles only additions", () => {
    const diff: DiffSummary = {
      added: [{ id: "a", title: "New" }, { id: "b", title: "Also new" }],
      removed: [],
      modified: [],
      unchangedCount: 0,
    };
    const text = formatDiffSummary(diff);
    expect(text).toContain("➕ Added");
    expect(text).not.toContain("➖");
    expect(text).not.toContain("✏️");
  });

  it("handles only removals", () => {
    const diff: DiffSummary = {
      added: [],
      removed: ["x", "y"],
      modified: [],
      unchangedCount: 0,
    };
    const text = formatDiffSummary(diff);
    expect(text).toContain("➖ Removed");
    expect(text).not.toContain("➕");
  });

  it("handles multiple modifications", () => {
    const diff: DiffSummary = {
      added: [],
      removed: [],
      modified: [
        { id: "a", changes: ["title changed"] },
        { id: "b", changes: ["desc +50 chars", "files: +f1"] },
      ],
      unchangedCount: 1,
    };
    const text = formatDiffSummary(diff);
    expect(text).toContain("✏️");
    expect(text).toContain("1 bead unchanged");
  });
});

// ─── S2: Simplified approval options structure ──────────────
describe("S2: simplified approval options", () => {
  // These tests validate the approve.ts source structure to ensure
  // the simplified option menus are correctly implemented.
  const { readFileSync } = require("fs");
  const { join } = require("path");
  const approveSource = readFileSync(join(__dirname, "approve.ts"), "utf8");

  it("round 0 offers Polish beads (not fresh-agent)", () => {
    expect(approveSource).toContain("🔍 Polish beads (round");
  });

  it("round 1+ offers Refine further (not same-agent)", () => {
    expect(approveSource).toContain("🔍 Refine further (round");
  });

  it("has Advanced options sub-menu", () => {
    expect(approveSource).toContain("⚙️ Advanced options...");
    expect(approveSource).toContain("Advanced refinement options");
  });

  it("Advanced sub-menu contains all specialist options", () => {
    // All specialist options should be in the advancedOptions array
    expect(approveSource).toContain("advancedOptions");
    // Fresh-agent in advanced
    const advSection = approveSource.slice(approveSource.indexOf("advancedOptions"));
    expect(advSection).toContain("Fresh-agent refinement");
    expect(advSection).toContain("Same-agent polish");
    expect(advSection).toContain("Blunder hunt");
    expect(advSection).toContain("Dedup check");
  });

  it("cross-model review only in Advanced after round 1", () => {
    // Cross-model review should be gated by round >= 1 inside the Advanced menu
    const advSection = approveSource.slice(approveSource.indexOf("advancedOptions"));
    const crossModelSection = advSection.slice(0, advSection.indexOf("advancedOptions.push(\"⬅️"));
    expect(crossModelSection).toContain("round >= 1");
    expect(crossModelSection).toContain("Cross-model review");
  });

  it("graph fix only in Advanced when issues exist", () => {
    const advSection = approveSource.slice(approveSource.indexOf("advancedOptions"));
    const graphSection = advSection.slice(0, advSection.indexOf("advancedOptions.push(\"⬅️"));
    expect(graphSection).toContain("hasGraphIssues");
    expect(graphSection).toContain("Fix graph issues");
  });

  it("maxReached shows only Start + Reject", () => {
    // When maxReached, options should only have startLabel and Reject
    expect(approveSource).toContain('if (maxReached)');
    // The maxReached block should push only 2 options
    const maxBlock = approveSource.slice(
      approveSource.indexOf("if (maxReached)"),
      approveSource.indexOf("} else {", approveSource.indexOf("if (maxReached)"))
    );
    expect(maxBlock).toContain("startLabel");
    expect(maxBlock).toContain("Reject");
    expect(maxBlock).not.toContain("Advanced");
  });

  it("'Refine further' round 1+ delegates to fresh-agent", () => {
    // The "Refine further" handler should produce freshAgent: true
    expect(approveSource).toContain("🔍 Refine further");
    const refineHandler = approveSource.slice(approveSource.indexOf("🔍 Refine further"));
    expect(refineHandler).toContain("freshAgent: true");
  });

  it("Advanced 'Back' returns to the visible approval menu without leaving the flow", () => {
    expect(approveSource).toContain("⬅️ Back");
    expect(approveSource).toContain("Main/advanced menu loop");
    expect(approveSource).toContain("choice = undefined;");
    expect(approveSource).toContain("choice = await ctx.ui.select(approvalPrompt, options)");
  });
});

describe("verification contract approval gate", () => {
  const baseValidation = {
    ok: true,
    orphaned: [],
    cycles: false,
    warnings: [],
    shallowBeads: [],
    templateIssues: [],
    verificationIssues: [],
  };

  it("blocks approval and identifies the bead when ### Verification: is missing", () => {
    const validation = {
      ...baseValidation,
      ok: false,
      verificationIssues: [{
        beadId: "pi-missing",
        issueType: "missing-section" as const,
        reason: "bead pi-missing is missing required ### Verification: section",
      }],
    };

    expect(approvalValidationBlocksStart(validation)).toBe(true);
    expect(verificationContractFailureLines(validation)).toEqual([
      "- bead pi-missing is missing required ### Verification: section",
    ]);
    expect(formatApprovalValidationWarning(validation)).toContain("approval blocked");
    expect(formatApprovalValidationWarning(validation)).toContain("bead pi-missing is missing required ### Verification: section");
  });

  it("blocks approval and names each missing verification component", () => {
    const validation = {
      ...baseValidation,
      ok: false,
      verificationIssues: [
        {
          beadId: "pi-incomplete",
          issueType: "missing-requirement" as const,
          requirement: "commands-checks" as const,
          reason: "bead pi-incomplete verification section is missing commands/checks",
          excerpt: "Success looks like: green output",
        },
        {
          beadId: "pi-incomplete",
          issueType: "missing-requirement" as const,
          requirement: "success-expectations" as const,
          reason: "bead pi-incomplete verification section is missing success expectations",
        },
        {
          beadId: "pi-incomplete",
          issueType: "missing-requirement" as const,
          requirement: "manual-proof" as const,
          reason: "bead pi-incomplete verification section is missing manual proof guidance",
        },
      ],
    };

    const warning = formatApprovalValidationWarning(validation);
    expect(approvalValidationBlocksStart(validation)).toBe(true);
    expect(warning).toContain("pi-incomplete verification section is missing commands/checks");
    expect(warning).toContain("pi-incomplete verification section is missing success expectations");
    expect(warning).toContain("pi-incomplete verification section is missing manual proof guidance");
    expect(warning).toContain("excerpt: Success looks like: green output");
  });

  it("does not block approval when verification validation passes", () => {
    const validation = { ...baseValidation };

    expect(approvalValidationBlocksStart(validation)).toBe(false);
    expect(verificationContractFailureLines(validation)).toEqual([]);
    expect(formatApprovalValidationWarning(validation)).not.toContain("Verification contracts");
  });

  it("preserves existing Files and template hygiene warning text", () => {
    const validation = {
      ...baseValidation,
      ok: false,
      shallowBeads: [{ id: "pi-files", reason: "Missing ### Files: section" }],
      templateIssues: [{
        beadId: "pi-template",
        issueType: "unresolved-placeholder",
        excerpt: "{{testFile}}",
        reason: "bead pi-template still contains an unresolved template placeholder",
      }],
    };

    const warning = formatApprovalValidationWarning(validation);
    expect(approvalValidationBlocksStart(validation)).toBe(false);
    expect(warning).toContain("pi-files (Missing ### Files: section)");
    expect(warning).toContain("Template hygiene");
    expect(warning).toContain("pi-template (unresolved-placeholder: {{testFile}})");
  });
});

describe("plan-to-bead audit integration", () => {
  const { readFileSync } = require("fs");
  const { join } = require("path");
  const approveSource = readFileSync(join(__dirname, "approve.ts"), "utf8");

  it("audits beads against a saved plan artifact when available", () => {
    expect(approveSource).toContain("auditPlanToBeads");
    expect(approveSource).toContain("formatPlanToBeadAuditWarnings");
    expect(approveSource).toContain("oc.state.planDocument");
  });

  it("launches implementation through NTM instead of inline/subagent work", () => {
    expect(approveSource).toContain("Launch the NTM implementation swarm now");
    expect(approveSource).toContain("Do not implement these beads inline");
    expect(approveSource).not.toContain("Implement bead ${firstBead.id} NOW");
    expect(approveSource).not.toContain("parallel_subagents` NOW to launch");
  });
});

// ─── Superpowers spec approval gate ───────────────────────────
describe("Superpowers spec approval — isSuperpowersSpecApprovalStage", () => {
  function makeSpecState(overrides: Partial<PlanningWorkflowState> = {}): OrchestratorState {
    const state = createInitialState();
    const wf: PlanningWorkflowState = {
      schemaVersion: 1,
      adapterId: SUPERPOWERS_ADAPTER_ID,
      stage: "awaiting_spec_approval",
      generationMode: "superpowers",
      goalFingerprint: "f".repeat(64),
      specArtifact: "superpowers/specs/example.md",
      specRefinementRound: 0,
      ...overrides,
    };
    state.planningWorkflow = wf;
    return state;
  }

  it("returns true when stage is awaiting_spec_approval and specArtifact is set", () => {
    expect(isSuperpowersSpecApprovalStage(makeSpecState())).toBe(true);
  });

  it("returns false when there is no planning workflow at all", () => {
    const state = createInitialState();
    expect(isSuperpowersSpecApprovalStage(state)).toBe(false);
  });

  it("returns false when the workflow is using the native adapter", () => {
    expect(
      isSuperpowersSpecApprovalStage(
        makeSpecState({ adapterId: "native", generationMode: "native" }),
      ),
    ).toBe(false);
  });

  it("returns false when stage is awaiting_plan_approval (implementation plan)", () => {
    expect(isSuperpowersSpecApprovalStage(makeSpecState({ stage: "awaiting_plan_approval" }))).toBe(false);
  });

  it("returns false when specArtifact is missing", () => {
    expect(isSuperpowersSpecApprovalStage(makeSpecState({ specArtifact: undefined }))).toBe(false);
  });
});

describe("Superpowers spec approval — formatSpecPreview", () => {
  it("renders spec-flavored copy and never the implementation-plan vocabulary", () => {
    const spec = "# Goal\n\n## 1. Problem Statement\nshort\n\n## 2. Desired Behavior\nshort";
    const preview = formatSpecPreview(spec);
    expect(preview).toContain("Spec artifact preview");
    expect(preview).not.toContain("Plan artifact preview");
    expect(preview).toContain("Sections");
  });

  it("truncates long specs and reports total length", () => {
    const spec = `# Section\n${"line\n".repeat(40)}`;
    const preview = formatSpecPreview(spec);
    expect(preview).toContain(`${spec.split("\n").length} lines`);
    expect(preview).toContain(`${spec.length} chars`);
  });
});

describe("Superpowers spec approval — approval options", () => {
  it("never includes implementation-plan or bead-creation copy", () => {
    const options = superpowersSpecApprovalOptions(0);
    expect(options.length).toBe(3);
    expect(options[0]).toContain("Accept spec and generate implementation plan");
    expect(options[1]).toContain("Refine spec (round 1)");
    expect(options[2]).toContain("Reject spec");
    for (const opt of options) {
      expect(opt).not.toContain("create beads");
      expect(opt).not.toContain("create-beads");
    }
  });

  it("bumps the refine round number for repeat passes", () => {
    expect(superpowersSpecApprovalOptions(2)[1]).toContain("round 3");
  });
});

describe("Superpowers spec approval — early branch wiring in approve.ts source", () => {
  const { readFileSync } = require("fs");
  const { join } = require("path");
  const approveSource = readFileSync(join(__dirname, "approve.ts"), "utf8");

  it("evaluates the spec branch BEFORE the implementation-plan approval block", () => {
    const specBranchIdx = approveSource.indexOf("isSuperpowersSpecApprovalStage(oc.state)");
    const planBranchIdx = approveSource.indexOf(
      "oc.state.phase === \"awaiting_plan_approval\" || (oc.state.phase === \"planning\" && oc.state.planDocument)",
    );
    expect(specBranchIdx).toBeGreaterThan(0);
    expect(planBranchIdx).toBeGreaterThan(specBranchIdx);
  });

  it("does NOT trigger plan size gates, plan quality scoring, docs/plans mirroring, or bead creation inside the spec branch", () => {
    const specBranchStart = approveSource.indexOf("Superpowers spec approval gate");
    expect(specBranchStart).toBeGreaterThan(0);
    const specBranchEnd = approveSource.indexOf(
      "if (oc.state.phase === \"awaiting_plan_approval\" || (oc.state.phase === \"planning\" && oc.state.planDocument)",
      specBranchStart,
    );
    expect(specBranchEnd).toBeGreaterThan(specBranchStart);
    const specBranchSlice = approveSource.slice(specBranchStart, specBranchEnd);

    // Plan size gate vocabulary
    expect(specBranchSlice).not.toContain("Plan too short");
    expect(specBranchSlice).not.toContain("planLineCount");
    // Plan quality scoring
    expect(specBranchSlice).not.toContain("planQualityScoringPrompt");
    expect(specBranchSlice).not.toContain("formatPlanQualityScore");
    expect(specBranchSlice).not.toContain("parsePlanQualityScore");
    // docs/plans mirroring
    expect(specBranchSlice).not.toContain("saveDocsPlan");
    // Bead creation handoff
    expect(specBranchSlice).not.toContain("planToBeadsPrompt");
    expect(specBranchSlice).not.toContain("beadCreationPrompt(");
    expect(specBranchSlice).not.toContain("creating_beads");
  });

  it("refinement path writes back to specArtifact, not planDocument", () => {
    const specBranchStart = approveSource.indexOf("Superpowers spec approval gate");
    const specBranchEnd = approveSource.indexOf(
      "if (oc.state.phase === \"awaiting_plan_approval\" || (oc.state.phase === \"planning\" && oc.state.planDocument)",
      specBranchStart,
    );
    const specBranchSlice = approveSource.slice(specBranchStart, specBranchEnd);
    // The refinement instructions should reference the spec artifact, not a planDocument path
    expect(specBranchSlice).toContain("specArtifactName");
    expect(specBranchSlice).toContain("write the updated spec back to the SAME artifact");
    expect(specBranchSlice).not.toContain("write the updated plan to the artifact");
  });

  it("acceptance path does not advance to bead creation or set planDocument", () => {
    const specBranchStart = approveSource.indexOf("Superpowers spec approval gate");
    const specBranchEnd = approveSource.indexOf(
      "if (oc.state.phase === \"awaiting_plan_approval\" || (oc.state.phase === \"planning\" && oc.state.planDocument)",
      specBranchStart,
    );
    const specBranchSlice = approveSource.slice(specBranchStart, specBranchEnd);
    expect(specBranchSlice).toContain("buildSuperpowersSpecApprovalStage");
    expect(specBranchSlice).toContain("oc.state.planDocument = undefined");
    expect(specBranchSlice).toContain("flywheel_plan");
    // Acceptance branch must NOT set creating_beads phase
    const acceptIdx = specBranchSlice.indexOf("Accept spec → advance to plan generation");
    expect(acceptIdx).toBeGreaterThan(0);
    const acceptSlice = specBranchSlice.slice(acceptIdx);
    expect(acceptSlice).not.toContain("creating_beads");
  });

  it("rejection path resets only the Superpowers workflow state and clears any stale planDocument", () => {
    const specBranchStart = approveSource.indexOf("Superpowers spec approval gate");
    const specBranchEnd = approveSource.indexOf(
      "if (oc.state.phase === \"awaiting_plan_approval\" || (oc.state.phase === \"planning\" && oc.state.planDocument)",
      specBranchStart,
    );
    const specBranchSlice = approveSource.slice(specBranchStart, specBranchEnd);
    expect(specBranchSlice).toContain("resetSuperpowersWorkflowAfterSpecRejection");
    expect(specBranchSlice).toContain("oc.state.planDocument = undefined");
  });
});

