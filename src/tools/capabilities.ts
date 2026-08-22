import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext } from "../types.js";
import { TOOL_CANONICAL_PREFIX, TOOL_FAMILIES, canonicalName } from "./shared.js";

/**
 * R-002: flywheel_capabilities — machine-readable contract for the pi-agent-flywheel
 * tool surface. Agents call this once to discover the tool list, canonical names,
 * deprecated aliases, orchestration phase order, env vars, and error categories
 * — instead of reading source.
 *
 * The output schema is contract_version-stable; breaking changes bump contract_version.
 * Pinned by src/_tool-contract.test.ts (R-009).
 */

export const CAPABILITIES_CONTRACT_VERSION = "1.0";

export interface FlywheelCapabilities {
  version: string;
  contract_version: string;
  canonical_prefix: string;
  tools: ToolCapability[];
  phases: PhaseDefinition[];
  error_categories: Record<string, ErrorCategory>;
  env_vars: EnvVarDefinition[];
  doctor_ref: string;
  status_ref: string;
  triage_ref: string;
  robot_docs_ref: string;
  generated_at: string;
}

interface ToolCapability {
  family: string;
  canonical_name: string;
  deprecated_aliases: string[];
  description: string;
  phase_position: number | null;
  prereq_tool: string | null;
  next_tool: string | null;
}

interface PhaseDefinition {
  position: number;
  name: string;
  canonical_tool: string;
  description: string;
}

interface ErrorCategory {
  code: string;
  fix_command: string;
  message_template: string;
}

interface EnvVarDefinition {
  name: string;
  effect: string;
}

export const CANONICAL_PHASES: PhaseDefinition[] = [
  { position: 1, name: "profile", canonical_tool: "flywheel_profile", description: "Read repo profile + scan results to seed downstream work." },
  { position: 2, name: "discover", canonical_tool: "flywheel_discover", description: "Generate candidate improvement ideas from the repo profile." },
  { position: 3, name: "select", canonical_tool: "flywheel_select", description: "Present ideas; user picks one (or enters custom goal). Persists selected goal." },
  { position: 4, name: "plan", canonical_tool: "flywheel_plan", description: "Run multi-model planning agents; produce bead draft." },
  { position: 5, name: "approve", canonical_tool: "flywheel_approve_beads", description: "Review + refine + approve the bead plan; emits beads to br." },
  { position: 6, name: "review", canonical_tool: "flywheel_review", description: "Per-bead review + next-bead selection after implementation." },
];

export const ERROR_CATEGORIES: Record<string, ErrorCategory> = {
  NO_GOAL: {
    code: "NO_GOAL",
    fix_command: "flywheel_select",
    message_template: "No goal selected. Call flywheel_select first.",
  },
  NO_PROFILE: {
    code: "NO_PROFILE",
    fix_command: "flywheel_profile",
    message_template: "No repo profile. Call flywheel_profile first.",
  },
  NO_IDEAS: {
    code: "NO_IDEAS",
    fix_command: "flywheel_discover",
    message_template: "No ideas available. Call flywheel_discover first.",
  },
  NO_PLAN: {
    code: "NO_PLAN",
    fix_command: "flywheel_plan",
    message_template: "No saved plan artifact found in orchestrator state.",
  },
  PLAN_SYNTH_FAILED: {
    code: "PLAN_SYNTH_FAILED",
    fix_command: "flywheel_plan({ mode: 'single_model' })",
    message_template: "All competing planning agents failed; retry with single_model fallback.",
  },
  BEAD_NOT_FOUND: {
    code: "BEAD_NOT_FOUND",
    fix_command: "br list",
    message_template: "Bead not found. Use `br list` to see available beads.",
  },
  OUT_OF_ORDER_TOOL_CALL: {
    code: "OUT_OF_ORDER_TOOL_CALL",
    fix_command: "flywheel_approve_beads",
    message_template: "Tool call does not match current planning-workflow stage. Wait for the previous step to finish, then resume from the recommended tool.",
  },
};

export const ENV_VARS: EnvVarDefinition[] = [
  { name: "FLYWHEEL_SUPPRESS_DEPRECATION", effect: "If set, suppresses deprecation warnings emitted when calling agent_flywheel_*/orch_* legacy tool names. Use in CI to reduce log noise." },
  { name: "FLYWHEEL_CHECKPOINT_TTL_DAYS", effect: "Override stale-checkpoint threshold (default: 7). Used by R-012 doctor recovery menu." },
  { name: "FLYWHEEL_SUPPRESS_SOURCE_RESEARCH", effect: "If set, suppresses the Source Research Card completion warning emitted during review for integration-heavy beads. Set when you want to quiet false-positive notices on local-only work." },
  { name: "FLYWHEEL_CLAUDE_CODE", effect: "Forces the Claude Code CLI availability probe used for model selection. Set \"1\" to prefer Claude, \"0\" to force the open-weight-via-OpenRouter fallback. Useful for deterministic tests/CI." },
];

