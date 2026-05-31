/**
 * Self-Improvement Loop — Feedback & Prompt Tracking
 *
 * A. Post-orchestration feedback — structured survey saved after completion
 * B. Automatic CASS context injection — prepend relevant rules to prompts
 * C. Prompt effectiveness tracking — track which prompts produce real changes
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

// ─── A. Post-Orchestration Feedback ─────────────────────────

export interface OrchestrationFeedback {
  /** ISO timestamp. */
  timestamp: string;
  /** The orchestration goal. */
  goal: string;
  /** Total beads created. */
  beadCount: number;
  /** Beads completed successfully. */
  completedCount: number;
  /** Total iteration rounds (gates). */
  totalRounds: number;
  /** Plan quality score (if computed). */
  planQualityScore?: number;
  /** Foregone conclusion score (if computed). */
  foregoneScore?: number;
  /** Polish rounds before bead approval. */
  polishRounds: number;
  /** Whether convergence was reached. */
  converged: boolean;
  /** Phases that triggered regression. */
  regressions: string[];
  /** Space violations detected. */
  spaceViolationCount: number;
}

const FEEDBACK_DIR = ".pi/orchestrator-feedback";

/**
 * Collect feedback from the current orchestration state.
 */
export function collectFeedback(state: import("./types.js").OrchestratorState): OrchestrationFeedback {
  const beadResults = Object.values(state.beadResults ?? {});
  const completedCount = beadResults.filter((r) => r.status === "success").length;

  return {
    timestamp: new Date().toISOString(),
    goal: state.selectedGoal ?? "unknown",
    beadCount: state.activeBeadIds?.length ?? 0,
    completedCount,
    totalRounds: state.iterationRound,
    planQualityScore: state.planReadinessScore?.overall,
    foregoneScore: state.foregoneScore?.overall,
    polishRounds: state.polishRound,
    converged: state.polishConverged,
    regressions: [], // Populated from session history if available
    spaceViolationCount: 0, // Populated from session history if available
  };
}

/**
 * Save feedback to the project-local feedback directory.
 */
export function saveFeedback(cwd: string, feedback: OrchestrationFeedback): string {
  const dir = join(cwd, FEEDBACK_DIR);
  mkdirSync(dir, { recursive: true });
  const filename = `feedback-${Date.now()}.json`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify(feedback, null, 2), "utf8");
  return filepath;
}

/**
 * Load all feedback files from the project.
 */
export function loadAllFeedback(cwd: string): OrchestrationFeedback[] {
  const dir = join(cwd, FEEDBACK_DIR);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort() // chronological order
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), "utf8")) as OrchestrationFeedback;
        } catch {
          return null;
        }
      })
      .filter((f): f is OrchestrationFeedback => f != null);
  } catch {
    return [];
  }
}

/**
 * Compute aggregate stats from all feedback.
 */
export interface FeedbackStats {
  totalOrchestrations: number;
  avgBeadCount: number;
  avgCompletionRate: number;
  avgPolishRounds: number;
  convergenceRate: number;
  avgPlanQuality: number | null;
  avgForegoneScore: number | null;
}

export function computeFeedbackStats(feedbacks: OrchestrationFeedback[]): FeedbackStats {
  if (feedbacks.length === 0) {
    return {
      totalOrchestrations: 0,
      avgBeadCount: 0,
      avgCompletionRate: 0,
      avgPolishRounds: 0,
      convergenceRate: 0,
      avgPlanQuality: null,
      avgForegoneScore: null,
    };
  }

  const n = feedbacks.length;
  const avgBeadCount = feedbacks.reduce((s, f) => s + f.beadCount, 0) / n;
  const avgCompletionRate = feedbacks.reduce((s, f) => {
    return s + (f.beadCount > 0 ? f.completedCount / f.beadCount : 1);
  }, 0) / n;
  const avgPolishRounds = feedbacks.reduce((s, f) => s + f.polishRounds, 0) / n;
  const convergenceRate = feedbacks.filter((f) => f.converged).length / n;

  const planScores = feedbacks.filter((f) => f.planQualityScore != null).map((f) => f.planQualityScore!);
  const foregoneScores = feedbacks.filter((f) => f.foregoneScore != null).map((f) => f.foregoneScore!);

  return {
    totalOrchestrations: n,
    avgBeadCount: Math.round(avgBeadCount * 10) / 10,
    avgCompletionRate: Math.round(avgCompletionRate * 100),
    avgPolishRounds: Math.round(avgPolishRounds * 10) / 10,
    convergenceRate: Math.round(convergenceRate * 100),
    avgPlanQuality: planScores.length > 0 ? Math.round(planScores.reduce((s, v) => s + v, 0) / planScores.length) : null,
    avgForegoneScore: foregoneScores.length > 0 ? Math.round(foregoneScores.reduce((s, v) => s + v, 0) / foregoneScores.length) : null,
  };
}

