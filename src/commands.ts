import type { CoordinationMode, OrchestratorContext, Bead } from './types.js';
import { createInitialState } from './types.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { brExec, resilientExec } from './cli-exec.js';
import { prepareComplianceAuditPlan, type ComplianceAuditMode, type ComplianceRemediationPolicy } from './compliance-audit.js';
import { buildWorkflowStatus, type WorkflowStatusOutput } from './workflow-status.js';

/**
 * Format staleness info for open beads, showing when they were created.
 * Groups beads by age: fresh (< 1 day), recent (< 7 days), stale (>= 7 days).
 */
function formatBeadStaleness(beads: Bead[]): string {
  if (beads.length === 0) return "";

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const fresh: Bead[] = [];
  const recent: Bead[] = [];
  const stale: Bead[] = [];

  for (const bead of beads) {
    if (!bead.created_at) {
      stale.push(bead); // No created_at = assume stale
      continue;
    }
    const createdMs = new Date(bead.created_at).getTime();
    if (!Number.isFinite(createdMs)) {
      stale.push(bead);
      continue;
    }
    const ageDays = (now - createdMs) / DAY_MS;

    if (ageDays < 1) {
      fresh.push(bead);
    } else if (ageDays < 7) {
      recent.push(bead);
    } else {
      stale.push(bead);
    }
  }

  const lines: string[] = [];

  if (fresh.length > 0) {
    lines.push(`  🟢 Fresh (< 1 day): ${fresh.map(b => b.id).join(", ")}`);
  }
  if (recent.length > 0) {
    lines.push(`  🟡 Recent (1-7 days): ${recent.map(b => `${b.id} (${formatAge(b.created_at)})`).join(", ")}`);
  }
  if (stale.length > 0) {
    lines.push(`  🔴 Stale (>= 7 days): ${stale.map(b => `${b.id} (${formatAge(b.created_at)})`).join(", ")}`);
  }

  return lines.join("\n");
}

/** Format a timestamp as relative age (e.g., "2d", "3w"). */
function formatAge(timestamp?: string): string {
  if (!timestamp) return "unknown";

  const now = Date.now();
  const createdMs = new Date(timestamp).getTime();
  if (!Number.isFinite(createdMs)) return "unknown";
  const ageDays = Math.floor((now - createdMs) / (24 * 60 * 60 * 1000));

  if (ageDays < 1) return "< 1d";
  if (ageDays < 7) return `${ageDays}d`;
  if (ageDays < 30) return `${Math.floor(ageDays / 7)}w`;
  if (ageDays < 365) return `${Math.floor(ageDays / 30)}mo`;
  return `${Math.floor(ageDays / 365)}y`;
}

function statusCommandWantsJson(args: string | undefined): boolean {
  return (args ?? "").split(/\s+/).some((part) => part === "--json");
}

function formatWorkflowStatusForSlash(status: WorkflowStatusOutput, warnings: string[] = []): string {
  const currentBeads = formatStatusBeadSummary(status.beads.current);
  const pendingBeads = status.beads.pending.length === 0
    ? "None"
    : `${status.beads.pending.length} pending: ${formatStatusBeadSummary(status.beads.pending)}`;
  const goalLine = status.selected_goal ? [`- Goal: ${status.selected_goal}`] : [];
  const compactionLines = formatStatusCompactionSummary(status);
  const warningLines = warnings.length > 0
    ? ["", "### Warnings", ...warnings.map((warning) => `- ${warning}`)]
    : [];

  return [
    "## Flywheel Status",
    `- Phase: ${status.phase}`,
    ...goalLine,
    `- Current beads: ${currentBeads}`,
    `- Pending beads: ${pendingBeads}`,
    `- Bead totals: ${status.beads.total} total, ${status.beads.open} open, ${status.beads.in_progress} in progress, ${status.beads.closed} closed, ${status.beads.deferred} deferred`,
    `- Confidence: ${status.confidence}`,
    `- Next action: ${status.next_action}`,
    `- Resume prompt: ${status.resume_prompt}`,
    ...compactionLines,
    ...warningLines,
  ].join("\n");
}

function formatStatusCompactionSummary(status: WorkflowStatusOutput): string[] {
  const latest = status.compaction?.latest;
  if (!latest) return [];

  const rawReasonLine = latest.raw_reason ? [`- Raw reason: ${latest.raw_reason}`] : [];
  const observedLine = latest.observed_at ? [`- Observed at: ${latest.observed_at}`] : [];
  const willRetry = latest.will_retry === undefined ? "unreported" : String(latest.will_retry);
  const duplicateRisk = latest.guidance.duplicate_side_effect_risk ? "yes" : "no";
  const retryWarning = latest.will_retry === true
    ? ["- Retry warning: Pi may retry the interrupted request; inspect workflow, bead, and file state before repeating side-effecting work."]
    : [];
  const warningLines = latest.guidance.warnings.length > 0
    ? ["- Warnings:", ...latest.guidance.warnings.map((warning) => `  - ${warning}`)]
    : [];
  const safeRecoverySteps = latest.guidance.next_steps.map((step, index) => `  ${index + 1}. ${step}`);

  return [
    "",
    "### Compaction",
    `- Last compaction: ${latest.guidance.title} (reason: ${latest.reason})`,
    `- Event: ${latest.event_name}`,
    ...rawReasonLine,
    `- willRetry: ${willRetry}`,
    ...observedLine,
    `- Guidance: ${latest.guidance.summary}`,
    `- Duplicate side-effect risk: ${duplicateRisk}`,
    ...retryWarning,
    "- Safe recovery sequence:",
    ...safeRecoverySteps,
    ...warningLines,
  ];
}

function formatStatusBeadSummary(beads: WorkflowStatusOutput["beads"]["current"]): string {
  if (beads.length === 0) return "None";
  const shown = beads.slice(0, 5).map((bead) => {
    const title = bead.title ? ` — ${bead.title}` : "";
    return `${bead.id}${title} (${bead.status})`;
  });
  const remaining = beads.length - shown.length;
  return remaining > 0 ? `${shown.join(", ")} (+${remaining} more)` : shown.join(", ");
}

function formatStatusError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Saved plan discovery ──────────────────────────────────────────────────

/**
 * A saved plan artifact found on disk.
 */
interface SavedPlan {
  /** Display label for the UI selection list */
  label: string;
  /** Absolute path to the markdown file */
  path: string;
  /** Artifact name relative to its session artifact root (e.g. "plans/foo.md") */
  artifactName: string;
  /** ISO timestamp of last modification */
  mtime: Date;
}

/** Sub-plan stems that are intermediate outputs, not final plans. */
const SUB_PLAN_STEMS = new Set(['correctness', 'robustness', 'ergonomics']);
const SUB_PLAN_SUFFIXES = ['-original'];

/** Push a plan entry if the file looks like a final plan document. */
function pushPlanEntry(plans: SavedPlan[], fullPath: string, file: string, artifactName: string, source: string): void {
  const stem = file.replace(/\.md$/, '');
  if (SUB_PLAN_STEMS.has(stem)) return;
  if (SUB_PLAN_SUFFIXES.some(s => stem.endsWith(s))) return;
  let mtime = new Date(0);
  try { mtime = statSync(fullPath).mtime; } catch { /* ignore */ }
  const ageDays = Math.floor((Date.now() - mtime.getTime()) / (24 * 60 * 60 * 1000));
  const ageStr = ageDays < 1 ? 'today' : ageDays < 7 ? `${ageDays}d ago` : ageDays < 30 ? `${Math.floor(ageDays / 7)}w ago` : `${Math.floor(ageDays / 30)}mo ago`;
  plans.push({ label: `${stem} [${source}] (${ageStr})`, path: fullPath, artifactName, mtime });
}

/**
 * Scan for saved plan documents from two sources:
 *  1. Session artifact directories under sessionDir (artifacts written by flywheel_plan)
 *  2. The project’s own docs/ directory (any .md file in docs/ or docs/plans/)
 *
 * Sub-plan files (correctness / robustness / ergonomics) are excluded.
 * Results are sorted most-recent first.
 */
function findSavedPlans(sessionDir: string, projectCwd?: string): SavedPlan[] {
  const plans: SavedPlan[] = [];
  const seen = new Set<string>();

  // ── 1. Session artifact directories ────────────────────────────────────
  if (existsSync(sessionDir)) {
    let sessionEntries: string[] = [];
    try { sessionEntries = readdirSync(sessionDir); } catch { /* ignore */ }

    for (const sessionId of sessionEntries) {
      const artifactsDir = join(sessionDir, sessionId, 'artifacts');
      if (!existsSync(artifactsDir)) continue;
      let artifactSessions: string[] = [];
      try { artifactSessions = readdirSync(artifactsDir); } catch { continue; }
      for (const artifactSessionId of artifactSessions) {
        const plansDir = join(artifactsDir, artifactSessionId, 'plans');
        if (!existsSync(plansDir)) continue;
        let planFiles: string[] = [];
        try { planFiles = readdirSync(plansDir); } catch { continue; }
        for (const file of planFiles) {
          if (!file.endsWith('.md')) continue;
          const fullPath = join(plansDir, file);
          if (seen.has(fullPath)) continue;
          seen.add(fullPath);
          pushPlanEntry(plans, fullPath, file, `plans/${file}`, 'session');
        }
      }
    }
  }

  // ── 2. Project docs/ directory ────────────────────────────────────────
  if (projectCwd) {
    const docsDirs = [
      join(projectCwd, 'docs'),
      join(projectCwd, 'docs', 'plans'),
      join(projectCwd, 'plans'),
    ];
    for (const dir of docsDirs) {
      if (!existsSync(dir)) continue;
      let files: string[] = [];
      try { files = readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const fullPath = join(dir, file);
        // Only scan top-level files in each dir (no recursion)
        try { if (!statSync(fullPath).isFile()) continue; } catch { continue; }
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);
        // Relative path from cwd for the artifactName
        const rel = fullPath.replace(projectCwd + '/', '');
        pushPlanEntry(plans, fullPath, file, rel, 'docs');
      }
    }
  }

  // Most-recent first
  return plans.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function parseOrchestrateArgs(rawArgs?: string): { goalArg?: string; coordinationMode?: CoordinationMode } {
  const input = rawArgs?.trim();
  if (!input) return {};

  const modeMatch = input.match(/(?:^|\s)--mode(?:=(worktree|single-branch)|\s+(worktree|single-branch))(?:\s|$)/);
  if (!modeMatch) {
    return { goalArg: input };
  }

  const coordinationMode = (modeMatch[1] ?? modeMatch[2]) as CoordinationMode;
  const goalArg = input.replace(modeMatch[0], " ").trim() || undefined;

  return { goalArg, coordinationMode };
}

