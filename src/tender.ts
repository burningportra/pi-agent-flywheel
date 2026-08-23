import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  forceReleaseFileReservation,
  checkFileReservations,
  fetchInbox,
  sendMessage,
  whoisAgent,
  type ExecFn,
} from "./agent-mail.js";

// ─── Types ─────────────────────────────────────────────────────

export type AgentHealth = "active" | "idle" | "stuck";

export interface AgentStatus {
  worktreePath: string;
  stepIndex: number;
  health: AgentHealth;
  lastActivity: number; // timestamp ms
  changedFiles: string[];
  /** Agent name (e.g. swarm-1-... ) for Agent Mail addressing. */
  agentName?: string;
}

export interface TenderConfig {
  /** Polling interval in ms (default 60_000 = 60s) */
  pollInterval: number;
  /** Agent is "stuck" after this many ms without changes (default 300_000 = 5 min) */
  stuckThreshold: number;
  /** Agent is "idle" after this many ms without changes (default 120_000 = 2 min) */
  idleThreshold: number;
  /** Cadence check interval in ms (default 20 * 60 * 1000 = 20 min) */
  cadenceIntervalMs: number;
  /** Auto-tick interval for idle-instruct / stalled-beed reopen / anti-slop (default 4 min). */
  autoTickIntervalMs: number;
  /** An in_progress bead with updated_at older than this (ms) counts as stalled (default 60 min). */
  stalledBeadThresholdMs: number;
  /** Invoke the anti-slop check every this many commits (default 6). */
  antiSlopCommitCadence: number;
}

export interface ConflictAlert {
  file: string;
  worktrees: string[];
  stepIndices: number[];
}

const DEFAULT_CONFIG: TenderConfig = {
  pollInterval: 60_000,
  stuckThreshold: 300_000,
  idleThreshold: 120_000,
  cadenceIntervalMs: 20 * 60 * 1000,
  autoTickIntervalMs: 4 * 60 * 1000,
  stalledBeadThresholdMs: 60 * 60 * 1000,
  antiSlopCommitCadence: 6,
};

const CADENCE_CHECKLIST = `## 👷 Operator Cadence Check (every ~20 min (configurable via cadenceIntervalMs))

1. 📊 **Check bead progress** — run \`br list --status in_progress --json\` or \`bv --robot-triage\`. Are agents making steady progress? Any beads stuck >15 min?
2. 🔄 **Handle compactions** — if any agent looks confused or is repeating itself, send: "Reread AGENTS.md so it's still fresh in your mind."
3. 🔍 **Run a review round** — pick one agent and send the fresh-eyes review prompt. Catches bugs before they compound.
4. ⚡ **Manage rate limits** — if an agent hit rate limits, switch account with CAAM or start a fresh agent.
5. 📦 **Periodic commit** — designate one agent to do an organized commit every 1–2 hours.
6. 🆕 **Handle surprises** — create new beads for unanticipated issues discovered during implementation.

### Operator Proof Card
Fill this out before any intervention:

\`\`\`markdown
- Evidence:
- Card matched:
- Target:
- Expected state change:
- Recovery:
\`\`\`

### Intervention Score Matrix
Score = Evidence × Impact × Reversibility / BlastRadius; only act if Score >= 2.0.

| Evidence | Impact | Reversibility | BlastRadius | Score |
|----------|--------|---------------|-------------|-------|
| 0-3 | 0-3 | 1-3 | 1-3 | >= 2.0 required |

### convergence triple-check
Declare done only when ready queue empty AND no in-flight work AND no expected upstream signals.

### Anti-pattern
If you find yourself sending the same nudge twice without movement, escalate to smart-restart, not another nudge.`;

// ─── Pure decision helpers (unit-testable) ────────────────────

/**
 * Return ids of `in_progress` beads whose `updated_at` is at least `thresholdMs`
 * old. This is the evidence-based stale-bead signal used by the auto-tick reopen.
 */
export function selectStalledBeads(
  beads: Array<{ id: string; status: string; updated_at?: string | number }>,
  now: number,
  thresholdMs: number
): string[] {
  return beads
    .filter((b) => b.status === "in_progress")
    .filter((b) => {
      const ts = typeof b.updated_at === "number" ? b.updated_at : Date.parse(String(b.updated_at ?? ""));
      return !Number.isNaN(ts) && now - ts >= thresholdMs;
    })
    .map((b) => b.id);
}

/**
 * Decide whether the anti-slop commit cadence has been reached.
 * `lastCount === 0` means we have not yet established a baseline, so nothing is due.
 */
