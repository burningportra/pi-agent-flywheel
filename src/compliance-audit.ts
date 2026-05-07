import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import { join } from "path";
import { brExecJson, type CliExecError } from "./cli-exec.js";

export const AUDIT_DIR_NAME = "beads_compliance_audit";
export const DEFAULT_AUDIT_THRESHOLD = 700;
export const MAX_AUDIT_PARALLELISM = 10;

export type ComplianceAuditMode =
  | "triage"
  | "standard"
  | "comprehensive"
  | "tripwire"
  | "single-bead"
  | "re-verification"
  | "onboarding"
  | "sample";

export type ComplianceRemediationPolicy = "completion-debt" | "reopen" | "report-only";
export type ComplianceAuditTier = "solo" | "pair" | "squad" | "battalion" | "swarm" | "mega-swarm";

export interface ComplianceAuditOptions {
  mode?: ComplianceAuditMode;
  threshold?: number;
  remediationPolicy?: ComplianceRemediationPolicy;
  parallelism?: number;
  beadId?: string;
  sampleSize?: number;
  testExecutionOk?: boolean;
}

export interface BrStatsPayload {
  summary?: {
    total_issues?: number;
    open_issues?: number;
    in_progress_issues?: number;
    closed_issues?: number;
    blocked_issues?: number;
    deferred_issues?: number;
    draft_issues?: number;
    ready_issues?: number;
    tombstone_issues?: number;
  };
}

export interface ComplianceAuditTierRecommendation {
  tier: ComplianceAuditTier;
  recommendedParallelism: number;
  recommendedMode?: ComplianceAuditMode;
  rationale: string;
}

export interface ComplianceAuditPlan {
  cwd: string;
  auditDir: string;
  auditDirExists: boolean;
  mode: ComplianceAuditMode;
  tier: ComplianceAuditTier;
  threshold: number;
  remediationPolicy: ComplianceRemediationPolicy;
  parallelism: number;
  totalCount: number;
  closedCount: number;
  beadId?: string;
  sampleSize?: number;
  testExecutionOk: boolean;
  prompt: string;
  summary: string;
}

export type ComplianceAuditPreflightResult =
  | { ok: true; plan: ComplianceAuditPlan; doctor: unknown; stats: BrStatsPayload }
  | { ok: false; stage: "doctor" | "stats" | "validation"; message: string; error?: CliExecError; doctor?: unknown };

export function clampAuditThreshold(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_AUDIT_THRESHOLD;
  return Math.max(0, Math.min(1000, Math.round(value)));
}

export function clampAuditParallelism(value: number | undefined, recommended: number): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : recommended;
  return Math.max(1, Math.min(MAX_AUDIT_PARALLELISM, raw));
}

export function recommendComplianceAuditTier(closedCount: number): ComplianceAuditTierRecommendation {
  if (closedCount < 20) {
    return { tier: "solo", recommendedParallelism: 1, rationale: "<20 closed beads: serial audit is cheaper than coordination." };
  }
  if (closedCount <= 150) {
    return { tier: "pair", recommendedParallelism: 3, rationale: "20–150 closed beads: 2–3 agents avoid local contention." };
  }
  if (closedCount <= 500) {
    return { tier: "squad", recommendedParallelism: 5, rationale: "150–500 closed beads: squad fan-out with file reservations." };
  }
  if (closedCount <= 1000) {
    return { tier: "battalion", recommendedParallelism: 7, rationale: "500–1000 closed beads: 6–7 agents, capped below thrash." };
  }
  if (closedCount <= 1500) {
    return { tier: "swarm", recommendedParallelism: 9, rationale: "1000–1500 closed beads: swarm fan-out, still below the 10-agent hard cap." };
  }
  return {
    tier: "mega-swarm",
    recommendedParallelism: 10,
    recommendedMode: "sample",
    rationale: "1500+ closed beads: hard-cap at 10 agents and prefer stratified Sample mode.",
  };
}

export function suggestComplianceAuditMode(input: {
  closedCount: number;
  auditDirExists: boolean;
  explicitMode?: ComplianceAuditMode;
  beadId?: string;
}): ComplianceAuditMode {
  if (input.explicitMode) return input.explicitMode;
  if (input.beadId) return "single-bead";
  if (input.auditDirExists) return "re-verification";
  if (input.closedCount > 1500) return "sample";
  if (input.closedCount > 50) return "onboarding";
  return "standard";
}

export function normalizeSampleSize(value: number | undefined, closedCount: number, mode: ComplianceAuditMode): number | undefined {
  if (mode !== "sample") return undefined;
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : Math.min(50, Math.max(15, closedCount));
  return Math.max(1, Math.min(50, raw));
}

