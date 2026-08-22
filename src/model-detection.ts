import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import { delimiter, join } from "path";
import { enforceGoogleOpenRouterModel } from "./model-policy.js";

/**
 * Model detection and selection for orchestrator planning.
 *
 * Detects available model providers and selects appropriate models for
 * multi-model planning, refinement, and swarm execution.
 */

export interface ModelProvider {
  name: string;
  prefix: string;
  available: boolean;
  models: string[];
}

export interface DetectedModels {
  providers: ModelProvider[];
  hasAnthropic: boolean;
  hasOpenAI: boolean;
  hasGoogle: boolean;
  hasOpenCode: boolean;
  hasOpenRouter: boolean;
  hasGroq: boolean;
  /** Whether the local Claude Code CLI (`claude`) is available. */
  claudeCodeAvailable: boolean;
  /** Best available model for correctness planning */
  correctnessModel: string;
  /** Best available model for robustness planning */
  robustnessModel: string;
  /** Best available model for ergonomics planning */
  ergonomicsModel: string;
  /** Best available model for synthesis */
  synthesisModel: string;
  /** Models for refinement rotation */
  refinementModels: string[];
}

/**
 * Model preferences by provider, ordered by capability.
 * These are the "best" models from each provider for planning tasks.
 */
const PROVIDER_BEST_MODELS: Record<string, string[]> = {
  anthropic: [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-sonnet-4-5",
  ],
  "openai-codex": [
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex",
    "gpt-5-codex",
  ],
  openai: [
    "gpt-5.4",
    "gpt-5.1",
    "gpt-4.1",
    "gpt-4o",
  ],
  // Direct Google/Antigravity models are intentionally not selected for
  // planner/refinement roles. Gemini must route via OpenRouter (`openrouter/google/...`).
  "google-antigravity": [],
  opencode: [
    "gpt-5.4",
    "gpt-5.3-codex",
    "claude-opus-5",
    "gemini-3.1-pro",
    "claude-sonnet-5",
  ],
  // OpenRouter preference for the Gemini "ergonomics" role: keep Gemini first so
  // the plugin's "route Google via OpenRouter" intent is preserved. DeepSeek V4 /
  // GLM 5.3 are available below as complementary open-weight options.
  openrouter: [
    "google/gemini-3.1-pro-preview",
    "deepseek/deepseek-v4-pro-0813",
    "z-ai/glm-5.3",
    "anthropic/claude-opus-5",
    "google/gemini-2.5-pro",
  ],
  groq: [], // Groq models are typically smaller/faster, not for planning
};

/**
 * OpenRouter preference for frontier open-weight models — the fallback when the
 * local Claude Code CLI is absent. Lead with DeepSeek V4 Pro and GLM 5.3, then
 * fall through to Gemini/Claude-over-OpenRouter.
 */
const OPENWEIGHT_BEST_MODELS: Record<string, string[]> = {
  openrouter: [
    "deepseek/deepseek-v4-pro-0813",
    "z-ai/glm-5.3",
    "google/gemini-3.1-pro-preview",
    "anthropic/claude-opus-5",
    "google/gemini-2.5-pro",
  ],
};


/**
 * Whether the local Claude Code CLI is installed. Checked for the `claude`
 * binary (NOT `cc`, which on macOS is the C compiler). `FLYWHEEL_CLAUDE_CODE`
 * overrides the PATH probe for deterministic test/CI behavior.
 */
