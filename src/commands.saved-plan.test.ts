import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("saved plan workflow continuity", () => {
  const source = readFileSync(join(__dirname, "commands.ts"), "utf8");

  it("routes loaded saved plans back through awaiting_plan_approval", () => {
    expect(source).toContain('oc.setPhase("awaiting_plan_approval", ctx)');
  });

  it("tells the agent to call agent_flywheel_approve_beads after loading a saved plan", () => {
    expect(source).toContain("review this plan inside the AgentFlywheel workflow");
    expect(source).toContain("Do not skip directly to bead creation");
    expect(source).toContain("Artifact: \\`${selectedPlan.artifactName}\\`");
  });

  it("makes the startup-only opening ceremony hook explicit before any startup UI", () => {
    expect(source).toContain("const runOrchestrateStartupFlow = async () => {");
    expect(source).toContain("Opening ceremony hook:");
    expect(source).toContain("await runOrchestrateStartupFlow();");
    expect(source).toContain("Existing orchestration detected");
    expect(source).toContain("Start the AgentFlywheel workflow for this repo. Begin by calling `agent_flywheel_profile` to scan the repository.");

    expect(source).toMatch(/Opening ceremony hook:[\s\S]*await runOrchestrateStartupFlow\(\);/);
  });

  it("registers a read-only release checklist command", () => {
    expect(source).toContain('pi.registerCommand("flywheel-release-checklist"');
    expect(source).toContain('description: "Legacy alias of /flywheel-release-checklist"');
    expect(source).toContain('dirtyScopeKnown: statusResult.ok');
    expect(source).toContain('const hasWarnings = !statusResult.ok ||');
    expect(source).toContain('resilientExec(pi, "git", ["status", "--short"]');
    expect(source).toContain("formatReleaseChecklist(checklist)");
    expect(source).not.toContain("npm version");
    expect(source).not.toContain("npm publish");
    expect(source).not.toContain("git tag");
    expect(source).not.toContain("git reset --hard");
    expect(source).not.toContain("git clean -fd");
  });
});
