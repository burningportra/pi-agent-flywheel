/**
 * Provider routing policy for agent-backed work.
 *
 * These helpers keep model/provider constraints explicit and testable instead of
 * relying on agents to remember operational rules from AGENTS.md.
 */

export type PlannerLaunchMode = "subagent" | "ntm_cc" | "ntm_agent";

export function isAnthropicModel(model: string | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return lower.startsWith("anthropic/") || lower.startsWith("claude-") || lower.includes("/claude-");
}

export function isOpenRouterGoogleModel(model: string | undefined): boolean {
  return Boolean(model?.toLowerCase().startsWith("openrouter/google/"));
}

export function isDirectGoogleModel(model: string | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  if (isOpenRouterGoogleModel(lower)) return false;
  return (
    lower.startsWith("google/") ||
    lower.startsWith("google-antigravity/") ||
    lower.startsWith("gemini-") ||
    lower.includes("/gemini-")
  );
}

export function toOpenRouterGoogleModel(model: string): string {
  const lower = model.toLowerCase();
  if (isOpenRouterGoogleModel(lower)) return model;

  const raw = model.split("/").pop() || model;
  const id = raw
    // Antigravity's "high" variant is provider-specific; route to the
    // closest OpenRouter model family instead.
    .replace(/-high$/i, "-preview");

  return `openrouter/google/${id}`;
}

export function enforceGoogleOpenRouterModel(model: string): string {
  return isDirectGoogleModel(model) ? toOpenRouterGoogleModel(model) : model;
}

export function isOpenAICodexModel(model: string | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return (
    lower.startsWith("openai/") ||
    lower.startsWith("openai-codex/") ||
    lower.includes("codex") ||
    lower.includes("gpt-")
  );
}

export function launchModeForModel(model: string | undefined): PlannerLaunchMode {
  if (isAnthropicModel(model)) return "ntm_cc";
  if (isDirectGoogleModel(model) || isOpenRouterGoogleModel(model)) return "ntm_agent";
  return "subagent";
}

export function providerPolicyNoteForModel(model: string | undefined): string | undefined {
  if (isAnthropicModel(model)) {
    return "Anthropic/Claude models must be launched in managed NTM Claude Code (`cc`) panes; do not use the subagent tool.";
  }
  if (isDirectGoogleModel(model) || isOpenRouterGoogleModel(model)) {
    return "Google/Gemini models must be launched in managed NTM Cursor (`--cursor`) panes backed by the official Cursor Agent CLI command `agent`, not Gemini (`gmi`) panes or hidden subagents. Prefer OpenRouter model IDs (`openrouter/google/...`) inside Cursor when needed.";
  }
  return undefined;
}
