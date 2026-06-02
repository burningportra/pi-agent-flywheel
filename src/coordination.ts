import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import type { CoordinationMode } from "./types.js";
import type { AgentMailPreflightResult, ExecFn } from "./agent-mail.js";
import { brExec, resilientExec } from "./cli-exec.js";
import type { ProviderPreflightSummary } from "./provider-preflight.js";

// ─── Types ─────────────────────────────────────────────────────

export interface CoordinationBackend {
  /** br CLI installed AND .beads/ initialized in project */
  beads: boolean;
  /** Agent-mail MCP server reachable */
  agentMail: boolean;
  /** Whether .git/hooks/pre-commit contains the agent-mail guard */
  preCommitGuardInstalled?: boolean;
}

/**
 * Coordination strategy derived from available backends.
 *
 * - "beads+agentmail": full coordination — beads for task lifecycle, agent-mail for messaging + file reservations
 * - "worktrees": bare — worktree isolation only, no task tracking or messaging
 */
export type CoordinationStrategy =
  | "beads+agentmail"
  | "worktrees";

export function selectStrategy(backend: CoordinationBackend): CoordinationStrategy {
  if (backend.beads && backend.agentMail) return "beads+agentmail";
  return "worktrees";
}

/**
 * Select coordination mode based on available backends.
 * When agent-mail is available, agents can safely share a single branch
 * using file reservations. Otherwise, fall back to worktree isolation.
 */
export function selectMode(backend: CoordinationBackend): CoordinationMode {
  return backend.agentMail ? "single-branch" : "worktree";
}

// ─── Implementation launch safety ─────────────────────────────

export interface LaunchSafetyBead {
  id: string;
  title?: string;
  files: string[];
}

export interface LaunchFileConflict {
  file: string;
  beadIds: string[];
}

export type ImplementationLaunchMode = "single-branch-parallel" | "worktree-parallel" | "sequential";

export interface ImplementationLaunchSafetyDecision {
  mode: ImplementationLaunchMode;
  workerCount: number;
  selectedBeadIds: string[];
  parallel: boolean;
  conflicts: LaunchFileConflict[];
  missingFileScopeBeadIds: string[];
  agentMailStatus: AgentMailPreflightResult["status"] | "not_required";
  providerStatus: ProviderPreflightSummary["status"] | "not_checked";
  providerPreflight?: ProviderPreflightSummary;
  downgradeReasons: string[];
  repairGuidance: string[];
  supervision: "interactive-subagents" | "visible-ntm" | "single-worker";
  explanation: string;
}

export function findFileScopeConflicts(beads: readonly LaunchSafetyBead[]): LaunchFileConflict[] {
  const fileToBeads = new Map<string, string[]>();
  for (const bead of beads) {
    const uniqueFiles = new Set(bead.files.map((file) => file.trim()).filter(Boolean));
    for (const file of uniqueFiles) {
      const beadIds = fileToBeads.get(file) ?? [];
      beadIds.push(bead.id);
      fileToBeads.set(file, beadIds);
    }
  }
  return [...fileToBeads.entries()]
    .filter(([, beadIds]) => beadIds.length > 1)
    .map(([file, beadIds]) => ({ file, beadIds }));
}

export function detectInteractiveSubagentToolSurface(toolNames: readonly string[] | undefined): boolean {
  if (!toolNames) return false;
  const tools = new Set(toolNames);
  return tools.has("subagent") && tools.has("subagent_interrupt") && tools.has("subagent_resume");
}

