import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Bead, VerificationContract } from "./types.js";
import { join } from "path";
import { enforceGoogleOpenRouterModel } from "./model-policy.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";

export interface CrossModelReviewResult {
  suggestions: string[];
  rawOutput: string;
  model: string;
  error?: string;
  fallbackUsed?: boolean;
}

export interface VerificationEvidenceAssessment {
  ok: boolean;
  requiredCommands: string[];
  missingCommands: string[];
  issues: string[];
  manualFallbackUsed: boolean;
}

const COMMAND_START = /\b(?:npm|pnpm|yarn|bun|cargo|go|pytest|python|python3|vitest|tsc|br|bv|git)\b[^;\n]*/gi;

function normalizeEvidenceText(text: string): string {
  return text.toLowerCase().replace(/[`'"“”]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeCommand(command: string): string {
  return command
    .replace(/^run\s+/i, "")
    .replace(/\s+and\s*$/i, "")
    .replace(/\s+or\s*$/i, "")
    .replace(/[.)]+$/g, "")
    .trim();
}

export function extractVerificationCommands(contract: VerificationContract): string[] {
  const commands: string[] = [];
  const matches = contract.body.match(COMMAND_START);
  if (!matches) return commands;
  
  for (const match of matches) {
    const raw = match
      .split(/\s+and\s+(?=(?:npm|pnpm|yarn|bun|cargo|go|pytest|python|python3|vitest|tsc|br|bv|git)\b)/i)
      .flatMap((part) => part.split(/\s*,\s*(?=(?:npm|pnpm|yarn|bun|cargo|go|pytest|python|python3|vitest|tsc|br|bv|git)\b)/i));
    for (const part of raw) {
      const command = normalizeCommand(part);
      if (command.length > 0 && !commands.includes(command)) commands.push(command);
    }
  }
  return commands;
}

export function assessVerificationEvidence(
  contract: VerificationContract,
  evidence: string
): VerificationEvidenceAssessment {
  const requiredCommands = extractVerificationCommands(contract);
  const normalizedEvidence = normalizeEvidenceText(evidence);
  const manualFallbackUsed = /manual\s+(?:proof|evidence|verification|fallback)|fallback\s+(?:proof|evidence)|manual\s+inspect/i.test(evidence);
  const mentionsAutomationBlocked = /(?:could not|couldn't|cannot|can't|unable to|blocked|unavailable|missing dependency|environment).{0,80}(?:run|execute|automation|command|check|test)|(?:command|check|test).{0,80}(?:could not|couldn't|cannot|can't|unable to|blocked|unavailable)/i.test(evidence);
  const reportsFailureOrSkipped = /\b(?:failed|failing|failure|skipped|skip|not run|did not run|wasn't run|was not run|not executed)\b/i.test(evidence);
  const genericOnly = /\b(?:tests passed|all tests pass|build passed|checks passed|verified|looks good)\b/i.test(evidence)
    && requiredCommands.length > 0
    && requiredCommands.every((command) => !normalizedEvidence.includes(normalizeEvidenceText(command)));

  const missingCommands = requiredCommands.filter((command) => !normalizedEvidence.includes(normalizeEvidenceText(command)));
  const issues: string[] = [];

  if (requiredCommands.length === 0 && !manualFallbackUsed) {
    issues.push("verification contract does not expose a concrete command/check to match against");
  }

  if (missingCommands.length > 0 && !(manualFallbackUsed && mentionsAutomationBlocked)) {
    issues.push(`missing evidence for required command/check(s): ${missingCommands.join(", ")}`);
  }

  if (genericOnly) {
    issues.push("generic evidence is insufficient; cite the exact command/check named by the verification contract");
  }

  if (reportsFailureOrSkipped && !(manualFallbackUsed && mentionsAutomationBlocked)) {
    issues.push("failed or skipped verification cannot be treated as a passing review without a justified manual proof fallback");
  }

  return {
    ok: issues.length === 0,
    requiredCommands,
    missingCommands,
    issues,
    manualFallbackUsed,
  };
}

/**
 * Send beads to an alternative model for cross-model review.
 * Uses pi --print with a different model to get a fresh perspective.
 */
export async function crossModelBeadReview(
  pi: ExtensionAPI,
  cwd: string,
  beads: Bead[],
  goal: string,
  signal?: AbortSignal
): Promise<CrossModelReviewResult> {
  // Pick an alternative model — try to use something different from the current session
  const altModel = pickAlternativeModel();

  const beadList = beads.map((b) => {
    return `### Bead ${b.id}: ${b.title}
Priority: ${b.priority} | Type: ${b.type} | Status: ${b.status}
${b.description}`;
  }).join("\n\n---\n\n");

  const prompt = `You are reviewing a set of implementation beads (tasks) for the goal: "${goal}"

## Beads to Review

${beadList}

## Your Task
Review these beads critically. Look for:
1. **Gaps in coverage** — is anything missing that the goal requires?
2. **Oversimplifications** — are any beads too vague or hand-wavy?
3. **Missing dependencies** — should any bead depend on another that it doesn't?
4. **Unclear scope** — would a fresh developer know exactly what to do?
5. **Split or merge candidates** — are any beads too large (should split) or too small (should merge)?
6. **Redundancies** — do any beads overlap significantly?

Output specific, actionable suggestions as a numbered list. Each suggestion should reference specific bead IDs.
Be specific. If everything looks solid, explain briefly why each bead is well-formed. Always output a numbered list.
Check for: parallel-ready beads that modify the same files, closure extraction feasibility, missing error handling, vague acceptance criteria.`;

  const outputDir = join(tmpdir(), `pi-bead-review-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const taskFile = join(outputDir, "review-task.md");
  writeFileSync(taskFile, prompt, "utf8");

  try {
    const args = [
      "--print",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--tools", "read,bash",
    ];

    if (altModel) {
      args.push("--model", altModel);
    }

    args.push(`@${taskFile}`);

    const result = await pi.exec("pi", args, {
      timeout: 120000, // 2 min
      cwd,
      signal,
    });

    const rawOutput = result.stdout.trim();
    const suggestions = parseSuggestions(rawOutput);
    const fallbackUsed = suggestions.length > 0 && !rawOutput.match(/^\s*\d+\.\s+/m) && !rawOutput.match(/^\s*[-*•]\s+/m);

    // Clean up temp files
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }

    return {
      suggestions,
      rawOutput,
      model: altModel ?? "default",
      fallbackUsed: fallbackUsed || undefined,
    };
  } catch (err) {
    // Clean up temp files on error too
    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }

    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      suggestions: [],
      rawOutput: errorMessage,
      model: altModel ?? "default",
      error: errorMessage,
    };
  }
}

