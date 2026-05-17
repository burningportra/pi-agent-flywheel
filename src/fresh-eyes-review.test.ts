import { describe, expect, it } from "vitest";
import {
  FRESH_EYES_REVIEW_LAUNCH_AFTER_COMMITS,
  FRESH_EYES_REVIEW_POLL_INTERVAL_MS,
  appendFreshEyesReviewToBead,
  buildFreshEyesAppendKey,
  buildFreshEyesReviewPrompt,
  findExistingFreshEyesEntry,
  renderFreshEyesReviewBlock,
  createFreshEyesReviewState,
  decideFreshEyesReviewLaunch,
  defaultFreshEyesReviewConfig,
  degradeFreshEyesMonitorState,
  initializeFreshEyesMonitorState,
  launchFreshEyesReview,
  runFreshEyesMonitorTick,
  shouldPollFreshEyesReview,
} from "./fresh-eyes-review.js";

const baselineState = createFreshEyesReviewState({
  baselineRef: "abc1234",
  baselineCommitCount: 10,
  currentBeadId: "pi-1h3m",
});

describe("defaultFreshEyesReviewConfig", () => {
  it("uses the requested 5-commit and 7-minute defaults", () => {
    expect(defaultFreshEyesReviewConfig()).toEqual({
      enabled: true,
      launchAfterCommits: 5,
      pollIntervalMs: 420000,
      coordination: "agent-mail",
      outputMode: "append-current-bead",
      reviewScope: "full",
    });
    expect(FRESH_EYES_REVIEW_LAUNCH_AFTER_COMMITS).toBe(5);
    expect(FRESH_EYES_REVIEW_POLL_INTERVAL_MS).toBe(7 * 60 * 1000);
  });
});

describe("createFreshEyesReviewState", () => {
  it("models baseline, commit count, current bead, and an unlaunched state", () => {
    expect(baselineState).toEqual({
      baselineRef: "abc1234",
      baselineCommitCount: 10,
      currentBeadId: "pi-1h3m",
      launched: false,
    });
  });

  it("omits blank current bead ids", () => {
    expect(createFreshEyesReviewState({ baselineRef: "abc1234", currentBeadId: "   " })).toEqual({
      baselineRef: "abc1234",
      launched: false,
    });
  });
});