function describeLaunchDecision(decision: Omit<ImplementationLaunchSafetyDecision, "explanation">): string {
  const lines: string[] = [];
  const providerDowngrades = decision.providerPreflight?.results.filter((result) => !result.launchable) ?? [];
  if (decision.mode === "single-branch-parallel") {
    lines.push(`✅ Parallel single-branch launch allowed for ${decision.selectedBeadIds.join(", ")}: Agent Mail reservations are available and file scopes are disjoint.`);
  } else if (decision.mode === "worktree-parallel") {
    lines.push(`🌿 Parallel launch downgraded to worktree isolation for ${decision.selectedBeadIds.join(", ")}.`);
  } else {
    lines.push(`🚦 Launch reduced to a single worker for ${decision.selectedBeadIds[0] ?? "the next bead"}.`);
  }

  if (decision.conflicts.length > 0) {
    lines.push(`Conflicting bead/file pairs: ${decision.conflicts.map((c) => `${c.file} (${c.beadIds.join(" ↔ ")})`).join("; ")}.`);
  }
  if (decision.missingFileScopeBeadIds.length > 0) {
    lines.push(`Missing file scopes: ${decision.missingFileScopeBeadIds.join(", ")}.`);
  }
  if (decision.agentMailStatus !== "available" && decision.agentMailStatus !== "not_required") {
    lines.push(`Agent Mail preflight: ${decision.agentMailStatus}.`);
  }
  if (decision.providerPreflight && providerDowngrades.length > 0) {
    const launchable = decision.providerPreflight.results
      .filter((result) => result.launchable)
      .map((result) => result.check.label)
      .join(", ");
    const unavailable = providerDowngrades
      .map((result) => `${result.check.required ? "required" : "optional"} ${result.check.label}: ${result.status}${result.evidence.length ? ` (${result.evidence.join("; ")})` : ""}`)
      .join("; ");
    lines.push(`Provider preflight: ${decision.providerStatus}${launchable ? `; launchable route(s): ${launchable}` : ""}; skipped/degraded: ${unavailable}.`);
  }
  if (decision.downgradeReasons.length > 0) {
    lines.push(`Downgrade reason: ${decision.downgradeReasons.join("; ")}.`);
  }
  if (decision.repairGuidance.length > 0) {
    lines.push(`Repair/preflight guidance: ${decision.repairGuidance.join(" | ")}`);
  }
  if (decision.supervision === "interactive-subagents") {
    lines.push("Supervisor surface: interactive subagents with resume/interrupt support are available.");
  } else if (decision.supervision === "visible-ntm") {
    lines.push("Supervisor surface: use visible/controllable NTM panes; avoid hidden non-interactive workers.");
  } else {
    lines.push("Supervisor surface: single worker avoids hidden non-interactive multi-agent coordination risk.");
  }
  return lines.join("\n");
}