/**
 * Pick an alternative model for cross-review.
 * Tries to select a model different from the likely current session model.
 */
function pickAlternativeModel(): string | undefined {
  // pi-r47 changes: Adjust model picking logic to ensure a fresh perspective based on verification needs
  // Default to Gemini through OpenRouter — different provider perspective from Claude
  // while respecting AgentFlywheel's provider routing policy.
  return enforceGoogleOpenRouterModel("gemini-2.5-pro");
}

/**
 * Parse suggestions from model output.
 * Supports numbered lists, bullet points, markdown headers, and paragraph fallback.
 */
export function parseSuggestions(output: string): string[] {
  const lines = output.split("\n");
  const suggestions: string[] = [];
  let current = "";

  for (const line of lines) {
    // Numbered list: "1. something"
    const numMatch = line.match(/^\s*(\d+)\.\s+(.+)/);
    // Bullet point: "- something", "* something", "• something"
    const bulletMatch = !numMatch && line.match(/^\s*[-*•]\s+(.+)/);
    // Markdown header: "## something"
    const headerMatch = !numMatch && !bulletMatch && line.match(/^#{1,3}\s+(.+)/);

    if (numMatch) {
      if (current) suggestions.push(current.trim());
      current = numMatch[2];
    } else if (bulletMatch) {
      if (current) suggestions.push(current.trim());
      current = bulletMatch[1];
    } else if (headerMatch) {
      // Headers act as section delimiters — flush current, but don't start a new suggestion from the header itself
      if (current) suggestions.push(current.trim());
      current = "";
    } else if (current && line.trim()) {
      current += " " + line.trim();
    }
  }
  if (current) suggestions.push(current.trim());

  // Paragraph fallback: if nothing parsed, split on double newlines
  if (suggestions.length === 0 && output.trim()) {
    const paragraphs = output.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
    return paragraphs;
  }

  return suggestions;
}