const COMPLIANCE_AUDIT_MODES = new Set<ComplianceAuditMode>([
  "triage",
  "standard",
  "comprehensive",
  "tripwire",
  "single-bead",
  "re-verification",
  "onboarding",
  "sample",
]);

function parseComplianceAuditArgs(rawArgs?: string): {
  mode?: ComplianceAuditMode;
  threshold?: number;
  remediationPolicy?: ComplianceRemediationPolicy;
  parallelism?: number;
  beadId?: string;
  sampleSize?: number;
  testExecutionOk?: boolean;
} {
  const args = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
  const out: {
    mode?: ComplianceAuditMode;
    threshold?: number;
    remediationPolicy?: ComplianceRemediationPolicy;
    parallelism?: number;
    beadId?: string;
    sampleSize?: number;
    testExecutionOk?: boolean;
  } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (COMPLIANCE_AUDIT_MODES.has(arg as ComplianceAuditMode)) {
      out.mode = arg as ComplianceAuditMode;
    } else if (arg === "--yes-run-tests" || arg === "--test-execution-ok") {
      out.testExecutionOk = true;
    } else if (arg.startsWith("--threshold=")) {
      out.threshold = Number(arg.slice("--threshold=".length));
    } else if (arg === "--threshold" && next) {
      out.threshold = Number(next);
      i++;
    } else if (arg.startsWith("--policy=")) {
      out.remediationPolicy = arg.slice("--policy=".length) as ComplianceRemediationPolicy;
    } else if (arg === "--policy" && next) {
      out.remediationPolicy = next as ComplianceRemediationPolicy;
      i++;
    } else if (arg.startsWith("--parallelism=")) {
      out.parallelism = Number(arg.slice("--parallelism=".length));
    } else if (arg === "--parallelism" && next) {
      out.parallelism = Number(next);
      i++;
    } else if (arg.startsWith("--sample-size=")) {
      out.sampleSize = Number(arg.slice("--sample-size=".length));
    } else if (arg === "--sample-size" && next) {
      out.sampleSize = Number(next);
      i++;
    } else if (!arg.startsWith("--") && !out.beadId) {
      out.beadId = arg;
      if (!out.mode) out.mode = "single-bead";
    }
  }

  return out;
}

/**
 * Register all slash-commands (/agent-flywheel, /flywheel-status, /memory) on the pi extension API.
 */
