import { describe, expect, it } from "vitest";
import {
  formatNtmSpawnFlags,
  recommendSwarmPaneMix,
  resolveSinglePaneSpec,
  scalePaneMixToTotal,
  paneSpecsForLaunch,
  totalPaneCount,
} from "./ntm-spawn.js";

describe("formatNtmSpawnFlags", () => {
  it("formats mixed pane flags with NTM's Cursor flag", () => {
    const flags = formatNtmSpawnFlags([
      { kind: "cc", count: 1, model: "opus" },
      { kind: "cod", count: 1 },
      { kind: "cursor", count: 1 },
    ]);
    expect(flags).toContain("--cc=1:opus");
    expect(flags).toContain("--cod=1");
    expect(flags).toContain("--cursor=1");
    expect(flags).not.toContain("--agent=");
    expect(flags).not.toContain("--gmi");
  });

  it("maps legacy agent pane specs to NTM's Cursor flag", () => {
    expect(formatNtmSpawnFlags([{ kind: "agent", count: 1 }])).toBe("--cursor=1");
  });
});

describe("recommendSwarmPaneMix", () => {
  it("includes cursor instead of gmi for small projects", () => {
    const mix = recommendSwarmPaneMix(10);
    expect(mix.some((s) => s.kind === "cursor")).toBe(true);
    expect(mix.some((s) => s.kind === "gmi")).toBe(false);
    expect(totalPaneCount(mix)).toBe(3);
  });

  it("scales to requested agent count", () => {
    const mix = recommendSwarmPaneMix(200, 5);
    expect(totalPaneCount(mix)).toBe(5);
    expect(mix.some((s) => s.kind === "cursor")).toBe(true);
  });
});

describe("resolveSinglePaneSpec", () => {
  it("routes Anthropic to cc", () => {
    expect(resolveSinglePaneSpec("anthropic/claude-opus-4-6").kind).toBe("cc");
  });

  it("routes OpenAI to cod", () => {
    expect(resolveSinglePaneSpec("openai-codex/gpt-5.4").kind).toBe("cod");
  });

  it("routes Gemini to cursor before gmi", () => {
    expect(resolveSinglePaneSpec("openrouter/google/gemini-3.1-pro-preview").kind).toBe("cursor");
  });

  it("falls back to gmi when agent CLI unavailable", () => {
    expect(
      resolveSinglePaneSpec("openrouter/google/gemini-3.1-pro-preview", { agentCliAvailable: false }).kind,
    ).toBe("gmi");
  });
});

describe("paneSpecsForLaunch", () => {
  it("uses single-pane resolution for agentCount 1", () => {
    const specs = paneSpecsForLaunch({
      agentCount: 1,
      model: "openrouter/google/gemini-3.1-pro-preview",
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].kind).toBe("cursor");
  });
});

describe("scalePaneMixToTotal", () => {
  it("adds panes when scaling up", () => {
    const scaled = scalePaneMixToTotal(
      [
        { kind: "cc", count: 1 },
        { kind: "cod", count: 1 },
        { kind: "cursor", count: 1 },
      ],
      5,
    );
    expect(totalPaneCount(scaled)).toBe(5);
  });
});
