import { describe, it, expect } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  duelingIdeationPrompt,
  duelingScorePrompt,
  parseConsensusIdeas,
  parseDuelingScores,
  parseMarkedIdeas,
  selectDuelingIdeaAgents,
  type DuelingIdeaAgent,
} from "./dueling-ideas.js";
import type { RepoProfile, ScanResult } from "./types.js";

function makeProfile(): RepoProfile {
  return {
    name: "test-repo",
    languages: ["TypeScript"],
    frameworks: ["Vitest"],
    structure: "src/index.ts",
    entrypoints: ["src/index.ts"],
    recentCommits: [],
    hasTests: true,
    testFramework: "vitest",
    hasDocs: true,
    hasCI: false,
    todos: [],
    keyFiles: {},
    readme: "# Test Repo",
  };
}

function makeCtx(models: Array<{ provider: string; id: string }>): ExtensionContext {
  return {
    model: "anthropic/claude-opus-4-6",
    modelRegistry: { getAvailable: () => models },
  } as unknown as ExtensionContext;
}

const agent: DuelingIdeaAgent = { type: "CC", model: "anthropic/claude-opus-4-6" };
const other: DuelingIdeaAgent = { type: "COD", model: "openai-codex/gpt-5.4" };

describe("dueling idea prompts", () => {
  it("asks each wizard to generate 30 and winnow to 5 with an importable JSON marker", () => {
    const prompt = duelingIdeationPrompt(agent, makeProfile(), undefined, ["Existing bead"], 30, 5);
    expect(prompt).toContain("Generate 30 candidate ideas");
    expect(prompt).toContain("VERY best 5 ideas");
    expect(prompt).toContain("IDEAS_JSON");
    expect(prompt).toContain("Existing bead");
    expect(prompt).toContain("Do not create beads");
  });

  it("asks cross-scorers for candid 0-1000 scoring with a score marker", () => {
    const prompt = duelingScorePrompt(agent, other, "# Ideas");
    expect(prompt).toContain("0 (worst) to 1000 (best)");
    expect(prompt).toContain("Be candid and adversarial");
    expect(prompt).toContain("SCORE_JSON");
  });
});

describe("dueling idea parsing", () => {
  it("parses marked idea JSON", () => {
    const output = `markdown\n### IDEAS_JSON\n\`\`\`json\n[{
      "id":"a",
      "title":"Idea A",
      "description":"Desc",
      "category":"dx",
      "effort":"low",
      "impact":"high",
      "rationale":"Because",
      "tier":"top"
    }]\n\`\`\``;
    const ideas = parseMarkedIdeas(output);
    expect(ideas).toHaveLength(1);
    expect(ideas[0].id).toBe("a");
    expect(ideas[0].category).toBe("dx");
  });

  it("parses and clamps marked score JSON", () => {
    const output = `### SCORE_JSON\n\`\`\`json\n[
      {"ideaId":"a","score": 1100, "verdict":"too high", "rationale":"x"},
      {"idea_id":"b","score": -20}
    ]\n\`\`\``;
    const scores = parseDuelingScores(output, "CC", "COD");
    expect(scores.map((s) => [s.ideaId, s.score])).toEqual([["a", 1000], ["b", 0]]);
    expect(scores[0].evaluator).toBe("CC");
    expect(scores[0].origin).toBe("COD");
  });

  it("parses consensus ideas from the synthesis marker", () => {
    const output = `# Report\n### CONSENSUS_IDEAS_JSON\n\`\`\`json\n[{"id":"win","title":"Winner"}]\n\`\`\``;
    expect(parseConsensusIdeas(output)[0].id).toBe("win");
  });
});

describe("selectDuelingIdeaAgents", () => {
  it("prefers diverse provider families and stable labels", () => {
    const ctx = makeCtx([
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "google-antigravity", id: "gemini-3.1-pro-high" },
    ]);
    const agents = selectDuelingIdeaAgents(ctx, 3);
    expect(agents.map((a) => a.type)).toEqual(["CC", "COD", "GMI"]);
    expect(agents).toHaveLength(3);
  });

  it("falls back to at least two agents when detection is sparse", () => {
    const ctx = makeCtx([{ provider: "anthropic", id: "claude-opus-4-6" }]);
    const agents = selectDuelingIdeaAgents(ctx, 3);
    expect(agents.length).toBeGreaterThanOrEqual(2);
    expect(new Set(agents.map((a) => a.type)).size).toBe(agents.length);
  });
});
