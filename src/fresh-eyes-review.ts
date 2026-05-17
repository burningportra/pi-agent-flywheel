import type {
  FreshEyesReviewConfig,
  FreshEyesReviewLaunchResult,
  FreshEyesReviewState,
} from "./types.js";

export const FRESH_EYES_REVIEW_POLL_INTERVAL_MS = 7 * 60 * 1000;
export const FRESH_EYES_REVIEW_LAUNCH_AFTER_COMMITS = 5;

export interface CreateFreshEyesReviewStateOptions {
  baselineRef: string;
  baselineCommitCount?: number;
  currentBeadId?: string | null;
}

export interface DecideFreshEyesReviewLaunchOptions {
  state: FreshEyesReviewState;
  commitsSinceBaseline: number;
  config?: Partial<FreshEyesReviewConfig>;
  headRef?: string;
  nowIso?: string;
}

export interface FreshEyesReviewPromptOptions {
  baselineRef: string;
  headRef: string;
  commitsSinceBaseline: number;
  currentBeadId?: string | null;
  threadId?: string;
  repoRoot?: string;
}

export interface FreshEyesAgentMailMessageInput {
  threadId: string;
  subject: string;
  body: string;
  importance: "normal" | "high";
}

export interface FreshEyesAgentMailBoundaryResult {
  ok?: boolean;
  agentName?: string;
  warning?: string;
}

export interface FreshEyesAgentMailBoundary {
  prepareThread(input: { threadId: string; reason: string }): Promise<FreshEyesAgentMailBoundaryResult | void>;
  sendMessage(input: FreshEyesAgentMailMessageInput): Promise<FreshEyesAgentMailBoundaryResult | void>;
}

export interface FreshEyesReviewerLaunchResult {
  ok?: boolean;
  agentName?: string;
  warning?: string;
}

export interface FreshEyesReviewerLaunchBoundary {
  launch(input: {
    threadId: string;
    prompt: string;
    reason: string;
    cwd?: string;
  }): Promise<FreshEyesReviewerLaunchResult | void>;
}

export interface LaunchFreshEyesReviewOptions {
  state: FreshEyesReviewState;
  commitsSinceBaseline: number;
  headRef: string;
  nowIso: string;
  config?: Partial<FreshEyesReviewConfig>;
  cwd?: string;
  runThreadId?: string;
  agentMail?: FreshEyesAgentMailBoundary;
  reviewer?: FreshEyesReviewerLaunchBoundary;
}

export function defaultFreshEyesReviewConfig(): FreshEyesReviewConfig {
  return {
    enabled: true,
    launchAfterCommits: FRESH_EYES_REVIEW_LAUNCH_AFTER_COMMITS,
    pollIntervalMs: FRESH_EYES_REVIEW_POLL_INTERVAL_MS,
    coordination: "agent-mail",
    outputMode: "append-current-bead",
    reviewScope: "full",
  };
}

export function createFreshEyesReviewState(options: CreateFreshEyesReviewStateOptions): FreshEyesReviewState {
  const currentBeadId = normalizeOptionalString(options.currentBeadId);

  return {
    baselineRef: options.baselineRef,
    baselineCommitCount: options.baselineCommitCount,
    launched: false,
    ...(currentBeadId ? { currentBeadId } : {}),
  };
}

export function decideFreshEyesReviewLaunch(
  options: DecideFreshEyesReviewLaunchOptions
): FreshEyesReviewLaunchResult {
  const config = { ...defaultFreshEyesReviewConfig(), ...options.config };
  const commitsSinceBaseline = Math.max(0, Math.floor(options.commitsSinceBaseline));

  if (!config.enabled) {
    return unchangedDecision(options.state, commitsSinceBaseline, "fresh-eyes review is disabled");
  }

  if (options.state.launched) {
    return unchangedDecision(options.state, commitsSinceBaseline, "fresh-eyes review already launched");
  }

  if (commitsSinceBaseline < config.launchAfterCommits) {
    return unchangedDecision(
      options.state,
      commitsSinceBaseline,
      `waiting for ${config.launchAfterCommits} commits; ${commitsSinceBaseline} observed`
    );
  }

  const nextState: FreshEyesReviewState = {
    ...options.state,
    launched: true,
    ...(options.nowIso ? { launchedAt: options.nowIso } : {}),
    ...(options.headRef ? { launchedForHead: options.headRef } : {}),
  };

  return {
    launched: true,
    status: "launched",
    reason: `fresh-eyes review threshold reached: ${commitsSinceBaseline} commit${commitsSinceBaseline === 1 ? "" : "s"} since baseline`,
    commitsSinceBaseline,
    threadId: nextState.threadId,
    launchedAt: nextState.launchedAt,
    launchedForHead: nextState.launchedForHead,
    nextState,
  };
}

