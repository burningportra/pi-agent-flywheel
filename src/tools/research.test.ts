/**
 * Tests for the flywheel_research tool's loop behavior:
 * - Early abort when investigate fails with no proposal
 * - Does not claim a nonexistent artifact on failure
 * - Actionable error message propagated from runResearchPhase
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResearchPhaseResult } from "../research-pipeline.js";

// Mock modules that have side effects or spawn agents
vi.mock("../research-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../research-pipeline.js")>();
  return {
    ...actual,
    runResearchPhase: vi.fn(),
  };
});

vi.mock("../profiler.js", () => ({
  profileRepo: vi.fn(async () => ({
    name: "test-project",
    rootPath: "/tmp/test",
    languages: ["TypeScript"],
    frameworks: [],
    packageManager: "npm",
    entrypoints: [],
    hasTests: false,
    testFramework: undefined,
    hasDocs: false,
    hasCI: false,
    ciPlatform: undefined,
    todos: [],
    recentCommits: [],
    readme: "",
  })),
}));

vi.mock("../session-artifacts.js", () => ({
  sessionArtifactPath: vi.fn((_ctx: any, name: string) => `/tmp/artifacts/${name}`),
}));

// Mock fs to avoid actual disk writes
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ""),
    existsSync: vi.fn(() => false),
  };
});

import { runResearchPhase } from "../research-pipeline.js";
import { registerResearchTool } from "./research.js";

// ─── Helpers ────────────────────────────────────────────────

function makePhaseResult(overrides: Partial<ResearchPhaseResult>): ResearchPhaseResult {
  return {
    phase: "investigate",
    success: false,
    proposal: "",
    ...overrides,
  };
}

function buildOc() {
  const state: any = {
    repoProfile: { name: "test-project", languages: ["TypeScript"] },
    researchState: undefined,
  };

  const registeredTools: Map<string, any> = new Map();

  const oc: any = {
    pi: {
      registerTool: vi.fn((spec: any) => {
        registeredTools.set(spec.name, spec);
      }),
    },
    state,
    orchestratorActive: false,
    setPhase: vi.fn(),
    persistState: vi.fn(),
    get _tools() { return registeredTools; },
  };

  return oc;
}

function buildCtx() {
  return {
    cwd: "/tmp/test-project",
    ui: {
      notify: vi.fn(),
      select: vi.fn(async () => "✅ Accept and continue to multi-model feedback"),
    },
    sessionManager: {
      getSessionDir: () => "/tmp/session",
      getSessionId: () => "sess-123",
      getSessionFile: () => undefined,
    },
  } as any;
}

async function invokeResearchTool(oc: any, ctx: any, params: { url: string }) {
  registerResearchTool(oc);
  // Use the canonical tool name
  const tool = oc._tools.get("flywheel_research");
  if (!tool) throw new Error("Tool not registered");
  return tool.execute("call-1", params, undefined, () => {}, ctx);
}

// ─── Tests ──────────────────────────────────────────────────

describe("flywheel_research tool — investigate failure aborts pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an error response (not success) when investigate fails with empty proposal", async () => {
    vi.mocked(runResearchPhase).mockResolvedValue(
      makePhaseResult({
        phase: "investigate",
        success: false,
        proposal: "",
        error: "agent=research-investigate | model=claude-opus-4-7 | exit=1 | No API key found for anthropic",
      })
    );

    const oc = buildOc();
    const ctx = buildCtx();
    const result = await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    expect(result.details?.error).toBe(true);
    expect(result.details?.phase).toBe("investigate");
  });

  it("does not continue to deepen phase after investigate fails with no proposal", async () => {
    vi.mocked(runResearchPhase).mockResolvedValue(
      makePhaseResult({
        phase: "investigate",
        success: false,
        proposal: "",
        error: "exit=1 | No API key found for anthropic",
      })
    );

    const oc = buildOc();
    const ctx = buildCtx();
    await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    // runResearchPhase should only have been called once (for investigate)
    expect(vi.mocked(runResearchPhase)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runResearchPhase).mock.calls[0][2]).toBe("investigate");
  });

  it("includes the actual error detail in the returned text (actionable message)", async () => {
    vi.mocked(runResearchPhase).mockResolvedValue(
      makePhaseResult({
        phase: "investigate",
        success: false,
        proposal: "",
        error: "agent=research-investigate | exit=1 | No API key found for anthropic",
      })
    );

    const oc = buildOc();
    const ctx = buildCtx();
    const result = await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    const text = result.content?.[0]?.text ?? "";
    expect(text).toContain("No API key found for anthropic");
    expect(text).not.toContain("partial output");
  });

  it("does not claim an artifact path in successful-result details when pipeline aborts", async () => {
    vi.mocked(runResearchPhase).mockResolvedValue(
      makePhaseResult({
        phase: "investigate",
        success: false,
        proposal: "",
        error: "exit=1 | API error",
      })
    );

    const oc = buildOc();
    const ctx = buildCtx();
    const result = await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    // The response should signal error, not include an artifactName as a success artifact
    expect(result.details?.error).toBe(true);
    // paused should not be set (this is an abort, not a pause)
    expect(result.details?.paused).toBeUndefined();
  });

  it("resets orchestrator to idle when aborting on investigate failure", async () => {
    vi.mocked(runResearchPhase).mockResolvedValue(
      makePhaseResult({
        phase: "investigate",
        success: false,
        proposal: "",
        error: "exit=1 | No API key",
      })
    );

    const oc = buildOc();
    const ctx = buildCtx();
    await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    expect(oc.setPhase).toHaveBeenCalledWith("idle", ctx);
    expect(oc.state.researchState).toBeUndefined();
  });

  it("continues past deepen/inversion failures when investigate produced a valid proposal", async () => {
    // investigate succeeds, deepen fails — pipeline should continue (warn, not abort)
    vi.mocked(runResearchPhase)
      .mockResolvedValueOnce(makePhaseResult({
        phase: "investigate",
        success: true,
        proposal: "A".repeat(300),
      }))
      .mockResolvedValueOnce(makePhaseResult({
        phase: "deepen",
        success: false,
        proposal: "A".repeat(300),  // preserved prior
        error: "exit=1 | timeout",
      }))
      // All remaining phases succeed minimally
      .mockResolvedValue(makePhaseResult({ success: true, proposal: "A".repeat(300) }));

    const oc = buildOc();
    const ctx = buildCtx();
    const result = await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    // Pipeline should NOT have aborted — deepen failure is a warning, not abort
    expect(result.details?.error).toBeUndefined();
    // Should have run more than just investigate
    expect(vi.mocked(runResearchPhase).mock.calls.length).toBeGreaterThan(1);
  });
});

describe("flywheel_research tool — no 'partial output' in user-facing messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not emit 'partial output' in abort response text when investigate fails", async () => {
    vi.mocked(runResearchPhase).mockResolvedValue(
      makePhaseResult({
        phase: "investigate",
        success: false,
        proposal: "",
        error: "exit=1 | No API key found for anthropic",
      })
    );

    const oc = buildOc();
    const ctx = buildCtx();
    const result = await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    const text = result.content?.[0]?.text ?? "";
    expect(text).not.toContain("partial output");
  });

  it("does not emit 'partial output' in ui.notify when investigate fails (abort path)", async () => {
    vi.mocked(runResearchPhase).mockResolvedValue(
      makePhaseResult({
        phase: "investigate",
        success: false,
        proposal: "",
        error: "exit=1 | model unavailable",
      })
    );

    const oc = buildOc();
    const ctx = buildCtx();
    await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    const allNotifications = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => c[0] as string);
    expect(allNotifications.some((n) => n.includes("partial output"))).toBe(false);
  });

  it("does not emit 'partial output' in ui.notify when deepen fails with no error field", async () => {
    // Simulate a future edge case: deepen returns success=false but no error set
    vi.mocked(runResearchPhase)
      .mockResolvedValueOnce(makePhaseResult({
        phase: "investigate",
        success: true,
        proposal: "A".repeat(300),
      }))
      .mockResolvedValueOnce(makePhaseResult({
        phase: "deepen",
        success: false,
        proposal: "A".repeat(300),
        error: undefined, // no error detail — the old path that produced "partial output"
      }))
      .mockResolvedValue(makePhaseResult({ success: true, proposal: "A".repeat(300) }));

    const oc = buildOc();
    const ctx = buildCtx();
    await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    const allNotifications = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => c[0] as string);
    // "partial output" must never appear, even when result.error is undefined
    expect(allNotifications.some((n) => n.includes("partial output"))).toBe(false);
    // The fallback should include phase info instead
    const warnMsg = allNotifications.find((n) => n.includes("Deepening analysis") && n.includes("had issues"));
    expect(warnMsg).toBeDefined();
    expect(warnMsg).toContain("phase=deepen");
  });

  it("includes phase and proposal-length in fallback when no error detail is available", async () => {
    // Use mockImplementation so the right phase failure is keyed to "inversion", not call order
    vi.mocked(runResearchPhase).mockImplementation(async (_pi, _cwd, phase) => {
      if (phase === "inversion") {
        return makePhaseResult({
          phase: "inversion",
          success: false,
          proposal: "A".repeat(300),
          error: undefined,
        });
      }
      return makePhaseResult({ success: true, proposal: "A".repeat(300) });
    });

    const oc = buildOc();
    const ctx = buildCtx();
    await invokeResearchTool(oc, ctx, { url: "https://github.com/test/repo" });

    const warnMsg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => c[0] as string)
      .find((n) => n.includes("Inversion analysis") && n.includes("had issues"));

    expect(warnMsg).toBeDefined();
    expect(warnMsg).toContain("phase=inversion");
    expect(warnMsg).toContain("proposal-length=300");
    expect(warnMsg).toContain("no error detail returned");
  });
});
