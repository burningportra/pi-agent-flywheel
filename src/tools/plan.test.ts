import { describe, expect, it } from "vitest";
import {
  buildMultiModelPlanSubagentConfigs,
  multiModelPlanArtifactNames,
  singleModelPlanArtifactName,
  slugifyGoal,
} from "./plan.js";

const profile = {
  name: "demo",
  rootPath: "/repo",
  languages: ["TypeScript"],
  frameworks: ["Vitest"],
  packageManager: "pnpm",
  entrypoints: ["src/index.ts"],
  hasTests: true,
  testFramework: "vitest",
  hasDocs: true,
  hasCI: false,
  ciPlatform: undefined,
  todos: [],
  recentCommits: [],
  readme: "",
} as any;

describe("slugifyGoal", () => {
  it("creates stable kebab-case slugs for plan artifacts", () => {
    expect(slugifyGoal("Add end-to-end /orchestrate smoke tests")).toBe(
      "add-end-to-end-orchestrate-smoke-tests",
    );
  });
});

describe("singleModelPlanArtifactName", () => {
  it("creates deterministic single-model artifact names", () => {
    expect(singleModelPlanArtifactName("TopStepX API Rate Limiter Guard")).toBe(
      "plans/topstepx-api-rate-limiter-guard.md",
    );
  });
});

describe("multiModelPlanArtifactNames", () => {
  it("creates deterministic final and per-planner artifact names", () => {
    const artifacts = multiModelPlanArtifactNames("TopStepX API Rate Limiter Guard");
    expect(artifacts.final).toBe("plans/topstepx-api-rate-limiter-guard-multi-model.md");
    expect(artifacts.planners.correctness).toBe(
      "plans/topstepx-api-rate-limiter-guard-multi-model/correctness.md",
    );
    expect(artifacts.planners.robustness).toBe(
      "plans/topstepx-api-rate-limiter-guard-multi-model/robustness.md",
    );
    expect(artifacts.planners.ergonomics).toBe(
      "plans/topstepx-api-rate-limiter-guard-multi-model/ergonomics.md",
    );
  });
});

describe("plan workflow handoff", () => {
  it("tells the agent to continue into agent_flywheel_approve_beads after writing the single-model plan", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "plan.ts"), "utf8");

    expect(source).toContain("After writing the artifact, immediately continue the workflow by calling");
    expect(source).toContain("agent_flywheel_approve_beads");
    expect(source).toContain("oc.state.planDocument = artifactName");
  });

  it("keeps the multi-model path inside agent_flywheel_approve_beads after synthesis", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "plan.ts"), "utf8");

    expect(source).toContain("review the synthesized plan in-menu");
    expect(source).toContain("Stay inside the AgentFlywheel workflow");
  });

  it("loads planner artifacts from sibling sub-agent sessions before re-prompting", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const source = readFileSync(join(__dirname, "plan.ts"), "utf8");

    expect(source).toContain("findSessionArtifactPath(ctx, artifactName)");
  });
});

describe("buildMultiModelPlanSubagentConfigs", () => {
  it("builds autonomous planner subagent configs that persist artifacts and exit", () => {
    const configs = buildMultiModelPlanSubagentConfigs(
      "/repo",
      "TopStepX API Rate Limiter Guard",
      profile,
      undefined,
    );

    expect(configs).toHaveLength(3);
    expect(configs.map((config) => config.name)).toEqual([
      "plan-correctness",
      "plan-robustness",
      "plan-ergonomics",
    ]);
    for (const config of configs) {
      expect(config.cwd).toBe("/repo");
      expect(config.task).toContain("write_artifact");
      expect(config.task).toContain("Do not create beads");
      expect(config.task).toContain("do not keep the pane open");
      expect(config.interactive).toBe(false);
    }
    expect(configs[0].agent).toBe("planner");
    expect(configs[1].agent).toBe("cc");
    expect(configs[1].launchMode).toBe("ntm_cc");
    expect(configs[1].launchInstruction).toContain("NTM Claude Code");
    expect(configs[1].task).toContain("must be launched in managed NTM Claude Code");
    expect(configs[2].model).toBe("openrouter/google/gemini-3.1-pro-preview");
    expect(configs[0].task).toContain(
      "plans/topstepx-api-rate-limiter-guard-multi-model/correctness.md",
    );
  });

  it("injects approved spec content into every planner task when provided (Superpowers multi-model)", () => {
    const approvedSpec =
      "## Spec Body\n- contract A must be preserved\n- non-goal: rewriting telemetry";
    const configs = buildMultiModelPlanSubagentConfigs(
      "/repo",
      "TopStepX API Rate Limiter Guard",
      profile,
      undefined,
      undefined,
      approvedSpec,
    );

    for (const config of configs) {
      expect(config.task).toContain("Approved Spec");
      expect(config.task).toContain("contract A must be preserved");
      expect(config.task).toContain("Treat the spec above as already accepted by the user");
    }
  });

  it("does NOT inject an Approved Spec section when no spec is supplied (native parity)", () => {
    const configs = buildMultiModelPlanSubagentConfigs(
      "/repo",
      "TopStepX API Rate Limiter Guard",
      profile,
      undefined,
    );
    for (const config of configs) {
      expect(config.task).not.toContain("Approved Spec");
    }
  });
});

