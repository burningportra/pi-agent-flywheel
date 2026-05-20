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
  research: ["agent_flywheel_research", "orch_research", "flywheel_research"],
  capabilities: ["flywheel_capabilities"],
  robot_docs: ["flywheel_robot_docs"],
  triage: ["flywheel_triage"],
} as const;

export function canonicalName(family: keyof typeof TOOL_FAMILIES): string {
  const names = TOOL_FAMILIES[family];
  return names[names.length - 1];
}

/**
 * R-005: slash-command alias deprecation map.
 * Canonical name = `flywheel-X`. Every legacy alias maps to its canonical.
 * Verbs without a `flywheel-X` form (e.g. /memory, /orchestrate-tool-feedback)
 * stay un-deprecated until they get a canonical assignment.
 */
export const SLASH_CANONICAL: Record<string, string> = {
  "agent-flywheel-start": "flywheel-start",
  "orchestrate": "flywheel-start",
  "agent-flywheel-research": "flywheel-research",
  "orchestrate-research": "flywheel-research",
  "agent-flywheel-release-checklist": "flywheel-release-checklist",
  "orchestrate-release-checklist": "flywheel-release-checklist",
  "orchestrate-stop": "flywheel-stop",
  "agent-flywheel-stop": "flywheel-stop",
  "orchestrate-cleanup": "flywheel-cleanup",
  "agent-flywheel-cleanup": "flywheel-cleanup",
  "orchestrate-status": "flywheel-status",
  "agent-flywheel-status": "flywheel-status",
  "agent-flywheel-doctor": "flywheel-doctor",
  "orchestrate-swarm-status": "flywheel-swarm-status",
  "agent-flywheel-swarm-status": "flywheel-swarm-status",
  "orchestrate-swarm-stop": "flywheel-swarm-stop",
  "agent-flywheel-swarm-stop": "flywheel-swarm-stop",
  "orchestrate-audit-beads": "flywheel-audit-beads",
  "agent-flywheel-audit-beads": "flywheel-audit-beads",
};

const slashWarningEmitted = new Set<string>();

export function emitSlashDeprecationWarning(calledName: string): void {
  const canonical = SLASH_CANONICAL[calledName];
  if (!canonical || canonical === calledName) return;
  if (process.env.FLYWHEEL_SUPPRESS_DEPRECATION) return;
  if (slashWarningEmitted.has(calledName)) return;
  slashWarningEmitted.add(calledName);
  console.warn(
    `[pi-agent-flywheel] /${calledName} is a deprecated alias of /${canonical}. ` +
    `The legacy alias will be removed in v2.0.0.`
  );
}

/** Reset slash deprecation cache. Test-only. */
export function _resetSlashDeprecationCache(): void {
  slashWarningEmitted.clear();
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
