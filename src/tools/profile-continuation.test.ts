import { describe, expect, it } from "vitest";
import { activeWorkflowContinuation } from "./profile.js";
import { createInitialState, type OrchestratorState } from "../types.js";

function makeState(overrides: Partial<OrchestratorState>): OrchestratorState {
  return { ...createInitialState(), ...overrides };
}

describe("activeWorkflowContinuation", () => {
  it("keeps completed discovery from reopening the profile/discovery menu", () => {
    const continuation = activeWorkflowContinuation(makeState({
      phase: "awaiting_selection",
      candidateIdeas: [{
        id: "idea-a",
        title: "Idea A",
        description: "Improve the workflow",
        category: "dx",
        effort: "low",
        impact: "high",
        rationale: "It reduces friction",
        tier: "top",
      }],
    }));

    expect(continuation?.text).toContain("agent_flywheel_select");
    expect(continuation?.text).toContain("Discovery is already complete");
    expect(continuation?.details.awaitingSelection).toBe(true);
  });

  it("keeps profiled standard discovery from reopening the profile/discovery menu", () => {
    const continuation = activeWorkflowContinuation(makeState({
      phase: "discovering",
      repoProfile: {
        name: "repo",
        languages: ["TypeScript"],
        frameworks: [],
        structure: "src/index.ts",
        entrypoints: [],
        recentCommits: [],
        hasTests: true,
        hasDocs: true,
        hasCI: false,
        todos: [],
        keyFiles: {},
      },
    }));

    expect(continuation?.text).toContain("agent_flywheel_discover");
    expect(continuation?.details.awaitingDiscovery).toBe(true);
  });

  it("does not block the Dueling Wizard re-entry profile call", () => {
    const continuation = activeWorkflowContinuation(makeState({
      phase: "discovering",
      duelingWizardLaunchRequested: true,
      repoProfile: {
        name: "repo",
        languages: ["TypeScript"],
        frameworks: [],
        structure: "src/index.ts",
        entrypoints: [],
        recentCommits: [],
        hasTests: true,
        hasDocs: true,
        hasCI: false,
        todos: [],
        keyFiles: {},
      },
    }));

    expect(continuation).toBeUndefined();
  });

  it("continues direct-to-beads instead of restarting after a goal is selected", () => {
    const continuation = activeWorkflowContinuation(makeState({
      phase: "creating_beads",
      selectedGoal: "Add rate limiting",
      constraints: ["no new dependencies"],
    }));

    expect(continuation?.text).toContain("Create beads");
    expect(continuation?.text).toContain("Add rate limiting");
    expect(continuation?.text).toContain("no new dependencies");
    expect(continuation?.text).toContain("do not call `agent_flywheel_profile` again");
  });

  it("does not intercept a fresh profile call", () => {
    expect(activeWorkflowContinuation(makeState({ phase: "idle" }))).toBeUndefined();
  });
});
