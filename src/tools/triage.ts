import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext, OrchestratorPhase } from "../types.js";
import { buildWorkflowStatus } from "../workflow-status.js";
import { providerPreflightRepairGuidance } from "../provider-preflight.js";
import { canonicalName } from "./shared.js";

/**
 * R-004: flywheel_triage — single-call mega-command returning everything an
 * agent needs to decide what to do next: quick_ref + recommendations + commands
 * + health. Replaces the typical 4+ round-trip discovery sequence
 * (doctor + profile + state + beads list) with one call.
 *
 * Output shape is contract_version-stable; agents may parse `recommendations[].command`
 * and execute it directly.
 */

export interface TriageRecommendation {
  action: string;
  command: string;
  why: string;
  priority: "high" | "medium" | "low";
}

export interface TriageHealth {
  has_goal: boolean;
  has_profile: boolean;
  active_bead_count: number;
  bead_results_summary: { success: number; failure: number; pending: number };
  phase: string;
  worktree_pool_present: boolean;
  swarm_tender_present: boolean;
  provider_preflight: {
    status: "not_checked";
    reason: string;
    launch_time_check: string;
    repair_guidance: string[];
  };
}

export interface TriageQuickRef {
  phase: string;
  next_canonical_tool: string | null;
  blocking_error: string | null;
}

export interface TriageOutput {
  contract_version: string;
  ttl_seconds: number;
  generated_at: string;
  quick_ref: TriageQuickRef;
  health: TriageHealth;
  recommendations: TriageRecommendation[];
  copy_paste_workflow: string[];
}

export const TRIAGE_CONTRACT_VERSION = "1.0";
export const TRIAGE_TTL_SECONDS = 60;

const NEXT_TOOL_BY_PHASE: Record<OrchestratorPhase, string | null> = {
  idle: "flywheel_profile",
  profiling: "flywheel_profile",
  discovering: "flywheel_discover",
  awaiting_selection: "flywheel_select",
  planning: "flywheel_plan",
  researching: "flywheel_research",
  awaiting_plan_approval: "flywheel_approve_beads",
  creating_beads: "flywheel_approve_beads",
  refining_beads: "flywheel_approve_beads",
  awaiting_bead_approval: "flywheel_approve_beads",
  implementing: "flywheel_review",
  reviewing: "flywheel_review",
  iterating: "flywheel_review",
  complete: null,
};

export function buildTriage(oc: OrchestratorContext): TriageOutput {
  const state = oc.state;
  const status = buildWorkflowStatus(state, []);
  const phase = status.phase;
  const hasGoal = !!state.selectedGoal;
  const hasProfile = !!state.repoProfile;
  const activeBeadIds = state.activeBeadIds ?? [];
  const beadResults = state.beadResults ?? {};
  const success = Object.values(beadResults).filter((r: any) => r.status === "success").length;
  const failure = Object.values(beadResults).filter((r: any) => r.status === "failure").length;
  const pending = activeBeadIds.length - success - failure;

  const researchState = state.researchState;

  // blocking_error captures the most-likely "why is the next tool blocked" hint
  let blocking: string | null = null;
  if (researchState?.url && !hasGoal) blocking = null;
  else if (!hasProfile) blocking = "NO_PROFILE: call flywheel_profile first";
  else if (!hasGoal && phase === "discovering") blocking = "NO_GOAL: call flywheel_select after discover";
  else if (!state.candidateIdeas?.length && phase === "awaiting_selection") blocking = "NO_IDEAS: call flywheel_discover first";

  const quick_ref: TriageQuickRef = {
    phase,
    next_canonical_tool: NEXT_TOOL_BY_PHASE[phase],
    blocking_error: blocking,
  };

  const health: TriageHealth = {
    has_goal: hasGoal,
    has_profile: hasProfile,
    active_bead_count: activeBeadIds.length,
    bead_results_summary: { success, failure, pending: Math.max(0, pending) },
    phase,
    worktree_pool_present: false, // populated externally if available
    swarm_tender_present: false,
    provider_preflight: {
      status: "not_checked",
      reason: "flywheel_triage is read-only; it does not probe providers or auth.",
      launch_time_check: "Implementation and review launches run bounded provider/model preflight before starting workers.",
      repair_guidance: [
        ...providerPreflightRepairGuidance("not_checked"),
        "If launch reports OAuth 403, 401, or Unauthorized, repair auth, switch provider/model, retry after repair, or reduce worker count.",
      ],
    },
  };

  const recs: TriageRecommendation[] = [];
  if (researchState?.url && !hasGoal) {
    recs.push({
      action: "Continue external-repo research",
      command: "flywheel_research",
      why: `Research target is ${researchState.url}; do not profile/discover ideas for the current checkout.`,
      priority: "high",
    });
  } else if (!hasProfile) {
    recs.push({ action: "Profile the repo", command: "flywheel_profile", why: "No repo profile yet — required before discovery.", priority: "high" });
  }
  if (!researchState?.url && hasProfile && !state.candidateIdeas?.length) {
    recs.push({ action: "Discover ideas", command: "flywheel_discover", why: "Profile is loaded but no candidate ideas.", priority: "high" });
  }
  if (state.candidateIdeas?.length && !hasGoal) {
    recs.push({ action: "Select a goal", command: "flywheel_select", why: "Ideas discovered; user picks one.", priority: "high" });
  }
  if (hasGoal && !state.planDocument) {
    recs.push({ action: "Plan beads", command: "flywheel_plan", why: "Goal selected; run multi-model planning agents.", priority: "high" });
  }
  if (state.planDocument && !activeBeadIds.length) {
    recs.push({ action: "Approve beads", command: "flywheel_approve_beads", why: "Plan written; refine and emit beads to br.", priority: "high" });
  }
  if (failure > 0) {
    recs.push({ action: "Diagnose failed beads", command: "flywheel_doctor", why: `${failure} bead(s) failed; check health.`, priority: "high" });
  }
  if (recs.length === 0) {
    recs.push({ action: "Inspect health", command: "flywheel_doctor", why: "No specific blockers detected; doctor is the safe read-only first call.", priority: "low" });
  }

  const copy_paste_workflow = [
    "flywheel_status        # recovery-first: parseable phase, goal, beads, confidence, next action",
    "flywheel_capabilities  # discover the tool surface",
    "flywheel_robot_docs    # paste-ready handbook",
    "flywheel_doctor        # health check",
    "flywheel_research({ url: 'https://github.com/org/repo' })  # external-repo research path",
    "flywheel_profile && flywheel_discover && flywheel_select && flywheel_plan && flywheel_approve_beads",
  ];

  return {
    contract_version: TRIAGE_CONTRACT_VERSION,
    ttl_seconds: TRIAGE_TTL_SECONDS,
    generated_at: new Date().toISOString(),
    quick_ref,
    health,
    recommendations: recs,
    copy_paste_workflow,
  };
}

export function registerTriageTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: canonicalName("triage"),
    label: "Flywheel Triage",
    description: "Mega-command: returns quick_ref + recommendations + commands + health in one call. Use after flywheel_status when resuming/recovering, or as a first-call shortcut for a fresh session.",
    promptSnippet: "Return one-shot triage: phase, recommendations, health, copy-paste workflow",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const triage = buildTriage(oc);
      return {
        content: [{ type: "text", text: JSON.stringify(triage, null, 2) }],
        details: { triage },
      };
    },

    renderResult(_result, _options, theme) {
      return new Text(theme.fg("success", `flywheel_triage (contract v${TRIAGE_CONTRACT_VERSION})`), 0, 0);
    },
  });
}