export function isClaudeCodeAvailable(): boolean {
  const override = process.env.FLYWHEEL_CLAUDE_CODE;
  if (override === "0" || override?.toLowerCase() === "false") return false;
  if (override === "1" || override?.toLowerCase() === "true") return true;

  const pathEnv = process.env.PATH ?? "";
  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude.ps1"]
    : ["claude"];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * Detect available model providers and their models from pi's model registry.
 */
export function detectAvailableModels(ctx: ExtensionContext): DetectedModels {
  const availableModels = ctx.modelRegistry?.getAvailable?.() ?? [];
  const currentModel = ctx.model;

  // Group models by provider
  const providerMap = new Map<string, Set<string>>();

  for (const model of availableModels) {
    const provider = model.provider ?? "default";
    if (!providerMap.has(provider)) {
      providerMap.set(provider, new Set());
    }
    providerMap.get(provider)!.add(model.id);
  }

  // Detect providers
  const hasAnthropic = providerMap.has("anthropic");
  const hasOpenAI = providerMap.has("openai") || providerMap.has("openai-codex");
  // Direct Google providers may exist, but AgentFlywheel only routes Gemini via OpenRouter.
  const hasGoogle = providerMap.has("google-antigravity") || providerMap.has("google") || hasOpenRouterGoogle(providerMap);
  const hasOpenCode = providerMap.has("opencode");
  const hasOpenRouter = providerMap.has("openrouter");
  const hasGroq = providerMap.has("groq");
  const claudeCodeAvailable = isClaudeCodeAvailable();

  // Build provider list
  const providers: ModelProvider[] = [];
  for (const [name, models] of providerMap) {
    providers.push({
      name,
      prefix: name,
      available: true,
      models: [...models],
    });
  }

  // Select best models for each planning role
  const correctnessModel = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? "anthropic/claude-opus-4-6";

  const anthropicBest = selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS);
  const openWeightBest = selectBestModel(providerMap, ["openrouter"], OPENWEIGHT_BEST_MODELS);

  // When Claude Code is installed, prefer Claude for reasoning-heavy roles; else
  // fall back to the frontier open-weight models (DeepSeek V4 / GLM 5.3) that
  // route through OpenRouter.
  const robustnessModel = claudeCodeAvailable
    ? (anthropicBest ?? openWeightBest ?? "anthropic/claude-opus-4-6")
    : (openWeightBest ?? anthropicBest ?? "anthropic/claude-opus-4-6");

  const ergonomicsModel = selectBestModel(providerMap, ["openrouter"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS)
    ?? "openrouter/google/gemini-3.1-pro-preview";

  const synthesisModel = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? "anthropic/claude-opus-4-6";

  // Build refinement rotation from available providers
  const refinementModels = buildRefinementRotation(providerMap, claudeCodeAvailable);

  return {
    providers,
    hasAnthropic,
    hasOpenAI,
    hasGoogle,
    hasOpenCode,
    hasOpenRouter,
    hasGroq,
    claudeCodeAvailable,
    correctnessModel,
    robustnessModel,
    ergonomicsModel,
    synthesisModel,
    refinementModels,
  };
}

/**
 * Select the best available model from a list of preferred providers.
 */
function selectBestModel(
  providerMap: Map<string, Set<string>>,
  preferredProviders: string[],
  providerBestModels: Record<string, string[]>
): string | null {
  for (const provider of preferredProviders) {
    const models = providerMap.get(provider);
    if (!models) continue;

    const bestForProvider = providerBestModels[provider] ?? [];
    for (const preferred of bestForProvider) {
      if (models.has(preferred)) {
        return enforceGoogleOpenRouterModel(`${provider}/${preferred}`);
      }
    }
  }
  return null;
}

function hasOpenRouterGoogle(providerMap: Map<string, Set<string>>): boolean {
  const models = providerMap.get("openrouter");
  return Boolean(models && [...models].some((model) => model.startsWith("google/")));
}

/**
 * Build a rotation of models from different providers for refinement rounds.
 * Using different providers helps avoid anchoring bias.
 *
 * When the local Claude Code CLI is present we lead with Claude (Anthropic);
 * otherwise we lead with the frontier open-weight model via OpenRouter (DeepSeek
 * V4 / GLM 5.3) so rounds stay on a strong, launchable surface.
 */
function buildRefinementRotation(providerMap: Map<string, Set<string>>, claudeCodeAvailable: boolean): string[] {
  const rotation: string[] = [];

  const anthropicBest = selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS);
  const openWeightBest = selectBestModel(providerMap, ["openrouter"], OPENWEIGHT_BEST_MODELS);
  const openaiBest = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS);

  // Lead with Claude when it's installed; otherwise with the open-weight
  // frontier via OpenRouter (falling back to Claude if available).
  const lead = claudeCodeAvailable ? anthropicBest : (openWeightBest ?? anthropicBest);
  if (lead) rotation.push(lead);

  // Add the other perspectives for diversity, deduped against the lead.
  const rest = [openaiBest, claudeCodeAvailable ? openWeightBest : anthropicBest].filter((m): m is string => Boolean(m));
  for (const candidate of rest) {
    if (!rotation.includes(candidate)) rotation.push(candidate);
  }

  // Fallbacks to guarantee a usable rotation.
  if (rotation.length === 0) {
    rotation.push("anthropic/claude-opus-4-6");
  }
  if (rotation.length === 1) {
    rotation.push("openai-codex/gpt-5.4");
  }
  if (rotation.length === 2) {
    rotation.push("openrouter/google/gemini-3.1-pro-preview");
  }

  return rotation;
}