export function decideImplementationLaunchSafety(input: {
  readyBeads: readonly LaunchSafetyBead[];
  requestedMode: CoordinationMode;
  agentMailPreflight?: AgentMailPreflightResult;
  worktreeAvailable: boolean;
  interactiveSubagentsAvailable?: boolean;
  visibleNtmAvailable?: boolean;
  providerPreflight?: ProviderPreflightSummary;
}): ImplementationLaunchSafetyDecision {
  const readyBeads = [...input.readyBeads];
  const selectedAll = readyBeads.map((bead) => bead.id);
  const conflicts = findFileScopeConflicts(readyBeads);
  const missingFileScopeBeadIds = readyBeads.filter((bead) => bead.files.length === 0).map((bead) => bead.id);
  const hasParallel = readyBeads.length > 1;
  const agentMailStatus: ImplementationLaunchSafetyDecision["agentMailStatus"] = input.requestedMode === "worktree"
    ? "not_required"
    : input.agentMailPreflight?.status ?? "server_unreachable";
  const reservationsAvailable = input.requestedMode === "worktree"
    ? true
    : input.agentMailPreflight?.reservationsAvailable === true;
  const hasControllableMultiAgentSurface = !!input.interactiveSubagentsAvailable || !!input.visibleNtmAvailable;
  const providerStatus = input.providerPreflight?.status ?? "not_checked";
  const providerLaunchable = !input.providerPreflight || input.providerPreflight.launchableCount > 0;
  const providerBlocksParallel = !!input.providerPreflight && !providerLaunchable;

  const downgradeReasons: string[] = [];
  if (!hasParallel) {
    const base = {
      mode: "sequential" as const,
      workerCount: Math.min(1, readyBeads.length),
      selectedBeadIds: selectedAll.slice(0, 1),
      parallel: false,
      conflicts,
      missingFileScopeBeadIds,
      agentMailStatus,
      downgradeReasons,
      providerStatus,
      providerPreflight: input.providerPreflight,
      repairGuidance: [...(input.agentMailPreflight?.repairGuidance ?? []), ...(input.providerPreflight?.repairGuidance ?? [])],
      supervision: "single-worker" as const,
    };
    return { ...base, explanation: describeLaunchDecision(base) };
  }

  if (input.requestedMode === "worktree" && !providerBlocksParallel) {
    const base = {
      mode: "worktree-parallel" as const,
      workerCount: readyBeads.length,
      selectedBeadIds: selectedAll,
      parallel: true,
      conflicts,
      missingFileScopeBeadIds,
      agentMailStatus,
      downgradeReasons: ["explicit worktree mode isolates worker changes; Agent Mail reservations are not required", ...(input.providerPreflight?.downgradeReasons ?? [])],
      providerStatus,
      providerPreflight: input.providerPreflight,
      repairGuidance: input.providerPreflight?.repairGuidance ?? [],
      supervision: (input.interactiveSubagentsAvailable ? "interactive-subagents" : "visible-ntm") as "visible-ntm" | "interactive-subagents",
    };
    return { ...base, explanation: describeLaunchDecision(base) };
  }

  if (!reservationsAvailable) downgradeReasons.push(`Agent Mail reservations unavailable (${agentMailStatus})`);
  if (conflicts.length > 0) downgradeReasons.push("ready bead file scopes overlap");
  if (missingFileScopeBeadIds.length > 0) downgradeReasons.push("one or more ready beads are missing ### Files scope");
  if (!hasControllableMultiAgentSurface) downgradeReasons.push("no visible/interactive multi-agent supervision surface detected");
  if (input.providerPreflight) {
    downgradeReasons.push(...input.providerPreflight.downgradeReasons);
    if (providerBlocksParallel) downgradeReasons.push(`no launchable worker provider/surface available (${providerStatus})`);
  }

  const safeSingleBranchParallel = reservationsAvailable
    && conflicts.length === 0
    && missingFileScopeBeadIds.length === 0
    && hasControllableMultiAgentSurface
    && !providerBlocksParallel;

  if (safeSingleBranchParallel) {
    const base = {
      mode: "single-branch-parallel" as const,
      workerCount: readyBeads.length,
      selectedBeadIds: selectedAll,
      parallel: true,
      conflicts,
      missingFileScopeBeadIds,
      agentMailStatus,
      downgradeReasons,
      providerStatus,
      providerPreflight: input.providerPreflight,
      repairGuidance: input.providerPreflight?.repairGuidance ?? [],
      supervision: (input.interactiveSubagentsAvailable ? "interactive-subagents" : "visible-ntm") as "interactive-subagents" | "visible-ntm",
    };
    return { ...base, explanation: describeLaunchDecision(base) };
  }

  if (input.worktreeAvailable) {
    const base = {
      mode: "worktree-parallel" as const,
      workerCount: readyBeads.length,
      selectedBeadIds: selectedAll,
      parallel: true,
      conflicts,
      missingFileScopeBeadIds,
      agentMailStatus,
      downgradeReasons,
      providerStatus,
      providerPreflight: input.providerPreflight,
      repairGuidance: [...(input.agentMailPreflight?.repairGuidance ?? []), ...(input.providerPreflight?.repairGuidance ?? [])],
      supervision: "visible-ntm" as const,
    };
    return { ...base, explanation: describeLaunchDecision(base) };
  }

  const base = {
    mode: "sequential" as const,
    workerCount: 1,
    selectedBeadIds: selectedAll.slice(0, 1),
    parallel: false,
    conflicts,
    missingFileScopeBeadIds,
    agentMailStatus,
    downgradeReasons,
    providerStatus,
    providerPreflight: input.providerPreflight,
    repairGuidance: [...(input.agentMailPreflight?.repairGuidance ?? []), ...(input.providerPreflight?.repairGuidance ?? [])],
    supervision: "single-worker" as const,
  };
  return { ...base, explanation: describeLaunchDecision(base) };
}

// ─── Detection ─────────────────────────────────────────────────

let _cached: CoordinationBackend | null = null;

/**
 * Detect all available coordination backends. Cached after first call.
 * Call `resetDetection()` to force re-detect (e.g. after install).
 */
export async function detectCoordinationBackend(
  pi: ExtensionAPI,
  cwd: string
): Promise<CoordinationBackend> {
  if (_cached) return _cached;

  const [beads, agentMail] = await Promise.all([
    detectBeads(pi, cwd),
    detectAgentMail(pi),
  ]);

  const preCommitGuardInstalled = agentMail
    ? await checkPreCommitGuard(pi.exec as unknown as ExecFn, cwd)
    : false;

  if (agentMail && !preCommitGuardInstalled) {
    console.warn(
      "[pi-agent-flywheel] Agent Mail is available but the pre-commit guard is not installed. " +
      "Run scaffoldPreCommitGuard() or set AGENT_NAME and install .git/hooks/pre-commit."
    );
  }

  _cached = { beads, agentMail, preCommitGuardInstalled };
  return _cached;
}

