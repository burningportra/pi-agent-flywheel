import { describe, expect, it } from "vitest";
import {
  beadCreationPrompt,
  goalBrainstormApproachesPrompt,
  implementationPlanFromSpecPrompt,
  implementationWorkerCoordinationContract,
  implementationWorkerPrompt,
  formatImplementationWorkerHandoff,
  orchestratorSystemPrompt,
  planRefinementPrompt,
  planToBeadsPrompt,
  SUBAGENT_AUTO_EXIT_INSTRUCTION,
  superpowersSpecPrompt,
  superpowersSpecRefinementPrompt,
  withSubagentAutoExitInstruction,
} from "./prompts.js";
import type { RepoProfile } from "./types.js";

const profile: RepoProfile = {
  name: "repo",
  languages: ["TypeScript"],
  frameworks: [],
  structure: "src/index.ts",
  entrypoints: ["src/index.ts"],
  recentCommits: [],
  hasTests: true,
  hasDocs: true,
  hasCI: false,
  todos: [],
  keyFiles: {},
};

describe("structured bead mutation prompt handoffs", () => {
  it("asks goal-to-bead planning for structured JSON instead of raw br mutation commands", () => {
    const prompt = beadCreationPrompt("Improve reliability", "repo context", []);

    expect(prompt).toContain("structured staged bead mutation plan");
    expect(prompt).toContain('"beads"');
    expect(prompt).toContain('"dependencies"');
    expect(prompt).toContain('"localId"');
    expect(prompt).not.toContain('br create "Title"');
    expect(prompt).not.toContain("br dep add <child-id>");
    expect(prompt).toContain("structured validation");
  });

  it("asks plan-to-bead planning for staged mutation data instead of shell blocks", () => {
    const prompt = planToBeadsPrompt("docs/plans/feature.md", "Improve reliability", profile);

    expect(prompt).toContain("structured staged bead mutation plan");
    expect(prompt).toContain("JSON shape");
    expect(prompt).toContain('"verification"');
    expect(prompt).not.toContain('br create "Title"');
    expect(prompt).not.toContain("br dep add <child-id>");
    expect(prompt).toContain("validate required fields");
  });

  it("keeps robot workflow guidance on the structured mutation path", () => {
    const prompt = orchestratorSystemPrompt({ beads: true, agentMail: true });

    expect(prompt).toContain("Draft staged bead mutation plans as structured JSON data");
    expect(prompt).toContain("validate/apply it and enter the bead approval menu");
    expect(prompt).not.toContain("Create beads via `br create");
    expect(prompt).not.toContain("setting dependencies with `br dep add`");
  });
});

describe("goal brainstorming prompts", () => {
  it("asks for 2-3 approaches with exactly one recommendation", () => {
    const prompt = goalBrainstormApproachesPrompt("Improve goal setting", profile, [
      { id: "constraints", value: "no-memory", label: "Do not change memory systems" },
    ]);

    expect(prompt).toContain("2-3 concrete implementation approaches");
    expect(prompt).toContain("Mark exactly one approach as recommended");
    expect(prompt).toContain("Do not change memory systems");
    expect(prompt).toContain("Return ONLY the JSON array");
  });
});

describe("implementation worker coordination contract", () => {
  it("centralizes non-pane pi-subagent coordination obligations", () => {
    const prompt = implementationWorkerCoordinationContract({
      cwd: "/repo",
      assignedBeadId: "pi-zbma",
      readyBeadIds: ["pi-zbma"],
      completedBeadIds: ["pi-done"],
    });

    expect(prompt).toContain("pi-subagents Implementation Coordination Contract");
    expect(prompt).toContain("Read ALL of AGENTS.md and README.md carefully");
    expect(prompt).toContain("Investigate the code architecture");
    expect(prompt).toContain("Review recent commits");
    expect(prompt).toContain("Register with MCP Agent Mail");
    expect(prompt).toContain("fresh callsign");
    expect(prompt).toContain("Check urgent and normal inbox messages");
    expect(prompt).toContain("acknowledge messages");
    expect(prompt).toContain("active-agent awareness");
    expect(prompt).toContain("bv --robot-next");
    expect(prompt).toContain("bv --robot-triage");
    expect(prompt).toContain("Anti-communication-purgatory");
    expect(prompt).toContain("Evidence-based stale in-progress policy");
    expect(prompt).toContain("unexpired file reservations");
    expect(prompt).toContain("br sync --flush-only");
    expect(prompt).not.toContain("NTM Tick Loop");
    expect(prompt).not.toContain("ntm --");
    expect(prompt).not.toContain("tmux panes");
  });

  it("places the coordination contract before bead-specific implementation text", () => {
    const prompt = implementationWorkerPrompt({
      cwd: "/repo",
      assignedBeadId: "pi-9rqv",
      readyBeadIds: ["pi-9rqv"],
      completedBeadIds: ["pi-zbma"],
      executionModeLabel: "shared checkout",
    });

    expect(prompt.indexOf("## pi-subagents Implementation Coordination Contract")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("## pi-subagents Implementation Coordination Contract")).toBeLessThan(
      prompt.indexOf("## Implementation Worker Task")
    );
    expect(prompt).toContain("Register with MCP Agent Mail");
    expect(prompt).toContain("Implement assigned bead pi-9rqv");
    expect(prompt).not.toContain("NTM Tick Loop");
    expect(prompt).not.toContain("ntm --");
    expect(prompt).not.toContain("managed NTM worker pane");
  });

  it("formats implementation handoff for pi-subagents without pane-management commands", () => {
    const handoff = formatImplementationWorkerHandoff({
      cwd: "/repo",
      workerCount: 1,
      assignedBeadId: "pi-9rqv",
      readyBeadIds: ["pi-9rqv"],
    });

    expect(handoff).toContain("Launch 1 clear-context pi-subagent implementation worker");
    expect(handoff).toContain("Give each worker this prompt before any bead-specific task text");
    expect(handoff.indexOf("## pi-subagents Implementation Coordination Contract")).toBeLessThan(
      handoff.indexOf("## Implementation Worker Task")
    );
    expect(handoff).toContain("Agent Mail");
    expect(handoff).toContain("bv --robot-next");
    expect(handoff).not.toContain("NTM Tick Loop");
    expect(handoff).not.toContain("ntm --");
    expect(handoff).not.toContain("tmux panes");
  });
});