export function antiSlopDue(
  commitCount: number,
  lastCount: number,
  cadence: number
): { due: boolean; since: number } {
  if (lastCount === 0) return { due: false, since: 0 };
  const since = commitCount - lastCount;
  return { due: since >= cadence, since };
}

// ─── SwarmTender ───────────────────────────────────────────────

export interface SwarmTenderOptions {
  config?: Partial<TenderConfig>;
  onStuck?: (agent: AgentStatus) => void;
  onConflict?: (conflict: ConflictAlert) => void;
  onTick?: (statuses: AgentStatus[]) => void;
  /** Called every cadenceIntervalMs with the operator cadence checklist. */
  onCadenceCheck?: (checklist: string) => void;
  /** Agent Mail orchestrator identity (for sending stuck-agent messages). */
  orchestratorAgentName?: string;
  /** Fired when idle/stuck agents exist and the auto-tick interval elapses, with a bv-guided ready bead. */
  onIdleInstruct?: (idleAgents: AgentStatus[], readyBead: string) => void;
  /** Fired after the tender auto-reopens clearly-stalled in_progress beads. */
  onStalledBeadReopened?: (reopenedBeadIds: string[]) => void;
  /** Fired when the anti-slop commit cadence is reached. */
  onAntiSlopDue?: (commitsSinceLast: number) => void;
}

export class SwarmTender {
  private pi: ExtensionAPI;
  private cwd: string;
  private agents: Map<number, AgentStatus>; // stepIndex → status
  private config: TenderConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onStuck?: (agent: AgentStatus) => void;
  private onConflict?: (conflict: ConflictAlert) => void;
  private onTick?: (statuses: AgentStatus[]) => void;
  private onCadenceCheck?: (checklist: string) => void;
  private onIdleInstruct?: (idleAgents: AgentStatus[], readyBead: string) => void;
  private onStalledBeadReopened?: (reopenedBeadIds: string[]) => void;
  private onAntiSlopDue?: (commitsSinceLast: number) => void;
  private lastCadencePromptAt: number = Date.now();
  private lastAutoTickAt: number = Date.now();
  private lastAntiSlopCommitCount = 0;
  private orchestratorAgentName?: string;

  constructor(
    pi: ExtensionAPI,
    cwd: string,
    worktrees: { path: string; stepIndex: number; agentName?: string }[],
    options?: SwarmTenderOptions
  ) {
    this.pi = pi;
    this.cwd = cwd;
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.onStuck = options?.onStuck;
    this.onConflict = options?.onConflict;
    this.onTick = options?.onTick;
    this.onCadenceCheck = options?.onCadenceCheck;
    this.onIdleInstruct = options?.onIdleInstruct;
    this.onStalledBeadReopened = options?.onStalledBeadReopened;
    this.onAntiSlopDue = options?.onAntiSlopDue;
    this.orchestratorAgentName = options?.orchestratorAgentName;

    this.agents = new Map();
    for (const wt of worktrees) {
      this.agents.set(wt.stepIndex, {
        worktreePath: wt.path,
        stepIndex: wt.stepIndex,
        health: "active",
        lastActivity: Date.now(),
        changedFiles: [],
        agentName: wt.agentName,
      });
    }
  }

  /** Start polling. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.config.pollInterval);
    // Run first poll immediately
    this.poll();
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get current status of all agents. */
  getStatus(): AgentStatus[] {
    return [...this.agents.values()];
  }

  /** Get summary string for widget display. */
  getSummary(): string {
    const statuses = this.getStatus();
    const active = statuses.filter((s) => s.health === "active").length;
    const idle = statuses.filter((s) => s.health === "idle").length;
    const stuck = statuses.filter((s) => s.health === "stuck").length;
    const parts: string[] = [];
    if (active > 0) parts.push(`${active} active`);
    if (idle > 0) parts.push(`${idle} idle`);
    if (stuck > 0) parts.push(`${stuck} stuck`);
    return parts.join(", ") || "no agents";
  }