export function resetDetection(): void {
  _cached = null;
}

export function getCachedBackend(): CoordinationBackend | null {
  return _cached;
}

// ─── Individual detectors ──────────────────────────────────────

async function detectBeads(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  // Check br CLI is installed
  const result = await brExec(pi, ["--help"], { timeout: 3000, cwd, maxRetries: 0 });
  if (!result.ok) return false;

  // Check .beads/ directory exists (initialized)
  return existsSync(join(cwd, ".beads"));
}

async function isAgentMailReachable(pi: ExtensionAPI): Promise<boolean> {
  const result = await resilientExec(pi, "curl", [
    "-s", "--max-time", "2",
    "http://127.0.0.1:8765/health/liveness",
  ], { timeout: 5000, maxRetries: 1 });
  if (!result.ok) return false;
  try {
    const parsed = JSON.parse(result.value.stdout.trim());
    return parsed?.status === "ok" || parsed?.status === "healthy" || parsed?.status === "alive";
  } catch {
    return result.value.code === 0 && result.value.stdout.length > 0;
  }
}

async function detectAgentMail(pi: ExtensionAPI): Promise<boolean> {
  // Check if already running
  if (await isAgentMailReachable(pi)) return true;

  // Not running — check if installed and try to start it
  const whichResult = await resilientExec(pi, "uv", ["run", "python", "-c", "import mcp_agent_mail"], {
    timeout: 5000,
    maxRetries: 0,
  });
  if (!whichResult.ok || whichResult.value.code !== 0) return false; // not installed

  // Installed but not running — start in background
  const startResult = await resilientExec(pi, "bash", ["-c",
    "nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &"
  ], { timeout: 5000, maxRetries: 0 });

  if (!startResult.ok) return false;

  // Wait up to 5 seconds for it to become reachable
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isAgentMailReachable(pi)) return true;
  }

  return false;
}

// ─── Pre-Commit Guard ──────────────────────────────────────────

/**
 * Check if the Agent Mail pre-commit guard is installed.
 * Returns true if .git/hooks/pre-commit exists and contains "AGENT_NAME" or "agent-mail".
 */
export async function checkPreCommitGuard(
  _exec: ExecFn,
  cwd: string
): Promise<boolean> {
  try {
    const hookPath = join(cwd, ".git/hooks/pre-commit");
    if (!existsSync(hookPath)) return false;
    const content = readFileSync(hookPath, "utf-8");
    return content.includes("AGENT_NAME") || content.includes("agent-mail");
  } catch {
    return false;
  }
}

/**
 * Write the Agent Mail pre-commit guard hook to .git/hooks/pre-commit.
 * The hook blocks commits when another agent has an exclusive file reservation.
 * Makes the hook executable.
 */
export async function scaffoldPreCommitGuard(
  _exec: ExecFn,
  cwd: string
): Promise<void> {
  const hookPath = join(cwd, ".git/hooks/pre-commit");
  const script = `#!/bin/sh
# Agent Mail pre-commit guard
# Blocks commits to files exclusively reserved by another agent.
if [ -n "$AGENT_NAME" ]; then
  curl -s -X POST http://127.0.0.1:8765/api \\
    -H 'Content-Type: application/json' \\
    -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"check_commit_conflicts\\",\\"arguments\\":{\\"human_key\\":\\"$(pwd)\\",\\"agent_name\\":\\"$AGENT_NAME\\"}}}" \\
    | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  conflicts=d.get('result',{}).get('structuredContent',{}).get('conflicts',[])
  if conflicts:
    [print(f'COMMIT BLOCKED — reservation conflict: {c}') for c in conflicts]
    sys.exit(1)
except Exception:
  pass  # agent-mail unavailable — allow commit
" 2>/dev/null
fi
`;
  writeFileSync(hookPath, script, "utf-8");
  chmodSync(hookPath, 0o755);
}

// ─── UBS Detection ─────────────────────────────────────────────

let _ubsAvailable: boolean | null = null;

/**
 * Detects whether the `ubs` CLI is available. Result is cached.
 */
export async function detectUbs(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  if (_ubsAvailable !== null) return _ubsAvailable;
  const result = await resilientExec(pi, "ubs", ["--help"], { timeout: 3000, cwd, maxRetries: 0 });
  _ubsAvailable = result.ok && result.value.code === 0;
  return _ubsAvailable;
}

/** Reset UBS detection cache (for testing). */
export function resetUbsCache(): void {
  _ubsAvailable = null;
}

