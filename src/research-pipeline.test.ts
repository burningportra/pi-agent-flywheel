import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  researchBlunderHuntPrompt,
  researchFeedbackPrompt,
  researchSynthesisPrompt,
  extractProjectName,
  runResearchPhase,
  type ResearchPipelineState,
} from "./research-pipeline.js";
import type { DeepPlanResult } from "./deep-plan.js";

// ─── runResearchPhase — error propagation ───────────────────

vi.mock("./deep-plan.js", () => ({
  runDeepPlanAgents: vi.fn(),
}));

// Import after mock so the mock is in place
import { runDeepPlanAgents } from "./deep-plan.js";

const mockPi = {} as any;

const baseState: ResearchPipelineState = {
  externalUrl: "https://github.com/test/repo",
  externalName: "repo",
  projectName: "this-project",
  currentPhase: "investigate",
  proposal: "",
  artifactName: "research/repo-proposal.md",
  phasesCompleted: [],
};

function failedResult(overrides: Partial<DeepPlanResult> = {}): DeepPlanResult {
  return {
    name: "research-investigate",
    model: "claude-opus-4-7",
    plan: "",
    exitCode: 1,
    elapsed: 2,
    error: "No API key found for anthropic",
    ...overrides,
  };
}

function successResult(plan: string, overrides: Partial<DeepPlanResult> = {}): DeepPlanResult {
  return {
    name: "research-investigate",
    model: "claude-opus-4-7",
    plan,
    exitCode: 0,
    elapsed: 5,
    ...overrides,
  };
}

describe("runResearchPhase — investigate error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates error from DeepPlanResult when agent fails", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      failedResult({ error: "No API key found for anthropic" }),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "investigate", baseState);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("No API key found for anthropic");
  });

  it("includes exit code in error message", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      failedResult({ exitCode: 2, error: "model unavailable" }),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "investigate", baseState);

    expect(result.error).toContain("exit=2");
  });

  it("includes model name in error message when known", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      failedResult({ model: "claude-opus-4-7" }),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "investigate", baseState);

    expect(result.error).toContain("claude-opus-4-7");
  });

  it("includes agent name in error message", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      failedResult({ name: "research-investigate" }),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "investigate", baseState);

    expect(result.error).toContain("research-investigate");
  });

  it("falls back to state.proposal when agent returns empty plan", async () => {
    const stateWithPrior = { ...baseState, proposal: "prior proposal content" };
    vi.mocked(runDeepPlanAgents).mockResolvedValue([failedResult({ plan: "" })]);

    const result = await runResearchPhase(mockPi, "/tmp", "investigate", stateWithPrior);

    expect(result.proposal).toBe("prior proposal content");
  });

  it("returns success and no error when agent produces substantial plan", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      successResult("A".repeat(200)),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "investigate", baseState);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.proposal).toHaveLength(200);
  });

  it("returns error when agent exits 0 but plan is empty (no content produced)", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      successResult(""),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "investigate", baseState);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("empty output");
  });
});

describe("runResearchPhase — deepen error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const stateWithProposal = { ...baseState, proposal: "existing proposal text that is long enough" };

  it("propagates error when deepen agent fails", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      failedResult({ name: "research-deepen", error: "timeout", exitCode: 1 }),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "deepen", stateWithProposal);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
    expect(result.error).toContain("exit=1");
  });

  it("preserves prior proposal when deepen fails", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      failedResult({ name: "research-deepen", plan: "" }),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "deepen", stateWithProposal);

    expect(result.proposal).toBe(stateWithProposal.proposal);
  });
});

describe("runResearchPhase — inversion error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const stateWithProposal = { ...baseState, proposal: "existing proposal that is long enough to count" };

  it("propagates error when inversion agent fails", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      failedResult({ name: "research-inversion", error: "model not available", exitCode: 1 }),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "inversion", stateWithProposal);

    expect(result.success).toBe(false);
    expect(result.error).toContain("model not available");
  });

  it("preserves prior proposal when inversion fails", async () => {
    vi.mocked(runDeepPlanAgents).mockResolvedValue([
      failedResult({ name: "research-inversion" }),
    ]);

    const result = await runResearchPhase(mockPi, "/tmp", "inversion", stateWithProposal);

    expect(result.proposal).toBe(stateWithProposal.proposal);
  });
});

// ─── researchBlunderHuntPrompt ──────────────────────────────