export function formatFeedbackStats(stats: FeedbackStats): string {
  if (stats.totalOrchestrations === 0) return "No orchestration history yet.";
  const lines = [
    `📊 **Orchestration History** (${stats.totalOrchestrations} runs)`,
    `  Avg beads/run:      ${stats.avgBeadCount}`,
    `  Completion rate:     ${stats.avgCompletionRate}%`,
    `  Avg polish rounds:   ${stats.avgPolishRounds}`,
    `  Convergence rate:    ${stats.convergenceRate}%`,
  ];
  if (stats.avgPlanQuality != null) {
    lines.push(`  Avg plan quality:    ${stats.avgPlanQuality}/100`);
  }
  if (stats.avgForegoneScore != null) {
    lines.push(`  Avg foregone score:  ${stats.avgForegoneScore}/100`);
  }
  return lines.join("\n");
}

// ─── B. Automatic CASS Context Injection ────────────────────

/** Prepend CASS context to a prompt if available. */
export function withCassContext(prompt: string, cwd: string, taskDescription?: string): string {
  try {
    const { readMemory } = require("./memory.js");
    const memory = readMemory(cwd, taskDescription);
    if (!memory) return prompt;

    return `## Context from Prior Orchestrations\n${memory}\n\n---\n\n${prompt}`;
  } catch {
    return prompt;
  }
}

// ─── C. Prompt Effectiveness Tracking ───────────────────────

export interface PromptRecord {
  /** Prompt identifier (e.g., "beadRefinement", "blunderHunt"). */
  name: string;
  /** Number of times this prompt was used. */
  uses: number;
  /** Total changes produced across all uses. */
  changesProduced: number;
  /** Number of uses that produced at least 1 change. */
  effectiveUses: number;
}

// In-memory tracking for the current session
const _promptTracker: Map<string, PromptRecord> = new Map();

/**
 * Track a prompt use and its outcome.
 */
export function trackPromptUse(name: string, changesProduced: number): void {
  const existing = _promptTracker.get(name) ?? { name, uses: 0, changesProduced: 0, effectiveUses: 0 };
  existing.uses++;
  existing.changesProduced += changesProduced;
  if (changesProduced > 0) existing.effectiveUses++;
  _promptTracker.set(name, existing);
}

/**
 * Get all prompt tracking records for the current session.
 */
export function getPromptRecords(): PromptRecord[] {
  return Array.from(_promptTracker.values());
}

/**
 * Get the effectiveness rate for a specific prompt (0-1).
 */
export function getPromptEffectiveness(name: string): number | null {
  const record = _promptTracker.get(name);
  if (!record || record.uses === 0) return null;
  return record.effectiveUses / record.uses;
}

/**
 * Format prompt effectiveness for display.
 */
export function formatPromptEffectiveness(): string {
  const records = getPromptRecords();
  if (records.length === 0) return "";

  const sorted = records.sort((a, b) => {
    const aRate = a.uses > 0 ? a.effectiveUses / a.uses : 0;
    const bRate = b.uses > 0 ? b.effectiveUses / b.uses : 0;
    return bRate - aRate;
  });

  const lines = ["### Prompt Effectiveness (this session)"];
  for (const r of sorted) {
    const rate = r.uses > 0 ? Math.round((r.effectiveUses / r.uses) * 100) : 0;
    const bar = "█".repeat(Math.round(rate / 10)) + "░".repeat(10 - Math.round(rate / 10));
    lines.push(`  ${r.name}: ${bar} ${rate}% (${r.effectiveUses}/${r.uses} effective, ${r.changesProduced} total changes)`);
  }

  return lines.join("\n");
}

/**
 * Reset tracking (for testing).
 */
export function resetPromptTracking(): void {
  _promptTracker.clear();
}

// ─── D. Review Feedback Pattern Mining ──────────────────────

export interface ReviewFeedbackEntry {
  text: string;
  filePath?: string;
  source?: string;
}

