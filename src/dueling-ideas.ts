import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import type { CandidateIdea, RepoProfile, ScanResult } from "./types.js";
import { formatRepoProfile, pickRefinementModel, withSubagentAutoExitInstruction } from "./prompts.js";
import { detectAvailableModels } from "./model-detection.js";
import { enforceGoogleOpenRouterModel, launchModeForModel, providerPolicyNoteForModel } from "./model-policy.js";
import { runDeepPlanAgents, type DeepPlanAgent, type DeepPlanResult } from "./deep-plan.js";
import { findSessionArtifactPath, sessionArtifactPath } from "./session-artifacts.js";
import { parseIdeasJSON } from "./ideation-funnel.js";

export interface DuelingIdeaAgent {
  /** Short stable artifact label: CC, COD, GMI, etc. */
  type: string;
  model: string;
}

export interface DuelingIdeaScore {
  ideaId: string;
  score: number;
  verdict?: string;
  rationale?: string;
  evaluator: string;
  origin: string;
}

export interface DuelingIdeasResult {
  agents: DuelingIdeaAgent[];
  ideasByAgent: Record<string, CandidateIdea[]>;
  scores: DuelingIdeaScore[];
  reportArtifactName: string;
  report: string;
  consensusIdeas: CandidateIdea[];
}

export interface DuelingResearchFocus {
  externalUrl: string;
  externalName: string;
}

const IDEAS_JSON_MARKER = "IDEAS_JSON";
const SCORE_JSON_MARKER = "SCORE_JSON";
const CONSENSUS_JSON_MARKER = "CONSENSUS_IDEAS_JSON";
export const DUELING_WIZARDS_ARTIFACT_PREFIX = "dueling-wizards";

function familyForModel(model: string): string {
  const lower = model.toLowerCase();
  if (/claude|anthropic/.test(lower)) return "CC";
  if (/openrouter\/google|gemini|google|antigravity/.test(lower)) return "GMI";
  if (/codex|openai|gpt|opencode/.test(lower)) return "COD";
  if (/openrouter/.test(lower)) return "OR";
  return "AI";
}

function uniqueType(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  const label = `${base}${i}`;
  used.add(label);
  return label;
}

/** Pick 2-3 diverse model-backed duel agents from the current pi model registry. */
export function selectDuelingIdeaAgents(ctx: ExtensionContext, maxAgents = 3): DuelingIdeaAgent[] {
  let models: string[];
  try {
    models = detectAvailableModels(ctx).refinementModels;
  } catch {
    models = [pickRefinementModel(0), pickRefinementModel(1), pickRefinementModel(2)];
  }

  // Preserve provider diversity first, then fill remaining slots if needed.
  const selected: string[] = [];
  const seenFamilies = new Set<string>();
  for (const model of models) {
    const family = familyForModel(model);
    if (!seenFamilies.has(family)) {
      selected.push(model);
      seenFamilies.add(family);
    }
    if (selected.length >= maxAgents) break;
  }
  for (const model of models) {
    if (selected.length >= maxAgents) break;
    if (!selected.includes(model)) selected.push(model);
  }

  while (selected.length < 2) {
    selected.push(pickRefinementModel(selected.length));
  }

  const usedTypes = new Set<string>();
  return selected.slice(0, maxAgents).map((model) => {
    const normalizedModel = enforceGoogleOpenRouterModel(model);
    return {
      model: normalizedModel,
      type: uniqueType(familyForModel(normalizedModel), usedTypes),
    };
  });
}