const TOOL_DESCRIPTIONS: Record<string, { description: string; phase_position: number | null; prereq: string | null; next: string | null }> = {
  profile: { description: "Read repo profile + scan results to seed downstream work.", phase_position: 1, prereq: null, next: "flywheel_discover" },
  discover: { description: "Generate candidate improvement ideas from the repo profile.", phase_position: 2, prereq: "flywheel_profile", next: "flywheel_select" },
  select: { description: "Present discovered ideas; user picks one or enters a custom goal.", phase_position: 3, prereq: "flywheel_discover", next: "flywheel_plan" },
  plan: { description: "Run multi-model planning agents; emit bead draft.", phase_position: 4, prereq: "flywheel_select", next: "flywheel_approve_beads" },
  approve_beads: { description: "Review + refine + approve the bead plan; persist beads to br.", phase_position: 5, prereq: "flywheel_plan", next: "flywheel_review" },
  review: { description: "Per-bead review + next-bead selection after implementation.", phase_position: 6, prereq: "flywheel_approve_beads", next: null },
  memory: { description: "Search/store/mark long-term flywheel memory entries.", phase_position: null, prereq: null, next: null },
  doctor: { description: "Read-only diagnostic for flywheel prerequisites and session health.", phase_position: null, prereq: null, next: null },
  status: { description: "Return machine-readable workflow status: phase, goal, bead summary, confidence, and next action.", phase_position: null, prereq: null, next: null },
  verify_beads: { description: "Reconcile a completed implementation wave: verify bead IDs are closed.", phase_position: null, prereq: null, next: null },
  audit_beads: { description: "Audit closed beads for compliance with their stated implementation.", phase_position: null, prereq: null, next: null },
  research: { description: "Study an external repo and synthesize a research-reimagine proposal for this project.", phase_position: null, prereq: null, next: "flywheel_approve_beads" },
  capabilities: { description: "Return the machine-readable tool contract for pi-agent-flywheel.", phase_position: null, prereq: null, next: null },
  robot_docs: { description: "Return a paste-ready agent handbook (canonical phase order, common errors, examples).", phase_position: null, prereq: null, next: null },
  triage: { description: "Mega-command: quick_ref + recommendations + commands + health in one call; use after flywheel_status when resuming or as a fresh-session shortcut.", phase_position: null, prereq: null, next: null },
};

export function buildCapabilities(version: string): FlywheelCapabilities {
  const tools: ToolCapability[] = (Object.keys(TOOL_FAMILIES) as (keyof typeof TOOL_FAMILIES)[]).map((family) => {
    const names = TOOL_FAMILIES[family];
    const canonical = canonicalName(family);
    const deprecated = names.filter((n) => n !== canonical);
    const meta = TOOL_DESCRIPTIONS[family] ?? { description: family, phase_position: null, prereq: null, next: null };
    return {
      family,
      canonical_name: canonical,
      deprecated_aliases: deprecated,
      description: meta.description,
      phase_position: meta.phase_position,
      prereq_tool: meta.prereq,
      next_tool: meta.next,
    };
  });

  return {
    version,
    contract_version: CAPABILITIES_CONTRACT_VERSION,
    canonical_prefix: TOOL_CANONICAL_PREFIX,
    tools,
    phases: CANONICAL_PHASES,
    error_categories: ERROR_CATEGORIES,
    env_vars: ENV_VARS,
    doctor_ref: canonicalName("doctor"),
    status_ref: canonicalName("status"),
    triage_ref: canonicalName("triage"),
    robot_docs_ref: canonicalName("robot_docs"),
    generated_at: new Date().toISOString(),
  };
}

export function registerCapabilitiesTool(oc: OrchestratorContext, packageVersion: string) {
  oc.pi.registerTool({
    name: canonicalName("capabilities"),
    label: "Flywheel Capabilities",
    description: "Return the machine-readable tool contract for pi-agent-flywheel: canonical names, deprecated aliases, phase order, error codes, env vars. Call this first to discover the tool surface without reading source.",
    promptSnippet: "Return pi-agent-flywheel tool contract (machine-readable)",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const caps = buildCapabilities(packageVersion);
      return {
        content: [{ type: "text", text: JSON.stringify(caps, null, 2) }],
        details: { capabilities: caps },
      };
    },

    renderResult(_result, _options, theme) {
      return new Text(theme.fg("success", `flywheel_capabilities (contract v${CAPABILITIES_CONTRACT_VERSION})`), 0, 0);
    },
  });
}
