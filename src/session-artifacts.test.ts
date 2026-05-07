import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { findSessionArtifactPath, sessionArtifactPath, sessionArtifactRoot } from "./session-artifacts.js";

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
