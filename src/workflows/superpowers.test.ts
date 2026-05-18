import { describe, expect, it } from "vitest";
import type { RepoProfile } from "../types.js";
import {
  buildSuperpowersPlanApprovalStage,
  buildSuperpowersPlanStage,
  buildSuperpowersSpecApprovalStage,
  buildSuperpowersSpecRefinementStage,
  buildSuperpowersSpecStage,
  initSuperpowersWorkflow,
  resetSuperpowersWorkflowAfterSpecRejection,
  SUPERPOWERS_ADAPTER_ID,
  SUPERPOWERS_STAGE_ORDER,
} from "./superpowers.js";

const profile: RepoProfile = {
  name: "repo",
  languages: ["TypeScript"],
  frameworks: [],
  structure: "src/index.ts",
  entrypoints: ["src/index.ts"],
  recentCommits: [],
  hasTests: true,
  hasDocs: true,
  hasCI: false,
  todos: [],
  keyFiles: {},
};

describe("initSuperpowersWorkflow", () => {
  it("starts at the spec stage with a stable goal fingerprint", () => {
    const state = initSuperpowersWorkflow({
      goal: "Add Superpowers spec workflow",
      constraints: ["typescript", "no-new-deps"],
      brainstormDecisionArtifact: "brainstorming/foo-decision.md",
    });
    expect(state.adapterId).toBe(SUPERPOWERS_ADAPTER_ID);
    expect(state.generationMode).toBe("superpowers");
    expect(state.stage).toBe("spec");
    expect(state.goalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(state.brainstormDecisionArtifact).toBe("brainstorming/foo-decision.md");
    expect(state.specRefinementRound).toBe(0);
  });
});

describe("buildSuperpowersSpecStage", () => {
  it("writes specArtifact under superpowers/specs and never produces a planDocument path", () => {
    const result = buildSuperpowersSpecStage({
      goal: "Add Superpowers spec workflow",
      profile,
      constraints: ["no-new-deps"],
    });
    expect(result.artifactName).toBe("superpowers/specs/add-superpowers-spec-workflow.md");
    expect(result.artifactName?.startsWith("plans/")).toBe(false);
    expect(result.nextState.specArtifact).toBe(result.artifactName);
    // Must not be writing into planDocument anywhere — that field doesn't even
    // live on PlanningWorkflowState, and the prompt must not direct it there.
    expect(result.prompt).toBeDefined();
    expect(result.prompt!).not.toContain("plans/<goal-slug>.md");
    expect(result.note).toMatch(/never planDocument/);
  });

  it("preserves the existing workflow goalFingerprint instead of regenerating it", () => {
    const initial = initSuperpowersWorkflow({
      goal: "Add Superpowers spec workflow",
      constraints: ["no-new-deps"],
    });
    const result = buildSuperpowersSpecStage({
      goal: "Add Superpowers spec workflow",
      profile,
      constraints: ["no-new-deps"],
      workflow: initial,
    });
    expect(result.nextState.goalFingerprint).toBe(initial.goalFingerprint);
  });
});

describe("buildSuperpowersSpecRefinementStage", () => {
  it("increments specRefinementRound and targets the existing spec artifact", () => {
    const initial = buildSuperpowersSpecStage({
      goal: "Add Superpowers spec workflow",
      profile,
      constraints: [],
    });
    const refined = buildSuperpowersSpecRefinementStage({
      goal: "Add Superpowers spec workflow",
      profile,
      constraints: [],
      workflow: initial.nextState,
      openQuestions: ["Is the spec stable?"],
    });
    expect(refined.nextState.specRefinementRound).toBe(1);
    expect(refined.artifactName).toBe(initial.artifactName);
    expect(refined.prompt).toContain("Is the spec stable?");
  });

  it("throws if called before a spec has been generated", () => {
    expect(() =>
      buildSuperpowersSpecRefinementStage({
        goal: "x",
        profile,
        constraints: [],
      }),
    ).toThrow(/non-empty PlanningWorkflowState/);
  });
});

describe("buildSuperpowersSpecApprovalStage", () => {
  it("records approved fingerprint and lastApprovedDocumentKind=spec", () => {
    const initial = buildSuperpowersSpecStage({
      goal: "Add Superpowers spec workflow",
      profile,
      constraints: ["no-new-deps"],
    });
    const approved = buildSuperpowersSpecApprovalStage({
      workflow: initial.nextState,
      approvedSpecBody: "## Goal\nApproved spec body",
      goal: "Add Superpowers spec workflow",
      constraints: ["no-new-deps"],
    });
    expect(approved.nextState.stage).toBe("awaiting_plan_approval");
    expect(approved.nextState.lastApprovedDocumentKind).toBe("spec");
    expect(approved.nextState.approvedSpecFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different fingerprint when the spec body changes", () => {
    const initial = buildSuperpowersSpecStage({
      goal: "Add Superpowers spec workflow",
      profile,
      constraints: ["no-new-deps"],
    });
    const a = buildSuperpowersSpecApprovalStage({
      workflow: initial.nextState,
      approvedSpecBody: "A",
      goal: "Add Superpowers spec workflow",
      constraints: ["no-new-deps"],
    });
    const b = buildSuperpowersSpecApprovalStage({
      workflow: initial.nextState,
      approvedSpecBody: "B",
      goal: "Add Superpowers spec workflow",
      constraints: ["no-new-deps"],
    });
    expect(a.nextState.approvedSpecFingerprint).not.toBe(b.nextState.approvedSpecFingerprint);
  });
});

describe("buildSuperpowersPlanStage", () => {
  it("targets plans/<slug>.md and embeds the approved spec body in the prompt", () => {
    const initial = buildSuperpowersSpecStage({
      goal: "Add Superpowers spec workflow",
      profile,
      constraints: ["no-new-deps"],
    });
    const approved = buildSuperpowersSpecApprovalStage({
      workflow: initial.nextState,
      approvedSpecBody: "## Goal\nApproved spec body",
      goal: "Add Superpowers spec workflow",
      constraints: ["no-new-deps"],
    });
    const plan = buildSuperpowersPlanStage({
      goal: "Add Superpowers spec workflow",
      profile,
      constraints: ["no-new-deps"],
      workflow: approved.nextState,
      approvedSpecBody: "## Goal\nApproved spec body",
    });
    expect(plan.artifactName).toBe("plans/add-superpowers-spec-workflow.md");
    expect(plan.prompt).toContain("## Goal\nApproved spec body");
    expect(plan.note).toMatch(/planDocument/);
  });

  it("refuses to plan before spec approval", () => {
    const initial = buildSuperpowersSpecStage({
      goal: "x",
      profile,
      constraints: [],
    });
    expect(() =>
      buildSuperpowersPlanStage({
        goal: "x",
        profile,
        constraints: [],
        workflow: initial.nextState,
        approvedSpecBody: "...",
      }),
    ).toThrow(/before spec approval/);
  });

  it("requires the approved spec body to embed in the prompt", () => {
    const initial = buildSuperpowersSpecStage({
      goal: "x",
      profile,
      constraints: [],
    });
    const approved = buildSuperpowersSpecApprovalStage({
      workflow: initial.nextState,
      approvedSpecBody: "spec",
      goal: "x",
      constraints: [],
    });
    expect(() =>
      buildSuperpowersPlanStage({
        goal: "x",
        profile,
        constraints: [],
        workflow: approved.nextState,
      }),
    ).toThrow(/approved spec body/);
  });
});

describe("buildSuperpowersPlanApprovalStage", () => {
  it("flips lastApprovedDocumentKind to plan and stage to handoff", () => {
    const initial = buildSuperpowersSpecStage({
      goal: "x",
      profile,
      constraints: [],
    });
    const approved = buildSuperpowersSpecApprovalStage({
      workflow: initial.nextState,
      approvedSpecBody: "spec",
      goal: "x",
      constraints: [],
    });
    const handed = buildSuperpowersPlanApprovalStage({ workflow: approved.nextState });
    expect(handed.nextState.stage).toBe("handoff");
    expect(handed.nextState.lastApprovedDocumentKind).toBe("plan");
  });
});

describe("resetSuperpowersWorkflowAfterSpecRejection", () => {
  it("clears spec artifacts and approval metadata but keeps adapter identity", () => {
    const initial = buildSuperpowersSpecStage({
      goal: "Reset spec workflow",
      profile,
      constraints: ["no-new-deps"],
    });
    const approved = buildSuperpowersSpecApprovalStage({
      workflow: { ...initial.nextState, specRefinementRound: 3 },
      approvedSpecBody: "spec body",
      goal: "Reset spec workflow",
      constraints: ["no-new-deps"],
    });
    // Pretend we are partway through plan approval state but the user
    // rejected the spec — the reset must still wipe spec-specific fields.
    const reset = resetSuperpowersWorkflowAfterSpecRejection(approved.nextState);
    expect(reset.adapterId).toBe(SUPERPOWERS_ADAPTER_ID);
    expect(reset.generationMode).toBe("superpowers");
    expect(reset.stage).toBe("idle");
    expect(reset.goalFingerprint).toBe(approved.nextState.goalFingerprint);
    expect(reset.specArtifact).toBeUndefined();
    expect(reset.approvedSpecFingerprint).toBeUndefined();
    expect(reset.specRefinementRound).toBeUndefined();
    expect(reset.lastApprovedDocumentKind).toBeUndefined();
  });

  it("preserves the brainstormDecisionArtifact reference for resume continuity", () => {
    const initial = initSuperpowersWorkflow({
      goal: "Keep brainstorm artifact",
      constraints: [],
      brainstormDecisionArtifact: "brainstorming/keep-brainstorm.md",
    });
    const reset = resetSuperpowersWorkflowAfterSpecRejection({
      ...initial,
      stage: "awaiting_spec_approval",
      specArtifact: "superpowers/specs/keep-brainstorm.md",
      specRefinementRound: 2,
    });
    expect(reset.brainstormDecisionArtifact).toBe("brainstorming/keep-brainstorm.md");
  });
});

describe("SUPERPOWERS_STAGE_ORDER", () => {
  it("walks brainstorming → spec → approval → plan → approval → handoff without going through implementation phases", () => {
    expect(SUPERPOWERS_STAGE_ORDER).toEqual([
      "spec",
      "awaiting_spec_approval",
      "plan",
      "awaiting_plan_approval",
      "handoff",
    ]);
  });
});