/**
 * Get deep planning models based on detected availability.
 * Falls back to hardcoded defaults if detection fails.
 */
export function getDeepPlanModels(ctx: ExtensionContext): {
  correctness: string;
  robustness: string;
  ergonomics: string;
  synthesis: string;
} {
  try {
    const detected = detectAvailableModels(ctx);
    return {
      correctness: detected.correctnessModel,
      robustness: detected.robustnessModel,
      ergonomics: detected.ergonomicsModel,
      synthesis: detected.synthesisModel,
    };
  } catch {
    // Fallback to hardcoded defaults
    return {
      correctness: "openai-codex/gpt-5.4",
      robustness: "anthropic/claude-opus-4-6",
      ergonomics: "openrouter/google/gemini-3.1-pro-preview",
      synthesis: "openai-codex/gpt-5.4",
    };
  }
}

/**
 * Get refinement model for a given round, using detected models.
 */
export function getRefinementModel(ctx: ExtensionContext, round: number): string {
  try {
    const detected = detectAvailableModels(ctx);
    const models = detected.refinementModels;
    return models[round % models.length] ?? "anthropic/claude-opus-4-6";
  } catch {
    // Fallback to hardcoded rotation
    const fallbacks = [
      "anthropic/claude-opus-4-6",
      "openai-codex/gpt-5.4",
      "openrouter/google/gemini-3.1-pro-preview",
    ];
    return fallbacks[round % fallbacks.length];
  }
}

/**
 * Format detected models for display.
 */
export function formatDetectedModels(detected: DetectedModels): string {
  const lines: string[] = [];

  lines.push("## Detected Model Providers");
  lines.push("");

  const providerStatus = [
    ["Anthropic", detected.hasAnthropic],
    ["OpenAI", detected.hasOpenAI],
    ["Google", detected.hasGoogle],
    ["OpenCode", detected.hasOpenCode],
    ["OpenRouter", detected.hasOpenRouter],
  ];

  for (const [name, available] of providerStatus) {
    const icon = available ? "✅" : "❌";
    lines.push(`${icon} ${name}`);
  }

  lines.push("");
  lines.push("## Planning Model Selection");
  lines.push("");
  lines.push(`- **Correctness:** ${detected.correctnessModel}`);
  lines.push(`- **Robustness:** ${detected.robustnessModel}`);
  lines.push(`- **Ergonomics:** ${detected.ergonomicsModel}`);
  lines.push(`- **Synthesis:** ${detected.synthesisModel}`);
  lines.push("");
  lines.push("**Refinement Rotation:**");
  for (const model of detected.refinementModels) {
    lines.push(`- ${model}`);
  }

  return lines.join("\n");
}