export function formatComplianceAuditSummary(plan: Omit<ComplianceAuditPlan, "prompt" | "summary">): string {
  const scope = plan.mode === "single-bead"
    ? `single bead ${plan.beadId ?? "(missing bead id)"}`
    : plan.mode === "sample"
      ? `sample of ${plan.sampleSize ?? "auto"} beads`
      : `${plan.closedCount} closed / ${plan.totalCount} total beads`;
  return [
    `# Beads compliance audit preflight`,
    `cwd: ${plan.cwd}`,
    `audit dir: ${plan.auditDir}${plan.auditDirExists ? " (existing; new pass)" : " (new)"}`,
    `mode: ${plan.mode}`,
    `tier: ${plan.tier}`,
    `scope: ${scope}`,
    `threshold: ${plan.threshold}`,
    `remediation: ${plan.remediationPolicy}`,
    `parallelism: ${plan.parallelism} (hard cap ${MAX_AUDIT_PARALLELISM})`,
    `test execution: ${plan.testExecutionOk ? "confirmed" : "NOT confirmed"}`,
  ].join("\n");
}

export function buildComplianceAuditPrompt(plan: Omit<ComplianceAuditPlan, "prompt" | "summary">): string {
  const modeLine = plan.mode === "single-bead"
    ? `Single-bead mode for ${plan.beadId}. Scope phases 2–6, 8–9 to that bead; Phase 1 and 7 may inspect the whole graph.`
    : plan.mode === "sample"
      ? `Sample mode. Use a stratified sample of ${plan.sampleSize} beads: keystones/bottlenecks, random recents, and any suspicious closed beads.`
      : `${plan.mode} mode over the bead universe.`;
  const testWarning = plan.testExecutionOk
    ? "The user confirmed test execution is OK. Still avoid prod credentials and destructive commands."
    : "Test execution is NOT confirmed. Stop before Phase 4 and ask the user to confirm tests/fuzzers/e2e are safe.";

  return `Run a beads compliance and completion verification audit for this repo.\n\n` +
    `## Project\n` +
    `- cwd: ${plan.cwd}\n` +
    `- audit dir: ${plan.auditDir}\n` +
    `- existing audit dir: ${plan.auditDirExists ? "yes — create a new dated pass under passes/" : "no — bootstrap it"}\n` +
    `- mode: ${plan.mode}\n` +
    `- tier: ${plan.tier}\n` +
    `- closed beads: ${plan.closedCount}\n` +
    `- total beads: ${plan.totalCount}\n` +
    `- threshold: ${plan.threshold}\n` +
    `- remediation policy: ${plan.remediationPolicy}\n` +
    `- parallelism: ${plan.parallelism} (hard cap ${MAX_AUDIT_PARALLELISM})\n` +
    `- ${modeLine}\n\n` +
    `## One rule\n` +
    `A bead status is a claim, not a fact. Treat every closed bead as unverified until concrete artifacts prove completion: file:line citations, raw test logs, coverage over bead-owned files, fuzzer/golden/e2e evidence, and anti-theater scans.\n\n` +
    `## Guardrails\n` +
    `- First run \`br doctor --json\`; if it exits non-zero or reports corruption, STOP and ask to fix beads first.\n` +
    `- Never delete or overwrite a previous \`${AUDIT_DIR_NAME}/passes/<timestamp>/\` directory.\n` +
    `- Keep \`${AUDIT_DIR_NAME}/\` out of the project git history; it is its own local audit artifact.\n` +
    `- Never tune the rubric mid-pass. Pin threshold=${plan.threshold} in rubric.md/manifest.json.\n` +
    `- ${testWarning}\n` +
    `- Phase 9 is graph maintenance only: ${plan.remediationPolicy === "report-only" ? "report gaps only; do not write beads." : plan.remediationPolicy === "reopen" ? "reopen false-closed originals only after scorecards cite missing items." : "create completion-debt beads linked to originals; do not silently fix code."}\n\n` +
    `## Required artifact layout\n` +
    `Create/update \`${AUDIT_DIR_NAME}/\` with: manifest.json, rubric.md, REPORT.md, synthesis.md, remediation.md, dashboard.html, and \`passes/<UTC>/\`. Per audited bead write spec.json, evidence.json, compliance.json, theater.json, test_depth.json, scorecard.md, plus raw logs under raw/.\n\n` +
    `## 10-phase loop\n` +
    `1. INVENTORY — br doctor, br list all beads, classify status/type, capture DAG/bv insights when available.\n` +
    `2. SPEC EXTRACTION — parse bead body literally into checklist items; preserve numeric requirements.\n` +
    `3. EVIDENCE GATHER — map each checklist item to file:line/test/CI/doc evidence or MISSING.\n` +
    `4. COMPLIANCE EXEC — re-run the claimed proof now; capture stdout/stderr/exit codes in raw/.\n` +
    `5. ANTI-THEATER — scan evidence for TODOs, stubs, hardcoded happy paths, mocks where forbidden, skipped/assert-true tests.\n` +
    `6. TEST DEPTH — measure coverage over bead-specific files, fuzzer duration/corpus, golden freshness, real-service e2e realism.\n` +
    `7. SYNTHESIS — find cross-bead contract drift, orphaned acceptance criteria, dependency anomalies.\n` +
    `8. SCORING — apply 0–1000 rubric: impl 300, tests 250, anti-theater 150, depth 150, docs/telemetry/migrations 100, integration 50. Flag closed beads below ${plan.threshold}.\n` +
    `9. REMEDIATION — ${plan.remediationPolicy}; record all actions in remediation.md.\n` +
    `10. FRESH EYES — spot-check the audit itself for rubric consistency and whole-category misses; write convergence.json.\n\n` +
    `## Output discipline\n` +
    `Return concise progress only. Cite artifact paths. Report failures honestly. Do not claim tests pass unless Phase 4 raw logs prove it.`;
}

