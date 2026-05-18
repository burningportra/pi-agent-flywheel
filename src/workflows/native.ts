/**
 * Native planning-workflow adapter.
 *
 * Wraps the legacy flywheel planning pipeline (single-model or multi-model
 * implementation plan → approval → beads) behind the {@link PlanningWorkflowAdapter}
 * interface. Behavior is intentionally a no-op compared to the pre-adapter
 * flywheel — existing tests and saved sessions must keep working unchanged.
 *
 * This adapter is the registry default. Any session whose `planningWorkflow`
 * is absent or whose `adapterId` is unknown resolves to this adapter via
 * `getPlanningWorkflowAdapter` in `./registry.ts`.
 */

import type { OrchestratorPhase } from "../types.js";
import type {
  PlanningWorkflowGenerationMode,
  PlanningWorkflowState,
  WorkflowStage,
} from "./types.js";
import { createInitialPlanningWorkflowState } from "./types.js";

export const NATIVE_ADAPTER_ID = "native";

/**
 * Shared adapter contract.
 *
 * Adapters describe how a planning workflow maps to the *existing*
 * OrchestratorPhase enum — they MUST NOT introduce new top-level phases.
 * Callers map workflow stages back to one of `planning` or
 * `awaiting_plan_approval` so the rest of the flywheel UI keeps working.
 */
export interface PlanningWorkflowAdapter {
  /** Adapter identifier persisted in `PlanningWorkflowState.adapterId`. */
  readonly id: string;
  /** Coarse planning approach this adapter implements. */
  readonly mode: PlanningWorkflowGenerationMode;
  /** Stages this adapter advertises support for. Other stages are rejected. */
  readonly supportedStages: ReadonlySet<WorkflowStage>;
  /**
   * Build the initial planning-workflow state for a fresh session using this
   * adapter. The caller is responsible for filling `goalFingerprint` from
   * `computePlanningWorkflowFingerprint` before persisting.
   */
  createInitialState(): PlanningWorkflowState;
  /**
   * Map a workflow stage to the OrchestratorPhase the runner should pin
   * while that stage is active. Returns `null` for stages that should not
   * change the top-level phase (e.g. `idle`, `handoff`).
   */
  stageToPhase(stage: WorkflowStage): OrchestratorPhase | null;
}

/**
 * Native adapter — the legacy flywheel planning flow.
 *
 * Only stages `idle`, `plan`, `awaiting_plan_approval`, and `handoff` are
 * supported. The spec-related stages used by Superpowers are intentionally
 * omitted so a misconfigured session cannot drive native through spec logic.
 */
export const nativePlanningAdapter: PlanningWorkflowAdapter = {
  id: NATIVE_ADAPTER_ID,
  mode: "native",
  supportedStages: new Set<WorkflowStage>([
    "idle",
    "plan",
    "awaiting_plan_approval",
    "handoff",
  ]),
  createInitialState(): PlanningWorkflowState {
    return createInitialPlanningWorkflowState(NATIVE_ADAPTER_ID, "native");
  },
  stageToPhase(stage: WorkflowStage): OrchestratorPhase | null {
    switch (stage) {
      case "plan":
        return "planning";
      case "awaiting_plan_approval":
        return "awaiting_plan_approval";
      default:
        return null;
    }
  },
};