export function duelingIdeationPrompt(
  agent: DuelingIdeaAgent,
  profile: RepoProfile,
  scanResult: ScanResult | undefined,
  existingBeadTitles: string[],
  ideaCount = 30,
  topCount = 5,
  researchFocus?: DuelingResearchFocus,
): string {
  const repoContext = formatRepoProfile(profile, scanResult);
  const beadSection = existingBeadTitles.length > 0
    ? `\n### Existing Beads (do not duplicate)\n${existingBeadTitles.map((t) => `- ${t}`).join("\n")}\n`
    : "";
  const focusSection = researchFocus
    ? `\n## External Research Focus\nThis duel is part of an external-repo research run. The target is ${researchFocus.externalName}: ${researchFocus.externalUrl}.\n\nBefore proposing ideas, clone/read that external repo and cite concrete files, README sections, architecture patterns, commands, or workflows from it. Your ideas must reimagine or adapt what you learned from ${researchFocus.externalName} for this current project; do not produce generic current-repo improvements that ignore the external target.\n`
    : "";
  const taskFocus = researchFocus
    ? `Come up with your very best research-reimagined ideas from ${researchFocus.externalName} for improving this project while making the adaptation robust, reliable, performant, intuitive, user-friendly, ergonomic, useful, compelling, and still obviously accretive and pragmatic.`
    : "Come up with your very best ideas for improving this project to make it more robust, reliable, performant, intuitive, user-friendly, ergonomic, useful, compelling, and still obviously accretive and pragmatic.";

  return `# Dueling Idea Wizards — Independent Ideation (${agent.type})

You are one contestant in an adversarial cross-model idea duel. Your job in this phase is independent ideation: study the project deeply, generate many options, then winnow to your strongest ideas. Another model will later score your ideas candidly.

First read AGENTS.md and README.md carefully if present. Then inspect the codebase architecture, tests, recent commits, TODOs, and project purpose using read-only tools.
${focusSection}
${repoContext}
${beadSection}
## Task
${taskFocus}

1. Generate ${ideaCount} candidate ideas internally.
2. Think through each idea: how it would work, how users and AI coding agents would perceive it, implementation risk, utility, complexity, and likely maintenance cost.
3. Winnow to your VERY best ${topCount} ideas, ordered best to worst.
4. Be specific to this repository${researchFocus ? ` and to ${researchFocus.externalName}` : ""}. Cite concrete files, tools, workflows, or observed gaps${researchFocus ? " from both the current repo and the external target" : ""}.

For each top idea include:
- title, category, effort, impact
- detailed rationale and repo evidence
- practical implementation sketch
- risks / why it might not be worth it
- 1-5 rubric scores: useful, pragmatic, accretive, robust, ergonomic

End your response with a fenced JSON array under the exact heading \`### ${IDEAS_JSON_MARKER}\` so the orchestrator can import your ideas:

### ${IDEAS_JSON_MARKER}
\`\`\`json
[
  {
    "id": "kebab-case-id",
    "title": "Short title",
    "description": "2-3 sentence description",
    "category": "feature|refactor|docs|dx|performance|reliability|security|testing",
    "effort": "low|medium|high",
    "impact": "low|medium|high",
    "rationale": "why this beat other candidates, citing repo evidence",
    "tier": "top",
    "sourceEvidence": ["specific repo signal"],
    "risks": ["known downside"],
    "scores": { "useful": 5, "pragmatic": 4, "accretive": 5, "robust": 4, "ergonomic": 4 }
  }
]
\`\`\`

Use ultrathink. Do not score other agents yet. Do not create beads.`;
}

export function duelingIdeaArtifactName(agent: DuelingIdeaAgent): string {
  return `${DUELING_WIZARDS_ARTIFACT_PREFIX}/WIZARD_IDEAS_${agent.type}.md`;
}

