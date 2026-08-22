/**
 * Swarm Launcher & Configuration
 *
 * Agent composition, staggered launch, status formatting,
 * and SwarmTender monitoring integration.
 */

import { swarmMarchingOrders, SWARM_STAGGER_DELAY_MS, SWARM_MODELS, withSubagentAutoExitInstruction, ntmOperatorTickLoopInstructions } from "./prompts.js";
import {
  describePaneSpecs,
  formatNtmSpawnFlags,
  paneSpecsForLaunch,
  recommendSwarmPaneMix,
  type NtmPaneKind,
  type NtmPaneSpec,
} from "./ntm-spawn.js";
import { SOURCE_RESEARCH_CARD_TEMPLATE, SOURCE_RESEARCH_WAIVER_TEMPLATE } from "./plan-quality.js";
import type { Bead } from "./types.js";
import type { AgentStatus } from "./tender.js";

// ─── Types ──────────────────────────────────────────────────

export interface SwarmAgentConfig {
  /** Display name for the agent. */
  name: string;
  /** Marching orders prompt. */
  task: string;
  /** Optional model override. */
  model?: string;
  /** Working directory. */
  cwd: string;
  /** Delay before spawning (ms) — for staggered starts. */
  delayMs: number;
  /** Swarm agents are autonomous and should exit after their final response. */
  interactive: false;
}

export interface NtmLaunchOptions {
  /** Working directory for the NTM project. */
  cwd: string;
  /** NTM label appended to the project session name. */
  label: string;
  /** Total worker panes when paneSpecs is omitted. */
  agentCount: number;
  /** Explicit NTM pane mix (`--cc`, `--cod`, `--cursor`; preferred over `--gmi`). */
  paneSpecs?: NtmPaneSpec[];
  /** Model hint for single-pane launches (routes cc/cod/cursor). */
  model?: string;
  /** Open bead count used to pick default mix when scaling swarm size. */
  openBeadCount?: number;
  /** Prompt delivered to each pane. */
  prompt: string;
  /** Optional heading for the rendered instructions. */
  title?: string;
  /** Extra note when Cursor CLI (`agent`) is unavailable and mix fell back. */
  spawnNote?: string;
}

export interface ImplementationSwarmPromptOptions {
  cwd: string;
  readyBeadIds: string[];
  assignedBeadId?: string;
  executionModeLabel?: string;
  completedBeadIds?: string[];
}

function shellString(value: string): string {
  return JSON.stringify(value);
}

function sanitizeNtmLabel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "implementation";
}

export function formatNtmRobotManagementLoopInstructions(options: { label: string; agentCount?: number }): string {
  const label = sanitizeNtmLabel(options.label);
  const paneHint = Math.max(1, Math.min(10, Math.floor(options.agentCount ?? 1))) === 1
    ? "the pane"
    : "each pane";

  return [
    "### Full NTM robot management loop",
    "Do not stop at launch or a one-time snapshot. Tend the panes with NTM robot surfaces until the swarm reaches a real completion condition.",
    "",
    "```bash",
    `session="$(basename \"$PWD\")--${label}"`,
    "ntm --robot-snapshot",
    "ntm --robot-attention --attention-session=\"$session\" || true",
    "ntm --robot-tail=\"$session\" --lines=50 || true",
    "ntm mail inbox \"$session\" --json || true",
    "ntm --robot-is-working || true",
    "ntm --robot-health-oauth || true",
    "ntm --robot-diagnose=\"$session\" --diagnose-fix || true",
    "ntm --robot-wait=\"$session\" --wait-until=idle --timeout=10m || true",
    "```",
    "",
    ntmOperatorTickLoopInstructions(),
    "",
    "Operator loop details:",
    "1. Snapshot/resync with `ntm --robot-snapshot`; if the cursor expires, snapshot again before acting.",
    "2. Block on attention with `ntm --robot-attention --attention-session=\"$session\"` and inspect flagged panes, not just final summaries.",
    `3. Tail ${paneHint} with \`ntm --robot-tail=\"$session\" --lines=50\`; verify whether work is actually progressing with \`ntm --robot-is-working\` and recent commits/tests.`,
    "4. Check coordination mail with `ntm mail inbox \"$session\" --json` and handle urgent reservation or review messages.",
    "5. For stuck panes, use the NTM unstick ladder: send a wake-up nudge with `ntm send`, interrupt with `ntm --robot-interrupt=\"$session\" --panes=N`, then `ntm --robot-diagnose=\"$session\" --diagnose-fix`; only restart/kill after capturing the pane tail.",
    "6. For rate-limited panes, confirm via `ntm --robot-health-oauth` / `ntm --robot-is-working`, then rotate/switch accounts with NTM instead of waiting silently.",
    "7. Send marching orders with `ntm send \"$session\" --pane N \"...\"` when panes drift into prose, idle handoff, or duplicate work.",
    "8. Stop only when completed beads have commits + verification evidence, no pane is actively working, and `br ready` / in-progress bead state shows no immediately actionable implementation work.",
  ].join("\n");
}

