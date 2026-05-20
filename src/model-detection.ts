import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-sonnet-4-6",
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
    "claude-opus-4-6",
    "gemini-3.1-pro",
    "claude-sonnet-4-6",
  ],
  openrouter: [
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-pro",
    "anthropic/claude-opus-4-6",
  ],
  groq: [], // Groq models are typically smaller/faster, not for planning
};

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

  const robustnessModel = selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? "anthropic/claude-opus-4-6";

  const ergonomicsModel = selectBestModel(providerMap, ["openrouter"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS)
    ?? "openrouter/google/gemini-3.1-pro-preview";

  const synthesisModel = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? "anthropic/claude-opus-4-6";

  // Build refinement rotation from available providers
  const refinementModels = buildRefinementRotation(providerMap);

  return {
    providers,
    hasAnthropic,
    hasOpenAI,
    hasGoogle,
    hasOpenCode,
    hasOpenRouter,
    hasGroq,
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
 */
function buildRefinementRotation(providerMap: Map<string, Set<string>>): string[] {
  const rotation: string[] = [];

  // Prefer Anthropic for reasoning
  const anthropicBest = selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS);
  if (anthropicBest) rotation.push(anthropicBest);

  // Add OpenAI/Codex for different perspective
  const openaiBest = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS);
  if (openaiBest && openaiBest !== rotation[0]) rotation.push(openaiBest);

  // Add Gemini for third perspective. Prefer OpenRouter when available so
  // Gemini rounds use the provider path that is easiest to route and monitor.
  const googleBest = selectBestModel(providerMap, ["openrouter"], PROVIDER_BEST_MODELS);
  if (googleBest && !rotation.includes(googleBest)) rotation.push(googleBest);

  // Fallback if we don't have enough diversity
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