export async function prepareComplianceAuditPlan(
  pi: ExtensionAPI,
  cwd: string,
  options: ComplianceAuditOptions = {},
): Promise<ComplianceAuditPreflightResult> {
  const doctorResult = await brExecJson<unknown>(pi, ["doctor", "--json"], {
    cwd,
    timeout: 10_000,
    maxRetries: 0,
    logWarnings: false,
  });
  if (!doctorResult.ok) {
    return {
      ok: false,
      stage: "doctor",
      message: "br doctor failed; fix the bead store before running a compliance audit.",
      error: doctorResult.error,
    };
  }
  const doctorPayload = doctorResult.value as any;
  if (doctorPayload && typeof doctorPayload === "object" && doctorPayload.ok === false) {
    return {
      ok: false,
      stage: "doctor",
      message: "br doctor reported an unhealthy bead store; fix beads before auditing completion claims.",
      doctor: doctorPayload,
    };
  }

  const statsResult = await brExecJson<BrStatsPayload>(pi, ["stats", "--json"], {
    cwd,
    timeout: 10_000,
    maxRetries: 1,
    logWarnings: false,
  });
  if (!statsResult.ok) {
    return {
      ok: false,
      stage: "stats",
      message: "Could not read br stats; audit needs bead counts for tier/mode selection.",
      error: statsResult.error,
      doctor: doctorPayload,
    };
  }

  const summary = statsResult.value.summary ?? {};
  const closedCount = Math.max(0, summary.closed_issues ?? 0);
  const totalCount = Math.max(0, summary.total_issues ?? closedCount);
  const auditDir = join(cwd, AUDIT_DIR_NAME);
  const auditDirExists = existsSync(auditDir);
  const mode = suggestComplianceAuditMode({
    closedCount,
    auditDirExists,
    explicitMode: options.mode,
    beadId: options.beadId,
  });

  if (mode === "single-bead" && !options.beadId) {
    return {
      ok: false,
      stage: "validation",
      message: "single-bead mode requires beadId.",
      doctor: doctorPayload,
    };
  }

  const tierRec = recommendComplianceAuditTier(closedCount);
  const threshold = clampAuditThreshold(options.threshold);
  const parallelism = clampAuditParallelism(options.parallelism, tierRec.recommendedParallelism);
  const remediationPolicy = options.remediationPolicy ?? (mode === "tripwire" ? "report-only" : "completion-debt");
  const sampleSize = normalizeSampleSize(options.sampleSize, closedCount, mode);

  const basePlan = {
    cwd,
    auditDir,
    auditDirExists,
    mode,
    tier: tierRec.tier,
    threshold,
    remediationPolicy,
    parallelism,
    totalCount,
    closedCount,
    beadId: options.beadId,
    sampleSize,
    testExecutionOk: options.testExecutionOk === true,
  } satisfies Omit<ComplianceAuditPlan, "prompt" | "summary">;

  const plan: ComplianceAuditPlan = {
    ...basePlan,
    prompt: buildComplianceAuditPrompt(basePlan),
    summary: formatComplianceAuditSummary(basePlan),
  };

  return { ok: true, plan, doctor: doctorPayload, stats: statsResult.value };
}
