import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  brainstormingDecisionRecordArtifactName,
  finalPlanArtifactName,
  findSessionArtifactPath,
  sessionArtifactPath,
  sessionArtifactRoot,
  specArtifactName,
} from "./session-artifacts.js";
import {
  computePlanningWorkflowFingerprint,
  slugifyWorkflowGoal,
} from "./workflows/artifacts.js";

function makeCtx(overrides?: Partial<any>) {
  return {
    cwd: "/repo",
    sessionManager: {
      getSessionDir: () => "/sessions-root/project",
      getSessionId: () => "session-123",
      getSessionFile: () => "/sessions-root/project/2026-04-07T00-00-00.jsonl",
      ...overrides?.sessionManager,
    },
    ...overrides,
  } as any;
}

describe("sessionArtifactRoot", () => {
  it("uses sessionDir and sessionId instead of deriving from the session jsonl path", () => {
    const root = sessionArtifactRoot(makeCtx());
    expect(root).toBe("/sessions-root/project/artifacts/session-123");
    expect(root).not.toContain(".jsonl/artifacts");
  });

  it("falls back to cwd when no session metadata exists", () => {
    const root = sessionArtifactRoot(makeCtx({
      sessionManager: {
        getSessionDir: () => undefined,
        getSessionId: () => undefined,
        getSessionFile: () => undefined,
      },
    }));
    expect(root).toBe("/repo/.pi-agent-flywheel-artifacts");
  });
});

describe("sessionArtifactPath", () => {
  it("resolves nested artifact paths under the artifact root", () => {
    const filePath = sessionArtifactPath(makeCtx(), "plans/my-plan.md");
    expect(filePath).toBe("/sessions-root/project/artifacts/session-123/plans/my-plan.md");
  });
});

describe("brainstormingDecisionRecordArtifactName", () => {
  it("creates deterministic brainstorming names outside saved-plan discovery", () => {
    const artifactName = brainstormingDecisionRecordArtifactName("Adopt Claude Code / Superpowers brainstorming!");
    expect(artifactName).toBe("brainstorming/adopt-claude-code-superpowers-brainstorming-decision.md");
    expect(artifactName.startsWith("plans/")).toBe(false);
  });
});

describe("findSessionArtifactPath", () => {
  it("finds artifacts written by sibling sub-agent sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "artifact-sibling-test-"));
    const artifactName = "plans/demo-multi-model/correctness.md";
    const filePath = join(root, "artifacts", "child-session", artifactName);
    mkdirSync(join(root, "artifacts", "child-session", "plans", "demo-multi-model"), { recursive: true });
    writeFileSync(filePath, "# Correctness plan", "utf8");

    const found = findSessionArtifactPath(makeCtx({
      sessionManager: {
        getSessionDir: () => root,
        getSessionId: () => "parent-session",
      },
    }), artifactName);

    expect(found).toBe(filePath);
  });

  it("prefers the current session artifact when present", () => {
    const root = mkdtempSync(join(tmpdir(), "artifact-direct-test-"));
    const artifactName = "plans/demo.md";
    const directPath = join(root, "artifacts", "parent-session", artifactName);
    const siblingPath = join(root, "artifacts", "child-session", artifactName);
    mkdirSync(join(root, "artifacts", "parent-session", "plans"), { recursive: true });
    mkdirSync(join(root, "artifacts", "child-session", "plans"), { recursive: true });
    writeFileSync(directPath, "# Parent", "utf8");
    writeFileSync(siblingPath, "# Child", "utf8");

    const found = findSessionArtifactPath(makeCtx({
      sessionManager: {
        getSessionDir: () => root,
        getSessionId: () => "parent-session",
      },
    }), artifactName);

    expect(found).toBe(directPath);
  });
});

describe("slugifyWorkflowGoal", () => {
  it("normalizes goals into kebab-case slugs", () => {
    expect(slugifyWorkflowGoal("Adopt Superpowers Spec Workflow!"))
      .toBe("adopt-superpowers-spec-workflow");
  });

  it("falls back when the goal collapses to empty", () => {
    expect(slugifyWorkflowGoal("...", "spec")).toBe("spec");
  });
});

describe("specArtifactName", () => {
  it("places spec artifacts outside the plans/ saved-plan discovery prefix", () => {
    const name = specArtifactName("Adopt Superpowers Spec Workflow");
    expect(name).toBe("superpowers/specs/adopt-superpowers-spec-workflow.md");
    expect(name.startsWith("plans/")).toBe(false);
  });

  it("does not collide with the final implementation-plan path for the same goal", () => {
    const goal = "Add Superpowers spec workflow";
    expect(specArtifactName(goal)).not.toBe(finalPlanArtifactName(goal));
    expect(finalPlanArtifactName(goal)).toMatch(/^plans\//);
    expect(specArtifactName(goal)).not.toMatch(/^plans\//);
  });
});

describe("finalPlanArtifactName", () => {
  it("preserves the legacy plans/<slug>.md contract for final plans", () => {
    expect(finalPlanArtifactName("Add Superpowers spec workflow"))
      .toBe("plans/add-superpowers-spec-workflow.md");
  });
});

describe("computePlanningWorkflowFingerprint", () => {
  const baseInput = {
    goal: "Add Superpowers spec workflow",
    constraints: ["typescript", "no-new-deps"],
    adapterId: "superpowers",
  };

  it("is deterministic for identical inputs", () => {
    const a = computePlanningWorkflowFingerprint(baseInput);
    const b = computePlanningWorkflowFingerprint({ ...baseInput });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is constraint-order independent", () => {
    const a = computePlanningWorkflowFingerprint(baseInput);
    const b = computePlanningWorkflowFingerprint({
      ...baseInput,
      constraints: ["no-new-deps", "typescript"],
    });
    expect(a).toBe(b);
  });

  it("changes when the goal text changes", () => {
    const a = computePlanningWorkflowFingerprint(baseInput);
    const b = computePlanningWorkflowFingerprint({
      ...baseInput,
      goal: "Different goal entirely",
    });
    expect(a).not.toBe(b);
  });

  it("changes when the adapter id changes", () => {
    const a = computePlanningWorkflowFingerprint(baseInput);
    const b = computePlanningWorkflowFingerprint({
      ...baseInput,
      adapterId: "native",
    });
    expect(a).not.toBe(b);
  });

  it("includes brainstorm and spec artifact references in the digest", () => {
    const a = computePlanningWorkflowFingerprint(baseInput);
    const withBrainstorm = computePlanningWorkflowFingerprint({
      ...baseInput,
      brainstormDecisionArtifact: "brainstorming/foo-decision.md",
    });
    const withSpec = computePlanningWorkflowFingerprint({
      ...baseInput,
      specArtifact: "superpowers/specs/foo.md",
    });
    expect(a).not.toBe(withBrainstorm);
    expect(a).not.toBe(withSpec);
    expect(withBrainstorm).not.toBe(withSpec);
  });

  it("treats blank and whitespace-only constraints as absent", () => {
    const clean = computePlanningWorkflowFingerprint(baseInput);
    const noisy = computePlanningWorkflowFingerprint({
      ...baseInput,
      constraints: ["typescript", "   ", "", "no-new-deps"],
    });
    expect(clean).toBe(noisy);
  });
});