export function implementationSwarmPrompt(options: ImplementationSwarmPromptOptions): string {
  const readyList = options.readyBeadIds.length > 0 ? options.readyBeadIds.join(", ") : "use bv --robot-next";
  const assigned = options.assignedBeadId
    ? `\nYou are assigned bead ${options.assignedBeadId}. If it is not already in_progress, claim it with \`br update ${options.assignedBeadId} --status in_progress\` before editing.`
    : "\nPick exactly one ready bead using `bv --robot-triage` (preferred) or `bv --robot-next`, then claim it with `br update <id> --status in_progress` before editing.";
  const completed = options.completedBeadIds?.length
    ? `\nAlready completed in this run: ${options.completedBeadIds.join(", ")}. Do not reopen or duplicate those beads.`
    : "";

  return withSubagentAutoExitInstruction(`You are an AgentFlywheel implementation worker running in a managed NTM worker pane (cc, cod, or agent — not the pi orchestrator chat).

Repository: ${options.cwd}
Ready bead candidates: ${readyList}${assigned}${completed}
${options.executionModeLabel ? `\nExecution mode: ${options.executionModeLabel}` : ""}

Workflow:
1. Read AGENTS.md and follow all repo-local instructions.
2. Check Agent Mail if available and reserve files listed in the bead before editing.
3. Inspect the bead with \`br show <id>\` and keep changes within its ### Files scope.
4. If the bead is integration-heavy (migration, adapter, Durable Object, Effect SQL, Alchemy, RPC, database, auth middleware, SDK, or package integration), complete a Source Research Card before editing and include it in your review feedback. Review will warn if this is missing; resolve false positives with the waiver line.

${formatWorkerSupervisionGuidance({ interactiveSubagentsAvailable: false })}

${SOURCE_RESEARCH_CARD_TEMPLATE}

False-positive waiver: ${SOURCE_RESEARCH_WAIVER_TEMPLATE}
5. Implement the bead, run the bead's Verification commands, and do a fresh-eyes self-review.
6. Commit only your bead changes with a message like \`bead <id>: <summary>\`.
7. Mark the bead closed with \`br update <id> --status closed\` and \`br sync --flush-only\` after verification passes.
8. Report the bead id, commit hash, changed files, verification output, Source Research Card if required, and any blockers.

${ntmOperatorTickLoopInstructions()}

If there is no safe ready bead, report that and exit. Do not wait idle in the pane.`);
}

export interface SwarmComposition {
  /** Total agent count. */
  total: number;
  /** NTM pane mix for spawn command. */
  paneSpecs: NtmPaneSpec[];
  /** Recommended model distribution (roster display). */
  models: Array<{ model: string; count: number }>;
  /** When set, every agent uses this model instead of the pane-kind default roster. */
  modelOverride?: string;
  /** Reasoning for the recommendation. */
  rationale: string;
}

function modelLabelForPaneKind(kind: NtmPaneKind): string {
  switch (kind) {
    case "cc":
      return SWARM_MODELS.opus;
    case "cod":
      return SWARM_MODELS.gpt;
    case "cursor":
    case "agent":
      return "cursor-agent";
    case "gmi":
      return "openrouter/google/gemini-3.1-pro-preview";
    default:
      return "unknown";
  }
}

function modelsFromPaneSpecs(paneSpecs: NtmPaneSpec[]): Array<{ model: string; count: number }> {
  return paneSpecs.map((spec) => ({
    model: modelLabelForPaneKind(spec.kind),
    count: spec.count,
  }));
}