describe("plan.ts — workflow-aware Superpowers branch", () => {
  const { readFileSync } = require("fs");
  const { join } = require("path");
  const source: string = readFileSync(join(__dirname, "plan.ts"), "utf8");

  it("accepts mode='superpowers' alongside single_model and multi_model", () => {
    expect(source).toContain('Type.Literal("superpowers")');
  });

  it("persists generationMode by ensuring planningWorkflow exists on first call", () => {
    expect(source).toContain("ensurePlanningWorkflowInitialized(oc.state)");
    expect(source).toContain("nativePlanningAdapter.createInitialState()");
  });

  it("routes through the workflow runner + adapter via planningDocumentKindFor", () => {
    expect(source).toContain("planningDocumentKindFor(oc.state)");
    expect(source).toContain("checkPlanningToolOrdering(\"flywheel_plan\", oc.state)");
  });

  it("Superpowers spec_generation writes specArtifact and leaves planDocument untouched", () => {
    // Find the spec-document branch and verify it sets specArtifact only.
    const specBranchStart = source.indexOf('if (documentKind === "spec")');
    expect(specBranchStart).toBeGreaterThan(-1);
    const specBranch = source.slice(specBranchStart, specBranchStart + 2000);
    expect(specBranch).toContain("specArtifact: artifactName");
    expect(specBranch).toContain('stage: "awaiting_spec_approval"');
    // Invariant: spec branch must NOT set planDocument
    expect(specBranch).not.toMatch(/oc\.state\.planDocument\s*=/);
    expect(specBranch).toContain("superpowersSpecPrompt");
  });

  it("Superpowers plan_generation reads approved spec body, sets planDocument, advances to awaiting_plan_approval", () => {
    expect(source).toContain("loadApprovedSpecBody(ctx, oc.state)");
    expect(source).toContain("implementationPlanFromSpecPrompt");
    // Search for the plan-from-spec branch
    const fromSpecIdx = source.indexOf("Single-agent implementation plan from approved spec");
    expect(fromSpecIdx).toBeGreaterThan(-1);
    const planBranch = source.slice(fromSpecIdx, fromSpecIdx + 1500);
    expect(planBranch).toContain("finalPlanArtifactName(goal)");
    expect(planBranch).toContain("oc.state.planDocument = artifactName");
    expect(planBranch).toContain('stage: "awaiting_plan_approval"');
  });

  it("Superpowers multi-model plan generation feeds approved spec into the deep-plan runner", () => {
    // The multi-model superpowers branch must pass approvedSpec through to
    // both the competing planners' prompts AND the runner options.
    const ssBranchIdx = source.indexOf("multi_model");
    expect(ssBranchIdx).toBeGreaterThan(-1);
    const allMulti = source;
    expect(allMulti).toMatch(/competingPlanAgentPrompt\([^)]*approvedSpec[^)]*\)/);
    expect(allMulti).toMatch(/runDeepPlanAgents\([^)]*\{\s*approvedSpec\s*\}\s*\)/m);
  });

  it("rejects mode='superpowers' when the active session is native", () => {
    expect(source).toContain('mode === "superpowers"');
    expect(source).toContain('"INVALID_INPUT"');
    expect(source).toContain("requires a Superpowers planning workflow");
  });

  it("rejects plan_generation when approved spec body cannot be loaded", () => {
    expect(source).toContain("approved spec artifact");
    expect(source).toContain('"NO_PLAN"');
  });

  it("native single_model and multi_model paths remain functionally unchanged", () => {
    // The native branch still uses singleModelPlanArtifactName/planDocumentPrompt
    // and multiModelPlanArtifactNames/buildMultiModelPlanSubagentConfigs.
    expect(source).toContain("singleModelPlanArtifactName(goal)");
    expect(source).toContain("planDocumentPrompt(goal, profile, scanResult)");
    expect(source).toContain("multiModelPlanArtifactNames(goal)");
    expect(source).toContain("buildMultiModelPlanSubagentConfigs(ctx.cwd, goal, profile, scanResult, ctx)");
  });
});
