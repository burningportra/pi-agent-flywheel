/**
 * Wrong-Space Detector
 *
 * Detects when an agent is doing plan-space work in code-space.
 * Three heuristics (all fast, no LLM):
 * 1. Architecture invention — files modified outside bead's ### Files
 * 2. Scope creep — files changed >> bead's file list
 * 3. Uncertainty language — hedging in implementation summary
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Bead, WorkspaceChangeBaseline } from "./types.js";
import { resilientExec } from "./cli-exec.js";

// ─── Types ──────────────────────────────────────────────────

export type SpaceViolationType =
  | "architecture_invention"
  | "scope_creep"
  | "uncertainty";

export type SpaceViolationSeverity = "info" | "warning" | "critical";

export interface SpaceViolation {
  type: SpaceViolationType;
  severity: SpaceViolationSeverity;
  evidence: string;
  suggestion: string;
}

export interface ReviewChangedFilesResult {
  filesChanged: string[];
  source: "baseline-delta" | "bead-commit" | "working-tree" | "skipped";
  skippedReason?: string;
}

const SPACE_DETECTOR_IGNORED_PREFIXES = [
  ".beads/",
  ".pi-flywheel/",
  ".pi-agent-flywheel/",
  ".ntm/",
  ".agents/",
  "tmp/",
] as const;

function normalizeChangedPath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

export function normalizeChangedFiles(files: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const file of files) {
    const cleaned = normalizeChangedPath(file);
    if (!cleaned) continue;
    if (SPACE_DETECTOR_IGNORED_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    normalized.push(cleaned);
  }
  return normalized;
}

export function changedFilesSinceBaseline(currentFiles: string[], baselineFiles: string[]): string[] {
  const baseline = new Set(normalizeChangedFiles(baselineFiles));
  return normalizeChangedFiles(currentFiles).filter((file) => !baseline.has(file));
}

async function gitLines(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string[]> {
  const result = await resilientExec(pi, "git", args, { cwd, timeout: 5000, maxRetries: 0 });
  if (!result.ok) return [];
  return result.value.stdout.trim().split("\n").map((line) => line.trim()).filter(Boolean);
}

async function gitText(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | undefined> {
  const result = await resilientExec(pi, "git", args, { cwd, timeout: 5000, maxRetries: 0 });
  return result.ok ? result.value.stdout.trim() : undefined;
}

async function workingTreeChangedFiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const tracked = await gitLines(pi, cwd, ["diff", "--name-only", "HEAD"]);
  const untracked = await gitLines(pi, cwd, ["ls-files", "--others", "--exclude-standard"]);
  return normalizeChangedFiles([...tracked, ...untracked]);
}

export async function captureWorkspaceChangeBaseline(
  pi: ExtensionAPI,
  cwd: string
): Promise<WorkspaceChangeBaseline> {
  const head = await gitText(pi, cwd, ["rev-parse", "HEAD"]);
  return {
    head,
    changedFiles: await workingTreeChangedFiles(pi, cwd),
    capturedAt: new Date().toISOString(),
  };
}

export async function getReviewChangedFiles(
  pi: ExtensionAPI,
  cwd: string,
  beadId: string,
  baseline?: WorkspaceChangeBaseline
): Promise<ReviewChangedFilesResult> {
  const currentHead = await gitText(pi, cwd, ["rev-parse", "HEAD"]);
  const currentDirty = await workingTreeChangedFiles(pi, cwd);

  if (baseline) {
    const committed = baseline.head && currentHead && currentHead !== baseline.head
      ? await gitLines(pi, cwd, ["diff", "--name-only", baseline.head, currentHead])
      : [];
    return {
      filesChanged: normalizeChangedFiles([
        ...committed,
        ...changedFilesSinceBaseline(currentDirty, baseline.changedFiles),
      ]),
      source: "baseline-delta",
    };
  }

  const lastMessage = await gitText(pi, cwd, ["log", "-1", "--pretty=%B"]);
  if (lastMessage?.includes(beadId)) {
    return {
      filesChanged: normalizeChangedFiles(await gitLines(pi, cwd, ["diff", "--name-only", "HEAD~1", "HEAD"])),
      source: "bead-commit",
    };
  }

  if (currentDirty.length > 0) {
    return {
      filesChanged: [],
      source: "skipped",
      skippedReason: "workspace baseline unavailable and checkout has pre-existing uncommitted changes; skipping wrong-space detection to avoid false positives",
    };
  }

  return { filesChanged: [], source: "working-tree" };
}

// ─── File Extraction ────────────────────────────────────────

/**
 * Extract expected files from a bead's description.
 * Looks for ### Files: section and inline file references.
 * Returns normalized paths (no leading ./ or /).
 */
