import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";

type ArtifactContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

export function sessionArtifactRoot(ctx: ArtifactContext): string {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();

  if (sessionDir && sessionId) {
    return join(sessionDir, "artifacts", sessionId);
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile && sessionId) {
    return join(dirname(sessionFile), "..", "artifacts", sessionId);
  }

  return join(ctx.cwd, ".pi-agent-flywheel-artifacts");
}

export function sessionArtifactPath(ctx: ArtifactContext, name: string): string {
  return join(sessionArtifactRoot(ctx), name);
}

function slugifyArtifactName(input: string, fallback: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || fallback;
}

export function brainstormingDecisionRecordArtifactName(rawGoal: string): string {
  return `brainstorming/${slugifyArtifactName(rawGoal, "goal")}-decision.md`;
}

/**
 * Re-export of the Superpowers-style spec artifact namer from
 * `workflows/artifacts.ts`. Kept here so callers can import every
 * artifact-naming helper from `session-artifacts.ts` without knowing the
 * internal workflow module layout.
 */
export { specArtifactName, finalPlanArtifactName } from "./workflows/artifacts.js";

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function addIfDirectory(set: Set<string>, path: string): void {
  if (existsSync(path)) set.add(path);
}

/**
 * Locate an artifact by name, including artifacts written by sub-agent sessions.
 *
 * Main-session artifacts live at:
 *   <sessionDir>/artifacts/<sessionId>/<name>
 * Sub-agents use their own session ids under the same artifacts directory, so a
 * parent workflow must search sibling artifact roots after interactive agents
 * complete.
 *
 * A legacy layout (<sessionDir>/<sessionId>/artifacts/<artifactSessionId>) is
 * also searched for older sessions.
 */
export function findSessionArtifactPath(ctx: ArtifactContext, name: string): string | undefined {
  const direct = sessionArtifactPath(ctx, name);
  if (existsSync(direct)) return direct;

  const sessionDir = ctx.sessionManager.getSessionDir();
  if (!sessionDir) return undefined;

  const artifactRoots = new Set<string>();
  addIfDirectory(artifactRoots, join(sessionDir, "artifacts"));

  for (const entry of safeReaddir(sessionDir)) {
    addIfDirectory(artifactRoots, join(sessionDir, entry, "artifacts"));
  }

  for (const root of artifactRoots) {
    for (const artifactSessionId of safeReaddir(root)) {
      const candidate = join(root, artifactSessionId, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return undefined;
}