export function buildDuelingIdeaSubagentConfigs(
  cwd: string,
  agents: DuelingIdeaAgent[],
  profile: RepoProfile,
  scanResult: ScanResult | undefined,
  existingBeadTitles: string[],
  artifactCtx?: Pick<ExtensionContext, "cwd" | "sessionManager">,
  researchFocus?: DuelingResearchFocus,
) {
  return agents.map((agent) => {
    const normalizedAgent = { ...agent, model: enforceGoogleOpenRouterModel(agent.model) };
    const artifactName = duelingIdeaArtifactName(normalizedAgent);
    const absoluteArtifactPath = artifactCtx ? sessionArtifactPath(artifactCtx, artifactName) : undefined;
    const launchMode = launchModeForModel(normalizedAgent.model);
    const policyNote = providerPolicyNoteForModel(normalizedAgent.model);
    const persistenceFallback = absoluteArtifactPath
      ? `If write_artifact is not available in your tool list, use the write tool to create exactly this file instead: \`${absoluteArtifactPath}\`.`
      : "If write_artifact is not available in your tool list, say so explicitly in your final response.";
    return {
      name: `dueling-${normalizedAgent.type.toLowerCase()}-ideas`,
      agent: launchMode === "ntm_cc" ? "cc" : launchMode === "ntm_agent" ? "agent" : "planner",
      cwd,
      model: normalizedAgent.model,
      launchMode,
      launchInstruction: launchMode === "ntm_cc"
        ? "Launch this wizard in a managed NTM Claude Code (`cc`) pane; do not use the subagent tool for Anthropic/Claude models."
        : launchMode === "ntm_agent"
          ? "Launch this wizard in a managed NTM Cursor (`--cursor`) pane backed by the official Cursor Agent CLI command `agent`; do not use the subagent tool or `--gmi` panes for Google/Gemini models."
          : "Launch this wizard with the subagent tool.",
      interactive: false,
      task: withSubagentAutoExitInstruction(
        `${policyNote ? `${policyNote}\n\n` : ""}${duelingIdeationPrompt(normalizedAgent, profile, scanResult, existingBeadTitles, 30, 5, researchFocus)}\n\n` +
        `After you finish, save your full wizard response with write_artifact using exactly this name: \`${artifactName}\`.\n` +
        `${persistenceFallback}\n` +
        `Do not create beads. In your final response, mention that you wrote \`${artifactName}\`.`
      ),
    };
  });
}

function loadDuelingIdeaArtifacts(
  ctx: ExtensionContext,
  agents: DuelingIdeaAgent[],
): Record<string, string> {
  const artifacts: Record<string, string> = {};
  for (const agent of agents) {
    const path = findSessionArtifactPath(ctx, duelingIdeaArtifactName(agent));
    if (!path) continue;
    try {
      const text = readFileSync(path, "utf8").trim();
      if (text) artifacts[agent.type] = text;
    } catch {
      // Ignore unreadable artifacts; the caller can regenerate or ask for them.
    }
  }
  return artifacts;
}

export function getMissingDuelingIdeaAgents(
  ctx: ExtensionContext,
  agents: DuelingIdeaAgent[],
): DuelingIdeaAgent[] {
  const artifacts = loadDuelingIdeaArtifacts(ctx, agents);
  return agents.filter((agent) => !artifacts[agent.type]);
}

export function duelingScorePrompt(
  evaluator: DuelingIdeaAgent,
  origin: DuelingIdeaAgent,
  originIdeasMarkdown: string,
): string {
  return `# Dueling Idea Wizards — Cross-Score ${evaluator.type} ON ${origin.type}

I asked another model the same thing and it came up with this list:

--- BEGIN ${origin.type} IDEAS ---
${originIdeasMarkdown}
--- END ${origin.type} IDEAS ---

Now carefully evaluate each idea and score it from 0 (worst) to 1000 (best). The score should reflect:
- how good and smart the idea is
- how useful it would be in practical real-life scenarios for humans and AI coding agents
- how practical it would be to implement correctly
- whether the utility/advantages justify the added complexity and tech debt
- whether the idea is actually accretive for this repo rather than merely plausible

Be candid and adversarial. Do not do a love-fest; weak ideas should get weak scores. Explain the strongest objection to each idea even when you score it highly.

End with a fenced JSON array under the exact heading \`### ${SCORE_JSON_MARKER}\`:

### ${SCORE_JSON_MARKER}
\`\`\`json
[
  { "ideaId": "id-from-the-other-agent", "score": 850, "verdict": "strong consensus candidate", "rationale": "why this score" }
]
\`\`\`

Use ultrathink. Do not create beads.`;
}

