import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
  formatImplementationWorkerHandoff,
  implementationWorkerCoordinationContract,
  implementationWorkerPrompt,
} from "./prompts.js";

function expectNoNtmWorkerRequirements(text: string): void {
  expect(text).not.toContain("managed NTM worker pane");
  expect(text).not.toContain("NTM Tick Loop");
  expect(text).not.toContain("ntm --");
  expect(text).not.toMatch(/launch(?:ing)?\s+(?:an?\s+)?NTM/i);
  expect(text).not.toContain("tmux panes");
}

describe("pi-subagents implementation coordination regression contract", () => {
  it("requires Agent Mail registration, bounded coordination, bv-first routing, and stale-bead evidence", () => {
    const contract = implementationWorkerCoordinationContract({
      cwd: "/repo",
      readyBeadIds: [],
    });

    expect(contract).toContain("## pi-subagents Implementation Coordination Contract");
    expect(contract).toContain("Read ALL of AGENTS.md and README.md carefully");
    expect(contract).toContain("Investigate the code architecture");
    expect(contract).toContain("Review recent commits");

    expect(contract).toContain("Register with MCP Agent Mail");
    expect(contract).toContain("fresh callsign");
    expect(contract).toContain("reserve the bead's file scope");
    expect(contract).toContain("introduce yourself on the bead thread");
    expect(contract).toContain("Check urgent and normal inbox messages");
    expect(contract).toContain("acknowledge messages");
    expect(contract).toContain("active-agent awareness");
    expect(contract).toContain("release reservations when finished");

    expect(contract).toContain("prefer `bv --robot-next` for solo work or `bv --robot-triage` for swarm-safe routing");
    expect(contract.indexOf("bv --robot-next")).toBeLessThan(contract.indexOf("br ready --json"));
    expect(contract).toContain("Track progress in beads and Agent Mail");
    expect(contract).toContain("br sync --flush-only");

    expect(contract).toContain("### 4. Anti-communication-purgatory rule");
    expect(contract).toContain("Coordinate promptly, then do the work");
    expect(contract).toContain("Bound coordination retries");
    expect(contract).toContain("continue with extra care rather than waiting indefinitely");

    expect(contract).toContain("### 5. Evidence-based stale in-progress policy");
    expect(contract).toContain("do not disrupt active work");
    expect(contract).toContain("recent Agent Mail activity");
    expect(contract).toContain("unexpired file reservations");
    expect(contract).toContain("one unanswered targeted check-in");
    expect(contract).toContain("If evidence is incomplete, leave the bead alone");

    expectNoNtmWorkerRequirements(contract);
  });

  it("assembles the coordination contract before bead-specific task text", () => {
    const prompt = implementationWorkerPrompt({
      cwd: "/repo",
      assignedBeadId: "pi-0srl",
      readyBeadIds: ["pi-0srl"],
      completedBeadIds: ["pi-zbma", "pi-9rqv"],
      executionModeLabel: "shared checkout",
    });

    const contractIndex = prompt.indexOf("## pi-subagents Implementation Coordination Contract");
    const taskIndex = prompt.indexOf("## Implementation Worker Task");

    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(taskIndex).toBeGreaterThan(contractIndex);
    expect(prompt).toContain("Assigned bead: pi-0srl");
    expect(prompt).toContain("Already completed in this run: pi-zbma, pi-9rqv");
    expect(prompt).toContain("Execution mode: shared checkout");
    expect(prompt).toContain("Implement assigned bead pi-0srl");
    expect(prompt).toContain("keep changes within its `### Files:` scope unless a focused test file is necessary");
    expect(prompt).toContain("Report the bead id, commit hash, changed files, exact verification output");
    expectNoNtmWorkerRequirements(prompt);
  });

  it("formats a representative clear-context handoff without pane or tick-loop requirements", () => {
    const handoff = formatImplementationWorkerHandoff({
      cwd: "/repo",
      workerCount: 3,
      readyBeadIds: ["pi-alpha", "pi-beta", "pi-gamma"],
      completedBeadIds: ["pi-done"],
      executionModeLabel: "single-branch mode",
    });

    expect(handoff).toContain("Launch 3 clear-context pi-subagent implementation workers with normal repository tools");
    expect(handoff).toContain("Give each worker this prompt before any bead-specific task text");
    expect(handoff).toContain("Pick exactly one safe ready bead");
    expect(handoff).toContain("Ready bead candidates: pi-alpha, pi-beta, pi-gamma");
    expect(handoff).toContain("Register with MCP Agent Mail");
    expect(handoff).toContain("bv --robot-next");
    expect(handoff).toContain("bv --robot-triage");
    expect(handoff.indexOf("## pi-subagents Implementation Coordination Contract")).toBeLessThan(
      handoff.indexOf("## Implementation Worker Task")
    );
    expectNoNtmWorkerRequirements(handoff);
  });

  it("keeps approve/review implementation launch handoffs on the pi-subagents path", () => {
    const approveSource = readFileSync(new URL("./tools/approve.ts", import.meta.url), "utf8");
    const reviewSource = readFileSync(new URL("./tools/review.ts", import.meta.url), "utf8");
    const implementationLaunchSource = `${approveSource}\n${reviewSource}`;

    expect(implementationLaunchSource).toContain("formatImplementationWorkerHandoff");
    expect(implementationLaunchSource).toContain('launchMode: "pi-subagents"');
    expect(implementationLaunchSource).toContain("Launch clear-context pi-subagents for implementation");
    expect(implementationLaunchSource).toContain("Launch a clear-context pi-subagent");
    expect(implementationLaunchSource).not.toContain("formatNtmLaunchInstructions");
    expect(implementationLaunchSource).not.toContain("implementationSwarmPrompt");
    expect(implementationLaunchSource).not.toContain('launchMode: "ntm"');
    expect(implementationLaunchSource).not.toContain("NTM Tick Loop");
    expect(implementationLaunchSource).not.toMatch(/Launch(?:ing)?\s+(?:an?\s+)?NTM/i);
  });
});