describe("fresh-eyes monitor integration helpers", () => {
  it("initializes a serializable baseline and preserves it on resume", () => {
    const initial = initializeFreshEyesMonitorState({
      baselineRef: "abc1234",
      baselineCommitCount: 10,
      currentBeadId: "pi-1h3m",
    });
    const resumed = initializeFreshEyesMonitorState({
      existing: initial,
      baselineRef: "should-not-replace",
      baselineCommitCount: 99,
      currentBeadId: "pi-next",
    });

    expect(initial).toMatchObject({
      enabled: true,
      baselineRef: "abc1234",
      baselineCommitCount: 10,
      currentBeadId: "pi-1h3m",
      launched: false,
      lastStatus: "initialized",
    });
    expect(JSON.parse(JSON.stringify(initial))).toEqual(initial);
    expect(resumed.baselineRef).toBe("abc1234");
    expect(resumed.baselineCommitCount).toBe(10);
    expect(resumed.currentBeadId).toBe("pi-next");
  });

  it("enforces the explicit 7-minute cadence", () => {
    const state = initializeFreshEyesMonitorState({ baselineRef: "abc1234", baselineCommitCount: 10 });
    expect(shouldPollFreshEyesReview(state, "2026-05-17T17:00:00.000Z").shouldPoll).toBe(true);
    expect(
      shouldPollFreshEyesReview(
        { ...state, lastCheckedAt: "2026-05-17T17:00:00.000Z" },
        "2026-05-17T17:06:59.000Z"
      )
    ).toMatchObject({ shouldPoll: false, elapsedMs: 419000 });
    expect(
      shouldPollFreshEyesReview(
        { ...state, lastCheckedAt: "2026-05-17T17:00:00.000Z" },
        "2026-05-17T17:07:00.000Z"
      ).shouldPoll
    ).toBe(true);
  });

  it("records below-threshold polling without launching", async () => {
    const monitor = initializeFreshEyesMonitorState({ baselineRef: "abc1234", baselineCommitCount: 10, currentBeadId: "pi-1h3m" });
    const result = await runFreshEyesMonitorTick({
      monitor,
      currentHeadRef: "def5678",
      currentCommitCount: 14,
      currentBeadId: "pi-1h3m",
      nowIso: "2026-05-17T17:07:00.000Z",
      launch: async (options) => decideFreshEyesReviewLaunch(options),
    });

    expect(result.polled).toBe(true);
    expect(result.commitsSinceBaseline).toBe(4);
    expect(result.status).toBe("waiting");
    expect(result.nextState.launched).toBe(false);
    expect(result.nextState.lastCheckedAt).toBe("2026-05-17T17:07:00.000Z");
  });

  it("launches once when the first eligible poll observes more than five commits", async () => {
    const monitor = initializeFreshEyesMonitorState({ baselineRef: "abc1234", baselineCommitCount: 10, currentBeadId: "pi-1h3m" });
    const first = await runFreshEyesMonitorTick({
      monitor,
      currentHeadRef: "def5678",
      currentCommitCount: 18,
      currentBeadId: "pi-1h3m",
      nowIso: "2026-05-17T17:07:00.000Z",
      launch: async (options) => ({
        launched: true,
        status: "launched",
        reason: "fake launched",
        commitsSinceBaseline: options.commitsSinceBaseline,
        threadId: options.state.currentBeadId,
        reviewerAgentName: "VioletLantern",
        launchedAt: options.nowIso,
        launchedForHead: options.headRef,
        nextState: {
          ...options.state,
          launched: true,
          launchedAt: options.nowIso,
          launchedForHead: options.headRef,
          threadId: options.state.currentBeadId,
          reviewerAgentName: "VioletLantern",
        },
      }),
    });
    const second = await runFreshEyesMonitorTick({
      monitor: first.nextState,
      currentHeadRef: "fedcba9",
      currentCommitCount: 25,
      currentBeadId: "pi-1h3m",
      nowIso: "2026-05-17T17:14:00.000Z",
      launch: async (options) => decideFreshEyesReviewLaunch(options),
    });

    expect(first.status).toBe("launched");
    expect(first.commitsSinceBaseline).toBe(8);
    expect(first.nextState.launched).toBe(true);
    expect(first.nextState.reviewerAgentName).toBe("VioletLantern");
    expect(second.status).toBe("waiting");
    expect(second.launchResult?.launched).toBe(false);
    expect(second.reason).toBe("fresh-eyes review already launched");
  });

  it("stores degraded launch outcomes without marking launched", async () => {
    const monitor = initializeFreshEyesMonitorState({ baselineRef: "abc1234", baselineCommitCount: 10, currentBeadId: "pi-1h3m" });
    const result = await runFreshEyesMonitorTick({
      monitor,
      currentHeadRef: "def5678",
      currentCommitCount: 15,
      currentBeadId: "pi-1h3m",
      nowIso: "2026-05-17T17:07:00.000Z",
      launch: async (options) => ({
        launched: false,
        status: "degraded",
        reason: "Agent Mail offline",
        warning: "Agent Mail offline",
        commitsSinceBaseline: options.commitsSinceBaseline,
        nextState: options.state,
      }),
    });

    expect(result.status).toBe("degraded");
    expect(result.nextState.launched).toBe(false);
    expect(result.nextState.lastStatusText).toBe("Agent Mail offline");
  });

  it("captures git lookup degradation as serializable monitor state", () => {
    const monitor = initializeFreshEyesMonitorState({ baselineRef: "abc1234", baselineCommitCount: 10 });
    const degraded = degradeFreshEyesMonitorState(monitor, "2026-05-17T17:07:00.000Z", "git rev-list failed");

    expect(degraded).toMatchObject({
      lastCheckedAt: "2026-05-17T17:07:00.000Z",
      lastStatus: "degraded",
      lastStatusText: "git rev-list failed",
    });
  });
});