export function duelingReactionPrompt(
  origin: DuelingIdeaAgent,
  scoresOnOriginMarkdown: string,
): string {
  return `# Dueling Idea Wizards — Reveal Reaction (${origin.type})

I asked the other model(s) to score YOUR ideas using the same 0-1000 grading methodology. Here is what they came up with:

${scoresOnOriginMarkdown}

Give your honest reaction:
- Where do you agree with their assessment?
- Where do you think they're wrong, and why?
- Which criticism changes your own evaluation?
- Which of your ideas is most underrated, if any?
- Which should be killed or downgraded after seeing the critique?

Be intellectually honest; concessions are valuable. Use ultrathink. Do not create beads.`;
}

export function duelingRebuttalPrompt(
  agent: DuelingIdeaAgent,
  ownIdeasMarkdown: string,
  scoresOnOwnMarkdown: string,
  opponentScoresMarkdown: string,
): string {
  return `# Dueling Idea Wizards — Formal Rebuttal (${agent.type})

You have now seen how other model(s) scored your ideas, and you have scored theirs. Write a formal rebuttal with two jobs:

1. Defend your most underrated ideas if the critics missed important value.
2. Attack the opponent ideas that you believe are weakest or over-scored.

## Your original ideas
${ownIdeasMarkdown}

## Other model scores on your ideas
${scoresOnOwnMarkdown}

## Your scores on other model ideas
${opponentScoresMarkdown}

Be technically specific. If a criticism is valid, concede it. If your defense depends on assumptions, name them. Use ultrathink. Do not create beads.`;
}

export function duelingSteelmanPrompt(
  agent: DuelingIdeaAgent,
  opponentIdeasMarkdown: string,
): string {
  return `# Dueling Idea Wizards — Steelman Challenge (${agent.type})

Force yourself to write the strongest possible case for the opponent model's #1 idea (or each opponent's #1 idea if there are multiple opponents).

## Opponent ideas
${opponentIdeasMarkdown}

Do not strawman. Explain why a smart user might genuinely prioritize the opponent's best idea, what implementation would make it succeed, and what hidden value your original scoring may have underweighted. Use ultrathink. Do not create beads.`;
}

export function duelingBlindspotPrompt(
  agent: DuelingIdeaAgent,
  allIdeasMarkdown: string,
  allScoresMarkdown: string,
  allReactionsMarkdown: string,
): string {
  return `# Dueling Idea Wizards — Blind Spot Probe (${agent.type})

After the full adversarial exchange, answer: what important idea did NONE of the models initially think of?

## All initial ideas
${allIdeasMarkdown}

## All cross-scores
${allScoresMarkdown}

## Reveal reactions
${allReactionsMarkdown}

Generate 1-3 genuinely new, non-duplicative ideas that become visible only after seeing the disagreement. Be skeptical: explain why each was missed and why it is or is not better than the original winners. Use ultrathink. Do not create beads.`;
}

