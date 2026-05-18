/**
 * Narrow runner for planning-workflow stages.
 *
 * Two responsibilities, deliberately kept small:
 *
 *  1. Map `state.planningWorkflow.stage` to an existing top-level
 *     OrchestratorPhase ("planning" or "awaiting_plan_approval" only). The
 *     runner does NOT introduce new phases — non-native adapters must reuse
 *     the same UI gates the native flow already exposes.
 *
 *  2. Detect out-of-order planning tool calls and return a {@link OutOfOrderRejection}
 *     with a targeted recovery instruction. The tool layer surfaces the
 *     `message` field to the agent so it can self-correct.
 *
 * Sessions without `planningWorkflow` (legacy checkpoints and any session
 * that never opted into an adapter) are treated as native: the runner is
 * permissive and defers to the tools' own state-validation logic.
 */

import type { OrchestratorState } from "../types.js";
import type { WorkflowStage } from "./types.js";
import { NATIVE_ADAPTER_ID } from "./native.js";
import { getPlanningWorkflowAdapter } from "./registry.js";

/** Subset of OrchestratorPhase values the runner is allowed to return. */
export type PlanningPhase = "planning" | "awaiting_plan_approval";

/** Planning-flow tool calls the runner enforces ordering for. */
export type PlanningToolCall = "flywheel_plan" | "flywheel_approve_beads";

/**
 * Returned when the runner rejects a tool call because it does not match the
 * current workflow stage. The `message` is intended to be surfaced verbatim
 * to the agent as a {@link FlywheelError} payload so the agent can correct
 * itself without inventing recovery steps.
 */
export interface OutOfOrderRejection {
  readonly code: "OUT_OF_ORDER_TOOL_CALL";
  readonly toolName: PlanningToolCall;
  readonly stage: WorkflowStage;
  readonly message: string;
  readonly recommendedTool?: PlanningToolCall;
}

/**
 * Map the active planning-workflow stage to one of the two top-level
 * phases the existing UI knows how to render.
 *
 * Returns `null` when the workflow is not in a planning stage right now
 * (e.g. `idle` before goal selection, `handoff` after bead creation). The
 * runner is intentionally silent in those cases — the caller already owns
 * the phase machinery for the rest of the flywheel.
 */
export function stageToPlanningPhase(state: OrchestratorState): PlanningPhase | null {
  const wf = state.planningWorkflow;
  if (!wf) return null;
  const adapter = getPlanningWorkflowAdapter(state);
  const mapped = adapter.stageToPhase(wf.stage);
  if (mapped === "planning" || mapped === "awaiting_plan_approval") return mapped;
  return null;
}

/**
 * Detect out-of-order planning tool calls.
 *
 * Behavior contract:
 *  - Returns `null` if the call is allowed for the current stage.
 *  - The native adapter is permissive — its only ordering constraints live
 *    inside the existing plan/approve tool implementations and predate
 *    this runner.
 *  - Non-native adapters reject `flywheel_plan` during brainstorm/spec/
 *    awaiting-spec-approval and reject `flywheel_approve_beads` while a
 *    plan or spec is still being generated.
 */
export function checkPlanningToolOrdering(
  toolName: PlanningToolCall,
  state: OrchestratorState,
): OutOfOrderRejection | null {
  const wf = state.planningWorkflow;
  if (!wf) return null;
  if (wf.adapterId === NATIVE_ADAPTER_ID) return null;

  const stage = wf.stage;

  if (toolName === "flywheel_plan") {
    if (
      stage === "brainstorming" ||
      stage === "spec" ||
      stage === "awaiting_spec_approval"
    ) {
      const message =
        stage === "awaiting_spec_approval"
          ? `Cannot generate the implementation plan while stage is "awaiting_spec_approval". Approve or refine the spec via flywheel_approve_beads first, then call flywheel_plan.`
          : `Cannot generate the implementation plan while stage is "${stage}". Wait for the current ${stage} step to complete and the spec to be approved.`;
      return {
        code: "OUT_OF_ORDER_TOOL_CALL",
        toolName,
        stage,
        message,
        recommendedTool: "flywheel_approve_beads",
      };
    }
    return null;
  }

  if (toolName === "flywheel_approve_beads") {
    if (stage === "brainstorming" || stage === "spec" || stage === "plan") {
      const noun = stage === "plan" ? "implementation plan" : "spec";
      const message = `Cannot approve while a ${noun} is still being generated (stage="${stage}"). Wait for ${noun} generation to finish, then call flywheel_approve_beads.`;
      return {
        code: "OUT_OF_ORDER_TOOL_CALL",
        toolName,
        stage,
        message,
      };
    }
    return null;
  }

  return null;
}