  /** Single poll cycle — check all worktrees. */
  private async poll(): Promise<void> {
    const now = Date.now();
    const allChangedFiles = new Map<string, number[]>(); // file → stepIndices

    for (const [stepIndex, agent] of this.agents) {
      try {
        // Check git status for this worktree
        const result = await this.pi.exec(
          "git",
          ["status", "--porcelain"],
          { timeout: 5000, cwd: agent.worktreePath }
        );

        const files = result.code === 0
          ? result.stdout.trim().split("\n").filter(Boolean).map((l) => l.slice(3))
          : [];

        // Check if files changed since last poll
        const filesChanged = files.length !== agent.changedFiles.length ||
          files.some((f, i) => f !== agent.changedFiles[i]);

        if (filesChanged) {
          agent.lastActivity = now;
          agent.changedFiles = files;
        }

        // Classify health
        const elapsed = now - agent.lastActivity;
        const prevHealth = agent.health;

        if (elapsed > this.config.stuckThreshold) {
          agent.health = "stuck";
          if (prevHealth !== "stuck") {
            this.onStuck?.(agent);
          }
        } else if (elapsed > this.config.idleThreshold) {
          agent.health = "idle";
        } else {
          agent.health = "active";
        }

        // Track files for conflict detection
        for (const file of files) {
          // Skip generated/ephemeral files
          if (file.startsWith(".pi-agent-flywheel/")) continue;
          const existing = allChangedFiles.get(file) ?? [];
          existing.push(stepIndex);
          allChangedFiles.set(file, existing);
        }
      } catch {
        // Worktree might be gone (already cleaned up)
        // Don't crash the tender
      }
    }

    // Conflict detection: files modified in multiple worktrees
    for (const [file, stepIndices] of allChangedFiles) {
      if (stepIndices.length > 1) {
        const worktrees = stepIndices.map(
          (idx) => this.agents.get(idx)?.worktreePath ?? ""
        ).filter(Boolean);
        this.onConflict?.({ file, worktrees, stepIndices });
      }
    }

    this.onTick?.(this.getStatus());

    // Auto-tick: idle-instruct, stalled-bead reopen, anti-slop cadence.
    if (now - this.lastAutoTickAt >= this.config.autoTickIntervalMs && process.env.FLYWHEEL_SWARM_AUTO_TICK !== "0") {
      await this.maybeAutoTick(this.getStatus().filter((a) => a.health !== "active"));
    }

    // Cadence check: fire if the interval has elapsed
    if (now - this.lastCadencePromptAt >= this.config.cadenceIntervalMs) {
      this.lastCadencePromptAt = now;
      this.onCadenceCheck?.(CADENCE_CHECKLIST);
    }
  }

  /**
   * Auto-tick pass: instruct idle agents, reopen clearly-stalled beads, and
   * flag the anti-slop commit cadence. Guarded by env toggles (run the three
   * checks only when enabled) and by evidence (never disrupt active work).
   */
  async maybeAutoTick(idleAgents: AgentStatus[]): Promise<void> {
    this.lastAutoTickAt = Date.now();

    // Idle-instruct: pick a ready bead and hand it to idle agents.
    const readyBead = await this._pickReadyBead();
    if (idleAgents.length > 0 && readyBead) {
      this.onIdleInstruct?.(idleAgents, readyBead);
      for (const a of idleAgents) {
        if (a.agentName) await this._sendIdleInstruct(a.agentName, readyBead);
      }
    }

    // Stalled-bead reopen: do not disrupt active work.
    if (process.env.FLYWHEEL_SWARM_AUTO_REOPEN !== "0") {
      const reopened = await this.reopenStalledBeads();
      if (reopened.length > 0) this.onStalledBeadReopened?.(reopened);
    }

    // Anti-slop cadence.
    await this._antiSlopCadence();
  }

  /** Best-effort: run `bv --robot-next` and return a ready-bead hint line. */
  private async _pickReadyBead(): Promise<string> {
    try {
      const res = await this.pi.exec("bv", ["--robot-next"], { timeout: 5000, cwd: this.cwd });
      if (res.code === 0 && res.stdout.trim()) return res.stdout.trim();
    } catch { /* bv may be unavailable */ }
    return "";
  }

  /**
   * Reopen `in_progress` beads whose `updated_at` is older than
   * `stalledBeadThresholdMs`. Only reopens when no agent is actively working
   * (health === active), so it never disrupts in-flight work.
   */
  async reopenStalledBeads(): Promise<string[]> {
    const reopened: string[] = [];
    const anyActive = [...this.agents.values()].some((a) => a.health === "active");
    if (anyActive) return reopened;

    try {
      const res = await this.pi.exec("br", ["list", "--json"], { timeout: 5000, cwd: this.cwd });
      if (res.code !== 0) return reopened;
      const parsed = JSON.parse(res.stdout);
      const issues: any[] = Array.isArray(parsed) ? parsed : parsed.issues ?? [];
      const toReopen = selectStalledBeads(issues, Date.now(), this.config.stalledBeadThresholdMs);
      for (const id of toReopen) {
        try {
          const upd = await this.pi.exec("br", ["update", id, "--status", "open"], { timeout: 5000, cwd: this.cwd });
          if (upd.code === 0) reopened.push(id);
        } catch { /* ignore per-bead failures */ }
      }
      if (reopened.length > 0) {
        await this.pi.exec("br", ["sync", "--flush-only"], { timeout: 5000, cwd: this.cwd });
      }
    } catch { /* br may be unavailable */ }
    return reopened;
  }