export function duelingSynthesisPrompt(
  projectName: string,
  agents: DuelingIdeaAgent[],
  ideaArtifacts: Record<string, string>,
  scoreArtifacts: Record<string, string>,
  reactionArtifacts: Record<string, string>,
  rebuttalArtifacts: Record<string, string> = {},
  steelmanArtifacts: Record<string, string> = {},
  blindspotArtifacts: Record<string, string> = {},
): string {
  const ideasSection = Object.entries(ideaArtifacts)
    .map(([type, text]) => `## WIZARD_IDEAS_${type}.md\n\n${text}`)
    .join("\n\n---\n\n");
  const scoresSection = Object.entries(scoreArtifacts)
    .map(([name, text]) => `## ${name}\n\n${text}`)
    .join("\n\n---\n\n");
  const reactionsSection = Object.entries(reactionArtifacts)
    .map(([type, text]) => `## WIZARD_REACTIONS_${type}.md\n\n${text}`)
    .join("\n\n---\n\n");
  const rebuttalsSection = Object.entries(rebuttalArtifacts)
    .map(([type, text]) => `## WIZARD_REBUTTAL_${type}.md\n\n${text}`)
    .join("\n\n---\n\n");
  const steelmanSection = Object.entries(steelmanArtifacts)
    .map(([type, text]) => `## WIZARD_STEELMAN_${type}.md\n\n${text}`)
    .join("\n\n---\n\n");
  const blindspotsSection = Object.entries(blindspotArtifacts)
    .map(([type, text]) => `## WIZARD_BLINDSPOTS_${type}.md\n\n${text}`)
    .join("\n\n---\n\n");

  return `# Dueling Idea Wizards — Final Synthesis for ${projectName}

You are the orchestrator. Synthesize the duel faithfully; do not editorialize away disagreement. Build a score matrix, identify consensus winners, contested ideas, killed ideas, and recommended next steps.

Agents used: ${agents.map((a) => `${a.type} (${a.model})`).join(", ")}

# Agent Ideas
${ideasSection}

# Cross-Scoring Files
${scoresSection}

# Reveal Reactions
${reactionsSection}

# Formal Rebuttals
${rebuttalsSection || "(No rebuttals produced.)"}

# Steelman Challenges
${steelmanSection || "(No steelman artifacts produced.)"}

# Blind Spot Probes
${blindspotsSection || "(No blind spot artifacts produced.)"}

Write a markdown report with this structure:

# Dueling Idea Wizards Report: ${projectName}
## Executive Summary
## Methodology
## Consensus Winners (scored 700+ by all scoring agents where possible)
## Contested Ideas
## Killed Ideas
## Score Matrix
## Meta-Analysis
- Include what the rebuttal, steelman, and blind-spot phases changed.
## Recommended Next Steps

Then end with a fenced JSON array under the exact heading \`### ${CONSENSUS_JSON_MARKER}\`. Include 3-7 surviving ideas suitable for AgentFlywheel selection. Use the normal CandidateIdea shape:

### ${CONSENSUS_JSON_MARKER}
\`\`\`json
[
  {
    "id": "kebab-case-id",
    "title": "Short title",
    "description": "2-3 sentence description",
    "category": "feature|refactor|docs|dx|performance|reliability|security|testing",
    "effort": "low|medium|high",
    "impact": "low|medium|high",
    "rationale": "cross-model synthesis and why it survived",
    "tier": "top",
    "sourceEvidence": ["origin agent + score evidence"],
    "risks": ["honest objections from the duel"],
    "scores": { "useful": 5, "pragmatic": 4, "accretive": 5, "robust": 4, "ergonomic": 4 }
  }
]
\`\`\``;
}

function markedJsonPayload(output: string, marker: string): string {
  const markerIndex = output.lastIndexOf(marker);
  const tail = markerIndex >= 0 ? output.slice(markerIndex + marker.length) : output;
  const fence = tail.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence?.[1]?.trim() || tail.trim();
}

export function parseMarkedIdeas(output: string, marker = IDEAS_JSON_MARKER): CandidateIdea[] {
  return parseIdeasJSON(markedJsonPayload(output, marker));
}

export function parseDuelingScores(output: string, evaluator: string, origin: string): DuelingIdeaScore[] {
  const payload = markedJsonPayload(output, SCORE_JSON_MARKER);
  const match = payload.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0].replace(/,\s*([}\]])/g, "$1"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): DuelingIdeaScore[] => {
      if (typeof item !== "object" || item === null) return [];
      const obj = item as Record<string, unknown>;
      const ideaId = String(obj.ideaId ?? obj.id ?? obj.idea_id ?? "").trim();
      if (!ideaId) return [];
      const rawScore = Number(obj.score);
      const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(1000, Math.round(rawScore))) : 0;
      return [{
        ideaId,
        score,
        verdict: typeof obj.verdict === "string" ? obj.verdict : undefined,
        rationale: typeof obj.rationale === "string" ? obj.rationale : undefined,
        evaluator,
        origin,
      }];
    });
  } catch {
    return [];
  }
}

export function parseConsensusIdeas(output: string): CandidateIdea[] {
  return parseMarkedIdeas(output, CONSENSUS_JSON_MARKER);
}

