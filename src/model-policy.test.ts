import { describe, expect, it } from "vitest";
import {
  enforceGoogleOpenRouterModel,
  isAnthropicModel,
  isDirectGoogleModel,
  launchModeForModel,
  toOpenRouterGoogleModel,
} from "./model-policy.js";

describe("model provider policy", () => {
  it("recognizes Anthropic models as NTM Claude Code pane work", () => {
    expect(isAnthropicModel("anthropic/claude-opus-4-6")).toBe(true);
    expect(isAnthropicModel("claude-sonnet-4-6")).toBe(true);
    expect(launchModeForModel("anthropic/claude-opus-4-6")).toBe("ntm_cc");
  });

  it("routes Gemini to Cursor NTM panes instead of subagent", () => {
    expect(isAnthropicModel("openai-codex/gpt-5.4")).toBe(false);
    expect(launchModeForModel("openrouter/google/gemini-3.1-pro-preview")).toBe("ntm_agent");
    expect(launchModeForModel("google-antigravity/gemini-3.1-pro-high")).toBe("ntm_agent");
  });

  it("normalizes direct Google/Gemini provider IDs to OpenRouter", () => {
    expect(isDirectGoogleModel("google-antigravity/gemini-3.1-pro-high")).toBe(true);
    expect(toOpenRouterGoogleModel("google-antigravity/gemini-3.1-pro-high")).toBe(
      "openrouter/google/gemini-3.1-pro-preview",
    );
    expect(enforceGoogleOpenRouterModel("google/gemini-2.5-pro")).toBe(
      "openrouter/google/gemini-2.5-pro",
    );
    expect(enforceGoogleOpenRouterModel("gemini-2.5-pro")).toBe(
      "openrouter/google/gemini-2.5-pro",
    );
  });

  it("leaves OpenRouter Google IDs untouched", () => {
    expect(isDirectGoogleModel("openrouter/google/gemini-3.1-pro-preview")).toBe(false);
    expect(enforceGoogleOpenRouterModel("openrouter/google/gemini-3.1-pro-preview")).toBe(
      "openrouter/google/gemini-3.1-pro-preview",
    );
  });
});