describe("decideFreshEyesReviewLaunch", () => {
  it("does not launch below the commit threshold", () => {
    const result = decideFreshEyesReviewLaunch({
      state: baselineState,
      commitsSinceBaseline: 4,
      headRef: "def5678",
    });

    expect(result.launched).toBe(false);
    expect(result.commitsSinceBaseline).toBe(4);
    expect(result.reason).toContain("waiting for 5 commits");
    expect(result.nextState).toBe(baselineState);
  });

  it("launches at the commit threshold", () => {
    const result = decideFreshEyesReviewLaunch({
      state: baselineState,
      commitsSinceBaseline: 5,
      headRef: "def5678",
      nowIso: "2026-05-17T17:00:00.000Z",
    });

    expect(result.launched).toBe(true);
    expect(result.commitsSinceBaseline).toBe(5);
    expect(result.reason).toContain("threshold reached");
    expect(result.nextState).toEqual({
      ...baselineState,
      launched: true,
      launchedAt: "2026-05-17T17:00:00.000Z",
      launchedForHead: "def5678",
    });
  });

  it("launches above the commit threshold", () => {
    const result = decideFreshEyesReviewLaunch({
      state: baselineState,
      commitsSinceBaseline: 8,
      headRef: "fedcba9",
    });

    expect(result.launched).toBe(true);
    expect(result.commitsSinceBaseline).toBe(8);
    expect(result.nextState.launched).toBe(true);
    expect(result.nextState.launchedForHead).toBe("fedcba9");
  });

  it("does not launch when already launched", () => {
    const launchedState = {
      ...baselineState,
      launched: true,
      launchedAt: "2026-05-17T17:00:00.000Z",
      launchedForHead: "def5678",
    };

    const result = decideFreshEyesReviewLaunch({
      state: launchedState,
      commitsSinceBaseline: 20,
      headRef: "fedcba9",
    });

    expect(result.launched).toBe(false);
    expect(result.reason).toBe("fresh-eyes review already launched");
    expect(result.nextState).toBe(launchedState);
  });

  it("does not launch when disabled", () => {
    const result = decideFreshEyesReviewLaunch({
      state: baselineState,
      commitsSinceBaseline: 10,
      config: { enabled: false },
    });

    expect(result.launched).toBe(false);
    expect(result.reason).toBe("fresh-eyes review is disabled");
    expect(result.nextState).toBe(baselineState);
  });

  it("normalizes fractional or negative commit counts deterministically", () => {
    expect(
      decideFreshEyesReviewLaunch({ state: baselineState, commitsSinceBaseline: -1 }).commitsSinceBaseline
    ).toBe(0);
    expect(
      decideFreshEyesReviewLaunch({ state: baselineState, commitsSinceBaseline: 5.9 }).commitsSinceBaseline
    ).toBe(5);
  });
});

