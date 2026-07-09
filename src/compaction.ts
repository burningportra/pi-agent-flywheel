import type {
  AgentFlywheelCompactionContext,
  CompactionEventName,
  CompactionReason,
  CompactionResumeGuidance,
  CompactionWorkflowSnapshot,
  NormalizedCompactionReason,
  RawCompactionEventPayload,
} from "./types.js";

export interface NormalizeCompactionEventOptions {
  eventName?: string;
  timestamp?: string | Date;
  workflow?: Partial<CompactionWorkflowSnapshot>;
}

const DEFAULT_EVENT_NAME = "unknown";

const REASON_ALIASES: Record<string, CompactionReason> = {
  manual: "manual",
  user: "manual",
  user_request: "manual",
  user_requested: "manual",
  threshold: "threshold",
  auto: "threshold",
  automatic: "threshold",
  auto_threshold: "threshold",
  context_threshold: "threshold",
  threshold_reached: "threshold",
  token_threshold: "threshold",
  overflow_retry: "overflow_retry",
  overflowed_retry: "overflow_retry",
  context_overflow_retry: "overflow_retry",
  retry_after_overflow: "overflow_retry",
};

export function normalizeCompactionReason(value: unknown): NormalizedCompactionReason {
  const rawReason = normalizeString(value);
  if (!rawReason) return { reason: "unknown" };

  const canonical = canonicalizeReason(rawReason);
  const known = REASON_ALIASES[canonical];
  if (known) {
    return canonical === known && rawReason === known ? { reason: known } : { reason: known, rawReason };
  }

  return { reason: "unknown", rawReason };
}

export function normalizeCompactionEvent(
  payload: RawCompactionEventPayload | Record<string, unknown> | unknown,
  options: NormalizeCompactionEventOptions = {}
): AgentFlywheelCompactionContext {
  const source = isRecord(payload) ? payload : {};
  const reason = normalizeCompactionReason(source.reason);
  const workflow = normalizeWorkflowSnapshot(source, options.workflow);
  const timestamp = normalizeTimestamp(source.timestamp) ?? normalizeTimestamp(source.observedAt) ?? normalizeTimestamp(options.timestamp);
  const willRetry = typeof source.willRetry === "boolean" ? source.willRetry : undefined;

  return stripUndefined({
    eventName: normalizeEventName(source.eventName) ?? normalizeEventName(source.event) ?? normalizeEventName(source.name) ?? normalizeEventName(options.eventName) ?? DEFAULT_EVENT_NAME,
    reason: reason.reason,
    rawReason: reason.rawReason,
    willRetry,
    timestamp,
    workflow,
  });
}

export function buildCompactionResumeGuidance(context: AgentFlywheelCompactionContext): CompactionResumeGuidance {
  const base = baseGuidanceForReason(context);
  const warnings = [...base.warnings];
  const nextSteps = [...base.nextSteps];
  const duplicateSideEffectRisk = context.willRetry === true || context.reason === "overflow_retry";

  if (context.willRetry === true) {
    warnings.unshift("Pi may retry the interrupted request; agents should avoid duplicate side effects until workflow and file state are inspected.");
    nextSteps.unshift("Inspect workflow status and the worktree before repeating any command that can mutate files, tasks, network state, or external systems.");
  } else if (context.willRetry === undefined) {
    warnings.push("Pi did not report willRetry; do not treat the missing field as false.");
  }

  return {
    reason: context.reason,
    title: base.title,
    summary: base.summary,
    nextSteps,
    warnings,
    duplicateSideEffectRisk,
  };
}

export function formatCompactionStatus(context: AgentFlywheelCompactionContext): string {
  const parts = [
    `event=${formatStatusValue(context.eventName)}`,
    `reason=${context.reason}`,
    context.rawReason ? `rawReason=${formatStatusValue(context.rawReason)}` : undefined,
    context.willRetry === undefined ? "willRetry=unreported" : `willRetry=${context.willRetry}`,
    context.timestamp ? `timestamp=${formatStatusValue(context.timestamp)}` : undefined,
    context.workflow?.phase ? `phase=${formatStatusValue(context.workflow.phase)}` : undefined,
    context.workflow?.selectedBeadId ? `bead=${formatStatusValue(context.workflow.selectedBeadId)}` : undefined,
    context.workflow?.goal ? `goal=${formatStatusValue(context.workflow.goal)}` : undefined,
    context.workflow?.beadSummary ? `beadSummary=${formatStatusValue(context.workflow.beadSummary)}` : undefined,
  ].filter((part): part is string => Boolean(part));

  return `Compaction status: ${parts.join(" ")}`;
}