describe("researchBlunderHuntPrompt", () => {
  it("includes the proposal text", () => {
    const prompt = researchBlunderHuntPrompt("# My Proposal\nIntegrate X with Y", 1);
    expect(prompt).toContain("# My Proposal");
    expect(prompt).toContain("Integrate X with Y");
  });

  it("includes the pass number", () => {
    expect(researchBlunderHuntPrompt("proposal", 3)).toContain("Pass 3/5");
  });

  it("uses overshoot mismatch technique", () => {
    const prompt = researchBlunderHuntPrompt("proposal", 1);
    expect(prompt).toContain("at least 50");
  });

  it("covers all 10 check categories", () => {
    const prompt = researchBlunderHuntPrompt("proposal", 1);
    expect(prompt).toContain("Architectural flaws");
    expect(prompt).toContain("Missing edge cases");
    expect(prompt).toContain("Unrealistic assumptions");
    expect(prompt).toContain("Contradictions");
    expect(prompt).toContain("Shallow reimagining");
    expect(prompt).toContain("Over-engineering");
  });

  it("asks for full revised proposal output", () => {
    const prompt = researchBlunderHuntPrompt("proposal", 1);
    expect(prompt).toContain("FULL revised proposal");
    expect(prompt).toContain("NO_CHANGES");
  });
});

// ─── researchFeedbackPrompt ─────────────────────────────────

describe("researchFeedbackPrompt", () => {
  it("includes the proposal text", () => {
    const prompt = researchFeedbackPrompt("# Proposal\nDo X");
    expect(prompt).toContain("# Proposal");
    expect(prompt).toContain("Do X");
  });

  it("asks for feedback on 5 dimensions", () => {
    const prompt = researchFeedbackPrompt("proposal");
    expect(prompt).toContain("Architectural soundness");
    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("Feasibility");
    expect(prompt).toContain("Innovation quality");
    expect(prompt).toContain("Risk assessment");
  });

  it("asks for numbered actionable suggestions", () => {
    const prompt = researchFeedbackPrompt("proposal");
    expect(prompt).toContain("numbered list");
    expect(prompt).toContain("actionable");
  });
});

// ─── researchSynthesisPrompt ────────────────────────────────

describe("researchSynthesisPrompt", () => {
  const feedback: DeepPlanResult[] = [
    { name: "fb-1", model: "claude", plan: "Suggestion A", exitCode: 0, elapsed: 10 },
    { name: "fb-2", model: "gpt", plan: "Suggestion B", exitCode: 0, elapsed: 12 },
    { name: "fb-3", model: "gemini", plan: "", exitCode: 1, elapsed: 5, error: "failed" },
  ];

  it("includes the original proposal", () => {
    const prompt = researchSynthesisPrompt("# Original Proposal", feedback);
    expect(prompt).toContain("# Original Proposal");
  });

  it("includes successful feedback only", () => {
    const prompt = researchSynthesisPrompt("proposal", feedback);
    expect(prompt).toContain("Suggestion A");
    expect(prompt).toContain("Suggestion B");
    // Failed feedback (empty plan) should be filtered
    expect(prompt).not.toContain("Feedback 3");
  });

  it("labels feedback by model", () => {
    const prompt = researchSynthesisPrompt("proposal", feedback);
    expect(prompt).toContain("claude");
    expect(prompt).toContain("gpt");
  });

  it("asks for 'best of all worlds' synthesis", () => {
    const prompt = researchSynthesisPrompt("proposal", feedback);
    expect(prompt).toContain("best of all worlds");
    expect(prompt).toContain("FULL revised proposal");
  });

  it("handles all feedback failing", () => {
    const allFailed: DeepPlanResult[] = [
      { name: "fb-1", model: "claude", plan: "", exitCode: 1, elapsed: 5 },
    ];
    const prompt = researchSynthesisPrompt("proposal", allFailed);
    // Should still include the original proposal
    expect(prompt).toContain("proposal");
  });
});

// ─── extractProjectName ─────────────────────────────────────

describe("extractProjectName", () => {
  it("extracts repo name from GitHub URL", () => {
    expect(extractProjectName("https://github.com/user/repo")).toBe("repo");
  });

  it("handles .git suffix", () => {
    expect(extractProjectName("https://github.com/user/repo.git")).toBe("repo");
  });

  it("handles trailing slash", () => {
    expect(extractProjectName("https://github.com/user/repo/")).toBe("repo");
  });

  it("handles non-GitHub URLs", () => {
    const name = extractProjectName("https://example.com/some/path/project");
    expect(name).toBe("project");
  });

  it("handles bare repo name", () => {
    expect(extractProjectName("my-project")).toBe("my-project");
  });

  it("handles complex GitHub URLs with sub-paths", () => {
    expect(extractProjectName("https://github.com/org-name/my-cool-repo/tree/main")).toBe("my-cool-repo");
  });
});
