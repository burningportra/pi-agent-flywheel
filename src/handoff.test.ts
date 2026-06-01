import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { createInitialState } from "./types.js";
import { generateHandoffMarkdown, shouldGenerateHandoff, writeHandoffArtifact } from "./handoff.js";

describe("handoff artifacts", () => {
  it("generates required handoff sections without duplicating plan contents", () => {
    const state = createInitialState();
    state.selectedGoal = "Build reliable adapters";
    state.phase = "implementing";
    state.currentBeadId = "pi-active";
    state.activeBeadIds = ["pi-active", "pi-next"];
    state.planDocument = "plans/reliable-adapters.md";
    state.planningWorkflow = {
      schemaVersion: 1,
      adapterId: "superpowers",
      generationMode: "superpowers",
      stage: "handoff",
      goalFingerprint: "abc",
      specArtifact: "superpowers/specs/reliable-adapters.md",
    };

    const markdown = generateHandoffMarkdown({
      cwd: "/repo",
      state,
      reason: "review failed twice",
      changedFiles: ["src/adapter.ts"],
      validationResults: ["npm test failed in adapter.test.ts"],
      deviations: ["Used fallback storage instead of D1"],
      blockers: ["Need current Effect SQL API"],
      openQuestions: ["Which migration path is canonical?"],
      nextSteps: ["Read local package source"],
      suggestedSkills: ["research-software"],
    });

    for (const heading of [
      "## Goal",
      "## Active Work",
      "## Changed Files",
      "## Validation Results",
      "## Deviations From Plan",
      "## Blockers",
      "## Open Questions",
      "## Next Steps",
      "## Suggested Skills",
      "## Referenced Artifacts",
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("pi-active");
    expect(markdown).toContain("plans/reliable-adapters.md");
    expect(markdown).toContain("superpowers/specs/reliable-adapters.md");
    expect(markdown).not.toContain("full spec body");
  });

  it("decides handoff triggers for long sessions, repeated failures, status, and stop", () => {
    const idle = createInitialState();
    const active = createInitialState();
    active.phase = "implementing";
    active.currentBeadId = "pi-active";

    expect(shouldGenerateHandoff({ event: "session_length", state: active, sessionMessageCount: 80, threshold: 80 })).toBe(true);
    expect(shouldGenerateHandoff({ event: "review_failure", state: active, reviewFailureCount: 2 })).toBe(true);
    expect(shouldGenerateHandoff({ event: "status_request", state: active })).toBe(true);
    expect(shouldGenerateHandoff({ event: "stop", state: active })).toBe(true);
    expect(shouldGenerateHandoff({ event: "status_request", state: idle })).toBe(false);
  });

  it("writes handoff markdown to a temp path", () => {
    const state = createInitialState();
    state.selectedGoal = "Ship feature";
    const path = writeHandoffArtifact({ cwd: "/repo", state, reason: "status requested" });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("# AgentFlywheel Handoff");
  });

  it("review and stop flows report handoff paths while status stays read-only", () => {
    const reviewSource = readFileSync(new URL("./tools/review.ts", import.meta.url), "utf8");
    expect(reviewSource).toContain("shouldGenerateHandoff({ event: \"review_failure\"");
    expect(reviewSource).toContain("handoffPath");

    const commandsSource = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    expect(commandsSource).toContain("shouldGenerateHandoff({ event: \"stop\"");
    expect(commandsSource).toContain("Handoff artifact");
    expect(commandsSource).not.toContain("shouldGenerateHandoff({ event: \"status_request\"");
  });
});