describe("launchFreshEyesReview", () => {
  it("launches through Agent Mail on the current bead thread", async () => {
    const calls: string[] = [];
    const agentMail = {
      prepareThread: async ({ threadId }: { threadId: string }) => {
        calls.push(`prepare:${threadId}`);
        return { ok: true };
      },
      sendMessage: async ({ threadId, body }: { threadId: string; body: string }) => {
        calls.push(`message:${threadId}`);
        expect(body).toContain("full fresh-eyes code review");
        expect(body).toContain("thread pi-1h3m");
        return { ok: true };
      },
    };
    const reviewer = {
      launch: async ({ threadId, prompt }: { threadId: string; prompt: string }) => {
        calls.push(`subagent:${threadId}`);
        expect(prompt).toContain("Coordinate through Agent Mail");
        return { agentName: "VioletLantern" };
      },
    };

    const result = await launchFreshEyesReview({
      state: baselineState,
      commitsSinceBaseline: 5,
      headRef: "def5678",
      nowIso: "2026-05-17T17:00:00.000Z",
      cwd: "/repo",
      agentMail,
      reviewer,
    });

    expect(calls).toEqual(["prepare:pi-1h3m", "message:pi-1h3m", "subagent:pi-1h3m"]);
    expect(result).toMatchObject({
      launched: true,
      status: "launched",
      threadId: "pi-1h3m",
      reviewerAgentName: "VioletLantern",
      launchedAt: "2026-05-17T17:00:00.000Z",
      launchedForHead: "def5678",
    });
    expect(result.nextState).toMatchObject({
      launched: true,
      threadId: "pi-1h3m",
      reviewerAgentName: "VioletLantern",
      launchedForHead: "def5678",
    });
  });

  it("falls back to a run-level thread when current bead context is missing", async () => {
    const state = createFreshEyesReviewState({ baselineRef: "abc1234" });
    let messageBody = "";
    const result = await launchFreshEyesReview({
      state,
      commitsSinceBaseline: 5,
      headRef: "def5678",
      nowIso: "2026-05-17T17:00:00.000Z",
      runThreadId: "run-2026-05-17",
      agentMail: {
        prepareThread: async () => ({ ok: true }),
        sendMessage: async ({ body }) => {
          messageBody = body;
          return { ok: true };
        },
      },
      reviewer: { launch: async () => ({ agentName: "BlueCastle" }) },
    });

    expect(result.status).toBe("launched");
    expect(result.threadId).toBe("run-2026-05-17");
    expect(result.reason).toContain("no current bead id available");
    expect(messageBody).toContain("using run-level thread run-2026-05-17");
  });

  it("falls back to a run-level thread when current bead id is malformed", async () => {
    const state = createFreshEyesReviewState({ baselineRef: "abc1234", currentBeadId: "bad bead id" });
    const result = await launchFreshEyesReview({
      state,
      commitsSinceBaseline: 5,
      headRef: "def5678",
      nowIso: "2026-05-17T17:00:00.000Z",
      runThreadId: "run-safe",
      agentMail: { prepareThread: async () => ({ ok: true }), sendMessage: async () => ({ ok: true }) },
      reviewer: { launch: async () => ({ agentName: "BlueCastle" }) },
    });

    expect(result.status).toBe("launched");
    expect(result.threadId).toBe("run-safe");
    expect(result.reason).toContain("not safe for Agent Mail");
    expect(result.nextState.currentBeadId).toBe("bad bead id");
  });

  it("returns degraded without throwing when Agent Mail is unavailable", async () => {
    const result = await launchFreshEyesReview({
      state: baselineState,
      commitsSinceBaseline: 5,
      headRef: "def5678",
      nowIso: "2026-05-17T17:00:00.000Z",
      reviewer: { launch: async () => ({ agentName: "BlueCastle" }) },
    });

    expect(result).toMatchObject({
      launched: false,
      status: "degraded",
      warning: "Agent Mail boundary unavailable",
    });
    expect(result.nextState).toBe(baselineState);
  });

  it("does not claim launch when Agent Mail fails", async () => {
    const result = await launchFreshEyesReview({
      state: baselineState,
      commitsSinceBaseline: 5,
      headRef: "def5678",
      nowIso: "2026-05-17T17:00:00.000Z",
      agentMail: {
        prepareThread: async () => ({ ok: true }),
        sendMessage: async () => ({ ok: false, warning: "Agent Mail offline" }),
      },
      reviewer: { launch: async () => ({ agentName: "BlueCastle" }) },
    });

    expect(result.launched).toBe(false);
    expect(result.status).toBe("degraded");
    expect(result.warning).toBe("Agent Mail offline");
    expect(result.nextState).toBe(baselineState);
  });

  it("does not claim launch when subagent launch fails after thread resolution", async () => {
    const result = await launchFreshEyesReview({
      state: baselineState,
      commitsSinceBaseline: 5,
      headRef: "def5678",
      nowIso: "2026-05-17T17:00:00.000Z",
      agentMail: { prepareThread: async () => ({ ok: true }), sendMessage: async () => ({ ok: true }) },
      reviewer: { launch: async () => ({ ok: false, warning: "subagent rejected launch" }) },
    });

    expect(result.launched).toBe(false);
    expect(result.status).toBe("degraded");
    expect(result.threadId).toBe("pi-1h3m");
    expect(result.warning).toBe("subagent rejected launch");
    expect(result.nextState).toBe(baselineState);
  });

  it("skips launch below threshold without invoking boundaries", async () => {
    const result = await launchFreshEyesReview({
      state: baselineState,
      commitsSinceBaseline: 4,
      headRef: "def5678",
      nowIso: "2026-05-17T17:00:00.000Z",
      agentMail: {
        prepareThread: async () => { throw new Error("should not prepare"); },
        sendMessage: async () => { throw new Error("should not message"); },
      },
      reviewer: { launch: async () => { throw new Error("should not launch"); } },
    });

    expect(result.launched).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("waiting for 5 commits");
  });
});

