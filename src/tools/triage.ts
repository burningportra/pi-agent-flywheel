import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext } from "../types.js";
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

const NEXT_TOOL_BY_PHASE: Record<string, string | null> = {
  idle: "flywheel_profile",
  profile: "flywheel_discover",
  discover: "flywheel_select",
  select: "flywheel_plan",
  plan: "flywheel_approve_beads",
  approve: "flywheel_review",
  review: null,
  researching: "flywheel_research",
};

export function buildTriage(oc: OrchestratorContext): TriageOutput {
  const state = oc.state;
  const phase = (state.phase ?? "idle") as string;
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
  else if (!hasGoal && phase === "discover") blocking = "NO_GOAL: call flywheel_select after discover";
  else if (!state.candidateIdeas?.length && phase === "select") blocking = "NO_IDEAS: call flywheel_discover first";

  const quick_ref: TriageQuickRef = {
    phase,
    next_canonical_tool: NEXT_TOOL_BY_PHASE[phase] ?? null,
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
    description: "Mega-command: returns quick_ref + recommendations + commands + health in one call. Recommended FIRST invocation when starting work with pi-agent-flywheel — replaces the doctor+profile+state+beads round-trip dance.",
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