export function formatWorkerSupervisionGuidance(options: { interactiveSubagentsAvailable: boolean }): string {
  if (options.interactiveSubagentsAvailable) {
    return [
      "### Worker supervision surface",
      "Use pi-interactive-subagents-style workers only when the tool surface supports live supervision: `subagent`, `subagent_interrupt`, `subagent_resume`, and caller-to-parent `caller_ping`.",
      "Workers that need supervisor decisions should use `caller_ping` instead of becoming unreachable while running.",
    ].join("\n");
  }
  return [
    "### Worker supervision surface",
    "Do not launch hidden/non-interactive multi-agent workers for same-checkout work: a running worker that cannot respond to intercom can miss supervisor decisions.",
    "Prefer visible NTM panes (`--cc`, `--cod`, `--cursor`) or reduce to one worker until an interrupt/resume/caller_ping-capable surface is available.",
  ].join("\n");
}

// ─── Agent Composition ──────────────────────────────────────

/** Recommend agent composition based on open bead count. */
export function recommendComposition(openBeadCount: number): SwarmComposition {
  const paneSpecs = recommendSwarmPaneMix(openBeadCount);
  const total = paneSpecs.reduce((sum, spec) => sum + spec.count, 0);
  const mixSummary = describePaneSpecs(paneSpecs);

  if (openBeadCount >= 400) {
    return {
      total,
      paneSpecs,
      models: modelsFromPaneSpecs(paneSpecs),
      rationale: `${openBeadCount} open beads — large project, full swarm (${mixSummary})`,
    };
  }
  if (openBeadCount >= 100) {
    return {
      total,
      paneSpecs,
      models: modelsFromPaneSpecs(paneSpecs),
      rationale: `${openBeadCount} open beads — medium project (${mixSummary})`,
    };
  }
  return {
    total,
    paneSpecs,
    models: modelsFromPaneSpecs(paneSpecs),
    rationale: `${openBeadCount} open beads — small project (${mixSummary})`,
  };
}

// ─── Agent Config Generation ────────────────────────────────

/**
 * Generate agent configurations for the swarm.
 * Each agent gets staggered delay and marching orders.
 */
export function generateAgentConfigs(
  count: number,
  cwd: string,
  composition: SwarmComposition
): SwarmAgentConfig[] {
  const configs: SwarmAgentConfig[] = [];

  // Distribute models across agents according to composition. Be defensive for
  // callers that provide pane specs without a precomputed roster.
  const modelQueue: string[] = [];
  const modelRoster = composition.models.length > 0
    ? composition.models
    : modelsFromPaneSpecs(composition.paneSpecs);
  for (const { model, count: modelCount } of modelRoster) {
    for (let i = 0; i < Math.max(0, Math.floor(modelCount)); i++) {
      modelQueue.push(model);
    }
  }
  if (modelQueue.length === 0) {
    modelQueue.push("cursor-agent");
  }

  for (let i = 0; i < count; i++) {
    const model = composition.modelOverride ?? modelQueue[i % modelQueue.length];
    const modelShort = model.split("/").pop()?.slice(0, 12) ?? `agent-${i}`;

    configs.push({
      name: `swarm-${i + 1}-${modelShort}`,
      task: withSubagentAutoExitInstruction(swarmMarchingOrders(cwd)),
      model,
      cwd,
      delayMs: i * SWARM_STAGGER_DELAY_MS,
      interactive: false,
    });
  }

  return configs;
}

// ─── Status Formatting ──────────────────────────────────────

/**
 * Format swarm status for display.
 */