function baseGuidanceForReason(context: AgentFlywheelCompactionContext): Omit<CompactionResumeGuidance, "reason" | "duplicateSideEffectRisk"> {
  switch (context.reason) {
    case "manual":
      return {
        title: "Manual compaction",
        summary: "A user or operator requested compaction. Resume from saved workflow status instead of replaying prior transcript context.",
        nextSteps: [
          "Re-read repository guidance and the current AgentFlywheel status.",
          "Continue only the confirmed bead or user task.",
          "Inspect the worktree before making more changes.",
        ],
        warnings: [],
      };
    case "threshold":
      return {
        title: "Automatic threshold compaction",
        summary: "Pi compacted because the session reached an automatic context threshold. Rehydrate repo rules, bead state, and recent file state before continuing.",
        nextSteps: [
          "Refresh AGENTS.md, bead status, and the latest worktree diff.",
          "Prefer the saved next action from AgentFlywheel status over transcript memory.",
          "Keep the next edit narrow until current state is confirmed.",
        ],
        warnings: [],
      };
    case "overflow_retry":
      return {
        title: "Overflow retry compaction",
        summary: "Pi compacted during overflow recovery. Treat the interrupted request as potentially retried until retry metadata and file state are checked.",
        nextSteps: [
          "Check AgentFlywheel status, bead state, and file diffs before continuing.",
          "Avoid repeating side-effecting commands until the interrupted action is understood.",
          "Record the resumed state before launching additional agents or tools.",
        ],
        warnings: ["Overflow recovery can leave uncertainty about which side effects completed before compaction."],
      };
    case "unknown": {
      const reasonDetail = context.rawReason
        ? `Pi reported an unrecognized compaction reason '${context.rawReason}'.`
        : "Pi did not report compaction reason metadata.";
      return {
        title: "Unknown compaction",
        summary: `${reasonDetail} Resume conservatively from durable workflow and file state.`,
        nextSteps: [
          "Read persisted workflow status and bead state before acting.",
          "Inspect the worktree and recent commits for already-completed work.",
          "Avoid assuming whether the interrupted request will be retried.",
        ],
        warnings: ["Unknown compaction metadata should be treated as incomplete, not benign."],
      };
    }
  }
}

function normalizeWorkflowSnapshot(
  source: Record<string, unknown>,
  override: Partial<CompactionWorkflowSnapshot> | undefined
): CompactionWorkflowSnapshot | undefined {
  const nested = firstRecord(source.workflowSnapshot, source.workflow);
  const snapshot = stripUndefined({
    phase: normalizeString(nested?.phase) ?? normalizeString(source.phase) ?? normalizeString(override?.phase),
    goal: normalizeString(nested?.goal) ?? normalizeString(nested?.selectedGoal) ?? normalizeString(source.goal) ?? normalizeString(source.selectedGoal) ?? normalizeString(override?.goal),
    selectedBeadId: normalizeString(nested?.selectedBeadId) ?? normalizeString(nested?.currentBeadId) ?? normalizeString(source.selectedBeadId) ?? normalizeString(source.currentBeadId) ?? normalizeString(override?.selectedBeadId),
    beadSummary: normalizeString(nested?.beadSummary) ?? normalizeString(nested?.currentBeadSummary) ?? normalizeString(source.beadSummary) ?? normalizeString(source.currentBeadSummary) ?? normalizeString(override?.beadSummary),
  });

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function canonicalizeReason(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEventName(value: unknown): CompactionEventName | undefined {
  return normalizeString(value) as CompactionEventName | undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return normalizeString(value);
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function formatStatusValue(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return /^[a-zA-Z0-9_.:/-]+$/.test(compact) ? compact : JSON.stringify(compact);
}
