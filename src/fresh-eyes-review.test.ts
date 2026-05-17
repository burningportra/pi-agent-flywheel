import { describe, expect, it } from "vitest";
import {
  FRESH_EYES_REVIEW_LAUNCH_AFTER_COMMITS,
  FRESH_EYES_REVIEW_POLL_INTERVAL_MS,
  buildFreshEyesReviewPrompt,
  createFreshEyesReviewState,
  decideFreshEyesReviewLaunch,
  defaultFreshEyesReviewConfig,
  launchFreshEyesReview,
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
