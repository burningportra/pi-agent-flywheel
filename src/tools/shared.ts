import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CoordinationMode } from "../types.js";

export const TOOL_CANONICAL_PREFIX = "flywheel_";

const deprecationWarningEmitted = new Set<string>();

export function emitToolDeprecationWarning(calledName: string, canonicalName: string): void {
  if (calledName === canonicalName) return;
  if (process.env.FLYWHEEL_SUPPRESS_DEPRECATION) return;
  const key = `${calledName}->${canonicalName}`;
  if (deprecationWarningEmitted.has(key)) return;
  deprecationWarningEmitted.add(key);
  console.warn(
    `[pi-agent-flywheel] tool name '${calledName}' is deprecated; use '${canonicalName}' instead. ` +
    `The legacy alias will be removed in v2.0.0.`
  );
}

export const TOOL_FAMILIES = {
  profile: ["agent_flywheel_profile", "orch_profile", "flywheel_profile"],
  discover: ["agent_flywheel_discover", "orch_discover", "flywheel_discover"],
  select: ["agent_flywheel_select", "orch_select", "flywheel_select"],
  plan: ["agent_flywheel_plan", "orch_plan", "flywheel_plan"],
  approve_beads: ["agent_flywheel_approve_beads", "orch_approve_beads", "flywheel_approve_beads"],
  review: ["agent_flywheel_review", "orch_review", "flywheel_review"],
  memory: ["agent_flywheel_memory", "orch_memory", "flywheel_memory"],
  doctor: ["agent_flywheel_doctor", "orch_doctor", "flywheel_doctor"],
  verify_beads: ["agent_flywheel_verify_beads", "orch_verify_beads", "flywheel_verify_beads"],
  audit_beads: ["agent_flywheel_audit_beads", "orch_audit_beads", "flywheel_audit_beads"],
  capabilities: ["flywheel_capabilities"],
  robot_docs: ["flywheel_robot_docs"],
  triage: ["flywheel_triage"],
} as const;

export function canonicalName(family: keyof typeof TOOL_FAMILIES): string {
  const names = TOOL_FAMILIES[family];
  return names[names.length - 1];
}

/** Reset memoized state. Test-only; not part of the public surface. */
export function _resetDeprecationCache(): void {
  deprecationWarningEmitted.clear();
}

export function formatModelRef(model: { provider?: string; id: string }): string {
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * Assign models to parallel agents using provider-diverse rotation.
 * Returns `undefined` per slot when fewer than 2 distinct models are available.
 */
export async function getParallelModelAssignments(ctx: ExtensionContext, agentCount: number): Promise<(string | undefined)[]> {
  if (agentCount < 2) {
    return Array(agentCount).fill(undefined);
  }

  const availableModels = ctx.modelRegistry.getAvailable();
  const orderedModels = availableModels.filter((model, index, models) =>
    models.findIndex((candidate) => formatModelRef(candidate) === formatModelRef(model)) === index
  );

  if (orderedModels.length < 2) {
    return Array(agentCount).fill(undefined);
  }

  const currentModelRef = ctx.model ? formatModelRef(ctx.model) : undefined;
  if (currentModelRef) {
    const currentIndex = orderedModels.findIndex((model) => formatModelRef(model) === currentModelRef);
    if (currentIndex > 0) {
      const [currentModel] = orderedModels.splice(currentIndex, 1);
      orderedModels.unshift(currentModel);
    }
  }

  const primaryModel = orderedModels[0];
  const rotation = [
    primaryModel,
    ...orderedModels.slice(1).filter((model) => model.provider !== primaryModel.provider),
  ];

  if (rotation.length < 2) {
    const fallbackAlt = orderedModels.slice(1).find((model) => formatModelRef(model) !== formatModelRef(primaryModel));
    if (!fallbackAlt) {
      return Array(agentCount).fill(undefined);
    }
    rotation.push(fallbackAlt);
  }

  return Array.from({ length: agentCount }, (_, index) => formatModelRef(rotation[index % rotation.length]));
}

/**
 * Pick execution mode: single-branch (shared checkout with file reservations)
 * or worktree (isolated checkouts). Prefers single-branch when agent-mail
 * is available for coordination.
 */
export function resolveExecutionMode(
  coordinationMode: CoordinationMode | undefined,
  hasAgentMail: boolean
): "worktree" | "single-branch" {
  if (coordinationMode === "single-branch") return "single-branch";
  if (coordinationMode === "worktree") return "worktree";
  return hasAgentMail ? "single-branch" : "worktree";
}