function writeArtifact(ctx: ExtensionContext, name: string, content: string): void {
  const path = sessionArtifactPath(ctx, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function scoreAverage(scores: DuelingIdeaScore[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
}

function fallbackConsensusIdeas(
  ideasByAgent: Record<string, CandidateIdea[]>,
  scores: DuelingIdeaScore[],
): CandidateIdea[] {
  const rows = Object.entries(ideasByAgent).flatMap(([origin, ideas]) =>
    ideas.map((idea) => {
      const ideaScores = scores.filter((s) => s.origin === origin && s.ideaId === idea.id);
      return { origin, idea, ideaScores, avg: scoreAverage(ideaScores) };
    })
  );

  const consensus = rows
    .filter((row) => row.ideaScores.length > 0 && row.ideaScores.every((s) => s.score >= 700))
    .sort((a, b) => b.avg - a.avg);
  const fallback = rows
    .filter((row) => row.ideaScores.length > 0)
    .sort((a, b) => b.avg - a.avg);
  const selected = (consensus.length >= 3 ? consensus : fallback).slice(0, 7);

  return selected.map((row, index) => ({
    ...row.idea,
    tier: index < 5 ? "top" : "honorable",
    rationale: `${row.idea.rationale || "Selected by dueling fallback synthesis."} Cross-model average score: ${Math.round(row.avg)}/1000 from ${row.ideaScores.length} evaluator(s).`,
    sourceEvidence: [
      ...(row.idea.sourceEvidence ?? []),
      `Origin: ${row.origin}`,
      `Dueling average score: ${Math.round(row.avg)}/1000`,
    ],
  }));
}

async function runNamedAgents(
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
  cwd: string,
  agents: DeepPlanAgent[],
  signal?: AbortSignal,
): Promise<Record<string, DeepPlanResult>> {
  const results = await runDeepPlanAgents(pi, cwd, agents, signal);
  return Object.fromEntries(results.map((result) => [result.name, result]));
}

export async function runDuelingIdeaWizards(
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
  ctx: ExtensionContext,
  profile: RepoProfile,
  scanResult: ScanResult | undefined,
  existingBeadTitles: string[],
  signal?: AbortSignal,
  onPhase?: (message: string) => void,
  researchFocus?: DuelingResearchFocus,
): Promise<DuelingIdeasResult> {
  const agents = selectDuelingIdeaAgents(ctx, 3);
  const artifactPrefix = DUELING_WIZARDS_ARTIFACT_PREFIX;

  onPhase?.(`⚔️ Phase 1/7: ${agents.length} wizards generating independent ideas...`);
  const ideaArtifacts: Record<string, string> = loadDuelingIdeaArtifacts(ctx, agents);
  const missingIdeaAgents = agents.filter((agent) => !ideaArtifacts[agent.type]);
  if (missingIdeaAgents.length > 0) {
    const ideaTasks: DeepPlanAgent[] = missingIdeaAgents.map((agent) => ({
      name: `ideas-${agent.type}`,
      model: agent.model,
      task: duelingIdeationPrompt(agent, profile, scanResult, existingBeadTitles, 30, 5, researchFocus),
    }));
    const ideaResults = await runNamedAgents(pi, ctx.cwd, ideaTasks, signal);
    for (const agent of missingIdeaAgents) {
      const text = ideaResults[`ideas-${agent.type}`]?.plan?.trim() || `No ideas produced by ${agent.type}.`;
      ideaArtifacts[agent.type] = text;
      writeArtifact(ctx, duelingIdeaArtifactName(agent), text);
    }
  }

  const ideasByAgent: Record<string, CandidateIdea[]> = {};
  for (const agent of agents) {
    const text = ideaArtifacts[agent.type] || `No ideas produced by ${agent.type}.`;
    const parsed = parseMarkedIdeas(text).slice(0, 15);
    ideasByAgent[agent.type] = parsed.map((idea, index) => ({ ...idea, tier: index < 5 ? "top" : "honorable" }));
  }

  onPhase?.("⚔️ Phase 2/7: Cross-scoring opponent ideas...");
  const scoreTasks: DeepPlanAgent[] = [];
  for (const evaluator of agents) {
    for (const origin of agents) {
      if (evaluator.type === origin.type) continue;
      scoreTasks.push({
        name: `scores-${evaluator.type}-on-${origin.type}`,
        model: evaluator.model,
        task: duelingScorePrompt(evaluator, origin, ideaArtifacts[origin.type] ?? ""),
      });
    }
  }
  const scoreResults = await runNamedAgents(pi, ctx.cwd, scoreTasks, signal);
  const scoreArtifacts: Record<string, string> = {};
  const scores: DuelingIdeaScore[] = [];
  for (const evaluator of agents) {
    for (const origin of agents) {
      if (evaluator.type === origin.type) continue;
      const key = `scores-${evaluator.type}-on-${origin.type}`;
      const artifactName = `WIZARD_SCORES_${evaluator.type}_ON_${origin.type}.md`;
      const text = scoreResults[key]?.plan?.trim() || `No scores produced by ${evaluator.type} on ${origin.type}.`;
      scoreArtifacts[artifactName] = text;
      writeArtifact(ctx, `${artifactPrefix}/${artifactName}`, text);
      scores.push(...parseDuelingScores(text, evaluator.type, origin.type));
    }
  }

  onPhase?.("⚔️ Phase 3/7: Reveal reactions...");
  const reactionTasks: DeepPlanAgent[] = agents.map((origin) => {
    const scoresOnOrigin = Object.entries(scoreArtifacts)
      .filter(([name]) => name.endsWith(`_ON_${origin.type}.md`))
      .map(([name, text]) => `## ${name}\n\n${text}`)
      .join("\n\n---\n\n");
    return {
      name: `reaction-${origin.type}`,
      model: origin.model,
      task: duelingReactionPrompt(origin, scoresOnOrigin),
    };
  });
  const reactionResults = await runNamedAgents(pi, ctx.cwd, reactionTasks, signal);
  const reactionArtifacts: Record<string, string> = {};
  for (const agent of agents) {
    const text = reactionResults[`reaction-${agent.type}`]?.plan?.trim() || `No reaction produced by ${agent.type}.`;
    reactionArtifacts[agent.type] = text;
    writeArtifact(ctx, `${artifactPrefix}/WIZARD_REACTIONS_${agent.type}.md`, text);
  }

  const allIdeasMarkdown = Object.entries(ideaArtifacts)
    .map(([type, text]) => `## WIZARD_IDEAS_${type}.md\n\n${text}`)
    .join("\n\n---\n\n");
  const allScoresMarkdown = Object.entries(scoreArtifacts)
    .map(([name, text]) => `## ${name}\n\n${text}`)
    .join("\n\n---\n\n");
  const allReactionsMarkdown = Object.entries(reactionArtifacts)
    .map(([type, text]) => `## WIZARD_REACTIONS_${type}.md\n\n${text}`)
    .join("\n\n---\n\n");

  onPhase?.("⚔️ Phase 4/7: Formal rebuttals...");
  const rebuttalTasks: DeepPlanAgent[] = agents.map((agent) => {
    const scoresOnOwn = Object.entries(scoreArtifacts)
      .filter(([name]) => name.endsWith(`_ON_${agent.type}.md`))
      .map(([name, text]) => `## ${name}\n\n${text}`)
      .join("\n\n---\n\n");
    const opponentScores = Object.entries(scoreArtifacts)
      .filter(([name]) => name.startsWith(`WIZARD_SCORES_${agent.type}_ON_`))
      .map(([name, text]) => `## ${name}\n\n${text}`)
      .join("\n\n---\n\n");
    return {
      name: `rebuttal-${agent.type}`,
      model: agent.model,
      task: duelingRebuttalPrompt(agent, ideaArtifacts[agent.type] ?? "", scoresOnOwn, opponentScores),
    };
  });
  const rebuttalResults = await runNamedAgents(pi, ctx.cwd, rebuttalTasks, signal);
  const rebuttalArtifacts: Record<string, string> = {};
  for (const agent of agents) {
    const text = rebuttalResults[`rebuttal-${agent.type}`]?.plan?.trim() || `No rebuttal produced by ${agent.type}.`;
    rebuttalArtifacts[agent.type] = text;
    writeArtifact(ctx, `${artifactPrefix}/WIZARD_REBUTTAL_${agent.type}.md`, text);
  }

  onPhase?.("⚔️ Phase 5/7: Steelman challenges...");
  const steelmanTasks: DeepPlanAgent[] = agents.map((agent) => {
    const opponentIdeas = Object.entries(ideaArtifacts)
      .filter(([type]) => type !== agent.type)
      .map(([type, text]) => `## WIZARD_IDEAS_${type}.md\n\n${text}`)
      .join("\n\n---\n\n");
    return {
      name: `steelman-${agent.type}`,
      model: agent.model,
      task: duelingSteelmanPrompt(agent, opponentIdeas),
    };
  });
  const steelmanResults = await runNamedAgents(pi, ctx.cwd, steelmanTasks, signal);
  const steelmanArtifacts: Record<string, string> = {};
  for (const agent of agents) {
    const text = steelmanResults[`steelman-${agent.type}`]?.plan?.trim() || `No steelman produced by ${agent.type}.`;
    steelmanArtifacts[agent.type] = text;
    writeArtifact(ctx, `${artifactPrefix}/WIZARD_STEELMAN_${agent.type}.md`, text);
  }

  onPhase?.("⚔️ Phase 6/7: Blind spot probes...");
  const blindspotTasks: DeepPlanAgent[] = agents.map((agent) => ({
    name: `blindspots-${agent.type}`,
    model: agent.model,
    task: duelingBlindspotPrompt(agent, allIdeasMarkdown, allScoresMarkdown, allReactionsMarkdown),
  }));
  const blindspotResults = await runNamedAgents(pi, ctx.cwd, blindspotTasks, signal);
  const blindspotArtifacts: Record<string, string> = {};
  for (const agent of agents) {
    const text = blindspotResults[`blindspots-${agent.type}`]?.plan?.trim() || `No blind spot probe produced by ${agent.type}.`;
    blindspotArtifacts[agent.type] = text;
    writeArtifact(ctx, `${artifactPrefix}/WIZARD_BLINDSPOTS_${agent.type}.md`, text);
  }

  onPhase?.("⚔️ Phase 7/7: Synthesizing report and consensus winners...");
  const synthesisPrompt = duelingSynthesisPrompt(
    profile.name,
    agents,
    ideaArtifacts,
    scoreArtifacts,
    reactionArtifacts,
    rebuttalArtifacts,
    steelmanArtifacts,
    blindspotArtifacts,
  );
  const synthesisResults = await runDeepPlanAgents(pi, ctx.cwd, [{
    name: "dueling-synthesis",
    model: agents[0]?.model ?? pickRefinementModel(0),
    task: synthesisPrompt,
  }], signal);
  let report = synthesisResults[0]?.plan?.trim() || "";
  let consensusIdeas = parseConsensusIdeas(report);

  if (consensusIdeas.length === 0) {
    consensusIdeas = fallbackConsensusIdeas(ideasByAgent, scores);
    const fallbackSummary = consensusIdeas
      .map((idea, index) => `${index + 1}. **${idea.title}** — ${idea.rationale}`)
      .join("\n");
    report = report || `# Dueling Idea Wizards Report: ${profile.name}\n\nSynthesis model did not produce a report. Fallback ranking by parsed cross-scores:\n\n${fallbackSummary}`;
    report += `\n\n## Fallback Consensus Ideas\n${fallbackSummary}\n`;
  }

  consensusIdeas = consensusIdeas.slice(0, 7).map((idea, index) => ({
    ...idea,
    tier: index < 5 ? "top" : "honorable",
  }));

  const reportArtifactName = `${artifactPrefix}/DUELING_WIZARDS_REPORT.md`;
  writeArtifact(ctx, reportArtifactName, report);

  return {
    agents,
    ideasByAgent,
    scores,
    reportArtifactName,
    report,
    consensusIdeas,
  };
}