export async function launchFreshEyesReview(
  options: LaunchFreshEyesReviewOptions
): Promise<FreshEyesReviewLaunchResult> {
  const decision = decideFreshEyesReviewLaunch({
    state: options.state,
    commitsSinceBaseline: options.commitsSinceBaseline,
    config: options.config,
    headRef: options.headRef,
    nowIso: options.nowIso,
  });

  if (!decision.launched) {
    return { ...decision, status: "skipped" };
  }

  if (!options.agentMail) {
    return degradedLaunch(options.state, decision.commitsSinceBaseline, "Agent Mail boundary unavailable");
  }

  if (!options.reviewer) {
    return degradedLaunch(options.state, decision.commitsSinceBaseline, "fresh-eyes reviewer launch boundary unavailable");
  }

  const resolved = resolveFreshEyesReviewThread(options.state.currentBeadId, options.runThreadId, options.state.baselineRef);
  const prompt = buildFreshEyesReviewPrompt({
    baselineRef: options.state.baselineRef,
    headRef: options.headRef,
    commitsSinceBaseline: decision.commitsSinceBaseline,
    currentBeadId: resolved.currentBeadId,
    threadId: resolved.threadId,
    repoRoot: options.cwd,
  });

  const subject = `Fresh-eyes review requested for ${resolved.currentBeadId ?? "implementation run"}`;
  const body = `${resolved.reason}\n\n${prompt}`;

  const prepared = await callBoundary(
    () => options.agentMail!.prepareThread({ threadId: resolved.threadId, reason: resolved.reason }),
    "Agent Mail thread preparation failed"
  );
  if (!prepared.ok) {
    return degradedLaunch(options.state, decision.commitsSinceBaseline, prepared.warning, resolved.threadId);
  }

  const messaged = await callBoundary(
    () => options.agentMail!.sendMessage({ threadId: resolved.threadId, subject, body, importance: "high" }),
    "Agent Mail review request failed"
  );
  if (!messaged.ok) {
    return degradedLaunch(options.state, decision.commitsSinceBaseline, messaged.warning, resolved.threadId);
  }

  const launched = await callBoundary(
    () => options.reviewer!.launch({ threadId: resolved.threadId, prompt, reason: resolved.reason, cwd: options.cwd }),
    "fresh-eyes reviewer launch failed"
  );
  if (!launched.ok) {
    return degradedLaunch(options.state, decision.commitsSinceBaseline, launched.warning, resolved.threadId);
  }

  const reviewerAgentName = launched.agentName ?? prepared.agentName ?? messaged.agentName;
  const nextState: FreshEyesReviewState = {
    ...options.state,
    launched: true,
    launchedAt: options.nowIso,
    launchedForHead: options.headRef,
    threadId: resolved.threadId,
    ...(reviewerAgentName ? { reviewerAgentName } : {}),
    ...(resolved.currentBeadId ? { currentBeadId: resolved.currentBeadId } : {}),
  };

  return {
    launched: true,
    status: "launched",
    reason: resolved.reason,
    commitsSinceBaseline: decision.commitsSinceBaseline,
    threadId: resolved.threadId,
    ...(reviewerAgentName ? { reviewerAgentName } : {}),
    launchedAt: options.nowIso,
    launchedForHead: options.headRef,
    nextState,
  };
}