describe("subagent completion discipline", () => {
  it("appends one auto-exit instruction block and is idempotent", () => {
    const task = withSubagentAutoExitInstruction("Do the work.");

    expect(task).toContain(SUBAGENT_AUTO_EXIT_INSTRUCTION);
    expect(task).toContain("do not keep the pane open");
    expect(withSubagentAutoExitInstruction(task)).toBe(task);
  });
});

describe("Superpowers spec prompts", () => {
  it("superpowersSpecPrompt frames the artifact as a spec, not an implementation plan", () => {
    const prompt = superpowersSpecPrompt(
      "Add Superpowers spec workflow",
      profile,
      ["no-new-deps"],
    );

    expect(prompt).toMatch(/specification document/i);
    expect(prompt).toContain("Acceptance Criteria");
    expect(prompt).toContain("Non-Goals");
    expect(prompt).toContain("superpowers/specs/<slug>.md");
    // Must NOT use the saved-plan namespace
    expect(prompt).not.toContain("plans/<goal-slug>.md");
    // Must NOT use implementation-plan vocabulary the plan prompt owns
    expect(prompt).not.toMatch(/file-by-file implementation sequence/i);
    expect(prompt).not.toContain("### 7. File Structure");
    expect(prompt).not.toContain("### 8. Sequencing");
    expect(prompt).toContain("no-new-deps");
  });

  it("superpowersSpecRefinementPrompt is distinct from planRefinementPrompt copy", () => {
    const refine = superpowersSpecRefinementPrompt("superpowers/specs/foo.md", 2, [
      "Is the CLI flag optional?",
    ]);
    const planRefine = planRefinementPrompt("plans/foo.md", 2);

    expect(refine).toContain("Spec Refinement Round 2");
    expect(refine).toMatch(/specification document/i);
    expect(refine).toContain("superpowers/specs/foo.md");
    expect(refine).toContain("Is the CLI flag optional?");
    // The spec refinement must not adopt implementation-plan refinement copy
    expect(refine).not.toContain("Round 2 Refinement\n");
    // It may reference "implementation plan" inside boundary rules (to warn
    // the agent off it), but it must not call this artifact one.
    expect(refine).not.toMatch(/evaluate this implementation plan/i);
    expect(refine).not.toMatch(/this is refinement round/i);
    // The two prompts must not be byte-identical
    expect(refine).not.toBe(planRefine);
  });

  it("implementationPlanFromSpecPrompt embeds the approved spec and targets plans/<slug>.md", () => {
    const approvedSpec = "## Goal\nAdd workflow\n\n## Acceptance Criteria\n- spec is approved";
    const prompt = implementationPlanFromSpecPrompt(
      "Add Superpowers spec workflow",
      approvedSpec,
      profile,
      ["no-new-deps", "preserve plan/<slug>.md path"],
    );

    expect(prompt).toContain(approvedSpec);
    expect(prompt).toContain("plans/<goal-slug>.md");
    expect(prompt).toContain("no-new-deps");
    expect(prompt).toMatch(/approved/i);
    // Must NOT overwrite the spec
    expect(prompt).toMatch(/Do NOT overwrite the approved spec/i);
    // Must not direct the agent to save under superpowers/specs
    expect(prompt).not.toContain("superpowers/specs/<slug>.md");
  });
});
