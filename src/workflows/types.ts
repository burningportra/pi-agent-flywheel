/**
 * Planning-workflow types for the multi-adapter planning system.
 *
 * pi-agent-flywheel originally ran a single hard-coded planning pipeline:
 * goal → multi-model plan → bead generation. The Superpowers adapter
 * introduces an intermediate "spec" document that must be approved before
 * the implementation plan is generated. Both flows still feed the same
 * downstream bead-generation contract, so we keep them behind a workflow
 * abstraction instead of overloading existing OrchestratorState fields.
 *
 * Public flywheel tool names (agent_flywheel_plan, agent_flywheel_approve_beads)
 * and OrchestratorPhase values do not change. Only this new state shape
 * tracks workflow-stage-specific artifacts and fingerprints.
 */

/** Logical step inside a planning workflow. Distinct from OrchestratorPhase. */
export type WorkflowStage =
  /** No workflow has been initialized for the current goal. */
  | "idle"
  /** Goal is being refined into a brainstorming decision record. */
  | "brainstorming"
  /** Spec authoring (Superpowers-style) is in flight. */
  | "spec"
  /** Spec artifact exists and is awaiting user approval. */
  | "awaiting_spec_approval"
  /** Implementation plan is being written from the approved spec or goal. */
  | "plan"
  /** Implementation plan exists and is awaiting user approval. */
  | "awaiting_plan_approval"
  /** Approved plan handed off to bead creation. */
  | "handoff";

/**
 * High-level planning approach.
 *
 * - "native" — the legacy single-model / multi-model plan straight to beads.
 * - "superpowers" — spec-first workflow with explicit approval before plan.
 *
 * Adapter ids may add finer-grained variants; this is the coarse switch
 * other code can read without knowing every adapter.
 */
export type PlanningWorkflowGenerationMode = "native" | "superpowers";

/** What kind of document was most recently approved in this workflow. */
export type ApprovedDocumentKind = "spec" | "plan";

/**
 * Stable snapshot of the inputs used to fingerprint a planning workflow.
 *
 * The fingerprint is recomputed whenever any of these change, allowing drift
 * detection without comparing raw artifact bodies. Keep this in sync with
 * `computePlanningWorkflowFingerprint` in `workflows/artifacts.ts`.
 */
export interface PlanningWorkflowFingerprintInput {
  /** Raw goal text as the user selected it. */
  goal: string;
  /** Constraints passed alongside the goal (order-independent). */
  constraints?: string[];
  /** Adapter id (e.g. "native", "superpowers"). */
  adapterId: string;
  /**
   * Optional path or content reference for brainstorming decision artifact —
   * included so a re-brainstorm invalidates the workflow fingerprint.
   */
  brainstormDecisionArtifact?: string;
  /** Optional spec artifact path or content reference. */
  specArtifact?: string;
}

/**
 * Per-session planning-workflow state.
 *
 * Lives at `OrchestratorState.planningWorkflow`. Always optional so legacy
 * checkpoints (written before this shape existed) keep loading.
 */
export interface PlanningWorkflowState {
  /** Schema version for forward-compatible checkpoint migration. */
  schemaVersion: 1;
  /** Adapter identifier — e.g. "native", "superpowers". */
  adapterId: string;
  /** Logical workflow step (see {@link WorkflowStage}). */
  stage: WorkflowStage;
  /** High-level planning approach. */
  generationMode: PlanningWorkflowGenerationMode;
  /**
   * Stable fingerprint over goal text, normalized constraints, adapter id,
   * and brainstorming/spec material. Used to detect drift.
   */
  goalFingerprint: string;
  /**
   * Artifact path (relative to the session artifact root) for the
   * brainstorming decision record, when one exists.
   */
  brainstormDecisionArtifact?: string;
  /**
   * Artifact path (relative to the session artifact root) for the
   * Superpowers spec document. Must NOT live under `plans/` so saved-plan
   * discovery does not pick it up as a final implementation plan.
   */
  specArtifact?: string;
  /** Fingerprint of the spec at the moment it was last approved. */
  approvedSpecFingerprint?: string;
  /** Number of spec refinement rounds the user has gone through. */
  specRefinementRound?: number;
  /** What document was most recently approved (spec or plan). */
  lastApprovedDocumentKind?: ApprovedDocumentKind;
  /** Free-form per-adapter state. Adapters own their own schema here. */
  adapterState?: Record<string, unknown>;
}

/**
 * Build an initial planning-workflow state for the given adapter.
 *
 * Returns an object whose stage is "idle" and whose fingerprint is empty —
 * the caller is expected to call `computePlanningWorkflowFingerprint` and
 * fill it in before persisting. This helper exists so adapter authors do not
 * forget the required `schemaVersion`.
 */
export function createInitialPlanningWorkflowState(
  adapterId: string,
  generationMode: PlanningWorkflowGenerationMode,
): PlanningWorkflowState {
  return {
    schemaVersion: 1,
    adapterId,
    stage: "idle",
    generationMode,
    goalFingerprint: "",
  };
}