  /** Count repo commits and fire onAntiSlopDue when the cadence is reached. */
  private async _antiSlopCadence(): Promise<void> {
    try {
      const res = await this.pi.exec("git", ["rev-list", "--count", "HEAD"], { timeout: 5000, cwd: this.cwd });
      if (res.code !== 0) return;
      const count = parseInt(res.stdout.trim(), 10);
      if (Number.isNaN(count)) return;
      const { due, since } = antiSlopDue(count, this.lastAntiSlopCommitCount, this.config.antiSlopCommitCadence);
      if (due) {
        this.lastAntiSlopCommitCount = count;
        this.onAntiSlopDue?.(since);
      } else if (this.lastAntiSlopCommitCount === 0) {
        // First observation: establish the baseline without firing. Without this,
        // lastAntiSlopCommitCount stays 0 forever and antiSlopDue always returns
        // due:false, so onAntiSlopDue never fires (dead code).
        this.lastAntiSlopCommitCount = count;
      }
    } catch { /* git may be unavailable */ }
  }

  /** Send a fresh bv-guided marching-orders message to an idle named agent. */
  private async _sendIdleInstruct(agentName: string, readyBead: string): Promise<void> {
    if (!this.orchestratorAgentName || !agentName) return;
    const exec = this.pi.exec as unknown as ExecFn;
    try {
      await sendMessage(exec, this.cwd, this.orchestratorAgentName, [agentName],
        "[SwarmTender] Idle — next bead",
        `You have been idle. Pick up a fresh ready bead and start: ${readyBead}\n\n` +
          `- Claim it with \`br update <id> --status in_progress\` and read \`br show <id>\`.\n` +
          `- Keep edits within its ### Files: scope, follow AGENTS.md, register with Agent Mail if needed, and coordinate on the bead thread.`, 
        { threadId: "general", importance: "normal" }
      );
    } catch { /* agent may not be an agent-mail agent */ }
  }

  /** Remove an agent from monitoring (e.g., step completed). */
  removeAgent(stepIndex: number): void {
    this.agents.delete(stepIndex);
    if (this.agents.size === 0) {
      this.stop();
    }
  }

  /**
   * Force-release stale file reservations from a stuck agent.
   * Uses Agent Mail's force_release_file_reservation to clear locks
   * so other agents can proceed.
   */
  async releaseStaleReservations(
    stuckAgentName: string,
    reservationIds: number[],
    note?: string
  ): Promise<void> {
    const exec = this.pi.exec as unknown as ExecFn;
    for (const id of reservationIds) {
      await forceReleaseFileReservation(
        exec, this.cwd, stuckAgentName, id,
        note ?? `SwarmTender: agent ${stuckAgentName} stuck for >${this.config.stuckThreshold / 1000}s`,
        true
      );
    }
  }

  /**
   * Send a nudge message to a stuck agent via Agent Mail.
   * Prompts the agent to check in or report blockers.
   */
  async nudgeStuckAgent(
    stuckAgentName: string,
    threadId: string
  ): Promise<void> {
    if (!this.orchestratorAgentName) return;
    const exec = this.pi.exec as unknown as ExecFn;
    await sendMessage(exec, this.cwd, this.orchestratorAgentName, [stuckAgentName],
      `[SwarmTender] Are you stuck?`,
      `You haven't made changes in >${this.config.stuckThreshold / 1000}s. ` +
      `Please report your status:\n` +
      `- If blocked, describe the blocker so we can re-route work.\n` +
      `- If still working, send a progress update.\n` +
      `- If done, release your file reservations with \`am_release\`.`,
      { threadId, importance: "high", ackRequired: true }
    );
  }

  /**
   * Get whois profile for an agent via Agent Mail.
   * Useful for diagnosing which agent is stuck and what it was doing.
   */
  async inspectAgent(agentName: string): Promise<any> {
    const exec = this.pi.exec as unknown as ExecFn;
    return whoisAgent(exec, this.cwd, agentName);
  }
}
