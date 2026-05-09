import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext } from "../types.js";
import { canonicalName, TOOL_FAMILIES, SLASH_CANONICAL } from "./shared.js";
import { CANONICAL_PHASES, ERROR_CATEGORIES } from "./capabilities.js";

/**
 * R-003: flywheel_robot_docs — paste-ready agent handbook returned in-tool.
 * Goal: an agent encountering pi-agent-flywheel for the first time should be
 * able to call this once and get everything needed to use the surface
 * correctly, without reading source.
 *
 * Output is markdown (stable string content). Pinned by snapshot test below.
 */

export function buildRobotDocs(): string {
  const lines: string[] = [];
  lines.push("# pi-agent-flywheel — Agent Handbook (machine-readable)");
  lines.push("");
  lines.push("> Call `flywheel_capabilities` for the structured contract; this guide is the prose companion.");
  lines.push("");
  lines.push("## 1. Canonical workflow (six phases)");
  lines.push("");
  lines.push("Always call tools in this order. Calling out of order returns a structured error naming the prerequisite tool.");
  lines.push("");
  lines.push("| Phase | Tool | What it does |");
  lines.push("|------:|------|--------------|");
  for (const p of CANONICAL_PHASES) {
    lines.push(`| ${p.position} | \`${p.canonical_tool}\` | ${p.description} |`);
  }
  lines.push("");
  lines.push("## 2. Tool naming convention");
  lines.push("");
  lines.push("All flywheel tools use the canonical prefix `flywheel_`. The legacy `agent_flywheel_*` and `orch_*` prefixes still work but emit a one-shot deprecation warning per legacy name. They will be removed in v2.0.0.");
  lines.push("");
  lines.push("Slash commands follow the same rule: canonical name is `/flywheel-X`. Legacy aliases `/agent-flywheel-X` and `/orchestrate-X` work but warn.");
  lines.push("");
  lines.push("## 3. Common errors and fixes");
  lines.push("");
  lines.push("| Error code | Fix command |");
  lines.push("|------------|-------------|");
  for (const cat of Object.values(ERROR_CATEGORIES)) {
    lines.push(`| \`${cat.code}\` | \`${cat.fix_command}\` |`);
  }
  lines.push("");
  lines.push("## 4. Five canonical workflows");
  lines.push("");
  lines.push("**4.1 Start a flywheel session.**");
  lines.push("```");
  lines.push("flywheel_profile      # phase 1");
  lines.push("flywheel_discover     # phase 2");
  lines.push("flywheel_select       # phase 3 (user picks goal)");
  lines.push("flywheel_plan         # phase 4");
  lines.push("flywheel_approve_beads # phase 5");
  lines.push("# Then per bead:");
  lines.push("flywheel_review       # phase 6");
  lines.push("```");
  lines.push("");
  lines.push("**4.2 Audit closed beads for compliance.**");
  lines.push("```");
  lines.push("flywheel_audit_beads  # one-shot bead-completion verification");
  lines.push("```");
  lines.push("Equivalent slash command: `/flywheel-audit-beads` (legacy aliases: `/agent-flywheel-audit-beads`, `/orchestrate-audit-beads`).");
  lines.push("");
  lines.push("**4.3 Audit codebase (NOT bead audit).**");
  lines.push("```");
  lines.push("/flywheel-audit       # codebase audit (legacy aliases: /agent-flywheel-audit, /orchestrate-audit)");
  lines.push("```");
  lines.push("Distinct from `/flywheel-audit-beads`: codebase audit spawns parallel agents for bugs/security/tests/dead-code; bead audit verifies completion claims.");
  lines.push("");
  lines.push("**4.4 Stop a stuck flywheel session.**");
  lines.push("```");
  lines.push("/flywheel-stop        # cancel orchestrator state");
  lines.push("/flywheel-cleanup     # release worktrees + reservations");
  lines.push("```");
  lines.push("");
  lines.push("**4.5 Diagnose health.**");
  lines.push("```");
  lines.push("flywheel_doctor       # read-only health check");
  lines.push("flywheel_triage       # mega-command: quick_ref + recommendations + commands + health");
  lines.push("```");
  lines.push("");
  lines.push("## 5. Self-discovery surfaces");
  lines.push("");
  lines.push("- `flywheel_capabilities` — machine-readable JSON contract (tools, schemas, error codes, phases).");
  lines.push("- `flywheel_robot_docs` — this document.");
  lines.push("- `flywheel_doctor` — read-only health diagnostics.");
  lines.push("- `flywheel_triage` — single-call mega-command (recommended first invocation).");
  lines.push("");
  lines.push("## 6. Environment variables");
  lines.push("");
  lines.push("- `FLYWHEEL_SUPPRESS_DEPRECATION=1` — suppress legacy-alias warnings (CI use).");
  lines.push("- `FLYWHEEL_CHECKPOINT_TTL_DAYS=N` — override stale-checkpoint threshold (default 7).");
  lines.push("");
  lines.push("## 7. Deprecation policy");
  lines.push("");
  lines.push("Legacy tool/command names emit a one-shot warning per legacy name per process. They will be removed in v2.0.0. Use `flywheel_capabilities.tools[].deprecated_aliases` to enumerate legacy names from the runtime contract.");
  return lines.join("\n");
}

export function registerRobotDocsTool(oc: OrchestratorContext) {
  oc.pi.registerTool({
    name: canonicalName("robot_docs"),
    label: "Flywheel Robot Docs",
    description: "Return a paste-ready agent handbook covering canonical phase order, tool naming, common errors, example workflows, and env vars. Call this when first encountering pi-agent-flywheel.",
    promptSnippet: "Return paste-ready agent handbook for pi-agent-flywheel",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const docs = buildRobotDocs();
      return {
        content: [{ type: "text", text: docs }],
        details: { length: docs.length, format: "markdown" },
      };
    },

    renderResult(_result, _options, theme) {
      return new Text(theme.fg("success", "flywheel_robot_docs (markdown handbook)"), 0, 0);
    },
  });
}