export function extractBeadFiles(bead: Bead): string[] {
  const desc = bead.description ?? "";
  const paths: string[] = [];

  // Match ### Files: section
  const filesSection = desc.match(/###\s*Files:\s*([^\n#]+(?:\n(?!###)[^\n#]*)*)/);
  if (filesSection) {
    const content = filesSection[1];
    // Split by commas, newlines, or list markers
    const candidates = content.split(/[,\n]/).map((s) =>
      s.replace(/^[-*\s]+/, "").trim()
    );
    for (const c of candidates) {
      const cleaned = c.replace(/^\.\//, "").trim();
      if (cleaned && /\.\w+$/.test(cleaned) && !cleaned.includes(" ")) {
        paths.push(cleaned);
      }
    }
  }

  // Also match inline file references like `src/foo.ts`
  const inlinePattern = /`((?:src|lib|test|tests|docs|scripts|bin)\/[\w./-]+\.\w+)`/g;
  let match: RegExpExecArray | null;
  while ((match = inlinePattern.exec(desc)) !== null) {
    const p = match[1];
    if (!paths.includes(p)) paths.push(p);
  }

  return paths;
}

// ─── Uncertainty Detection ──────────────────────────────────

const UNCERTAINTY_PATTERNS = [
  /\bi think\b/i,
  /\bmight need\b/i,
  /\bnot sure if\b/i,
  /\bnot sure whether\b/i,
  /\bprobably\b/i,
  /\bmaybe we should\b/i,
  /\bunclear whether\b/i,
  /\bI'm not confident\b/i,
  /\bthis is a guess\b/i,
  /\bneeds further investigation\b/i,
  /\bTODO.*figure out\b/i,
  /\bnot entirely sure\b/i,
  /\bthis might break\b/i,
  /\bhacky\b/i,
  /\bworkaround\b/i,
] as const;

/**
 * Count uncertainty signals in text.
 * Returns the number of distinct pattern matches.
 */
export function countUncertaintySignals(text: string): number {
  return UNCERTAINTY_PATTERNS.filter((p) => p.test(text)).length;
}

// ─── Core Detection ─────────────────────────────────────────

/**
 * Detect space violations after a bead implementation.
 * All heuristic — no LLM calls, runs in <1ms.
 *
 * @param bead The bead that was just implemented
 * @param summary The agent's implementation summary
 * @param feedback The agent's review feedback
 * @param filesChanged Files changed according to git diff (paths relative to repo root)
 */
export function detectSpaceViolations(
  bead: Bead,
  summary: string,
  feedback: string,
  filesChanged: string[]
): SpaceViolation[] {
  const violations: SpaceViolation[] = [];
  const beadFiles = extractBeadFiles(bead);
  const text = `${summary} ${feedback}`;

  // Skip detection if the bead has no file list (can't compare)
  if (beadFiles.length === 0) return violations;

  // ── 1. Architecture invention ──────────────────────────
  // Files created/modified that aren't in the bead's expected file list.
  // Normalize both sides for comparison (strip leading src/ etc. for fuzzy match).
  const unexpectedFiles = filesChanged.filter((changed) => {
    // Exact match
    if (beadFiles.some((bf) => changed === bf || changed.endsWith(`/${bf}`))) return false;
    // Fuzzy: check if the changed file's basename matches any bead file's basename
    const changedBase = changed.split("/").pop() ?? "";
    if (beadFiles.some((bf) => bf.split("/").pop() === changedBase)) return false;
    return true;
  });

  if (unexpectedFiles.length > beadFiles.length && unexpectedFiles.length >= 3) {
    violations.push({
      type: "architecture_invention",
      severity: unexpectedFiles.length > beadFiles.length * 2 ? "critical" : "warning",
      evidence: `${unexpectedFiles.length} files modified outside bead scope: ${unexpectedFiles.slice(0, 5).join(", ")}${unexpectedFiles.length > 5 ? ` (+${unexpectedFiles.length - 5} more)` : ""}`,
      suggestion: "This looks like plan-space work happening in code-space. Consider creating new beads for the unexpected scope.",
    });
  }

  // ── 2. Scope creep ────────────────────────────────────
  // Total files changed significantly exceeds bead's file list.
  if (filesChanged.length > beadFiles.length * 3 && filesChanged.length >= 5) {
    violations.push({
      type: "scope_creep",
      severity: filesChanged.length > beadFiles.length * 5 ? "critical" : "warning",
      evidence: `Bead lists ${beadFiles.length} files but ${filesChanged.length} were changed (${(filesChanged.length / beadFiles.length).toFixed(1)}x expansion)`,
      suggestion: "The bead may be under-specified. Consider splitting into multiple beads with explicit file ownership.",
    });
  }

  // ── 3. Uncertainty language ────────────────────────────
  // Hedging in the implementation summary suggests the bead was too vague.
  const uncertaintyCount = countUncertaintySignals(text);
  if (uncertaintyCount >= 3) {
    violations.push({
      type: "uncertainty",
      severity: uncertaintyCount >= 5 ? "critical" : "warning",
      evidence: `Implementation summary contains ${uncertaintyCount} uncertainty signals (e.g., "not sure", "might need", "probably")`,
      suggestion: "The bead description may be too vague. Enrich it with more context, rationale, and acceptance criteria before continuing.",
    });
  }

  return violations;
}

// ─── Formatting ─────────────────────────────────────────────

/**
 * Format space violations for display in the review UI.
 */
export function formatSpaceViolations(violations: SpaceViolation[]): string {
  if (violations.length === 0) return "";

  const severityEmoji: Record<SpaceViolationSeverity, string> = {
    info: "ℹ️",
    warning: "⚠️",
    critical: "🔴",
  };

  const typeLabels: Record<SpaceViolationType, string> = {
    architecture_invention: "Architecture Invention",
    scope_creep: "Scope Creep",
    uncertainty: "Uncertainty Detected",
  };

  const lines = ["### ⚠️ Space Violation Detected", ""];
  for (const v of violations) {
    lines.push(`${severityEmoji[v.severity]} **${typeLabels[v.type]}**: ${v.evidence}`);
    lines.push(`  → ${v.suggestion}`);
    lines.push("");
  }

  lines.push("This may indicate the plan or beads were insufficient for this work.");
  return lines.join("\n");
}