export function registerCommands(oc: OrchestratorContext) {

  const { pi } = oc;

  const workflowStatusHandler = async (args: string, ctx: any) => {
    const warnings: string[] = [];
    let beads: Bead[] = [];
    try {
      const { readBeads } = await import("./beads.js");
      beads = await readBeads(pi, ctx.cwd);
    } catch (error) {
      warnings.push(`Could not read beads: ${formatStatusError(error)}`);
    }

    const status = buildWorkflowStatus(oc.state, beads);
    const message = statusCommandWantsJson(args)
      ? JSON.stringify(status, null, 2)
      : formatWorkflowStatusForSlash(status, warnings);
    ctx.ui.notify(message, warnings.length > 0 ? "warning" : "info");
  };

  const startHandler = async (args: string, ctx: any) => {

      const { runOpeningCeremony } = await import("./opening-ceremony.js");
      const runOrchestrateStartupFlow = async () => {
        const { readBeads } = await import("./beads.js");
        const { detectSessionStage, formatSessionContext, buildResumeLabel } = await import("./session-state.js");
        const { readCheckpoint: readCp, clearCheckpoint: clearCp } = await import("./checkpoint.js");
        
        // Check for existing state that can be resumed
        let hasExistingState = oc.state.phase !== "idle" && oc.state.phase !== "complete";
        let existingBeads: import("./types.js").Bead[] = [];
        try {
          existingBeads = await readBeads(pi, ctx.cwd);
        } catch { /* no beads dir */ }
        const hasActiveBeads = existingBeads.some(b => b.status === "open" || b.status === "in_progress");

      // Checkpoint recovery: if state is idle and no active beads, check disk checkpoint
      let checkpointWarnings: string[] = [];
      if (!hasExistingState && !hasActiveBeads) {
        const checkpoint = readCp(ctx.cwd);
        if (checkpoint && checkpoint.envelope.state.phase !== "idle" && checkpoint.envelope.state.phase !== "complete") {
          // Restore state from checkpoint
          oc.state = checkpoint.envelope.state;
          hasExistingState = true;
          checkpointWarnings = checkpoint.warnings;
          // Check for git HEAD mismatch
          try {
            const { execSync } = await import("child_process");
            const currentHead = execSync("git rev-parse HEAD", { cwd: ctx.cwd, stdio: "pipe" }).toString().trim();
            if (checkpoint.envelope.gitHead && checkpoint.envelope.gitHead !== currentHead) {
              checkpointWarnings.push("checkpoint is from a different git commit");
            }
          } catch { /* git not available or not a repo */ }
          console.log(`[pi-agent-flywheel] /agent-flywheel: recovered from checkpoint — phase=${oc.state.phase}`);
        }
      }
      
      // Resume vs Fresh fork
      if (hasExistingState || hasActiveBeads) {
        const openBeads = existingBeads.filter(b => b.status === "open" || b.status === "in_progress");
        const openCount = openBeads.length;
        const inProgressBeads = existingBeads.filter(b => b.status === "in_progress");
        const staleBeads = openBeads.filter(b => {
          if (!b.created_at) return true;
          const ageDays = (Date.now() - new Date(b.created_at).getTime()) / (24 * 60 * 60 * 1000);
          return ageDays >= 7;
        });

        // Detect/infer exactly which stage the user is in
        const stage = detectSessionStage(oc.state, existingBeads);
        const currentBeadTitle = stage.currentBeadId
          ? existingBeads.find(b => b.id === stage.currentBeadId)?.title
          : undefined;

        // Build a rich context block for the prompt header
        const stageContext = formatSessionContext(stage, currentBeadTitle);
        const stalenessInfo = formatBeadStaleness(openBeads);
        
        // Build context-aware option list
        const choices: string[] = [];

        // Discover saved plans for this project
        const sessionDir = ctx.sessionManager.getSessionDir();
        const savedPlans = findSavedPlans(sessionDir, ctx.cwd);

        // ── Continue working ──
        choices.push(buildResumeLabel(stage));
        choices.push(`🎯 Pick a bead — choose a specific bead to work on`);
        if (inProgressBeads.length > 0) {
          choices.push(`🔁 Reset stuck — unblock ${inProgressBeads.length} in-progress bead(s) back to open`);
        }

        // ── Adjust the plan ──
        choices.push(`➕ Extend — keep existing beads, add new ones via planning`);
        if (savedPlans.length > 0) {
          choices.push(`📄 Load saved plan — pick from ${savedPlans.length} previously generated plan(s)`);
        }
        if (staleBeads.length > 0) {
          choices.push(`🧹 Prune stale — archive ${staleBeads.length} stale bead(s) ≥7d, keep the rest`);
        }
        choices.push(`🔧 Sync beads — pull latest from JSONL (br sync --import-only)`);

        // ── Start over ──
        choices.push(`🔄 Fresh — archive all open beads as deferred, start new planning`);
        choices.push(`🗑️ Clear — permanently delete all ${existingBeads.length} bead(s), start from scratch`);

        choices.push(`❌ Cancel`);

        // Show rich context: stage summary + bead staleness + checkpoint warnings
        const separator = stalenessInfo ? `\n${stalenessInfo}` : "";
        const cpWarningStr = checkpointWarnings.length > 0
          ? `\n⚠️ Checkpoint: ${checkpointWarnings.join("; ")}`
          : "";
        const choice = await ctx.ui.select(
          `Existing orchestration detected\n\n${stageContext}${separator}${cpWarningStr}`,
          choices
        );

        // ── Handle: Resume ────────────────────────────────────────
        if (choice?.startsWith("📂")) {
          oc.orchestratorActive = true;
          // Sync the persisted phase to the detected stage if it was idle/complete
          if (oc.state.phase === "idle" || oc.state.phase === "complete") {
            oc.setPhase(stage.phase !== "idle" && stage.phase !== "complete" ? stage.phase : (hasActiveBeads ? "implementing" : "profiling"), ctx);
          }
          oc.persistState();
          pi.sendUserMessage(stage.resumePrompt, { deliverAs: "followUp" });
          return;

        // ── Handle: Pick a bead ───────────────────────────────────
        } else if (choice?.startsWith("🎯")) {
          if (openBeads.length === 0) {
            ctx.ui.notify("No open beads to pick from.", "info");
            return;
          }
          const beadChoices = openBeads.map(b => {
            const status = b.status === "in_progress" ? " 🔄" : "";
            const age = b.created_at ? ` (${formatAge(b.created_at)})` : "";
            const title = b.title.length > 60 ? b.title.slice(0, 57) + "..." : b.title;
            return `${b.id}${status}${age} — ${title}`;
          });
          const beadChoice = await ctx.ui.select("Select a bead to work on:", beadChoices);
          if (!beadChoice) {
            ctx.ui.notify("Orchestration cancelled.", "info");
            return;
          }
          const beadId = beadChoice.split(/\s+/)[0];
          // Mark it in-progress
          await brExec(pi, ["update", beadId, "--status", "in_progress"], { cwd: ctx.cwd, timeout: 5000 });
          oc.orchestratorActive = true;
          oc.setPhase("implementing", ctx);
          oc.persistState();
          const { formatNtmLaunchInstructions, implementationSwarmPrompt } = await import("./swarm.js");
          const ntmInstructions = formatNtmLaunchInstructions({
            cwd: ctx.cwd,
            label: `implementation-${beadId}`,
            agentCount: 1,
            openBeadCount: 1,
            title: "🐝 NTM implementation pane",
            prompt: implementationSwarmPrompt({
              cwd: ctx.cwd,
              readyBeadIds: [beadId],
              assignedBeadId: beadId,
              executionModeLabel: "Manual status-menu launch — shared checkout; coordinate with reservations when available.",
              completedBeadIds: Object.entries(oc.state.beadResults ?? {}).filter(([, result]) => result.status === "success").map(([id]) => id),
            }),
          });
          pi.sendUserMessage(
            `**NEXT: Launch an NTM pane for bead ${beadId}. Do not implement it inline.**\n\n${ntmInstructions}`,
            { deliverAs: "followUp" }
          );
          return;

        // ── Handle: Reset stuck ───────────────────────────────────
        } else if (choice?.startsWith("🔁")) {
          let resetCount = 0;
          for (const bead of inProgressBeads) {
            const r = await brExec(pi, ["update", bead.id, "--status", "open"], { cwd: ctx.cwd, timeout: 5000 });
            if (r.ok) resetCount++;
          }
          ctx.ui.notify(`🔁 Reset ${resetCount} bead(s) from in-progress → open.`, "info");
          oc.orchestratorActive = true;
          if (oc.state.phase === "idle" || oc.state.phase === "complete") {
            oc.setPhase("implementing", ctx);
          }
          oc.persistState();
          pi.sendUserMessage(
            `Resumed after resetting ${resetCount} stuck bead(s). Call \`agent_flywheel_review\` to pick the next bead and continue inside the AgentFlywheel workflow.`,
            { deliverAs: "followUp" }
          );
          return;

        // ── Handle: Extend ────────────────────────────────────────
        } else if (choice?.startsWith("➕")) {
          // Sub-choice: add new beads or continue with existing ones
          const extendChoice = await ctx.ui.select(
            `Extend plan — ${openCount} open bead(s) active`,
            [
              `💡 New ideas — scan repo and propose new beads to add`,
              `▶️  Continue — keep working on existing beads`,
            ]
          );
          if (!extendChoice) {
            ctx.ui.notify("Orchestration cancelled.", "info");
            return;
          }
          oc.orchestratorActive = true;
          if (extendChoice.startsWith("💡")) {
            // Keep existing beads; go back to discovering/planning to add more
            oc.setPhase("discovering", ctx);
            oc.persistState();
            pi.sendUserMessage(
              `Extending existing plan with ${openCount} open bead(s) still active.\n\n` +
              `Call \`agent_flywheel_discover\` to generate new ideas, then add beads with \`br create\` and return through \`agent_flywheel_approve_beads\`. ` +
              `Existing open beads will not be touched.`,
              { deliverAs: "followUp" }
            );
          } else {
            // Continue implementing the existing open beads
            oc.setPhase("implementing", ctx);
            oc.persistState();
            pi.sendUserMessage(
              `Continuing with ${openCount} open bead(s). Call \`agent_flywheel_review\` to pick the next bead and implement it inside the AgentFlywheel workflow.`,
              { deliverAs: "followUp" }
            );
          }
          return;

        // ── Handle: Prune stale ───────────────────────────────────
        } else if (choice?.startsWith("🧹")) {
          let pruneCount = 0;
          for (const bead of staleBeads) {
            const r = await brExec(pi, ["update", bead.id, "--status", "deferred"], { cwd: ctx.cwd, timeout: 5000 });
            if (r.ok) pruneCount++;
          }
          ctx.ui.notify(`🧹 Archived ${pruneCount} stale bead(s) as deferred.`, "info");
          const remaining = openBeads.filter(b => !staleBeads.find(s => s.id === b.id));
          if (remaining.length === 0) {
            ctx.ui.notify("No active beads remain — starting fresh planning.", "info");
            // Fall through to fresh start below
          } else {
            oc.orchestratorActive = true;
            if (oc.state.phase === "idle" || oc.state.phase === "complete") {
              oc.setPhase("implementing", ctx);
            }
            oc.persistState();
            pi.sendUserMessage(
              `Pruned ${pruneCount} stale bead(s). ${remaining.length} bead(s) remain active.\n\n` +
              `Call \`agent_flywheel_review\` to continue implementing inside the AgentFlywheel workflow: ${remaining.map(b => b.id).join(", ")}.`,
              { deliverAs: "followUp" }
            );
            return;
          }

        // ── Handle: Load saved plan ────────────────────────────────
        } else if (choice?.startsWith("📄 Load saved plan")) {
          const planChoices = savedPlans.map(p => p.label);
          planChoices.push("← Back");
          const planChoice = await ctx.ui.select("Select a saved plan:", planChoices);
          if (!planChoice || planChoice === "← Back") {
            ctx.ui.notify("Plan selection cancelled.", "info");
            return;
          }
          const selectedIdx = planChoices.indexOf(planChoice);
          const selectedPlan = savedPlans[selectedIdx];
          if (!selectedPlan) { ctx.ui.notify("Plan not found.", "warning"); return; }
          let planContent = "";
          try { planContent = readFileSync(selectedPlan.path, "utf8"); } catch {
            ctx.ui.notify(`⚠️ Could not read plan: ${selectedPlan.path}`, "warning");
            return;
          }
          oc.orchestratorActive = true;
          oc.state.planDocument = selectedPlan.artifactName;
          oc.setPhase("awaiting_plan_approval", ctx);
          oc.persistState();
          pi.sendUserMessage(
            `**Loaded saved plan: ${selectedPlan.label}**\n\n` +
            `**NEXT: Call \`agent_flywheel_approve_beads\` NOW to review this plan inside the AgentFlywheel workflow.**\n\n` +
            `Artifact: \`${selectedPlan.artifactName}\`\n\n` +
            `Do not skip directly to bead creation — keep the run inside the plan approval → bead creation → bead approval happy path.`,
            { deliverAs: "followUp" }
          );
          return;

        // ── Handle: Sync beads ────────────────────────────────────
        } else if (choice?.startsWith("🔧 Sync beads")) {
          ctx.ui.notify("🔄 Syncing beads from JSONL…", "info");
          const syncResult = await brExec(pi, ["sync", "--import-only"], { cwd: ctx.cwd, timeout: 15000 });
          if (syncResult.ok) {
            const msg = (syncResult.value.stdout.trim() || syncResult.value.stderr.trim() || "Sync complete.").slice(0, 120);
            ctx.ui.notify(`✅ Bead sync done: ${msg}`, "info");
          } else {
            ctx.ui.notify(`⚠️ Sync failed: ${syncResult.error.stderr || syncResult.error.command}`, "warning");
          }
          // Re-enter the /agent-flywheel menu so user can pick next action
          pi.sendUserMessage("/agent-flywheel", { deliverAs: "followUp" });
          return;

        // ── Handle: Fresh ─────────────────────────────────────────
        } else if (choice?.startsWith("🔄")) {
          for (const bead of existingBeads) {
            if (bead.status === "open" || bead.status === "in_progress") {
              await brExec(pi, ["update", bead.id, "--status", "deferred"], { cwd: ctx.cwd, timeout: 5000 });
            }
          }
          ctx.ui.notify(`📦 Archived ${openCount} open bead(s) as deferred.`, "info");
          clearCp(ctx.cwd); // Clear checkpoint on fresh start
          // Fall through to fresh start

        // ── Handle: Clear ─────────────────────────────────────────
        } else if (choice?.startsWith("🗑️")) {
          const allCount = existingBeads.length;
          const ids = existingBeads.map((b) => b.id);
          const hardDel = await brExec(pi, ["delete", ...ids, "--force", "--hard"], { cwd: ctx.cwd, timeout: 15000, maxRetries: 0 });
          if (hardDel.ok) {
            ctx.ui.notify(`🗑️ Deleted ${allCount} bead(s).`, "info");
          } else {
            // Fallback without --hard
            const softDel = await brExec(pi, ["delete", ...ids, "--force"], { cwd: ctx.cwd, timeout: 15000, maxRetries: 0 });
            if (softDel.ok) {
              ctx.ui.notify(`🗑️ Deleted ${allCount} bead(s).`, "info");
            } else {
              ctx.ui.notify("⚠️ Failed to delete beads.", "warning");
            }
          }
          clearCp(ctx.cwd); // Clear checkpoint on clear
          // Fall through to fresh start

        // ── Handle: Cancel ────────────────────────────────────────
        } else {
          ctx.ui.notify("Orchestration cancelled.", "info");
          return;
        }
      }
      
      // Active orchestration override (only if no beads detected but orchestrator is running)
      if (oc.orchestratorActive && !hasExistingState && !hasActiveBeads) {
        const override = await ctx.ui.confirm(
          "Orchestrator Active",
          "An orchestration is in progress. Reset and start fresh?"
        );
        if (!override) return;
      }

      oc.state = createInitialState();
      const { goalArg, coordinationMode } = parseOrchestrateArgs(args);
      let selectedGoalArg = goalArg;
      if (coordinationMode) {
        oc.state.coordinationMode = coordinationMode;
      }
      oc.orchestratorActive = true;
      oc.persistState();

      // ── Fresh start: choose profile, custom goal, research, or saved plan ──
      if (!selectedGoalArg) {
        const freshSessionDir = ctx.sessionManager.getSessionDir();
        const freshPlans = findSavedPlans(freshSessionDir, ctx.cwd);
        const freshChoices = [
          "🔍 Profile repo — scan, discover ideas, then plan (default)",
          "✏️  Enter your own goal — scan repo, then plan that goal",
          "🔬 Research external repo — study a GitHub project and adapt ideas",
          ...(freshPlans.length > 0 ? [`📄 Load saved plan — pick from ${freshPlans.length} previously generated plan(s)`] : []),
        ];
        const freshChoice = await ctx.ui.select(
          "🌟 Start AgentFlywheel:",
          freshChoices
        );

        if (freshChoice?.startsWith("✏️")) {
          const customGoal = await ctx.ui.input(
            "Enter your goal:",
            "e.g., Add API rate limiting with Redis"
          );
          if (!customGoal?.trim()) {
            ctx.ui.notify("AgentFlywheel cancelled — no goal provided.", "info");
            oc.orchestratorActive = false;
            oc.setPhase("idle", ctx);
            oc.persistState();
            return;
          }
          selectedGoalArg = customGoal.trim();
          oc.state.selectedGoal = selectedGoalArg;
          oc.persistState();
        }

        if (freshChoice?.startsWith("🔬")) {
          const researchUrl = await ctx.ui.input(
            "GitHub repo URL to research:",
            "https://github.com/org/repo"
          );
          const url = researchUrl?.trim();
          if (!url) {
            ctx.ui.notify("Research cancelled — no repo URL provided.", "info");
            oc.orchestratorActive = false;
            oc.setPhase("idle", ctx);
            oc.persistState();
            return;
          }
          const { extractProjectName } = await import("./research-pipeline.js");
          const externalName = extractProjectName(url);
          oc.orchestratorActive = true;
          oc.setPhase("researching", ctx);
          oc.state.researchState = {
            url,
            externalName,
            artifactName: `research/${externalName}-proposal.md`,
            phasesCompleted: [],
          };
          oc.persistState();
          pi.sendUserMessage(
            `Start AgentFlywheel external-repo research for ${url}. Call \`flywheel_research\` with this exact URL now. Do not call \`flywheel_profile\`, standard discovery, or Dueling Idea Wizards for the current checkout; every future gate in this run should stay focused on the external repo until the research proposal is handed off to bead approval.`,
            { deliverAs: "followUp" }
          );
          return;
        }

        if (freshChoice?.startsWith("📄 Load saved plan")) {
          const planChoices = freshPlans.map(p => p.label);
          planChoices.push("← Cancel");
          const planChoice = await ctx.ui.select("Select a saved plan:", planChoices);
          if (planChoice && planChoice !== "← Cancel") {
            const selectedIdx = planChoices.indexOf(planChoice);
            const selectedPlan = freshPlans[selectedIdx];
            if (selectedPlan) {
              let planContent = "";
              try { planContent = readFileSync(selectedPlan.path, "utf8"); } catch {
                ctx.ui.notify(`⚠️ Could not read plan: ${selectedPlan.path}`, "warning");
              }
              if (planContent) {
                oc.state.planDocument = selectedPlan.artifactName;
                oc.setPhase("awaiting_plan_approval", ctx);
                oc.persistState();
                pi.sendUserMessage(
                  `**Loaded saved plan: ${selectedPlan.label}**\n\n` +
                  `**NEXT: Call \`agent_flywheel_approve_beads\` NOW to review this plan inside the AgentFlywheel workflow.**\n\n` +
                  `Artifact: \`${selectedPlan.artifactName}\`\n\n` +
                  `Do not skip directly to bead creation — keep the run inside the plan approval → bead creation → bead approval happy path.`,
                  { deliverAs: "followUp" }
                );
                return;
              }
            }
          }
          // Cancelled or failed — fall through to normal profile path
        } else if (freshChoice === undefined) {
          ctx.ui.notify("AgentFlywheel cancelled.", "info");
          oc.orchestratorActive = false;
          oc.setPhase("idle", ctx);
          oc.persistState();
          return;
        }
        // freshChoice === profile or cancelled saved-plan load — fall through
      }

        if (selectedGoalArg) {
          oc.state.selectedGoal = selectedGoalArg;
          oc.persistState();
          pi.sendUserMessage(
            `Start the AgentFlywheel workflow for this repo. I want to: ${selectedGoalArg}\n\nBegin by calling \`agent_flywheel_profile\` to scan the repo, then stay inside the AgentFlywheel workflow/menus while routing my stated goal through the normal planning or bead-creation path.`,
            { deliverAs: "followUp" }
          );
        } else {
          pi.sendUserMessage(
            "Start the AgentFlywheel workflow for this repo. Begin by calling `agent_flywheel_profile` to scan the repository.",
            { deliverAs: "followUp" }
          );
        }
      };

      // Opening ceremony hook:
      // Insert any startup-only presentation immediately before running the
      // command startup flow below so it fires once per /agent-flywheel invocation
      // before any resume menu, saved-plan selector, notify(), or agent_flywheel_profile
      // follow-up message is shown.
      // Animate only in raw TTY (no TUI) — in pi's TUI, console.log
      // output cannot use ANSI cursor movement to overwrite previous frames,
      // so animated mode would stack all frames on top of each other.
      const canAnimateCeremony = Boolean(process.stdout.isTTY && !ctx.hasUI);
      let ceremonyPrevLines = 0;
      await runOpeningCeremony(
        {
          write: (text) => {
            const trimmed = text.trimEnd();
            // In animated mode, clear the previous frame before writing the next
            if (ceremonyPrevLines > 0 && canAnimateCeremony) {
              process.stdout.write(`\x1b[${ceremonyPrevLines}A\x1b[J`);
            }
            console.log(trimmed);
            ceremonyPrevLines = trimmed.split('\n').length;
          },
        },
        {
          interactive: canAnimateCeremony,
          terminalWidth: process.stdout.columns,
        }
      );
      await runOrchestrateStartupFlow();
  };

  // ─── Command: /agent-flywheel ───────────────────────────────────
  pi.registerCommand("agent-flywheel", {
    description:
      "Start AgentFlywheel for this repo",
    handler: startHandler,
  });

  pi.registerCommand("agent-flywheel-start", {
    description: "Start AgentFlywheel for this repo (alias of /agent-flywheel)",
    handler: startHandler,
  });

  pi.registerCommand("flywheel-start", {
    description: "Alias of /agent-flywheel",
    handler: startHandler,
  });

  // ─── Command: /flywheel-release-checklist ───────────────────
  const releaseChecklistHandler = async (_args: string, ctx: any) => {
    const { buildReleaseChecklist, formatReleaseChecklist } = await import("./release-checklist.js");
    const statusResult = await resilientExec(pi, "git", ["status", "--short"], {
      cwd: ctx.cwd,
      timeout: 5000,
      maxRetries: 0,
      logWarnings: false,
    });
    const statusLines = statusResult.ok
      ? statusResult.value.stdout.split("\n").filter((line) => line.trim().length > 0)
      : [];
    const checklist = buildReleaseChecklist({ cwd: ctx.cwd, statusLines, dirtyScopeKnown: statusResult.ok });
    const warning = statusResult.ok
      ? ""
      : `\n\n⚠️ Could not inspect git status: ${statusResult.error.stderr || statusResult.error.command}. The checklist did not assume the checkout is clean.`;
    const hasWarnings = !statusResult.ok || !checklist.version.versionsMatch || checklist.dirtyFiles.some((group) => group.severity === "warning");
    ctx.ui.notify(`${formatReleaseChecklist(checklist)}${warning}`, hasWarnings ? "warning" : "info");
  };

  pi.registerCommand("flywheel-release-checklist", {
    description: "Read-only release/version checklist: package versions, dirty scope, and verification commands",
    handler: releaseChecklistHandler,
  });

  pi.registerCommand("agent-flywheel-release-checklist", {
    description: "Legacy alias of /flywheel-release-checklist",
    handler: releaseChecklistHandler,
  });


  // ─── Command: /memory ──────────────────────────────────────────
  pi.registerCommand("memory", {
    description: "Manage CASS memory: stats, view, search, add, mark harmful",
    handler: async (args, ctx) => {
      const { listMemoryEntries, searchMemory, getMemoryStats, appendMemory, markRule } = await import("./memory.js");
      const parts = (args ?? "").trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "stats";

      // ── /memory stats (default) ──
      if (subcommand === "stats" || subcommand === "") {
        const stats = getMemoryStats(ctx.cwd);
        if (stats.entryCount === 0) {
          ctx.ui.notify("📭 No memory entries yet. Use `/memory add <text>` to create one.", "info");
          return;
        }
        const statusLine = stats.overallStatus ? ` (${stats.overallStatus})` : "";
        const versionLine = stats.version ? ` · cm v${stats.version}` : "";
        ctx.ui.notify(
          `🧠 CASS Memory: ${stats.entryCount} rules${statusLine}${versionLine}`,
          "info"
        );
        return;
      }

      // ── /memory view ──
      if (subcommand === "view") {
        const entries = listMemoryEntries(ctx.cwd);
        if (entries.length === 0) {
          ctx.ui.notify("📭 No memory entries to view.", "info");
          return;
        }
        const choices = entries.map((e) =>
          `${e.index}: [${e.id}] (${e.category}) ${e.content.slice(0, 60).replace(/\n/g, " ")}${e.content.length > 60 ? "…" : ""}`
        );
        const selected = await ctx.ui.select("Select a memory entry to view:", choices);
        if (selected === undefined) return;
        const idx = parseInt(selected, 10);
        const entry = entries.find((e) => e.index === idx);
        if (entry) {
          ctx.ui.notify(`## ${entry.id} (${entry.category})\n\n${entry.content}`, "info");
        }
        return;
      }

      // ── /memory search <query> ──
      if (subcommand === "search") {
        const query = parts.slice(1).join(" ").trim();
        if (!query) {
          ctx.ui.notify("Usage: `/memory search <query>`", "warning");
          return;
        }
        const results = searchMemory(ctx.cwd, query);
        if (results.length === 0) {
          ctx.ui.notify(`No memory entries matching "${query}".`, "info");
          return;
        }
        const summary = results
          .map((e) => `**[${e.id}]** (${e.category}) ${e.content.slice(0, 80).replace(/\n/g, " ")}${e.content.length > 80 ? "…" : ""}`)
          .join("\n");
        ctx.ui.notify(`🔍 ${results.length} match(es) for "${query}":\n\n${summary}`, "info");
        return;
      }

      // ── /memory add <text> ──
      if (subcommand === "add") {
        const text = parts.slice(1).join(" ").trim();
        if (!text) {
          ctx.ui.notify("Usage: `/memory add <text>`", "warning");
          return;
        }
        const ok = appendMemory(ctx.cwd, text);
        if (ok) {
          ctx.ui.notify("✅ Memory entry added.", "info");
        } else {
          ctx.ui.notify("❌ Failed to write memory entry.", "error");
        }
        return;
      }

      // ── /memory prune ──
      if (subcommand === "prune") {
        const entries = listMemoryEntries(ctx.cwd);
        if (entries.length === 0) {
          ctx.ui.notify("📭 No memory entries to prune.", "info");
          return;
        }
        const choices = entries.map((e) =>
          `${e.index}: [${e.id}] (${e.category}) ${e.content.slice(0, 60).replace(/\n/g, " ")}${e.content.length > 60 ? "…" : ""}`
        );
        const selected = await ctx.ui.select("Select entry to mark as harmful:", choices);
        if (selected === undefined) {
          ctx.ui.notify("Prune cancelled.", "info");
          return;
        }
        const idx = parseInt(selected, 10);
        const entry = entries.find((e) => e.index === idx);
        if (!entry) { ctx.ui.notify("Entry not found.", "warning"); return; }
        const confirmed = await ctx.ui.confirm(
          "Confirm Mark Harmful",
          `Mark rule ${entry.id} as harmful? This downgrades the rule.`
        );
        if (!confirmed) {
          ctx.ui.notify("Prune cancelled.", "info");
          return;
        }
        const ok = markRule(entry.id, false, "pruned via /memory command", ctx.cwd);
        ctx.ui.notify(ok ? `🗑️ Marked ${entry.id} as harmful.` : "❌ Failed to mark rule.", ok ? "info" : "error");
        return;
      }

      // ── Unknown subcommand → help ──
      ctx.ui.notify(
        "**Memory commands:**\n" +
        "• `/memory` or `/memory stats` — show stats\n" +
        "• `/memory view` — browse entries\n" +
        "• `/memory search <query>` — search entries\n" +
        "• `/memory add <text>` — add an entry\n" +
        "• `/memory prune` — delete entries",
        "info"
      );
    },
  });


  // ─── Command: /agent-flywheel-research ──────────────────────
  const researchHandler = async (args: string, ctx: any) => {
      const url = (args ?? "").trim();
      if (!url) {
        ctx.ui.notify(
          "Usage: /agent-flywheel-research <github-url>\n\n" +
          "Runs the Research & Reimagine pipeline:\n" +
          "1. Investigate external project\n" +
          "2. Deepen (push past conservative suggestions)\n" +
          "3. Inversion analysis (what can WE do that THEY can't?)\n" +
          "4. 5x blunder hunt\n" +
          "5. User review (accept / edit / pause)\n" +
          "6. Multi-model competing feedback\n" +
          "7. Synthesize best feedback into final proposal\n" +
          "Then: plan approval → bead creation → implementation loop",
          "info"
        );
        return;
      }

      const researchModule = await import("./research-pipeline.js");
      const { extractProjectName, runResearchPhase } = researchModule;
      const { researchHandoffPrompt } = await import("./prompts.js");
      const { writeFileSync, readFileSync, existsSync, mkdirSync } = await import("fs");
      const { dirname } = await import("path");
      const { sessionArtifactPath } = await import("./session-artifacts.js");

      const externalName = extractProjectName(url);
      const artifactName = `research/${externalName}-proposal.md`;
      const artifactPath = sessionArtifactPath(ctx, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });

      // ── Pre-flight: auto-profile if repo profile is missing ──────────────────
      if (!oc.state.repoProfile) {
        ctx.ui.notify("📊 No repo profile found — running quick profile before research...", "info");
        try {
          const { profileRepo } = await import("./profiler.js");
          oc.state.repoProfile = await profileRepo(pi, ctx.cwd);
          oc.persistState();
          ctx.ui.notify(`✅ Profiled: ${oc.state.repoProfile.name} (${oc.state.repoProfile.languages.join(", ")})`, "info");
        } catch (err: any) {
          ctx.ui.notify(`⚠️ Could not profile repo: ${err.message ?? err}. Continuing without profile.`, "warning");
        }
      }

      const projectName = oc.state.repoProfile?.name ?? "this project";

      // ── Resume detection: skip phases completed in prior sessions ────────────
      const existingResearch = oc.state.researchState;
      const isResumingSameUrl = existingResearch?.url === url;
      const alreadyCompleted = new Set<string>(
        isResumingSameUrl ? (existingResearch?.phasesCompleted ?? []) : []
      );

      // Load saved proposal text from disk when resuming
      let initialProposal = "";
      if (isResumingSameUrl && existsSync(artifactPath)) {
        try { initialProposal = readFileSync(artifactPath, "utf8"); } catch { /* ignore */ }
      }

      if (isResumingSameUrl && alreadyCompleted.size > 0) {
        ctx.ui.notify(
          `🔁 Resuming research for \`${externalName}\` — skipping ${alreadyCompleted.size} completed phase(s): ${[...alreadyCompleted].join(", ")}`,
          "info"
        );
      }

      const pipelineState = {
        externalUrl: url,
        externalName,
        projectName,
        currentPhase: "investigate" as const,
        proposal: initialProposal,
        artifactName,
        phasesCompleted: [...alreadyCompleted] as string[],
      };

      // ── Activate orchestrator + enter researching phase ──────────────────────
      oc.orchestratorActive = true;
      oc.setPhase("researching", ctx);
      oc.state.researchState = { url, externalName, artifactName, phasesCompleted: [...alreadyCompleted] };
      oc.persistState();

      const phases: Array<{ phase: string; label: string; emoji: string }> = [
        { phase: "investigate",  label: "Investigating external project", emoji: "📚" },
        { phase: "deepen",       label: "Deepening analysis",             emoji: "🔍" },
        { phase: "inversion",    label: "Inversion analysis",             emoji: "🔄" },
        { phase: "blunder_hunt", label: "5x blunder hunt",                emoji: "🔨" },
        { phase: "user_review",  label: "User review",                    emoji: "📝" },
        { phase: "multi_model",  label: "Multi-model feedback",           emoji: "🧠" },
        { phase: "synthesis",    label: "Synthesizing feedback",          emoji: "🔗" },
      ];

      // user_review callback shown between blunder_hunt and multi_model.
      const userReviewCallback = async (proposal: string): Promise<{ accepted: boolean; editedProposal?: string }> => {
        const PREVIEW_CHARS = 2000;
        const preview = proposal.length > PREVIEW_CHARS
          ? proposal.slice(0, PREVIEW_CHARS) + `\n...\n*(${proposal.length - PREVIEW_CHARS} more chars — full proposal at ${artifactName})*`
          : proposal;

        const choice = await ctx.ui.select(
          `📝 **User Review — proposal after 5x blunder hunt**\n\n` +
          `Saved to: \`${artifactName}\`\n\n` +
          `**Preview:**\n${preview}\n\n` +
          `Tip: Open the artifact file to read or edit the full proposal before continuing.`,
          [
            "✅ Accept and continue to multi-model feedback",
            "✏️  Pause — I will edit the file manually, then rerun",
            "⏸️  Pause pipeline (resume manually)",
          ]
        );

        if (choice?.startsWith("✏️")) {
          ctx.ui.notify(
            `Pipeline paused for manual editing.\n` +
            `Edit the proposal at:\n  ${artifactPath}\n\n` +
            `When done, rerun \`/agent-flywheel-research ${url}\` to resume from this point.`,
            "info"
          );
          return { accepted: false };
        }

        if (!choice || choice.startsWith("⏸️")) {
          ctx.ui.notify(
            `Research pipeline paused.\nProposal saved to: ${artifactName}\n\n` +
            `Rerun \`/agent-flywheel-research ${url}\` to resume from the user-review phase.`,
            "info"
          );
          return { accepted: false };
        }

        return { accepted: true };
      };

      const phaseLog: string[] = [];

      for (const { phase, label, emoji } of phases) {
        // Skip phases already completed in a prior session
        if (alreadyCompleted.has(phase)) {
          phaseLog.push(`⏭️ ${emoji} **${label}** — skipped (completed in prior session)`);
          continue;
        }

        ctx.ui.notify(`${emoji} Phase ${phases.findIndex(p => p.phase === phase) + 1}/7: ${label}...`, "info");
        (pipelineState as any).currentPhase = phase;

        const reviewCb = phase === "user_review" ? userReviewCallback : undefined;

        try {
          const result = await runResearchPhase(pi, ctx.cwd, phase as any, pipelineState as any, undefined, reviewCb);
          if (result.proposal) {
            pipelineState.proposal = result.proposal;
            writeFileSync(artifactPath, pipelineState.proposal, "utf8");
          }

          if (!result.success) {
            if (phase === "user_review") {
              // User chose to pause — persist progress so resume skips completed phases
              oc.state.researchState = {
                url, externalName, artifactName,
                phasesCompleted: [...pipelineState.phasesCompleted],
              };
              oc.persistState();
              return;
            }
            const warn = `⚠️ ${emoji} **${label}** had issues: ${result.error ?? "partial output"}. Continuing.`;
            ctx.ui.notify(warn, "warning");
            phaseLog.push(warn);
          } else {
            // Mark complete and persist immediately — crash-safe progress tracking
            pipelineState.phasesCompleted.push(phase);
            alreadyCompleted.add(phase);
            oc.state.researchState = {
              url, externalName, artifactName,
              phasesCompleted: [...pipelineState.phasesCompleted],
            };
            oc.persistState();

            if (phase !== "user_review" && phase !== "multi_model") {
              const snippet = pipelineState.proposal.slice(0, 300).replace(/\n+/g, " ");
              const hasProposal = pipelineState.proposal.length > 100;
              const status = hasProposal
                ? `✅ ${emoji} **${label}** complete${result.model ? ` (${result.model})` : ""} — proposal ${pipelineState.proposal.length} chars\n\n> ${snippet}${pipelineState.proposal.length > 300 ? "..." : ""}\n\n_Artifact: ${artifactName}_`
                : `⚠️ ${emoji} **${label}** produced no output — check that the repo URL is accessible.`;
              phaseLog.push(status);
              ctx.ui.notify(status, hasProposal ? "info" : "warning");
            }
          }
        } catch (err: any) {
          const errMsg = `❌ ${emoji} **${label}** failed: ${err.message ?? err}. Continuing with current proposal.`;
          ctx.ui.notify(errMsg, "error");
          phaseLog.push(errMsg);
        }
      }

      // ── All phases done — transition to the full flywheel pipeline ────────────
      const selectedGoal = `Research-reimagine: ${externalName} ideas for ${projectName}`;
      oc.state.selectedGoal = selectedGoal;
      oc.state.planDocument = artifactName;
      oc.state.planRefinementRound = 0;
      // Clear research state — pipeline has advanced to plan approval
      oc.state.researchState = undefined;
      oc.setPhase("awaiting_plan_approval", ctx);
      oc.persistState();

      const completedCount = pipelineState.phasesCompleted.length;
      ctx.ui.notify(
        `✅ Research pipeline complete (${completedCount}/${phases.length} phases).\n` +
        `Proposal saved to: ${artifactName}\n\n` +
        `Transitioning to plan approval → bead creation → implementation.`,
        "info"
      );

      // Directive follow-up using the same "NEXT: ... NOW" pattern as tool results,
      // so the agent immediately drives the full flywheel rather than just acknowledging.
      pi.sendUserMessage(
        researchHandoffPrompt(
          externalName,
          selectedGoal,
          artifactName,
          completedCount,
          phases.length,
          !!oc.state.repoProfile
        ),
        { deliverAs: "followUp" }
      );
    };

  pi.registerCommand("agent-flywheel-research", {
    description: "Study an external project and reimagine its ideas for this project (7-phase pipeline)",
    handler: researchHandler,
  });

  pi.registerCommand("flywheel-research", {
    description: "Alias of /agent-flywheel-research",
    handler: researchHandler,
  });

  // ─── Command: /flywheel-swarm ─────────────────────────
  const launchSwarm = async (_args: string, ctx: any) => {
    if (!oc.state.selectedGoal) {
      ctx.ui.notify("No active orchestration with a goal. Run /flywheel-start first.", "warning");
      return;
    }

    const { readBeads, readyBeads } = await import("./beads.js");
    const beads = await readBeads(pi, ctx.cwd);
    const ready = await readyBeads(pi, ctx.cwd);
    const openBeads = beads.filter((b) => b.status === "open" || b.status === "in_progress");

    if (ready.length === 0 && openBeads.length === 0) {
      ctx.ui.notify("No open or ready beads. All beads are either blocked or completed.", "info");
      return;
    }

    const { recommendComposition, generateAgentConfigs, formatLaunchInstructions } = await import("./swarm.js");
    const { SWARM_MODELS } = await import("./prompts.js");
    const { ensureCoreRules } = await import("./agents-md.js");

    // Ensure AGENTS.md has core rules before launching agents
    await ensureCoreRules(ctx.cwd);

    const composition = recommendComposition(openBeads.length);

    // Let user adjust count
    const countInput = await ctx.ui.input(
      `How many agents? (suggested: ${composition.total} — ${composition.rationale})`,
      `${composition.total}`
    );
    const count = Math.max(1, Math.min(20, parseInt(countInput || `${composition.total}`, 10)));

    // Let the user pick the worker model, defaulting to the swarm's open-weight default.
    const defaultModel = SWARM_MODELS.deepseek;
    const modelInput = await ctx.ui.input(
      `Swarm agent model? (default: ${defaultModel}; type "auto" to use per-pane-kind defaults)`,
      defaultModel
    );
    const modelOverride = modelInput.trim() === "auto" || modelInput.trim() === ""
      ? undefined
      : modelInput.trim();
    composition.modelOverride = modelOverride;

    const configs = generateAgentConfigs(count, ctx.cwd, composition);
    const workerNameByIndex = new Map(configs.map((c, i) => [i, c.name]));

    // Launch mode: default NTM panes, but offer Herdr pi agents when inside Herdr.
    let launchMode: "ntm" | "pi" = "ntm";
    const { isInsideHerdr, formatPiSwarmLaunchInstructions } = await import("./pi-swarm.js");
    if (isInsideHerdr()) {
      const modeInput = await ctx.ui.input(
        `Swarm launch mode? (ntm = NTM panes [default], pi = Herdr pi agents)`,
        "ntm"
      );
      launchMode = modeInput.trim().toLowerCase() === "pi" ? "pi" : "ntm";
    }

    let instructions: string;
    if (launchMode === "pi") {
      const { swarmMarchingOrders } = await import("./prompts.js");
      const prompt = configs[0]?.task ?? swarmMarchingOrders(ctx.cwd);
      instructions = formatPiSwarmLaunchInstructions({
        cwd: ctx.cwd,
        agentCount: count,
        prompt,
        label: "swarm",
        model: modelOverride,
        workerNames: configs.map((c) => c.name),
      });
    } else {
      instructions = formatLaunchInstructions(configs, composition);
    }

    // Start SwarmTender for monitoring
    const { SwarmTender } = await import("./tender.js");
    const worktrees = configs.map((c, i) => ({ path: ctx.cwd, stepIndex: i, agentName: c.name }));
    const ntmSession = `${basename(ctx.cwd)}--swarm`;
    oc.swarmTender = new SwarmTender(pi, ctx.cwd, worktrees, {
      config: {
        pollInterval: 60_000,
        stuckThreshold: 300_000,
        idleThreshold: 120_000,
      },
      onStuck: (agent) => {
        ctx.ui.notify(
          `⚠️ Agent #${agent.stepIndex} appears stuck (no changes for 5 min). ` +
            `Consider sending: "Reread AGENTS.md and check your current bead status."`,
          "warning"
        );
      },
      onConflict: (conflict) => {
        ctx.ui.notify(
          `🔴 File conflict: ${conflict.file} being edited by agents #${conflict.worktrees.join(", #")}`,
          "error"
        );
      },
      onIdleInstruct: (idleAgents, readyBead) => {
        const panes = idleAgents.map((a) => `#${a.stepIndex + 1}`).join(", ");
        // Best-effort nudge: NTM panes via ntm send, Herdr pi agents via agent prompt.
        for (const a of idleAgents) {
          const name = workerNameByIndex.get(a.stepIndex) ?? `swarm-${a.stepIndex + 1}`;
          if (launchMode === "pi") {
            pi.exec("herdr", ["agent", "prompt", name, `Pick up: ${readyBead}`]).catch(() => undefined);
          } else {
            pi.exec("ntm", ["send", ntmSession, "--pane", String(a.stepIndex + 1), `Pick up: ${readyBead}`]).catch(() => undefined);
          }
        }
        ctx.ui.notify(
          `🤖 Idle panes ${panes}: auto-instructed with ${readyBead}. ` +
            (launchMode === "pi" ? "Sent via herdr agent prompt." : `NTM session "${ntmSession}".`),
          "info"
        );
      },
      onStalledBeadReopened: (ids) => {
        ctx.ui.notify(`♻️ Reopened clearly-stalled beads: ${ids.join(", ")}`, "info");
      },
      onAntiSlopDue: (commits) => {
        ctx.ui.notify(
          `🧹 Anti-slop cadence reached (${commits} commits). Run the de-slopify skill + a fresh-eyes pass and add follow-up beads for any findings.`,
          "info"
        );
      },
    });
    oc.swarmTender.start();

    pi.sendUserMessage(
      `${instructions}\n\n` +
        `**NEXT: Run the ${launchMode === "pi" ? "Herdr" : "NTM"} launch command above. Do not implement inline in the current chat.**\n\n` +
        `SwarmTender is monitoring. Use \`/flywheel-swarm-status\` to check health.`,
      { deliverAs: "followUp" }
    );
  };

  pi.registerCommand("flywheel-swarm", {
    description: "Launch a persistent agent swarm for parallel bead execution",
    handler: launchSwarm,
  });

  pi.registerCommand("agent-flywheel-swarm", {
    description: "Launch a persistent agent swarm for parallel bead execution",
    handler: launchSwarm,
  });




  // ─── Command: /flywheel-audit ─────────────────────────────
  const codebaseAuditOptions = {
    description: "Full codebase audit: spin up parallel agents for bugs, security, tests, and dead code",
    handler: async (args: string, ctx: any) => {
      const { auditAgentPrompt, findingsToBeadsPrompt } = await import("./prompts.js");
      const { getDomainChecklist, formatDomainBlunderItems } = await import("./domain-knowledge.js");
      const { runDeepPlanAgents } = await import("./deep-plan.js");
      const { pickRefinementModel } = await import("./prompts.js");

      // Profile if needed
      if (!oc.state.repoProfile) {
        ctx.ui.notify("📊 Profiling repo first...", "info");
        try {
          const { profileRepo } = await import("./profiler.js");
          oc.state.repoProfile = await profileRepo(pi, ctx.cwd);
          oc.persistState();
        } catch { /* best-effort */ }
      }
      const profile = oc.state.repoProfile ?? { name: "", languages: [], frameworks: [], keyFiles: {} as Record<string,string>, testFramework: undefined, ciSystem: undefined, packageManager: undefined, hasGit: true, todos: [], recentCommits: [], entrypoints: [], structure: "", hasTests: false, hasDocs: false, hasCI: false };

      // Parse optional focus filter from args (e.g. "--focus bugs,security")
      const argStr = args.trim();
      const focusMatch = argStr.match(/--focus\s+([\w,\-]+)/);
      type AuditFocus = "bugs" | "security" | "tests" | "dead-code";
      const allFoci: AuditFocus[] = ["bugs", "security", "tests", "dead-code"];
      let foci: AuditFocus[] = allFoci;
      if (focusMatch) {
        const requested = focusMatch[1].split(",").map((s: string) => s.trim()) as AuditFocus[];
        foci = requested.filter(f => allFoci.includes(f));
        if (foci.length === 0) foci = allFoci;
      }

      // Let user choose scope if interactive
      const scopeChoice = await ctx.ui.select(
        `## 🔍 Codebase Audit\n\nLaunching ${foci.length} parallel audit agent(s): **${foci.join(", ")}**\n\nThis will spawn one agent per focus area. Each reads the full codebase and reports findings.`,
        [
          `🚀 Full audit (${foci.length} agents in parallel)`,
          "🎯 Quick — bugs + security only (2 agents)",
          "❌ Cancel",
        ]
      );

      if (!scopeChoice || scopeChoice.startsWith("❌")) return;
      if (scopeChoice.startsWith("🎯")) foci = ["bugs", "security"];

      // Get file list for context
      let files: string[] = [];
      const findSrcResult = await resilientExec(pi, "find", ["src", "-type", "f", "-name", "*.ts", "-not", "-path", "*/node_modules/*"], { cwd: ctx.cwd, timeout: 10000, maxRetries: 0 });
      if (findSrcResult.ok) {
        files = findSrcResult.value.stdout.trim().split("\n").filter(Boolean).slice(0, 100);
      } /* use empty list on failure — agent will explore on its own */

      const domainChecklist = getDomainChecklist(profile);
      const domainExtras = domainChecklist ? formatDomainBlunderItems(domainChecklist) : undefined;

      ctx.ui.notify(`🚀 Launching ${foci.length} audit agent(s)...`, "info");

      const agents = foci.map((focus, i) => ({
        name: `audit-${focus}`,
        model: pickRefinementModel(i),
        task: auditAgentPrompt(focus, profile, files, ctx.cwd, domainExtras),
      }));

      let results: import("./deep-plan.js").DeepPlanResult[];
      try {
        results = await runDeepPlanAgents(pi, ctx.cwd, agents);
      } catch (err: any) {
        ctx.ui.notify(`❌ Audit agents failed: ${err.message ?? err}`, "error");
        return;
      }

      // Parse findings from each agent output
      const allFindings: Array<{ severity: string; file: string; line: string; title: string; description: string; fix: string; focus: string }> = [];
      const summaries: string[] = [];

      for (const result of results) {
        const focusName = result.name.replace("audit-", "");
        if (result.exitCode !== 0 || !result.plan) {
          summaries.push(`⚠️ **${focusName}**: agent failed or produced no output`);
          continue;
        }
        const jsonMatch = result.plan.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            if (Array.isArray(parsed)) {
              allFindings.push(...parsed.map((f: any) => ({ ...f, focus: focusName })));
            }
          } catch { /* ignore parse errors */ }
        }
        // Extract prose summary (after the JSON block)
        const afterJson = result.plan.replace(/```json[\s\S]*?```/g, "").trim();
        if (afterJson) summaries.push(`**${focusName}:** ${afterJson.slice(0, 300)}`);
      }

      // Sort by severity
      const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      allFindings.sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));

      const critical = allFindings.filter(f => f.severity === "critical" || f.severity === "high");
      const other = allFindings.filter(f => f.severity !== "critical" && f.severity !== "high");

      const sevEmoji = (s: string) =>
        s === "critical" ? "🔴" : s === "high" ? "🟠" : s === "medium" ? "🟡" : "⚪";

      const findingLines = allFindings.slice(0, 30).map(f =>
        `${sevEmoji(f.severity)} **[${f.focus}]** ${f.file}:${f.line} — ${f.title}`
      );

      const report = [
        `## 🔍 Audit Complete — ${allFindings.length} finding(s)`,
        `**Critical/High:** ${critical.length}  |  **Other:** ${other.length}`,
        "",
        summaries.length > 0 ? `### Agent Summaries\n${summaries.join("\n\n")}` : "",
        findingLines.length > 0 ? `### All Findings\n${findingLines.join("\n")}` : "✅ No findings.",
      ].filter(Boolean).join("\n\n");

      pi.sendUserMessage(report, { deliverAs: "followUp" });

      if (allFindings.length === 0) return;

      // Offer to create fix beads
      const createBeads = await ctx.ui.select(
        `Create fix beads for findings?`,
        [
          `🔴 Critical & high only (${critical.length} bead${critical.length !== 1 ? "s" : ""})`,
          `📋 All findings (${allFindings.length} bead${allFindings.length !== 1 ? "s" : ""})`,
          "⏭️  No — just the report",
        ]
      );

      if (!createBeads || createBeads.startsWith("⏭️")) return;

      const toCreate = createBeads.startsWith("🔴") ? critical : allFindings;
      const beadInstructions = findingsToBeadsPrompt(toCreate, ctx.cwd);
      pi.sendUserMessage(
        `Create beads for the ${toCreate.length} finding(s):\n\n${beadInstructions}`,
        { deliverAs: "followUp" }
      );
    },
  };
  pi.registerCommand("flywheel-audit", codebaseAuditOptions);
  pi.registerCommand("agent-flywheel-audit", { ...codebaseAuditOptions, description: "Legacy alias of /flywheel-audit" });



  const auditBeadsHandler = async (args: string, ctx: any) => {
    const parsed = parseComplianceAuditArgs(args);
    let preflight = await prepareComplianceAuditPlan(pi, ctx.cwd, parsed);
    if (!preflight.ok) {
      ctx.ui.notify(`❌ Beads compliance audit preflight failed at ${preflight.stage}: ${preflight.message}`, "error");
      return;
    }

    let plan = preflight.plan;
    if (!plan.testExecutionOk) {
      const confirmed = await ctx.ui.confirm(
        "Run beads compliance audit",
        `${plan.summary}\n\nPhase 4 may run tests, fuzzers, coverage, and e2e checks. Confirm this checkout is safe for test execution?`
      );
      if (!confirmed) {
        ctx.ui.notify(`${plan.summary}\n\nAudit prompt prepared, but not started because test execution was not confirmed.`, "warning");
        return;
      }
      preflight = await prepareComplianceAuditPlan(pi, ctx.cwd, { ...parsed, testExecutionOk: true });
      if (!preflight.ok) {
        ctx.ui.notify(`❌ Beads compliance audit preflight failed at ${preflight.stage}: ${preflight.message}`, "error");
        return;
      }
      plan = preflight.plan;
    }

    ctx.ui.notify(plan.summary, "info");
    pi.sendUserMessage(plan.prompt, { deliverAs: "followUp" });
  };

  pi.registerCommand("agent-flywheel-audit-beads", {
    description: "Audit closed beads for actual completion with evidence packs",
    handler: auditBeadsHandler,
  });

  pi.registerCommand("flywheel-audit-beads", {
    description: "Audit closed beads for actual completion with evidence packs",
    handler: auditBeadsHandler,
  });

  // ─── AgentFlywheel preferred aliases + compatibility aliases ─────────────
  pi.registerCommand("agent-flywheel-doctor", {
    description: "Read-only diagnostic of AgentFlywheel prerequisites and session health",
    handler: async (_args, ctx) => {
      const { runDoctorChecks, formatDoctorReport } = await import("./tools/doctor.js");
      const report = await runDoctorChecks(pi, ctx.cwd);
      ctx.ui.notify(formatDoctorReport(report), report.overall === "red" ? "error" : report.overall === "yellow" ? "warning" : "info");
    },
  });

  pi.registerCommand("flywheel-doctor", {
    description: "Read-only diagnostic of flywheel prerequisites and session health",
    handler: async (_args, ctx) => {
      const { runDoctorChecks, formatDoctorReport } = await import("./tools/doctor.js");
      const report = await runDoctorChecks(pi, ctx.cwd);
      ctx.ui.notify(formatDoctorReport(report), report.overall === "red" ? "error" : report.overall === "yellow" ? "warning" : "info");
    },
  });

  pi.registerCommand("agent-flywheel-status", {
    description: "Legacy alias of /flywheel-status",
    handler: workflowStatusHandler,
  });

  pi.registerCommand("flywheel-status", {
    description: "Show current flywheel workflow status; pass --json for the machine-readable contract",
    handler: workflowStatusHandler,
  });

  pi.registerCommand("agent-flywheel-stop", {
    description: "Stop the current AgentFlywheel session",
    handler: async (_args, ctx) => {
      if (!oc.orchestratorActive) {
        ctx.ui.notify("No AgentFlywheel session in progress.", "info");
        return;
      }
      if (oc.worktreePool) {
        const summary = await oc.worktreePool.safeCleanup();
        if (summary.autoCommitted > 0) ctx.ui.notify(`💾 Auto-committed ${summary.autoCommitted} dirty worktree(s) before cleanup.`, "info");
        oc.worktreePool = undefined;
      }
      if (oc.swarmTender) { oc.swarmTender.stop(); oc.swarmTender = undefined; }
      try {
        const { shouldGenerateHandoff, writeHandoffArtifact } = await import("./handoff.js");
        if (shouldGenerateHandoff({ event: "stop", state: oc.state })) {
          const statusResult = await resilientExec(pi, "git", ["status", "--short"], { cwd: ctx.cwd, timeout: 5000, maxRetries: 0 });
          const changedFiles = statusResult.ok
            ? statusResult.value.stdout.split("\n").map((line) => line.trim().split(/\s+/).at(-1)).filter((file): file is string => Boolean(file))
            : [];
          const handoffPath = writeHandoffArtifact({
            cwd: ctx.cwd,
            state: oc.state,
            reason: "orchestrator stopped with active work",
            changedFiles,
            blockers: ["Orchestration was stopped before all active work completed."],
          });
          ctx.ui.notify(`🧾 Handoff artifact written: ${handoffPath}`, "info");
        }
      } catch { /* best-effort */ }
      oc.orchestratorActive = false;
      oc.setPhase("idle", ctx);
      oc.persistState();
      ctx.ui.notify("🛑 AgentFlywheel stopped.", "warning");
    },
  });

  pi.registerCommand("flywheel-stop", {
    description: "Stop the current AgentFlywheel/orchestration session",
    handler: async (_args, ctx) => {
      if (!oc.orchestratorActive) {
        ctx.ui.notify("No orchestration in progress.", "info");
        return;
      }
      if (oc.worktreePool) {
        const summary = await oc.worktreePool.safeCleanup();
        if (summary.autoCommitted > 0) ctx.ui.notify(`💾 Auto-committed ${summary.autoCommitted} dirty worktree(s) before cleanup.`, "info");
        oc.worktreePool = undefined;
      }
      if (oc.swarmTender) { oc.swarmTender.stop(); oc.swarmTender = undefined; }
      try {
        const { shouldGenerateHandoff, writeHandoffArtifact } = await import("./handoff.js");
        if (shouldGenerateHandoff({ event: "stop", state: oc.state })) {
          const statusResult = await resilientExec(pi, "git", ["status", "--short"], { cwd: ctx.cwd, timeout: 5000, maxRetries: 0 });
          const changedFiles = statusResult.ok
            ? statusResult.value.stdout.split("\n").map((line) => line.trim().split(/\s+/).at(-1)).filter((file): file is string => Boolean(file))
            : [];
          const handoffPath = writeHandoffArtifact({
            cwd: ctx.cwd,
            state: oc.state,
            reason: "orchestrator stopped with active work",
            changedFiles,
            blockers: ["Orchestration was stopped before all active work completed."],
          });
          ctx.ui.notify(`🧾 Handoff artifact written: ${handoffPath}`, "info");
        }
      } catch { /* best-effort */ }
      oc.orchestratorActive = false;
      oc.setPhase("idle", ctx);
      oc.persistState();
      ctx.ui.notify("🛑 Flywheel stopped.", "warning");
    },
  });

  pi.registerCommand("agent-flywheel-cleanup", {
    description: "Clean up orphaned AgentFlywheel worktrees",
    handler: async (_args, ctx) => {
      const { findOrphanedWorktrees, cleanupOrphanedWorktrees } = await import("./worktree.js");
      const tracked = oc.worktreePool ? [...oc.worktreePool.getAll()] : [];
      const orphans = await findOrphanedWorktrees(pi, ctx.cwd, tracked);
      if (orphans.length === 0) {
        ctx.ui.notify("✅ No orphaned worktrees found.", "info");
        return;
      }
      const dirtyCount = orphans.filter((o) => o.isDirty).length;
      const confirmed = await ctx.ui.confirm(
        "Clean up worktrees",
        `Found ${orphans.length} orphaned worktree(s)${dirtyCount ? ` (${dirtyCount} dirty — will auto-commit)` : ""}. Remove them?`
      );
      if (!confirmed) return;
      const summary = await cleanupOrphanedWorktrees(pi, ctx.cwd, orphans);
      ctx.ui.notify(`🧹 Removed ${summary.removed} worktree(s)${summary.autoCommitted ? `; auto-committed ${summary.autoCommitted}` : ""}${summary.errors.length ? `; errors: ${summary.errors.join(", ")}` : ""}`, summary.errors.length ? "warning" : "info");
    },
  });

  pi.registerCommand("flywheel-cleanup", {
    description: "Clean up orphaned AgentFlywheel worktrees",
    handler: async (_args, ctx) => {
      const { findOrphanedWorktrees, cleanupOrphanedWorktrees } = await import("./worktree.js");
      const tracked = oc.worktreePool ? [...oc.worktreePool.getAll()] : [];
      const orphans = await findOrphanedWorktrees(pi, ctx.cwd, tracked);
      if (orphans.length === 0) {
        ctx.ui.notify("✅ No orphaned worktrees found.", "info");
        return;
      }
      const dirtyCount = orphans.filter((o) => o.isDirty).length;
      const confirmed = await ctx.ui.confirm(
        "Clean up worktrees",
        `Found ${orphans.length} orphaned worktree(s)${dirtyCount ? ` (${dirtyCount} dirty — will auto-commit)` : ""}. Remove them?`
      );
      if (!confirmed) return;
      const summary = await cleanupOrphanedWorktrees(pi, ctx.cwd, orphans);
      ctx.ui.notify(`🧹 Removed ${summary.removed} worktree(s)${summary.autoCommitted ? `; auto-committed ${summary.autoCommitted}` : ""}${summary.errors.length ? `; errors: ${summary.errors.join(", ")}` : ""}`, summary.errors.length ? "warning" : "info");
    },
  });

  pi.registerCommand("agent-flywheel-swarm-status", {
    description: "Show AgentFlywheel swarm health: active/idle/stuck agents, bead progress, conflicts",
    handler: async (_args, ctx) => {
      if (!oc.swarmTender) {
        ctx.ui.notify("No swarm active. Launch one with /flywheel-swarm.", "info");
        return;
      }
      const { formatSwarmStatus } = await import("./swarm.js");
      const { readBeads } = await import("./beads.js");
      ctx.ui.notify(formatSwarmStatus(oc.swarmTender.getStatus(), await readBeads(pi, ctx.cwd)), "info");
    },
  });

  pi.registerCommand("flywheel-swarm-status", {
    description: "Show swarm health: active/idle/stuck agents, bead progress, conflicts",
    handler: async (_args, ctx) => {
      if (!oc.swarmTender) {
        ctx.ui.notify("No swarm active. Launch one with /flywheel-swarm.", "info");
        return;
      }
      const { formatSwarmStatus } = await import("./swarm.js");
      const { readBeads } = await import("./beads.js");
      ctx.ui.notify(formatSwarmStatus(oc.swarmTender.getStatus(), await readBeads(pi, ctx.cwd)), "info");
    },
  });

  pi.registerCommand("agent-flywheel-swarm-stop", {
    description: "Stop the swarm tender and send landing prompts",
    handler: async (_args, ctx) => {
      if (!oc.swarmTender) {
        ctx.ui.notify("No swarm active.", "info");
        return;
      }
      oc.swarmTender.stop();
      oc.swarmTender = undefined;
      const { landingChecklistInstructions } = await import("./prompts.js");
      ctx.ui.notify(`🛑 Swarm tender stopped.\n\nAgents may still be running in their terminals. Send each the landing checklist:\n\n${landingChecklistInstructions(ctx.cwd).slice(0, 500)}...`, "info");
    },
  });

  pi.registerCommand("flywheel-swarm-stop", {
    description: "Stop the swarm tender and send landing prompts",
    handler: async (_args, ctx) => {
      if (!oc.swarmTender) {
        ctx.ui.notify("No swarm active.", "info");
        return;
      }
      oc.swarmTender.stop();
      oc.swarmTender = undefined;
      const { landingChecklistInstructions } = await import("./prompts.js");
      ctx.ui.notify(`🛑 Swarm tender stopped.\n\nAgents may still be running in their terminals. Send each the landing checklist:\n\n${landingChecklistInstructions(ctx.cwd).slice(0, 500)}...`, "info");
    },
  });
}
