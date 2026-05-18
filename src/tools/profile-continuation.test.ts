import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { activeWorkflowContinuation } from "./profile.js";
import { createInitialState, type OrchestratorState } from "../types.js";
import {
  initSuperpowersWorkflow,
  SUPERPOWERS_ADAPTER_ID,
} from "../workflows/superpowers.js";

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

  it("keeps research runs from falling into repo-profile discovery", () => {
    const continuation = activeWorkflowContinuation(makeState({
      phase: "researching",
      researchState: {
        url: "https://github.com/obra/superpowers",
        externalName: "superpowers",
        artifactName: "research/superpowers-proposal.md",
        phasesCompleted: ["investigate"],
      },
    }));

    expect(continuation?.text).toContain("flywheel_research");
    expect(continuation?.text).toContain("https://github.com/obra/superpowers");
    expect(continuation?.text).toContain("Do not open repo-profile discovery");
    expect(continuation?.details.research).toBe(true);
  });

  it("continues direct-to-beads instead of restarting after a goal is selected", () => {
    const continuation = activeWorkflowContinuation(makeState({
      phase: "creating_beads",
      selectedGoal: "Add rate limiting",
      constraints: ["no new dependencies"],
    }));

    expect(continuation?.text).toContain("Draft a structured staged bead mutation plan");
    expect(continuation?.text).toContain("Add rate limiting");
    expect(continuation?.text).toContain("no new dependencies");
    expect(continuation?.text).toContain("do not call `agent_flywheel_profile` again");
  });

  it("does not intercept a fresh profile call", () => {
    expect(activeWorkflowContinuation(makeState({ phase: "idle" }))).toBeUndefined();
  });
});

// ─── Picker parity tests ──────────────────────────────────
// These tests live alongside profile-continuation tests so the bead
// (pi-i2x2) Files scope stays minimal. They guard that the custom-goal
// workflow picker in profile.ts exposes the same Superpowers option as
// the idea-selection picker in select.ts, and that both pickers initialize
// equivalent planningWorkflow state.

const profileSource = readFileSync(join(__dirname, "profile.ts"), "utf8");
const selectSourceForParity = readFileSync(join(__dirname, "select.ts"), "utf8");

describe("profile.ts — Superpowers workflow option (custom-goal branch)", () => {
  it("exposes the Superpowers spec-first option in the workflow picker", () => {
    expect(profileSource).toContain("🪄 Superpowers Planning");
    expect(profileSource).toContain("spec-first");
  });

  it("preserves the original four native workflow options", () => {
    expect(profileSource).toContain("📋 Plan first");
    expect(profileSource).toContain("🧠 Multi-model plan");
    expect(profileSource).toContain("🧠 Deep plan");
    expect(profileSource).toContain("⚡ Direct to beads");
  });

  it("initializes planningWorkflow state when Superpowers is selected", () => {
    expect(profileSource).toContain("initSuperpowersWorkflow");
    expect(profileSource).toContain("oc.state.planningWorkflow");
  });

  it("imports initSuperpowersWorkflow from the workflows module", () => {
    expect(profileSource).toMatch(
      /import\s*\{\s*initSuperpowersWorkflow\s*\}\s*from\s*"\.\.\/workflows\/superpowers\.js"/
    );
  });
});

describe("Superpowers picker parity across select.ts and profile.ts", () => {
  it("both pickers expose the same Superpowers option label", () => {
    const label = "🪄 Superpowers Planning";
    expect(selectSourceForParity).toContain(label);
    expect(profileSource).toContain(label);
  });

  it("both pickers route via initSuperpowersWorkflow so state cannot diverge", () => {
    expect(selectSourceForParity).toContain("initSuperpowersWorkflow");
    expect(profileSource).toContain("initSuperpowersWorkflow");
  });

  it("the shared helper produces a Superpowers planningWorkflow state with required fields", () => {
    const state = initSuperpowersWorkflow({
      goal: "Add rate limiting",
      constraints: ["no new dependencies"],
    });
    expect(state.adapterId).toBe(SUPERPOWERS_ADAPTER_ID);
    expect(state.generationMode).toBe("superpowers");
    expect(state.stage).toBe("spec");
    expect(state.goalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(state.specRefinementRound).toBe(0);
  });

  it("identical goal+constraints produce identical fingerprints (picker independence)", () => {
    const goal = "Add API rate limiting with Redis";
    const constraints = ["no new dependencies", "keep backward compat"];
    const a = initSuperpowersWorkflow({ goal, constraints });
    const b = initSuperpowersWorkflow({ goal, constraints });
    expect(a.goalFingerprint).toBe(b.goalFingerprint);
    expect(a.adapterId).toBe(b.adapterId);
    expect(a.stage).toBe(b.stage);
    expect(a.generationMode).toBe(b.generationMode);
  });
});
