/**
 * Superpowers planning adapter.
 *
 * The Superpowers workflow runs a spec-first pipeline:
 *
 *   brainstorming → spec → spec_approval → plan → plan_approval → handoff
 *
 * It deliberately re-uses the existing goal-refinement primitives
 * (`runGoalRefinement`, `extractConstraints`, `BrainstormDecisionRecord`)
 * and the shared `sessionArtifactPath` helper. The only Superpowers-specific
 * pieces are:
 *   - the three prompts in `prompts.ts` (`superpowersSpecPrompt`,
 *     `superpowersSpecRefinementPrompt`, `implementationPlanFromSpecPrompt`)
 *   - the spec-artifact namespace (`superpowers/specs/<slug>.md`)
 *   - a strict invariant that the spec is stored on
 *     `planningWorkflow.specArtifact` and NEVER on `oc.state.planDocument`,
 *     so saved-plan discovery and bead generation continue to see only
 *     final implementation plans.
 *
 * This module is intentionally side-effect-free: it produces prompts and
 * planning-workflow state transitions but does not call into the pi
 * ExtensionAPI. The next bead (pi-3ujg) wires the registry runner that
 * actually invokes adapters; keeping side effects out of here lets that
 * runner stay testable.
 */

import { dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

import type { RepoProfile, ScanResult } from "../types.js";
import {
  implementationPlanFromSpecPrompt,
  superpowersSpecPrompt,
  superpowersSpecRefinementPrompt,
} from "../prompts.js";
import {
  finalPlanArtifactName,
  specArtifactName,
  computePlanningWorkflowFingerprint,
} from "./artifacts.js";
import type {
  PlanningWorkflowState,
  WorkflowStage,
} from "./types.js";
import { createInitialPlanningWorkflowState } from "./types.js";

/** Adapter identifier used in `PlanningWorkflowState.adapterId`. */
export const SUPERPOWERS_ADAPTER_ID = "superpowers";

/**
 * Inputs every stage handler accepts. The handlers are pure functions —
 * they read these inputs, produce a next-state and a prompt (or artifact
 * description), and return without touching the filesystem or pi APIs.
 */
export interface SuperpowersStageInput {
  goal: string;
  profile: RepoProfile;
  scanResult?: ScanResult;
  /** Normalized constraints from the refined brainstorm decision record. */
  constraints: string[];
  /** Current planning workflow state, if any. */
  workflow?: PlanningWorkflowState;
  /** Optional artifact path of the brainstorming decision record. */
  brainstormDecisionArtifact?: string;
  /** Approved spec body, only required for the plan/handoff stages. */
  approvedSpecBody?: string;
}

/** Result of a single stage transition. */
export interface SuperpowersStageResult {
  /** Next planning-workflow state. */
  nextState: PlanningWorkflowState;
  /** Prompt string to send to the planning agent for this stage (if any). */
  prompt?: string;
  /**
   * Artifact name (relative to the session artifact root) the stage either
   * expects to be written or will read from. Useful for adapter runners
   * that need to reserve files before invoking the agent.
   */
  artifactName?: string;
  /** Human-readable status note for logs / UI. */
  note: string;
}

/**
 * Build the initial Superpowers workflow state from a refined goal.
 *
 * Stage starts at "spec" — by the time this is called, brainstorming has
 * already produced the constraints we are about to fingerprint over.
 */
export function initSuperpowersWorkflow(input: {
  goal: string;
  constraints: string[];
  brainstormDecisionArtifact?: string;
}): PlanningWorkflowState {
  const base = createInitialPlanningWorkflowState(SUPERPOWERS_ADAPTER_ID, "superpowers");
  const goalFingerprint = computePlanningWorkflowFingerprint({
    goal: input.goal,
    constraints: input.constraints,
    adapterId: SUPERPOWERS_ADAPTER_ID,
    brainstormDecisionArtifact: input.brainstormDecisionArtifact,
  });

  return {
    ...base,
    stage: "spec",
    goalFingerprint,
    brainstormDecisionArtifact: input.brainstormDecisionArtifact,
    specRefinementRound: 0,
  };
}

// ─── Stage handlers ──────────────────────────────────────────

/**
 * "spec" stage — first-pass spec generation. Reuses the brainstorm
 * decision record's constraints rather than re-prompting the user.
 *
 * Invariant: the returned state stores the spec artifact path on
 * `specArtifact` and never touches `planDocument`. Callers that wire this
 * into the orchestrator must NOT copy this path into `oc.state.planDocument`.
 */
export function buildSuperpowersSpecStage(input: SuperpowersStageInput): SuperpowersStageResult {
  const workflow = input.workflow ?? initSuperpowersWorkflow({
    goal: input.goal,
    constraints: input.constraints,
    brainstormDecisionArtifact: input.brainstormDecisionArtifact,
  });

  const artifactName = specArtifactName(input.goal);
  const prompt = superpowersSpecPrompt(input.goal, input.profile, input.constraints, input.scanResult);

  const nextState: PlanningWorkflowState = {
    ...workflow,
    stage: "spec",
    specArtifact: artifactName,
    specRefinementRound: workflow.specRefinementRound ?? 0,
  };

  return {
    nextState,
    prompt,
    artifactName,
    note: "Superpowers spec generation — store result on planningWorkflow.specArtifact, never planDocument",
  };
}

/**
 * "spec" refinement — fresh-eyes pass over the existing spec artifact.
 * Increments `specRefinementRound`. Open questions surfaced by the previous
 * round are folded into the prompt so the reviewer can address them.
 */
export function buildSuperpowersSpecRefinementStage(
  input: SuperpowersStageInput & { openQuestions?: string[] },
): SuperpowersStageResult {
  const workflow = input.workflow;
  if (!workflow) {
    throw new Error(
      "buildSuperpowersSpecRefinementStage requires a non-empty PlanningWorkflowState (spec stage must have run first)",
    );
  }
  if (!workflow.specArtifact) {
    throw new Error("Cannot refine a spec before one exists — call buildSuperpowersSpecStage first");
  }

  const round = (workflow.specRefinementRound ?? 0) + 1;
  const prompt = superpowersSpecRefinementPrompt(
    workflow.specArtifact,
    round,
    input.openQuestions ?? [],
  );

  return {
    nextState: {
      ...workflow,
      stage: "spec",
      specRefinementRound: round,
    },
    prompt,
    artifactName: workflow.specArtifact,
    note: `Superpowers spec refinement round ${round}`,
  };
}

/**
 * Mark the current spec as approved. Records the approved fingerprint
 * (spec body + constraints + adapter) so a later drift check can detect
 * spec edits made after approval but before plan generation.
 */
export function buildSuperpowersSpecApprovalStage(input: {
  workflow: PlanningWorkflowState;
  approvedSpecBody: string;
  goal: string;
  constraints: string[];
}): SuperpowersStageResult {
  if (!input.workflow.specArtifact) {
    throw new Error("Cannot approve a spec before one has been generated");
  }

  const approvedFingerprint = computePlanningWorkflowFingerprint({
    goal: input.goal,
    constraints: input.constraints,
    adapterId: SUPERPOWERS_ADAPTER_ID,
    brainstormDecisionArtifact: input.workflow.brainstormDecisionArtifact,
    specArtifact: input.approvedSpecBody,
  });

  return {
    nextState: {
      ...input.workflow,
      stage: "awaiting_plan_approval",
      approvedSpecFingerprint: approvedFingerprint,
      lastApprovedDocumentKind: "spec",
    },
    note: "Superpowers spec approved — ready to generate implementation plan",
    artifactName: input.workflow.specArtifact,
  };
}

/**
 * "plan" stage — generate the final implementation plan from the
 * approved spec. The plan artifact lives under `plans/<slug>.md` so
 * downstream bead generation can find it.
 */
export function buildSuperpowersPlanStage(input: SuperpowersStageInput): SuperpowersStageResult {
  const workflow = input.workflow;
  if (!workflow) {
    throw new Error("buildSuperpowersPlanStage requires a PlanningWorkflowState in awaiting_plan_approval");
  }
  if (!workflow.approvedSpecFingerprint) {
    throw new Error("Cannot generate implementation plan before spec approval");
  }
  if (!input.approvedSpecBody) {
    throw new Error("buildSuperpowersPlanStage requires the approved spec body to embed in the prompt");
  }

  const planArtifact = finalPlanArtifactName(input.goal);
  const prompt = implementationPlanFromSpecPrompt(
    input.goal,
    input.approvedSpecBody,
    input.profile,
    input.constraints,
    input.scanResult,
  );

  return {
    nextState: {
      ...workflow,
      stage: "plan",
    },
    prompt,
    artifactName: planArtifact,
    note: "Superpowers implementation plan — store path on oc.state.planDocument, NOT planningWorkflow.specArtifact",
  };
}

/**
 * Mark the implementation plan as approved. The orchestrator must set
 * `oc.state.planDocument` to the plan artifact path before invoking this —
 * this stage only updates workflow metadata.
 */
export function buildSuperpowersPlanApprovalStage(input: {
  workflow: PlanningWorkflowState;
}): SuperpowersStageResult {
  return {
    nextState: {
      ...input.workflow,
      stage: "handoff",
      lastApprovedDocumentKind: "plan",
    },
    note: "Superpowers implementation plan approved — handing off to bead generation",
  };
}

// ─── Tiny artifact-IO helpers (used by the runner) ───────────

/**
 * Persist a Superpowers spec to disk. Returns the absolute path written.
 * Callers should reserve the artifact name first when running in
 * single-branch mode with agent-mail coordination.
 */
export function writeSuperpowersSpecArtifact(absoluteArtifactPath: string, body: string): string {
  mkdirSync(dirname(absoluteArtifactPath), { recursive: true });
  writeFileSync(absoluteArtifactPath, body, "utf8");
  return absoluteArtifactPath;
}

/** Read a previously-written spec body, returning undefined if absent. */
export function readSuperpowersSpecArtifact(absoluteArtifactPath: string): string | undefined {
  if (!existsSync(absoluteArtifactPath)) return undefined;
  try {
    return readFileSync(absoluteArtifactPath, "utf8");
  } catch {
    return undefined;
  }
}

// ─── Public stage table ──────────────────────────────────────

/**
 * Ordered list of stages the Superpowers adapter walks through. Exported so
 * the workflow registry runner (pi-3ujg) can validate transitions without
 * hard-coding the order.
 */
export const SUPERPOWERS_STAGE_ORDER: WorkflowStage[] = [
  "spec",
  "awaiting_spec_approval",
  "plan",
  "awaiting_plan_approval",
  "handoff",
];
