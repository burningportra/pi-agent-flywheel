import { detectSessionStage, type SessionStage } from "./session-state.js";
import type { Bead, OrchestratorPhase, OrchestratorState } from "./types.js";

export const WORKFLOW_STATUS_CONTRACT_VERSION = 1 as const;

export type WorkflowStatusContractVersion = typeof WORKFLOW_STATUS_CONTRACT_VERSION;
export type WorkflowStatusConfidence = "high" | "medium" | "low";
export type WorkflowApprovalState =
  | "not_started"
  | "goal_selection"
  | "planning"
  | "awaiting_plan_approval"
  | "awaiting_bead_approval"
  | "approved"
  | "complete";

export interface WorkflowStatusBead {
  id: string;
  title: string | null;
  status: Bead["status"] | "unknown";
  priority: number | null;
  type: string | null;
  updated_at: string | null;
}

export interface WorkflowStatusBeads {
  total: number;
  open: number;
  in_progress: number;
  closed: number;
  deferred: number;
  pending: WorkflowStatusBead[];
  current: WorkflowStatusBead[];
}

export interface WorkflowStatusOutput {
  contract_version: WorkflowStatusContractVersion;
  phase: OrchestratorPhase;
  selected_goal: string | null;
  approval_state: WorkflowApprovalState;
  beads: WorkflowStatusBeads;
  next_action: string;
  resume_prompt: string;
  confidence: WorkflowStatusConfidence;
  inferred_from: string[];
}

/**
 * Build a stable, JSON-ready status object from persisted orchestrator state and
 * already-loaded bead data. This function is intentionally pure: callers own all
 * I/O for loading state, bead lists, and any live coordination signals.
 */
export function buildWorkflowStatus(
  state: OrchestratorState,
  liveBeads: readonly Bead[] = []
): WorkflowStatusOutput {
  const beads = [...liveBeads];
  const detectedStage = detectSessionStage(state, beads);
  const stage = hydrateInferredStagePrompts(state, beads, detectedStage);
  const orderedBeads = orderBeadsForStatus(beads, state.activeBeadIds);
  const currentIds = new Set<string>();

  if (stage.currentBeadId) currentIds.add(stage.currentBeadId);
  for (const bead of orderedBeads) {
    if (bead.status === "in_progress") currentIds.add(bead.id);
  }

  const current = orderedBeads
    .filter((bead) => currentIds.has(bead.id))
    .map(toStatusBead);

  if (stage.currentBeadId && !current.some((bead) => bead.id === stage.currentBeadId)) {
    current.push({
      id: stage.currentBeadId,
      title: null,
      status: "unknown",
      priority: null,
      type: null,
      updated_at: null,
    });
  }

  return {
    contract_version: WORKFLOW_STATUS_CONTRACT_VERSION,
    phase: stage.phase,
    selected_goal: stage.goal ?? null,
    approval_state: approvalStateForPhase(stage.phase),
    beads: {
      total: orderedBeads.length,
      open: orderedBeads.filter((bead) => bead.status === "open").length,
      in_progress: orderedBeads.filter((bead) => bead.status === "in_progress").length,
      closed: orderedBeads.filter((bead) => bead.status === "closed").length,
      deferred: orderedBeads.filter((bead) => bead.status === "deferred").length,
      pending: orderedBeads
        .filter((bead) => bead.status === "open" && !currentIds.has(bead.id))
        .map(toStatusBead),
      current,
    },
    next_action: stage.nextAction,
    resume_prompt: stage.resumePrompt,
    confidence: stage.confidence,
    inferred_from: [...stage.inferredFrom],
  };
}

function hydrateInferredStagePrompts(
  state: OrchestratorState,
  beads: Bead[],
  detectedStage: SessionStage
): SessionStage {
  if (detectedStage.phase === state.phase) return detectedStage;

  const promptStage = detectSessionStage({ ...state, phase: detectedStage.phase }, beads);
  if (promptStage.phase !== detectedStage.phase) return detectedStage;

  return {
    ...promptStage,
    confidence: detectedStage.confidence,
    inferredFrom: detectedStage.inferredFrom,
  };
}

function approvalStateForPhase(phase: OrchestratorPhase): WorkflowApprovalState {
  switch (phase) {
    case "idle":
    case "profiling":
    case "discovering":
      return "not_started";
    case "awaiting_selection":
      return "goal_selection";
    case "planning":
    case "researching":
      return "planning";
    case "awaiting_plan_approval":
      return "awaiting_plan_approval";
    case "creating_beads":
    case "refining_beads":
    case "awaiting_bead_approval":
      return "awaiting_bead_approval";
    case "implementing":
    case "reviewing":
    case "iterating":
      return "approved";
    case "complete":
      return "complete";
  }
}

function toStatusBead(bead: Bead): WorkflowStatusBead {
  return {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    priority: bead.priority,
    type: bead.type,
    updated_at: bead.updated_at ?? null,
  };
}

function orderBeadsForStatus(beads: Bead[], activeBeadIds: readonly string[] | undefined): Bead[] {
  const inputOrder = new Map(beads.map((bead, index) => [bead.id, index]));
  const activeOrder = new Map((activeBeadIds ?? []).map((id, index) => [id, index]));

  return [...beads].sort((a, b) => {
    const aActive = activeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bActive = activeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aActive !== bActive) return aActive - bActive;

    const aInput = inputOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bInput = inputOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aInput !== bInput) return aInput - bInput;

    return a.id.localeCompare(b.id);
  });
}