export function buildFreshEyesReviewPrompt(options: FreshEyesReviewPromptOptions): string {
  const currentBeadId = normalizeOptionalString(options.currentBeadId);
  const currentBead = currentBeadId ?? "unknown current bead";
  const thread = normalizeOptionalString(options.threadId) ?? currentBeadId;
  const repoLine = normalizeOptionalString(options.repoRoot)
    ? `- Repository root: ${options.repoRoot}\n`
    : "";

  return `You are the fresh-eyes reviewer for an active pi-agent-flywheel implementation run.

Perform a full fresh-eyes code review of the current repository state. Review the recent implementation work independently; do not assume the implementing agents caught every issue.

Context:
${repoLine}- Current bead: ${currentBead}
- Baseline ref before implementation progress: ${options.baselineRef}
- Current head ref: ${options.headRef}
- Commits since baseline: ${options.commitsSinceBaseline}
- Coordination channel: Agent Mail${thread ? ` thread ${thread}` : ""}

Review scope:
- Correctness and edge cases
- Type safety and build/test risks
- Integration with existing flywheel, bead, checkpoint, review, and coordination flows
- Regressions in existing user workflows
- Missing or weak tests
- Clear follow-up actions for implementation agents

Coordination instructions:
- Coordinate through Agent Mail; use the thread above when available.
- Report concise, actionable findings with file paths and evidence.
- If findings should affect active work, format them so they can be appended to the current bead.
- If no issues are found, send a short clean-pass note with what you inspected.
- Do not make code changes unless explicitly asked; this pass is for independent review feedback.`;
}

function unchangedDecision(
  state: FreshEyesReviewState,
  commitsSinceBaseline: number,
  reason: string
): FreshEyesReviewLaunchResult {
  return {
    launched: false,
    status: "skipped",
    reason,
    commitsSinceBaseline,
    threadId: state.threadId,
    nextState: state,
  };
}

function degradedLaunch(
  state: FreshEyesReviewState,
  commitsSinceBaseline: number,
  warning: string,
  threadId?: string
): FreshEyesReviewLaunchResult {
  return {
    launched: false,
    status: "degraded",
    reason: warning,
    warning,
    commitsSinceBaseline,
    ...(threadId ? { threadId } : {}),
    nextState: state,
  };
}

async function callBoundary<T extends FreshEyesAgentMailBoundaryResult | FreshEyesReviewerLaunchResult | void>(
  call: () => Promise<T>,
  fallbackWarning: string
): Promise<{ ok: boolean; agentName?: string; warning: string }> {
  try {
    const result = await call();
    const ok = result?.ok !== false;
    const warning = normalizeOptionalString(result?.warning) ?? fallbackWarning;
    return {
      ok,
      ...(normalizeOptionalString(result?.agentName) ? { agentName: normalizeOptionalString(result?.agentName) } : {}),
      warning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, warning: `${fallbackWarning}: ${message}` };
  }
}

function resolveFreshEyesReviewThread(
  currentBeadId: string | null | undefined,
  runThreadId: string | null | undefined,
  baselineRef: string
): { threadId: string; currentBeadId?: string; reason: string } {
  const normalizedBeadId = normalizeOptionalString(currentBeadId);
  if (normalizedBeadId && isSafeThreadId(normalizedBeadId)) {
    return {
      threadId: normalizedBeadId,
      currentBeadId: normalizedBeadId,
      reason: `fresh-eyes review threshold reached; coordinating on current bead thread ${normalizedBeadId}`,
    };
  }

  const normalizedRunThread = normalizeOptionalString(runThreadId);
  const fallbackThread = normalizedRunThread && isSafeThreadId(normalizedRunThread)
    ? normalizedRunThread
    : `fresh-eyes-${sanitizeThreadPart(baselineRef)}`;
  const reason = normalizedBeadId
    ? `fresh-eyes review threshold reached; current bead id '${normalizedBeadId}' is not safe for Agent Mail, using run-level thread ${fallbackThread}`
    : `fresh-eyes review threshold reached; no current bead id available, using run-level thread ${fallbackThread}`;
  return { threadId: fallbackThread, reason };
}

function isSafeThreadId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function sanitizeThreadPart(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "implementation-run";
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
