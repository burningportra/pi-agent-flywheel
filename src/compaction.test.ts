import { describe, expect, it } from "vitest";
import {
  buildCompactionResumeGuidance,
  formatCompactionStatus,
  normalizeCompactionEvent,
  normalizeCompactionReason,
  recordCompactionContext,
} from "./compaction.js";
import type {
  AgentFlywheelCompactionContext,
  AgentFlywheelCompactionState,
  CompactionResumeGuidance,
  RawCompactionEventPayload,
} from "./types.js";

describe("normalizeCompactionReason", () => {
  it("normalizes known manual, threshold, and overflow retry reasons", () => {
    expect(normalizeCompactionReason("manual")).toEqual({ reason: "manual" });
    expect(normalizeCompactionReason("auto")).toEqual({ reason: "threshold", rawReason: "auto" });
    expect(normalizeCompactionReason("context-threshold")).toEqual({ reason: "threshold", rawReason: "context-threshold" });
    expect(normalizeCompactionReason("overflow retry")).toEqual({ reason: "overflow_retry", rawReason: "overflow retry" });
  });

  it("normalizes missing or blank reasons to unknown without rawReason", () => {
    expect(normalizeCompactionReason(undefined)).toEqual({ reason: "unknown" });
    expect(normalizeCompactionReason(null)).toEqual({ reason: "unknown" });
    expect(normalizeCompactionReason("   ")).toEqual({ reason: "unknown" });
  });

  it("preserves future reason strings while normalizing safely", () => {
    expect(normalizeCompactionReason("planner_rewrite")).toEqual({
      reason: "unknown",
      rawReason: "planner_rewrite",
    });
    expect(normalizeCompactionReason("threshold_policy_v2")).toEqual({
      reason: "unknown",
      rawReason: "threshold_policy_v2",
    });
    expect(normalizeCompactionReason("overflow_retry_after_tool_call")).toEqual({
      reason: "unknown",
      rawReason: "overflow_retry_after_tool_call",
    });
  });
});

describe("normalizeCompactionEvent", () => {
  it("keeps missing willRetry undefined for older Pi payloads", () => {
    const context = normalizeCompactionEvent({
      eventName: "session_compact",
      reason: "manual",
      timestamp: "2026-07-09T12:00:00.000Z",
    });

    expect(context).toMatchObject({
      eventName: "session_compact",
      reason: "manual",
      timestamp: "2026-07-09T12:00:00.000Z",
    });
    expect("willRetry" in context).toBe(false);
    expect(context.willRetry).toBeUndefined();
  });

  it("preserves only boolean willRetry values", () => {
    expect(normalizeCompactionEvent({ event: "session_compact", reason: "threshold", willRetry: false }).willRetry).toBe(false);
    expect(normalizeCompactionEvent({ event: "session_compact", reason: "threshold", willRetry: true }).willRetry).toBe(true);
    expect(normalizeCompactionEvent({ event: "session_compact", reason: "threshold", willRetry: "false" }).willRetry).toBeUndefined();
  });

  it("normalizes future reasons into rawReason and preserves workflow snapshot fields", () => {
    const payload: RawCompactionEventPayload = {
      name: "session_before_compact",
      reason: "model_context_shift",
      willRetry: true,
      observedAt: "2026-07-09T12:01:00.000Z",
      workflowSnapshot: {
        phase: "implementing",
        selectedGoal: "Add compaction awareness",
        currentBeadId: "pi-oied",
        currentBeadSummary: "Add compaction context model and guidance helpers",
      },
    };

    expect(normalizeCompactionEvent(payload)).toEqual({
      eventName: "session_before_compact",
      reason: "unknown",
      rawReason: "model_context_shift",
      willRetry: true,
      timestamp: "2026-07-09T12:01:00.000Z",
      workflow: {
        phase: "implementing",
        goal: "Add compaction awareness",
        selectedBeadId: "pi-oied",
        beadSummary: "Add compaction context model and guidance helpers",
      },
    });
  });

  it("uses explicit options as safe fallbacks without requiring a live Pi runtime", () => {
    expect(normalizeCompactionEvent({}, {
      eventName: "session_compact",
      timestamp: new Date("2026-07-09T12:02:00.000Z"),
      workflow: { phase: "reviewing", selectedBeadId: "pi-next" },
    })).toEqual({
      eventName: "session_compact",
      reason: "unknown",
      timestamp: "2026-07-09T12:02:00.000Z",
      workflow: {
        phase: "reviewing",
        selectedBeadId: "pi-next",
      },
    });
  });

  it("does not let fallback workflow options overwrite event snapshot metadata", () => {
    expect(normalizeCompactionEvent({
      eventName: "session_compact",
      reason: "manual",
      workflowSnapshot: {
        phase: "implementing",
        selectedBeadId: "pi-oied",
      },
    }, {
      workflow: {
        phase: "reviewing",
        selectedBeadId: "fallback-bead",
        beadSummary: "fallback summary",
      },
    })).toMatchObject({
      workflow: {
        phase: "implementing",
        selectedBeadId: "pi-oied",
        beadSummary: "fallback summary",
      },
    });
  });
});

