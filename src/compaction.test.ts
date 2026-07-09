import { describe, expect, it, vi } from "vitest";
import {
  buildCompactionResumeGuidance,
  formatCompactionStatus,
  normalizeCompactionEvent,
  normalizeCompactionReason,
  recordCompactionContext,
  registerCompactionLifecycleHandlers,
} from "./compaction.js";
import { createInitialState } from "./types.js";
import type {
  AgentFlywheelCompactionContext,
  AgentFlywheelCompactionState,
  CompactionResumeGuidance,
  OrchestratorState,
  RawCompactionEventPayload,
} from "./types.js";

describe("normalizeCompactionReason", () => {
  it("normalizes known manual, threshold, and overflow retry reasons", () => {
    expect(normalizeCompactionReason("manual")).toEqual({ reason: "manual" });
    expect(normalizeCompactionReason("auto")).toEqual({ reason: "threshold", rawReason: "auto" });
    expect(normalizeCompactionReason("context-threshold")).toEqual({ reason: "threshold", rawReason: "context-threshold" });
    expect(normalizeCompactionReason("overflow")).toEqual({ reason: "overflow" });
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

  it("produces distinct manual, threshold, overflow, overflow retry, and unknown guidance", () => {
    const manual = guidanceFor("manual");
    const threshold = guidanceFor("threshold");
    const overflow = guidanceFor("overflow");
    const overflowRetry = guidanceFor("overflow_retry");
    const unknown = guidanceFor("unknown", { rawReason: "future_reason" });

    expect(new Set([manual.title, threshold.title, overflow.title, overflowRetry.title, unknown.title]).size).toBe(5);
    expect(manual.summary).toContain("requested compaction");
    expect(threshold.summary).toContain("automatic context threshold");
    expect(overflow.summary).toContain("context overflow handling");
    expect(overflowRetry.summary).toContain("overflow recovery");
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

describe("registerCompactionLifecycleHandlers", () => {
  function setupState(overrides: Partial<OrchestratorState> = {}) {
    const handlers = new Map<string, (event: unknown, ctx: { cwd: string }) => void | Promise<void>>();
    const pi = {
      on: vi.fn((event: string, handler: (event: unknown, ctx: { cwd: string }) => void | Promise<void>) => {
        handlers.set(event, handler);
      }),
    };
    const state: OrchestratorState = { ...createInitialState(), ...overrides };
    const persistState = vi.fn();
    const onCwd = vi.fn();
    const onError = vi.fn();

    registerCompactionLifecycleHandlers(pi, {
      getState: () => state,
      persistState,
      onCwd,
      onError,
      now: () => "2026-07-09T12:00:00.000Z",
      recentLimit: 2,
    });

    return { handlers, pi, state, persistState, onCwd, onError };
  }

  it("registers the supported Pi compaction lifecycle hooks", () => {
    const { handlers, pi } = setupState();

    expect(pi.on).toHaveBeenCalledWith("session_before_compact", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_compact", expect.any(Function));
    expect([...handlers.keys()]).toEqual(["session_before_compact", "session_compact"]);
  });

  it("no-ops when the installed Pi runtime does not expose lifecycle subscriptions", () => {
    const persistState = vi.fn();
    const onError = vi.fn();

    expect(() => registerCompactionLifecycleHandlers({}, {
      getState: () => createInitialState(),
      persistState,
      onError,
    })).not.toThrow();

    expect(persistState).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps startup non-fatal if an older Pi runtime rejects compaction lifecycle events", () => {
    const persistState = vi.fn();
    const onError = vi.fn();
    const unsupported = new Error("unknown event");

    expect(() => registerCompactionLifecycleHandlers({
      on: () => {
        throw unsupported;
      },
    }, {
      getState: () => createInitialState(),
      persistState,
      onError,
    })).not.toThrow();

    expect(persistState).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("session_before_compact", unsupported);
    expect(onError).toHaveBeenCalledWith("session_compact", unsupported);
  });

  it("records supported reason and willRetry payloads with a workflow snapshot without advancing phase", async () => {
    const { handlers, state, persistState, onCwd, onError } = setupState({
      phase: "implementing",
      selectedGoal: "Wire compaction lifecycle events",
      currentBeadId: "pi-s2k4",
      beadResults: {
        "pi-s2k4": {
          beadId: "pi-s2k4",
          status: "partial",
          summary: "Lifecycle handlers are being wired",
        },
      },
    });

    await handlers.get("session_before_compact")?.({
      type: "session_before_compact",
      reason: "overflow",
      willRetry: true,
    }, { cwd: "/repo" });

    expect(state.phase).toBe("implementing");
    expect(state.compaction?.latest).toEqual({
      eventName: "session_before_compact",
      reason: "overflow",
      willRetry: true,
      timestamp: "2026-07-09T12:00:00.000Z",
      workflow: {
        phase: "implementing",
        goal: "Wire compaction lifecycle events",
        selectedBeadId: "pi-s2k4",
        beadSummary: "Lifecycle handlers are being wired",
      },
    });
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(onCwd).toHaveBeenCalledWith("/repo");
    expect(onError).not.toHaveBeenCalled();
  });

  it("records empty older payloads as observed unknown compactions", async () => {
    const { handlers, state, persistState } = setupState({
      phase: "reviewing",
      currentBeadId: "pi-current",
    });

    await handlers.get("session_compact")?.({}, { cwd: "/repo" });

    expect(state.phase).toBe("reviewing");
    expect(state.compaction?.latest).toEqual({
      eventName: "session_compact",
      reason: "unknown",
      timestamp: "2026-07-09T12:00:00.000Z",
      workflow: {
        phase: "reviewing",
        selectedBeadId: "pi-current",
      },
    });
    expect(persistState).toHaveBeenCalledTimes(1);
  });

  it("normalizes future payloads and keeps the latest event plus bounded recent history", async () => {
    const { handlers, state } = setupState({ phase: "implementing" });

    await handlers.get("session_before_compact")?.({ reason: "manual" }, { cwd: "/repo" });
    await handlers.get("session_compact")?.({ reason: "future_reason", willRetry: false }, { cwd: "/repo" });

    expect(state.compaction?.latest).toMatchObject({
      eventName: "session_compact",
      reason: "unknown",
      rawReason: "future_reason",
      willRetry: false,
    });
    expect(state.compaction?.recent?.map((event) => event.eventName)).toEqual(["session_compact", "session_before_compact"]);
  });

  it("swallows recording failures so Pi compaction can continue", async () => {
    const handlers = new Map<string, (event: unknown, ctx: { cwd: string }) => void | Promise<void>>();
    const state = createInitialState();
    const onError = vi.fn();

    registerCompactionLifecycleHandlers({
      on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => void | Promise<void>) => {
        handlers.set(event, handler);
      },
    }, {
      getState: () => state,
      persistState: () => {
        throw new Error("session append failed");
      },
      onError,
    });

    expect(() => handlers.get("session_compact")?.({ reason: "manual" }, { cwd: "/repo" })).not.toThrow();
    expect(onError).toHaveBeenCalledWith("session_compact", expect.any(Error));
    expect(state.phase).toBe("idle");
  });
});