export interface FeedbackRuleCandidate {
  id: string;
  theme: string;
  confidence: number;
  count: number;
  evidence: { text: string; filePath?: string; source?: string }[];
  affectedFiles: string[];
  agentsMdSuggestion: string;
  cassMemoryBullet: string;
  lintRuleSuggestion?: string;
}

interface FeedbackTheme {
  id: string;
  theme: string;
  patterns: RegExp[];
  agentsMdSuggestion: string;
  cassMemoryBullet: string;
  lintRuleSuggestion?: string;
}

const FEEDBACK_THEMES: FeedbackTheme[] = [
  {
    id: "effect-idioms",
    theme: "Effect idioms and service-layer style",
    patterns: [
      /\basync\s*\/\s*await\b|\basync\b|\bawait\b/i,
      /\btry\s*\/\s*catch\b|\btry\s*\{/i,
      /\bEffect\b|\bEffect\.fn\b/i,
      /\bOption\b|\bnull\b|\bundefined\b/i,
      /\.andThen\b/i,
      /\blayer\b|\bLive\b/i,
      /\byield\b.*\bservice|\bservice\b.*\byield/i,
      /\bparameter injection\b|\binject(?:ed|ion)?\b/i,
    ],
    agentsMdSuggestion:
      "For Effect-based modules, follow the local Effect idioms: prefer Effect.fn and .andThen, model absence with Option instead of null/undefined, avoid ad-hoc async/await and try/catch, name production layers `layer` rather than `Live`, and yield services through tags instead of parameter injection.",
    cassMemoryBullet:
      "When editing Effect code, first inspect local idioms and use Effect.fn/.andThen, Option for absence, tag-yielded services, and `layer` naming; avoid async/await, try/catch, null/undefined, and parameter injection unless existing code explicitly uses them.",
    lintRuleSuggestion:
      "Consider lint checks for async/await, try/catch, null/undefined, `Live` layer names, and parameter-injected services in Effect-heavy paths.",
  },
  {
    id: "verification-honesty",
    theme: "Verification honesty",
    patterns: [
      /all tests pass|tests passed|verification output|focused test|did not run|not run/i,
      /claim(?:ed)? .*pass|green result|suppress.*fail/i,
    ],
    agentsMdSuggestion:
      "Report verification exactly: name the commands actually run, preserve failing output, and do not imply the full suite passed when only focused checks ran.",
    cassMemoryBullet:
      "When reporting validation, cite exact commands and outcomes; do not upgrade focused or skipped checks into broad success claims.",
    lintRuleSuggestion:
      "Consider review-time checks for vague verification phrases such as 'all tests pass' without exact command evidence.",
  },
];

function normalizeFeedback(text: string): string {
  return text.toLowerCase().replace(/[`'"“”().,;:!?]/g, " ").replace(/\s+/g, " ").trim();
}

function candidateFromTheme(theme: FeedbackTheme, entries: ReviewFeedbackEntry[]): FeedbackRuleCandidate | undefined {
  const matched = entries.filter((entry) => theme.patterns.some((pattern) => pattern.test(entry.text)));
  const uniqueEvidence = new Map<string, ReviewFeedbackEntry>();
  for (const entry of matched) {
    const key = normalizeFeedback(entry.text);
    if (!uniqueEvidence.has(key)) uniqueEvidence.set(key, entry);
  }
  const evidence = Array.from(uniqueEvidence.values());
  if (evidence.length < 2) return undefined;

  const affectedFiles = Array.from(new Set(evidence.map((entry) => entry.filePath).filter((file): file is string => Boolean(file)))).sort();
  const patternHits = theme.patterns.filter((pattern) => matched.some((entry) => pattern.test(entry.text))).length;
  const confidence = Math.min(0.95, Math.max(0.55, 0.45 + evidence.length * 0.12 + patternHits * 0.04));

  return {
    id: theme.id,
    theme: theme.theme,
    confidence: Math.round(confidence * 100) / 100,
    count: evidence.length,
    evidence: evidence.slice(0, 5).map((entry) => ({ text: entry.text, filePath: entry.filePath, source: entry.source })),
    affectedFiles,
    agentsMdSuggestion: theme.agentsMdSuggestion,
    cassMemoryBullet: theme.cassMemoryBullet,
    lintRuleSuggestion: theme.lintRuleSuggestion,
  };
}

export function mineRepeatedReviewFeedback(entries: ReviewFeedbackEntry[]): FeedbackRuleCandidate[] {
  return FEEDBACK_THEMES
    .map((theme) => candidateFromTheme(theme, entries))
    .filter((candidate): candidate is FeedbackRuleCandidate => Boolean(candidate))
    .sort((a, b) => b.confidence - a.confidence || b.count - a.count || a.id.localeCompare(b.id));
}

export function formatFeedbackRuleCandidates(candidates: FeedbackRuleCandidate[]): string {
  if (candidates.length === 0) {
    return "No repeated review-feedback themes found. No AGENTS.md or CASS memory rule is proposed.";
  }

  const sections = ["## Review Feedback Rule Candidates", "Review and approve these before editing AGENTS.md or writing CASS memory."];
  for (const candidate of candidates) {
    sections.push(
      `\n### ${candidate.theme} (${Math.round(candidate.confidence * 100)}% confidence, ${candidate.count} evidence items)`,
      candidate.affectedFiles.length > 0 ? `Affected files: ${candidate.affectedFiles.join(", ")}` : "Affected files: not specified",
      "\nEvidence:",
      ...candidate.evidence.map((entry) => `- ${entry.filePath ? `${entry.filePath}: ` : ""}${entry.text}`),
      "\nAGENTS.md suggestion:",
      candidate.agentsMdSuggestion,
      "\nCASS memory bullet:",
      candidate.cassMemoryBullet,
      candidate.lintRuleSuggestion ? `\nOptional lint-rule suggestion:\n${candidate.lintRuleSuggestion}` : "",
    );
  }
  return sections.filter(Boolean).join("\n");
}

// ─── D. Per-Tool Feedback ────────────────────────────────────

export interface ToolFeedback {
  toolName: string;
  sessionId?: string;
  timestamp: number;
  /** 1-5 rating */
  usability: number;
  /** 1-5 rating */
  ergonomics: number;
  /** What went well */
  strengths: string[];
  /** What was confusing or missing */
  weaknesses: string[];
  /** Specific suggestions */
  suggestions: string[];
}

/**
 * Prompt text for collecting structured tool feedback from an agent.
 * Paste this into the agent's context after it finishes using a tool.
 */
export function toolFeedbackPrompt(toolName: string): string {
  return `## Tool Feedback Survey: ${toolName}\n\nYou just used ${toolName}. Please provide structured feedback so we can improve it.\n\n### Rate on 1-5:\n- **Usability**: How easy was it to use correctly?\n- **Ergonomics**: Did the API surface feel natural and agent-friendly?\n\n### Qualitative:\n- **Strengths**: What worked well? (list 1-3 items)\n- **Weaknesses**: What was confusing, missing, or annoying? (list 1-3 items)\n- **Suggestions**: Specific improvements you'd make (list 1-3 items)\n\n### Output Format (JSON)\n\`\`\`json\n{\n  "usability": <1-5>,\n  "ergonomics": <1-5>,\n  "strengths": ["..."],\n  "weaknesses": ["..."],\n  "suggestions": ["..."]\n}\n\`\`\``;
}

export function parseToolFeedback(output: string, toolName: string): ToolFeedback | null {
  const match = output.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const p = JSON.parse(match[1]);
    return {
      toolName,
      timestamp: Date.now(),
      usability: Math.min(5, Math.max(1, Math.round(p.usability ?? 3))),
      ergonomics: Math.min(5, Math.max(1, Math.round(p.ergonomics ?? 3))),
      strengths: Array.isArray(p.strengths) ? p.strengths : [],
      weaknesses: Array.isArray(p.weaknesses) ? p.weaknesses : [],
      suggestions: Array.isArray(p.suggestions) ? p.suggestions : [],
    };
  } catch { return null; }
}

/** Save tool feedback to .pi-agent-flywheel-feedback/tools/<toolName>.jsonl */
export function saveToolFeedback(cwd: string, feedback: ToolFeedback): void {
  try {
    const { mkdirSync: mkd, appendFileSync: apf } = require("fs");
    const { join: pj } = require("path");
    const dir = pj(cwd, ".pi-agent-flywheel-feedback", "tools");
    mkd(dir, { recursive: true });
    const file = pj(dir, `${feedback.toolName}.jsonl`);
    apf(file, JSON.stringify(feedback) + "\n", "utf8");
  } catch { /* best-effort */ }
}