export function formatSwarmStatus(
  agents: AgentStatus[],
  beads: Bead[]
): string {
  if (agents.length === 0) return "No swarm agents active.";

  const active = agents.filter((a) => a.health === "active").length;
  const idle = agents.filter((a) => a.health === "idle").length;
  const stuck = agents.filter((a) => a.health === "stuck").length;

  const openBeads = beads.filter((b) => b.status === "open").length;
  const inProgress = beads.filter((b) => b.status === "in_progress").length;
  const closed = beads.filter((b) => b.status === "closed").length;

  const healthEmoji = stuck > 0 ? "🔴" : idle > agents.length / 2 ? "🟡" : "🟢";

  const lines = [
    `${healthEmoji} **Swarm Status** (${agents.length} agents)`,
    `  Active: ${active} | Idle: ${idle} | Stuck: ${stuck}`,
    `  Beads: ${openBeads} open | ${inProgress} in progress | ${closed} closed`,
  ];

  if (stuck > 0) {
    const stuckAgents = agents.filter((a) => a.health === "stuck");
    lines.push(`  ⚠️ Stuck agents: ${stuckAgents.map((a) => `#${a.stepIndex}`).join(", ")}`);
  }

  // File conflict detection
  const fileMap = new Map<string, number[]>();
  for (const agent of agents) {
    for (const file of agent.changedFiles) {
      const existing = fileMap.get(file) ?? [];
      existing.push(agent.stepIndex);
      fileMap.set(file, existing);
    }
  }
  const conflicts = Array.from(fileMap.entries()).filter(([, indices]) => indices.length > 1);
  if (conflicts.length > 0) {
    lines.push(`  🔴 File conflicts (${conflicts.length}):`);
    for (const [file, indices] of conflicts.slice(0, 5)) {
      lines.push(`    ${file} — agents #${indices.join(", #")}`);
    }
    if (conflicts.length > 5) {
      lines.push(`    ... and ${conflicts.length - 5} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a managed NTM launch command. Launches visible cc/cod/cursor panes
 * instead of asking the current orchestrator agent to edit inline.
 */
export function formatNtmLaunchInstructions(options: NtmLaunchOptions): string {
  const label = sanitizeNtmLabel(options.label);
  const paneSpecs = paneSpecsForLaunch({
    agentCount: options.agentCount,
    openBeadCount: options.openBeadCount,
    model: options.model,
    paneSpecs: options.paneSpecs,
  });
  const agentCount = paneSpecs.reduce((sum, spec) => sum + spec.count, 0);
  const spawnFlags = formatNtmSpawnFlags(paneSpecs);
  const title = options.title ?? "🐝 NTM Implementation Swarm";
  const mixLine = describePaneSpecs(paneSpecs);
  const noteBlock = options.spawnNote ? `\n\n${options.spawnNote}` : "";

  return [
    `## ${title}`,
    "",
    `Launch **${agentCount} managed NTM worker pane${agentCount === 1 ? "" : "s"}** (${mixLine}). Cursor Agent panes use NTM \`--cursor\` (backed by the official Cursor CLI command \`agent\`) and are preferred over Gemini (\`--gmi\`) for ergonomics-style work. Do **not** implement inline in the current chat; let the NTM panes claim/complete beads and report back.`,
    noteBlock,
    "",
    "```bash",
    `cd ${shellString(options.cwd)}`,
    "ntm --robot-docs=quickstart >/dev/null 2>&1 || true",
    `ntm spawn "$(basename "$PWD")" --label ${shellString(label)} --no-user ${spawnFlags} --stagger-mode=smart --prompt ${shellString(options.prompt)}`,
    `ntm --robot-snapshot`,
    "```",
    "",
    "Install the Cursor Agent CLI (`agent`) if `--cursor` panes fail to start. Run `ntm deps -v` and `agent --help` to verify agent CLIs.",
    "",
    formatNtmRobotManagementLoopInstructions({ label, agentCount }),
    "",
    "After panes finish, collect their summaries/commits and call `agent_flywheel_review`/`orch_review` for completed beads so AgentFlywheel state stays in sync.",
  ].join("\n");
}

/**
 * Format the swarm launch configuration for the LLM to execute.
 * Prefer NTM panes so implementation is visible, observable, and killable.
 */
export function formatLaunchInstructions(
  configs: SwarmAgentConfig[],
  composition?: SwarmComposition,
): string {
  const cwd = configs[0]?.cwd ?? process.cwd();
  const prompt = configs[0]?.task ?? swarmMarchingOrders(cwd);
  const instructions = formatNtmLaunchInstructions({
    cwd,
    label: "swarm",
    agentCount: configs.length,
    paneSpecs: composition?.paneSpecs,
    model: composition?.modelOverride,
    prompt,
    title: "🐝 Swarm Launch Configuration",
  });

  const lines = [instructions, "", "### Agent roster"];
  for (const config of configs) {
    lines.push(`- **${config.name}** — Pane/model: ${config.model ?? "ntm worker"}; Delay: ${config.delayMs / 1000}s`);
  }

  lines.push("");
  lines.push("**Important:**");
  lines.push("- NTM handles visible panes and smart staggering; avoid launching hidden `subagent` workers for implementation swarms");
  lines.push("- Each agent should independently use `bv --robot-triage` / `bv --robot-next` to pick work");
  lines.push("- Agents coordinate via Agent Mail file reservations");
  lines.push("- Manage the swarm with the full NTM robot loop above; `/orchestrate-swarm-status` is a dashboard shortcut, not a substitute for tending attention/tail/mail/health");
  lines.push("- Stop with `/orchestrate-swarm-stop` only after robot-loop convergence checks pass");

  return lines.join("\n");
}