describe("fresh-eyes bead append helpers", () => {
  const launchedState = {
    ...baselineState,
    launched: true,
    launchedAt: "2026-05-17T17:00:00.000Z",
    launchedForHead: "def5678",
    threadId: "pi-1h3m",
    reviewerAgentName: "VioletLantern",
  };

  it("builds stable append keys and detects existing entries", () => {
    const key = buildFreshEyesAppendKey({
      threadId: "pi-1h3m",
      launchedForHead: "DEF 5678",
      reviewerAgentName: "Violet Lantern",
    });

    expect(key).toBe("pi-1h3m|def-5678|violet-lantern");
    expect(findExistingFreshEyesEntry(`before\n<!-- fresh-eyes-review:${key} -->\nafter`, key)).toBe(true);
  });

  it("renders bounded findings with metadata and actionable bullets", () => {
    const block = renderFreshEyesReviewBlock({
      threadId: "pi-1h3m",
      reviewerAgentName: "VioletLantern",
      launchedForHead: "def5678",
      timestampIso: "2026-05-17T17:10:00.000Z",
      findings: ["src/foo.ts misses an edge case"],
      suggestedActions: ["Add a regression test"],
    });

    expect(block).toContain("<!-- fresh-eyes-review:pi-1h3m|def5678|violetlantern -->");
    expect(block).toContain("Reviewer: VioletLantern");
    expect(block).toContain("Agent Mail thread: pi-1h3m");
    expect(block).toContain("Triggering head: def5678");
    expect(block).toContain("- src/foo.ts misses an edge case");
    expect(block).toContain("- Add a regression test");
  });

  it("renders short clean-pass notes when there are no findings", () => {
    const block = renderFreshEyesReviewBlock({
      threadId: "pi-1h3m",
      reviewerAgentName: "VioletLantern",
      launchedForHead: "def5678",
      timestampIso: "2026-05-17T17:10:00.000Z",
      findings: [],
      cleanPass: true,
    });

    expect(block).toContain("Clean pass: no actionable fresh-eyes findings were reported.");
    expect(block).not.toContain("Suggested actions:");
    expect(block).not.toContain("TODO");
  });

  it("appends findings to the current bead and suppresses duplicates", async () => {
    let description = "Existing bead body without trailing newline";
    const beads = {
      getBeadById: async (beadId: string) => ({ id: beadId, description }),
      updateBeadDescription: async (_beadId: string, nextDescription: string) => {
        description = nextDescription;
        return { ok: true };
      },
    };

    const first = await appendFreshEyesReviewToBead({
      state: launchedState,
      timestampIso: "2026-05-17T17:10:00.000Z",
      findings: ["src/foo.ts needs bounds checking"],
      suggestedActions: ["Add bounds-check regression coverage"],
      beads,
    });
    const duplicate = await appendFreshEyesReviewToBead({
      state: launchedState,
      timestampIso: "2026-05-17T17:10:00.000Z",
      findings: ["src/foo.ts needs bounds checking"],
      beads,
    });

    expect(first.status).toBe("appended");
    expect(first.appended).toBe(true);
    expect(description).toContain("## Fresh-Eyes Review Findings");
    expect(description.match(/fresh-eyes-review:pi-1h3m\|def5678\|violetlantern/g)).toHaveLength(1);
    expect(duplicate.status).toBe("skipped");
    expect(duplicate.appended).toBe(false);
    expect(description.match(/fresh-eyes-review:pi-1h3m\|def5678\|violetlantern/g)).toHaveLength(1);
  });

  it("keeps distinct entries for different heads under an existing heading", async () => {
    let description = "Body\n\n## Fresh-Eyes Review Findings\n\nLegacy note with malformed marker <!-- fresh-eyes-review -->";
    const beads = {
      getBeadById: async (beadId: string) => ({ id: beadId, description }),
      updateBeadDescription: async (_beadId: string, nextDescription: string) => {
        description = nextDescription;
        return true;
      },
    };

    await appendFreshEyesReviewToBead({
      state: launchedState,
      timestampIso: "2026-05-17T17:10:00.000Z",
      findings: ["First head finding"],
      beads,
    });
    await appendFreshEyesReviewToBead({
      state: { ...launchedState, launchedForHead: "fedcba9" },
      timestampIso: "2026-05-17T17:20:00.000Z",
      findings: ["Second head finding"],
      beads,
    });

    expect(description.match(/## Fresh-Eyes Review Findings/g)).toHaveLength(1);
    expect(description).toContain("First head finding");
    expect(description).toContain("Second head finding");
    expect(description).toContain("fedcba9");
  });

  it("returns a warning without mutating when current bead is missing", async () => {
    let touched = false;
    const result = await appendFreshEyesReviewToBead({
      state: { ...launchedState, currentBeadId: undefined },
      timestampIso: "2026-05-17T17:10:00.000Z",
      findings: ["Should not append"],
      beads: {
        getBeadById: async () => {
          touched = true;
          return null;
        },
        updateBeadDescription: async () => {
          touched = true;
        },
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.warning).toBe("missing current bead id");
    expect(touched).toBe(false);
  });

  it("degrades non-fatally when bead update fails", async () => {
    const result = await appendFreshEyesReviewToBead({
      state: launchedState,
      timestampIso: "2026-05-17T17:10:00.000Z",
      findings: ["Finding"],
      beads: {
        getBeadById: async (beadId: string) => ({ id: beadId, description: "Body" }),
        updateBeadDescription: async () => ({ ok: false, warning: "br update failed" }),
      },
    });

    expect(result.status).toBe("degraded");
    expect(result.appended).toBe(false);
    expect(result.warning).toBe("br update failed");
  });
});

describe("buildFreshEyesReviewPrompt", () => {
  it("asks for a full fresh-eyes review and Agent Mail coordination", () => {
    const prompt = buildFreshEyesReviewPrompt({
      baselineRef: "abc1234",
      headRef: "def5678",
      commitsSinceBaseline: 5,
      currentBeadId: "pi-1h3m",
      threadId: "pi-1h3m",
      repoRoot: "/repo",
    });

    expect(prompt).toContain("full fresh-eyes code review");
    expect(prompt).toContain("Agent Mail");
    expect(prompt).toContain("thread pi-1h3m");
    expect(prompt).toContain("Current bead: pi-1h3m");
    expect(prompt).toContain("Baseline ref before implementation progress: abc1234");
    expect(prompt).toContain("Current head ref: def5678");
    expect(prompt).toContain("Commits since baseline: 5");
    expect(prompt).toContain("appended to the current bead");
    expect(prompt).toContain("Do not make code changes unless explicitly asked");
  });

  it("handles unknown current bead without inventing a fake Agent Mail thread", () => {
    const prompt = buildFreshEyesReviewPrompt({
      baselineRef: "abc1234",
      headRef: "def5678",
      commitsSinceBaseline: 5,
    });

    expect(prompt).toContain("Current bead: unknown current bead");
    expect(prompt).toContain("Coordination channel: Agent Mail\n");
    expect(prompt).not.toContain("thread unknown current bead");
    expect(prompt).toContain("Coordinate through Agent Mail");
  });
});