describe("buildCompactionResumeGuidance", () => {
  function guidanceFor(reason: AgentFlywheelCompactionContext["reason"], overrides: Partial<AgentFlywheelCompactionContext> = {}): CompactionResumeGuidance {
    return buildCompactionResumeGuidance({
      eventName: "session_compact",
      reason,
      ...overrides,
    });
  }

  it("produces distinct manual, threshold, overflow retry, and unknown guidance", () => {
    const manual = guidanceFor("manual");
    const threshold = guidanceFor("threshold");
    const overflow = guidanceFor("overflow_retry");
    const unknown = guidanceFor("unknown", { rawReason: "future_reason" });

    expect(new Set([manual.title, threshold.title, overflow.title, unknown.title]).size).toBe(4);
    expect(manual.summary).toContain("requested compaction");
    expect(threshold.summary).toContain("automatic context threshold");
    expect(overflow.summary).toContain("overflow recovery");
    expect(unknown.summary).toContain("future_reason");
  });

  it("warns about duplicate side effects when Pi may retry the interrupted request", () => {
    const guidance = guidanceFor("threshold", { willRetry: true });

    expect(guidance.duplicateSideEffectRisk).toBe(true);
    expect(guidance.warnings.join("\n")).toContain("Pi may retry the interrupted request");
    expect(guidance.warnings.join("\n")).toContain("avoid duplicate side effects");
    expect(guidance.nextSteps[0]).toContain("before repeating any command");
  });

  it("does not imply that missing willRetry means false", () => {
    const guidance = guidanceFor("manual");

    expect(guidance.duplicateSideEffectRisk).toBe(false);
    expect(guidance.warnings.join("\n")).toContain("do not treat the missing field as false");
  });

  it("marks overflow retry as side-effect risk even when retry metadata is absent", () => {
    const guidance = guidanceFor("overflow_retry");

    expect(guidance.duplicateSideEffectRisk).toBe(true);
    expect(guidance.warnings.join("\n")).toContain("Overflow recovery");
    expect(guidance.warnings.join("\n")).toContain("missing field");
  });
});

describe("formatCompactionStatus", () => {
  it("formats compact status without coercing missing willRetry to false", () => {
    const status = formatCompactionStatus({
      eventName: "session_compact",
      reason: "unknown",
      rawReason: "future reason",
      timestamp: "2026-07-09T12:03:00.000Z",
      workflow: {
        phase: "implementing",
        goal: "Add compaction awareness",
        selectedBeadId: "pi-oied",
      },
    });

    expect(status).toContain("event=session_compact");
    expect(status).toContain("reason=unknown");
    expect(status).toContain('rawReason="future reason"');
    expect(status).toContain("willRetry=unreported");
    expect(status).toContain("bead=pi-oied");
    expect(status).not.toContain("willRetry=false");
  });
});

describe("recordCompactionContext", () => {
  it("stores the latest context and keeps a bounded recent history", () => {
    const state: { compaction?: AgentFlywheelCompactionState } = {};

    recordCompactionContext(state, {
      eventName: "session_before_compact",
      reason: "manual",
      timestamp: "2026-07-09T12:00:00.000Z",
    }, 2);
    const second = recordCompactionContext(state, {
      eventName: "session_compact",
      reason: "threshold",
      timestamp: "2026-07-09T12:01:00.000Z",
    }, 2);
    const third = recordCompactionContext(state, {
      eventName: "session_compact",
      reason: "overflow_retry",
      willRetry: true,
      timestamp: "2026-07-09T12:02:00.000Z",
    }, 2);

    expect(second.recent?.map((event) => event.reason)).toEqual(["threshold", "manual"]);
    expect(third.latest.reason).toBe("overflow_retry");
    expect(third.recent?.map((event) => event.reason)).toEqual(["overflow_retry", "threshold"]);
  });
});
