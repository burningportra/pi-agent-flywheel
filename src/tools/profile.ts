import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext, OrchestratorState } from "../types.js";
import type { RepoProfile, ScanResult } from "../types.js";
import { scanRepo } from "../scan.js";
import { detectAgentGuidanceFiles } from "../profiler.js";
import {
  formatRepoProfile,
  discoveryInstructions,
  beadCreationPrompt,
  workflowRoadmap,
} from "../prompts.js";
import { runGoalRefinement, extractConstraints } from "../goal-refinement.js";
import { detectCoordinationBackend, selectMode, selectStrategy } from "../coordination.js";
import { brExec, brExecJson } from "../cli-exec.js";
import { initSuperpowersWorkflow } from "../workflows/superpowers.js";

import { emitToolDeprecationWarning, canonicalName } from "./shared.js";
/** Compute weighted score for a candidate idea (for fallback sorting). */
function weightedScore(idea: import("../types.js").CandidateIdea): number {
  if (!idea.scores) return 0;
  const s = idea.scores;
  return s.useful * 2 + s.pragmatic * 2 + s.accretive * 1.5 + s.robust + s.ergonomic;
}

export interface ProfileContinuation {
  text: string;
  details: Record<string, unknown>;
}

/**
 * Build the non-blocking foundation-gap warnings shown by the profile tool.
 *
 * The profile tool passes the same explicit target repository root (`ctx.cwd`)
 * used by scanRepo/profileRepo so guidance detection does not depend on ambient
 * process.cwd(). When repoRoot is omitted by older tests/callers, prefer the
 * profile's captured guidance detection, then fall back to the existing
 * keyFiles-based check rather than doing cwd-based detection.
 */
export function buildFoundationGaps(profile: RepoProfile, repoRoot?: string): string[] {
  const foundationGaps: string[] = [];
  const guidance = repoRoot ? detectAgentGuidanceFiles(repoRoot) : profile.agentGuidance;
  const hasAgentsMd = guidance
    ? guidance.found
    : profile.keyFiles && Object.keys(profile.keyFiles).some(f => f.toLowerCase() === "agents.md");
  if (!hasAgentsMd) {
    foundationGaps.push("- No AGENTS.md found. Consider creating one for agent guidance.");
  }
  if (!profile.hasTests) {
    foundationGaps.push("- No test framework detected. Consider adding tests before orchestrating.");
  }
  if (!profile.hasCI && !profile.ciPlatform) {
    foundationGaps.push("- No CI/build tooling detected. Consider adding build scripts or CI.");
  }
  if (profile.recentCommits.length === 0) {
    foundationGaps.push("- No git history detected. Consider initializing git for version control.");
  }
  return foundationGaps;
}

/**
 * If an AgentFlywheel run is already past profiling, a stray profile call should
 * continue the current phase instead of reopening discovery and trapping users
 * in the start/discover/select loop.
 */
export function activeWorkflowContinuation(state: OrchestratorState): ProfileContinuation | undefined {
  if (state.phase === "awaiting_selection" && state.candidateIdeas && state.candidateIdeas.length > 0) {
    const ideaSummary = state.candidateIdeas
      .slice(0, 7)
      .map((idea, index) => `${index + 1}. **${idea.title}** [${idea.category}] — ${idea.description}`)
      .join("\n");
    return {
      text:
        `**NEXT: Call \`agent_flywheel_select\` NOW to present these ${state.candidateIdeas.length} idea(s) to the user.**\n\n` +
        `Discovery is already complete; do not call \`agent_flywheel_profile\` again unless the user explicitly starts over.\n\n` +
        `### Available Ideas\n${ideaSummary}`,
      details: { continuation: true, phase: state.phase, awaitingSelection: true, ideaCount: state.candidateIdeas.length },
    };
  }

  const hasInFlightInteractiveDiscovery = Boolean(
    state.duelingWizardLaunchRequested || state.funnelRawIdeas?.length || state.funnelWinnowedIds?.length
  );
  if (state.phase === "discovering" && state.repoProfile && !state.selectedGoal && !hasInFlightInteractiveDiscovery) {
    return {
      text:
        "**NEXT: Call `agent_flywheel_discover` NOW to generate standard discovery ideas.**\n\n" +
        "The repo is already profiled and discovery is waiting for idea generation; do not call `agent_flywheel_profile` again unless the user explicitly starts over.",
      details: { continuation: true, phase: state.phase, awaitingDiscovery: true },
    };
  }

  const researchState = state.researchState;
  if (researchState?.url && !state.selectedGoal) {
    return {
      text:
        `**NEXT: Continue external-repo research with \`flywheel_research\` NOW.**\n\n` +
        `Research target: ${researchState.url}\n` +
        `External project: ${researchState.externalName}\n` +
        `Completed phases: ${(researchState.phasesCompleted ?? []).join(", ") || "none"}\n\n` +
        `Do not open repo-profile discovery or Dueling Idea Wizards; this run is researching the external repo, then handing off to \`flywheel_approve_beads\`.`,
      details: { continuation: true, phase: state.phase, research: true, url: researchState.url, artifactName: researchState.artifactName },
    };
  }

  if (!state.selectedGoal) return undefined;

  const currentConstraints = state.constraints ?? [];
  const constraints = currentConstraints.length > 0
    ? `\nConstraints: ${currentConstraints.join(", ")}`
    : "";
  const goalLine = `Goal: "${state.selectedGoal}"${constraints}`;

  switch (state.phase) {
    case "planning": {
      const planHint = state.planDocument
        ? `A plan artifact is expected at \`${state.planDocument}\`. If it has already been written, call \`agent_flywheel_approve_beads\` now; otherwise finish writing that artifact first.`
        : "Call `agent_flywheel_plan` with the workflow mode the user selected.";
      return {
        text:
          `**NEXT: Continue the existing planning phase.**\n\n${goalLine}\n\n` +
          `${planHint}\n\nDo not restart discovery/profile unless the user explicitly starts over via \`/agent-flywheel\` → Fresh/Clear.`,
        details: { continuation: true, phase: state.phase, goal: state.selectedGoal, planDocument: state.planDocument },
      };
    }
    case "awaiting_plan_approval":
      return {
        text:
          `**NEXT: Call \`agent_flywheel_approve_beads\` NOW to review the plan.**\n\n${goalLine}\n\n` +
          `${state.planDocument ? `Plan artifact: \`${state.planDocument}\`\n\n` : ""}` +
          "Do not restart discovery/profile unless the user explicitly starts over.",
        details: { continuation: true, phase: state.phase, goal: state.selectedGoal, planDocument: state.planDocument },
      };
    case "creating_beads":
      return {
        text:
          `**NEXT: Draft a structured staged bead mutation plan for the selected goal, then call \`agent_flywheel_approve_beads\` to validate/apply it.**\n\n${goalLine}\n\n` +
          "Discovery and goal selection are already complete; do not call `agent_flywheel_profile` again unless the user explicitly starts over.",
        details: { continuation: true, phase: state.phase, goal: state.selectedGoal },
      };
    case "refining_beads":
    case "awaiting_bead_approval":
      return {
        text:
          `**NEXT: Call \`agent_flywheel_approve_beads\` NOW to continue bead refinement/approval.**\n\n${goalLine}\n\n` +
          "Do not restart discovery/profile unless the user explicitly starts over.",
        details: { continuation: true, phase: state.phase, goal: state.selectedGoal },
      };
    case "implementing":
    case "reviewing":
    case "iterating":
      return {
        text:
          `**NEXT: Call \`agent_flywheel_review\` NOW to continue implementation/review.**\n\n${goalLine}\n\n` +
          "Do not restart discovery/profile unless the user explicitly starts over.",
        details: { continuation: true, phase: state.phase, goal: state.selectedGoal },
      };
    default:
      return undefined;
  }
}

export function registerProfileTool(oc: OrchestratorContext) {
  for (const toolName of ["agent_flywheel_profile", "orch_profile", "flywheel_profile"] as const) {
  oc.pi.registerTool({
    name: toolName,
    label: "Profile Repo",
    description:
      "Scan the current repository to collect its tech stack, structure, commits, TODOs, and key files. Returns a structured profile. [phase 1/6, prereq: none, next: flywheel_discover]",
    promptSnippet: "Profile the current repo (languages, frameworks, structure, commits, TODOs)",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      emitToolDeprecationWarning(toolName, canonicalName("profile"));
      const continuation = activeWorkflowContinuation(oc.state);
      if (continuation) {
        return {
          content: [{ type: "text", text: continuation.text }],
          details: continuation.details,
        };
      }

      oc.setPhase("profiling", ctx);
      ctx.ui.notify(`pi-agent-flywheel v${oc.version}`, 'info');
      onUpdate?.({
        content: [{ type: "text", text: "Scanning repository..." }],
        details: {},
      });

      const scanResult: ScanResult = await scanRepo(oc.pi, ctx.cwd, signal);
      const profile = scanResult.profile;
      oc.state.scanResult = scanResult;
      oc.state.repoProfile = profile;

      // Detect supported coordination backends (beads, agent-mail)
      const coordBackend = await detectCoordinationBackend(oc.pi, ctx.cwd);
      const coordStrategy = selectStrategy(coordBackend);
      oc.state.coordinationBackend = coordBackend;
      oc.state.coordinationStrategy = coordStrategy;
      oc.state.coordinationMode ??= selectMode(coordBackend);
      oc.persistState();

      oc.setPhase("discovering", ctx);

      const formatted = formatRepoProfile(profile, scanResult);
      const scanSourceLine = scanResult.source === "ccc"
        ? "🔬 Scan: ccc"
        : `📊 Scan: built-in${scanResult.fallback ? ` (fallback from ${scanResult.fallback.from})` : ""}`;

      // Ensure AGENTS.md has agent-mail section when agent-mail is available
      if (coordBackend.agentMail) {
        const { ensureAgentMailSection } = await import("../agents-md.js");
        await ensureAgentMailSection(ctx.cwd);
        // Register project in agent-mail so sub-agents can use it
        await oc.ensureAgentMailProject(ctx.cwd);
      }

      // Foundation validation — non-blocking warnings
      const foundationGaps = buildFoundationGaps(profile, ctx.cwd);
      const foundationWarning = foundationGaps.length > 0
        ? `\n⚠️ Foundation gaps detected:\n${foundationGaps.join("\n")}\n`
        : "";

      // Coordination backend summary with upgrade hints
      const coordParts: string[] = [];
      if (coordBackend.beads) coordParts.push("beads");
      if (coordBackend.agentMail) coordParts.push("agent-mail");
      
      const missingTools: string[] = [];
      if (!coordBackend.beads) missingTools.push("`br init` for task tracking");
      if (!coordBackend.agentMail) missingTools.push("`agent-mail` for multi-agent coordination");
      
      const coordLine = coordParts.length > 0
        ? `🤝 Coordination: ${coordParts.join(" + ")} → strategy: **${coordStrategy}**`
        : "🤝 Coordination: bare worktrees (no beads/agent-mail detected)";
      
      const upgradeHint = missingTools.length > 0 && coordParts.length < 2
        ? `\n💡 **Upgrade available:** Install ${missingTools.join(", ")} for enhanced coordination. Run \`/orchestrate-setup\` for guided install.`
        : "";

      // Read CASS memory context for this repo/goal
      const { readMemory } = await import("../memory.js");
      const taskHint = oc.state.selectedGoal || `orchestration session for ${profile.name || "this repo"}`;
      const memory = readMemory(ctx.cwd, taskHint);
      const memoryContext = memory
        ? `\n\n### Prior Context (CASS memory; secondary to live codebase scan)\n${memory}`
        : "";

      // Workflow roadmap for user orientation
      const roadmap = workflowRoadmap("discovering");

      // Check for existing beads so we can offer a clear option
      let existingBeadCount = 0;
      let deferredBeadCount = 0;
      let existingBeadIds: string[] = [];
      let deferredBeadIds: string[] = [];
      try {
        const { readBeads } = await import("../beads.js");
        const existingBeads = await readBeads(oc.pi, ctx.cwd);
        const activeBeads = existingBeads.filter(b => b.status === "open" || b.status === "in_progress");
        const deferredBeads = existingBeads.filter(b => b.status === "deferred");
        existingBeadCount = activeBeads.length;
        existingBeadIds = activeBeads.map(b => b.id);
        deferredBeadCount = deferredBeads.length;
        deferredBeadIds = deferredBeads.map(b => b.id);
      } catch { /* no beads dir */ }

      const totalBeadCount = existingBeadCount + deferredBeadCount;
      const allBeadIds = [...existingBeadIds, ...deferredBeadIds];

      const preselectedGoal = oc.state.selectedGoal?.trim();

      // Offer discovery mode choice — unified menu replaces the old two-step flow
      const discoveryChoices: string[] = [];
      if (existingBeadCount > 0) {
        discoveryChoices.push(`▶️  Work on beads — implement the ${existingBeadCount} existing open bead(s)`);
      }
      if (deferredBeadCount > 0) {
        discoveryChoices.push(`♻️  Reactivate deferred — restore ${deferredBeadCount} deferred bead(s) and start implementing`);
      }
      discoveryChoices.push(
        "💡 Standard discovery — generate 10-15 scored ideas",
        "🔬 Deep discovery (30→5→15 funnel) — broader brainstorm with competitive winnowing",
        "⚔️ Dueling Idea Wizards — adversarial cross-model discovery with score matrix",
        "✏️  I know what I want — enter a custom goal",
      );
      if (totalBeadCount > 0) {
        discoveryChoices.push(`🗑️ Clear beads — permanently delete all ${totalBeadCount} bead(s) and start fresh`);
      }
      discoveryChoices.push("❌ Cancel");

      const discoveryMode = preselectedGoal
        ? "✏️  I know what I want — enter a custom goal"
        : await ctx.ui.select(
          "How should we discover improvement ideas?",
          discoveryChoices
        );

      if (discoveryMode?.startsWith("✏️")) {
        // Custom goal — skip discovery + selection, go straight to workflow choice
        const goal = preselectedGoal ?? (await ctx.ui.input(
          "Enter your goal:",
          "e.g., Add API rate limiting with Redis"
        ));
        if (!goal) {
          return {
            content: [{ type: "text", text: "No goal entered." }],
            details: { profile, scanResult },
          };
        }
        const refinement = await runGoalRefinement(goal, profile, oc.pi, ctx);
        oc.state.selectedGoal = refinement.enrichedGoal;
        const refinementUsed = !refinement.skipped;
        if (refinementUsed) {
          oc.state.constraints = extractConstraints(refinement.answers);
        }
        oc.setPhase("planning", ctx);
        oc.persistState();

        // Ask for constraints only if refinement didn't already capture them
        if (!refinementUsed) {
          const constraintInput = await ctx.ui.input(
            "Any constraints? (comma-separated, or leave empty)",
            "e.g., no new dependencies, keep backward compat"
          );
          oc.state.constraints = constraintInput
            ? constraintInput.split(",").map((c) => c.trim()).filter(Boolean)
            : [];
        }
        oc.persistState();

        // Workflow choice: plan first, deep plan, direct to beads, or Superpowers spec-first
        const workflowOptions = [
          "📋 Plan first — generate a single plan document before creating beads",
          "🧠 Multi-model plan — competing planners synthesize one plan document",
          "🧠 Deep plan (beads) — multi-model planning agents create beads",
          "⚡ Direct to beads — jump straight to bead creation",
          "🪄 Superpowers Planning — spec-first: brainstorm → spec → approve → plan",
        ];

        let workflowChoice: string | undefined;
        try {
          workflowChoice = await ctx.ui.select("🛤️ Choose a workflow:", workflowOptions);
        } catch {
          workflowChoice = workflowOptions[3]; // default to direct
        }

        if (workflowChoice === undefined) {
          oc.orchestratorActive = false;
          oc.setPhase("idle", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "Workflow selection cancelled. Orchestration stopped." }],
            details: { selected: false },
          };
        }

        const enrichedGoal = refinement.enrichedGoal;
        const constraintsSummary = oc.state.constraints.length > 0
          ? `\nConstraints: ${oc.state.constraints.join(", ")}`
          : "";
        const repoContext = formatRepoProfile(profile, scanResult);

        if (workflowChoice.startsWith("📋")) {
          oc.state.planRefinementRound = 0;
          oc.setPhase("planning", ctx);
          oc.persistState();
          return {
            content: [{
              type: "text",
              text: `**NEXT: Call \`agent_flywheel_plan\` with mode \`single_model\` NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nGenerate a detailed implementation plan as a markdown artifact. Stay inside the AgentFlywheel workflow: after the plan is written, return to \`agent_flywheel_approve_beads\` for plan approval before creating beads.`,
            }],
            details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "plan_first" },
          };
        }

        if (workflowChoice.startsWith("🧠 Multi-model")) {
          oc.state.planRefinementRound = 0;
          oc.setPhase("planning", ctx);
          oc.persistState();
          return {
            content: [{
              type: "text",
              text: `**NEXT: Call \`agent_flywheel_plan\` with mode \`multi_model\` NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nRun competing planners for correctness, robustness, and ergonomics, then synthesize them into one plan document artifact. Stay inside the AgentFlywheel workflow: after synthesis, return to \`agent_flywheel_approve_beads\` for plan approval before creating beads.`,
            }],
            details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "multi_model_plan" },
          };
        }

        if (workflowChoice.startsWith("🧠 Deep plan")) {
          oc.setPhase("planning", ctx);
          oc.persistState();
          return {
            content: [{
              type: "text",
              text: `**NEXT: Run deep planning with multi-model agents.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nUse the deep planning system to generate beads via multi-model triangulation.`,
            }],
            details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "deep_plan" },
          };
        }

        if (workflowChoice.startsWith("🪄")) {
          // Superpowers spec-first workflow: stash adapter state and stay in planning phase.
          oc.state.planRefinementRound = 0;
          oc.state.planningWorkflow = initSuperpowersWorkflow({
            goal: enrichedGoal,
            constraints: oc.state.constraints,
          });
          oc.setPhase("planning", ctx);
          oc.persistState();
          return {
            content: [{
              type: "text",
              text: `**NEXT: Call \`agent_flywheel_plan\` with mode \`superpowers\` NOW.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nGenerate the Superpowers spec artifact (stored at \`planningWorkflow.specArtifact\`, NOT \`planDocument\`). After the spec is approved via \`agent_flywheel_approve_beads\`, the implementation plan stage runs and only then are beads created.`,
            }],
            details: {
              profile,
              scanResult,
              customGoal: goal,
              selected: true,
              goal: enrichedGoal,
              constraints: oc.state.constraints,
              workflow: "superpowers",
              planningWorkflow: oc.state.planningWorkflow,
            },
          };
        }

        // Default: Direct to beads
        const instructions = beadCreationPrompt(enrichedGoal, repoContext, oc.state.constraints);
        oc.setPhase("creating_beads", ctx);
        oc.persistState();
        return {
          content: [{
            type: "text",
            text: `**NEXT: Draft a structured staged bead mutation plan for this goal, then call \`agent_flywheel_approve_beads\` to validate/apply it before implementation.**\n\nGoal: "${enrichedGoal}"${constraintsSummary}\n\nStay inside the AgentFlywheel workflow: once the staged plan is ready, return to \`agent_flywheel_approve_beads\` for validation and bead approval before implementation.\n\n---\n\n${instructions}`,
          }],
          details: { profile, scanResult, customGoal: goal, selected: true, goal: enrichedGoal, constraints: oc.state.constraints, workflow: "direct" },
        };
      }

      if (discoveryMode?.startsWith("⚔️")) {
        // Dueling Idea Wizards: independent cross-model ideation → adversarial scoring → reveal → synthesis.
        oc.setPhase("discovering", ctx);
        oc.persistState();

        let existingBeadTitles: string[] = [];
        try {
          const brListResult = await brExecJson<unknown[]>(oc.pi, ["list", "--json"], {
            cwd: ctx.cwd,
            timeout: 8000,
          });
          if (brListResult.ok && Array.isArray(brListResult.value)) {
            existingBeadTitles = brListResult.value
              .map((b: unknown) => (b as Record<string, unknown>)?.title)
              .filter((t): t is string => typeof t === "string");
          }
        } catch {
          try {
            const { readBeads } = await import("../beads.js");
            const beads = await readBeads(oc.pi, ctx.cwd);
            existingBeadTitles = beads.map((b) => b.title);
          } catch { /* no beads yet */ }
        }

        const {
          buildDuelingIdeaSubagentConfigs,
          getMissingDuelingIdeaAgents,
          runDuelingIdeaWizards,
          selectDuelingIdeaAgents,
        } = await import("../dueling-ideas.js");
        const duelingResearchFocus = oc.state.researchState?.url
          ? { externalUrl: oc.state.researchState.url, externalName: oc.state.researchState.externalName }
          : undefined;
        const wizardAgents = selectDuelingIdeaAgents(ctx, 3);
        const missingWizardAgents = ctx.hasUI ? getMissingDuelingIdeaAgents(ctx, wizardAgents) : [];
        const shouldPromptForWizards = missingWizardAgents.length > 0 && !oc.state.duelingWizardLaunchRequested;
        if (shouldPromptForWizards) {
          oc.state.duelingWizardLaunchRequested = true;
          oc.setPhase("discovering", ctx);
          oc.persistState();
          const pendingConfigs = buildDuelingIdeaSubagentConfigs(
            ctx.cwd,
            missingWizardAgents,
            profile,
            scanResult,
            existingBeadTitles,
            ctx,
            duelingResearchFocus,
          );
          const completedAgents = wizardAgents
            .filter((agent) => !missingWizardAgents.some((missing) => missing.type === agent.type))
            .map((agent) => `${agent.type} (${agent.model})`);
          const statusLine = completedAgents.length > 0
            ? `Completed wizard artifacts: ${completedAgents.join(", ")}\nPending wizards: ${missingWizardAgents.map((agent) => `${agent.type} (${agent.model})`).join(", ")}`
            : `Pending wizards: ${missingWizardAgents.map((agent) => `${agent.type} (${agent.model})`).join(", ")}`;

          return {
            content: [{
              type: "text",
              text:
                `**Workflow:** ${roadmap}\n\n` +
                `**NEXT: Spawn autonomous Dueling Idea Wizard sub-agents using \`subagent\` NOW.**\n\n` +
                `${statusLine}\n\n` +
                `Launch one \`subagent\` call for each pending wizard config below. ` +
                `Each wizard writes independent ideas to a session artifact, sends one final response, and exits. ` +
                `After all wizard sub-agents complete, call \`agent_flywheel_profile\` again and choose Dueling Idea Wizards to continue cross-scoring and synthesis.\n\n` +
                `\`\`\`json\n${JSON.stringify(pendingConfigs, null, 2)}\n\`\`\``,
            }],
            details: {
              profile,
              scanResult,
              dueling: true,
              interactive: false,
              awaitingWizardArtifacts: true,
              agents: wizardAgents,
              pendingWizardCount: pendingConfigs.length,
            },
          };
        }

        if (missingWizardAgents.length > 0 && oc.state.duelingWizardLaunchRequested) {
          ctx.ui.notify(
            "⚠️ Wizard artifacts are still missing after the launch step. Recovering by running the missing Dueling Idea Wizard phase in-process instead of prompting again.",
            "warning"
          );
        }

        const duel = await runDuelingIdeaWizards(
          oc.pi,
          ctx,
          profile,
          scanResult,
          existingBeadTitles,
          signal,
          (message) => ctx.ui.notify(message, "info"),
          duelingResearchFocus,
        );

        if (duel.consensusIdeas.length === 0) {
          ctx.ui.notify("⚠️ Dueling Idea Wizards produced no parseable consensus ideas. Falling back to standard discovery.", "warning");
          const modeInstructions = discoveryInstructions(profile, scanResult);
          return {
            content: [{
              type: "text",
              text: `**Workflow:** ${roadmap}\n\n**NEXT: Call \`agent_flywheel_discover\` with your top 5 ideas and next 5-10 honorable mentions NOW.**\n\n${modeInstructions}\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}${upgradeHint}${foundationWarning}\n\n${formatted}${memoryContext}`,
            }],
            details: { profile, scanResult, duelingFallback: true },
          };
        }

        oc.state.candidateIdeas = duel.consensusIdeas;
        oc.state.funnelRawIdeas = Object.values(duel.ideasByAgent).flat();
        oc.state.funnelWinnowedIds = duel.consensusIdeas.filter((i) => i.tier === "top").map((i) => i.id);
        oc.state.duelingWizardLaunchRequested = false;
        oc.setPhase("awaiting_selection", ctx);
        oc.persistState();

        const ideasSummary = duel.consensusIdeas
          .map((idea, n) => `${n + 1}. **${idea.title}** [${idea.category}] — ${idea.description}`)
          .join("\n");
        const agentSummary = duel.agents.map((a) => `${a.type} (${a.model})`).join(", ");

        return {
          content: [{
            type: "text",
            text:
              `**Workflow:** ${roadmap}\n\n` +
              `**NEXT: Call \`agent_flywheel_select\` NOW to present these ${duel.consensusIdeas.length} consensus ideas to the user.**\n\n` +
              `---\n\n⚔️ Dueling Idea Wizards complete.\n\n` +
              `Agents used: ${agentSummary}\n\n` +
              `Report artifact: \`${duel.reportArtifactName}\`\n\n` +
              `### Consensus Ideas\n${ideasSummary}`,
          }],
          details: {
            profile,
            scanResult,
            dueling: true,
            agents: duel.agents,
            scoreCount: duel.scores.length,
            reportArtifactName: duel.reportArtifactName,
            selectedCount: duel.consensusIdeas.length,
          },
        };
      }

      if (discoveryMode?.startsWith("🔬")) {
        // Deep discovery: 30→5→15 funnel via sub-agents
        oc.setPhase("discovering", ctx);
        oc.persistState();

        const { broadIdeationPrompt, winnowingPrompt, expandIdeasPrompt, parseIdeasJSON, parseWinnowingResult } = await import("../ideation-funnel.js");
        // GAP 15 & 17: import WINNOWING_MODEL_NOTE for annotation (enforces model divergence)
        const { WINNOWING_MODEL_NOTE: _winnowingNote } = await import("../ideation-funnel.js");
        void _winnowingNote; // already prepended inside winnowingPrompt() itself
        const { runDeepPlanAgents } = await import("../deep-plan.js");
        const { pickRefinementModel } = await import("../prompts.js");

        // Phase 1: Generate 30 ideas (sub-agent)
        // GAP 15: fetch existing bead titles to prevent duplicate proposals
        ctx.ui.notify("💡 Phase 1/3: Generating 30 raw ideas...", "info");
        let phase1BeadTitles: string[] = [];
        try {
          // Try br list --json first (as specified), fall back to readBeads
          const brListResult = await brExecJson<unknown[]>(oc.pi, ["list", "--json"], {
            cwd: ctx.cwd,
            timeout: 8000,
          });
          if (!brListResult.ok) {
            throw new Error(brListResult.error.stderr || brListResult.error.command);
          }
          if (Array.isArray(brListResult.value)) {
            phase1BeadTitles = brListResult.value
              .map((b: unknown) => (b as Record<string, unknown>)?.title)
              .filter((t): t is string => typeof t === "string");
          }
        } catch {
          // br unavailable or failed — try readBeads fallback, then continue with empty array
          try {
            const { readBeads } = await import("../beads.js");
            const beads = await readBeads(oc.pi, ctx.cwd);
            phase1BeadTitles = beads.map((b) => b.title);
          } catch { /* no beads yet, pass empty array */ }
        }
        const phase1Prompt = broadIdeationPrompt(profile, scanResult, phase1BeadTitles);
        // GAP 17: model(0) for ideation — winnowing MUST use a different model (model(1))
        const phase1Results = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
          name: "ideation-broad",
          model: pickRefinementModel(0), // ideation model — different from winnowing (model 1)
          task: phase1Prompt,
        }], signal);
        const rawIdeas = parseIdeasJSON(phase1Results[0]?.plan ?? "");

        if (rawIdeas.length < 10) {
          // Fallback to standard discovery if broad ideation failed
          ctx.ui.notify(`⚠️ Broad ideation produced only ${rawIdeas.length} ideas. Falling back to standard discovery.`, "warning");
          const modeInstructions = discoveryInstructions(profile, scanResult);
          return {
            content: [{
              type: "text",
              text: `**Workflow:** ${roadmap}\n\n**NEXT: Call \`agent_flywheel_discover\` with your top 5 ideas and next 5-10 honorable mentions NOW.**\n\n${modeInstructions}\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}${upgradeHint}${foundationWarning}\n\n${formatted}${memoryContext}`,
            }],
            details: { profile, scanResult, funnelFallback: true },
          };
        }

        oc.state.funnelRawIdeas = rawIdeas;
        oc.persistState();
        ctx.ui.notify(`✅ Phase 1 complete: ${rawIdeas.length} raw ideas generated.`, "info");

        // Phase 2: Winnow to 5 (DIFFERENT model — GAP 17)
        // pickRefinementModel(1) is structurally different from pickRefinementModel(0).
        // This ensures winnowing uses a different provider/checkpoint than ideation,
        // so the critique comes from genuinely different blind spots.
        ctx.ui.notify("🔬 Phase 2/3: Competitive winnowing (30→5)...", "info");
        const phase2Prompt = winnowingPrompt(rawIdeas, profile);
        const phase2Results = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
          name: "ideation-winnow",
          // GAP 17: MUST use a different model index than ideation (index 0).
          // Different models = different blind spots = real critical evaluation.
          model: pickRefinementModel(1), // winnowing model — structurally different from ideation (model 0)
          task: phase2Prompt,
        }], signal);
        const winnowResult = parseWinnowingResult(phase2Results[0]?.plan ?? "");

        if (winnowResult.keptIds.length === 0) {
          ctx.ui.notify(`⚠️ Winnowing failed to parse results. Using top-scored ideas instead.`, "warning");
          // Fallback: sort by weighted score and take top 5
          winnowResult.keptIds.push(
            ...rawIdeas
              .sort((a, b) => weightedScore(b) - weightedScore(a))
              .slice(0, 5)
              .map((i) => i.id)
          );
        }

        oc.state.funnelWinnowedIds = winnowResult.keptIds;
        oc.persistState();

        let top5 = winnowResult.keptIds
          .map((id) => rawIdeas.find((i) => i.id === id))
          .filter((i): i is NonNullable<typeof i> => i !== undefined && i !== null);

        const desiredTopCount = Math.min(5, rawIdeas.length);
        if (top5.length < desiredTopCount) {
          const chosenIds = new Set(top5.map((i) => i.id));
          const supplements = rawIdeas
            .filter((idea) => !chosenIds.has(idea.id))
            .slice()
            .sort((a, b) => weightedScore(b) - weightedScore(a))
            .slice(0, desiredTopCount - top5.length);
          ctx.ui.notify(
            top5.length === 0
              ? "⚠️ Winnowing returned IDs that did not match generated ideas. Falling back to top-scored ideas."
              : `⚠️ Winnowing matched only ${top5.length}/${desiredTopCount} ideas. Filling the rest by score.`,
            "warning"
          );
          top5 = [...top5, ...supplements];
          oc.state.funnelWinnowedIds = top5.map((idea) => idea.id);
          oc.persistState();
        }

        // Mark top 5 as tier "top"
        for (const idea of top5) idea.tier = "top";

        ctx.ui.notify(`✅ Phase 2 complete: ${winnowResult.cutCount} ideas cut, ${top5.length} kept.`, "info");

        // Phase 3: Expand to 15 (10 more ideas)
        ctx.ui.notify("💡 Phase 3/3: Generating 10 complementary ideas...", "info");
        let existingBeadTitles: string[] = [];
        try {
          const { readBeads } = await import("../beads.js");
          const beads = await readBeads(oc.pi, ctx.cwd);
          existingBeadTitles = beads.map((b) => b.title);
        } catch { /* no beads yet */ }

        const phase3Prompt = expandIdeasPrompt(top5, existingBeadTitles, profile);
        const phase3Results = await runDeepPlanAgents(oc.pi, ctx.cwd, [{
          name: "ideation-expand",
          model: pickRefinementModel(2), // yet another model
          task: phase3Prompt,
        }], signal);
        const expandedIdeas = parseIdeasJSON(phase3Results[0]?.plan ?? "");

        // Mark expanded ideas as honorable
        for (const idea of expandedIdeas) idea.tier = "honorable";

        // Combine: top 5 + expanded
        const allIdeas = [...top5, ...expandedIdeas];
        ctx.ui.notify(`✅ Deep discovery complete: ${top5.length} top + ${expandedIdeas.length} honorable = ${allIdeas.length} total ideas.`, "info");

        // ── GAP 16: Human review between Phase 3 and bead creation ──────────────
        // The guide requires a human review step: users must confirm which ideas
        // to pursue before beads are created.
        const ideasSummary = [
          `### Top ${top5.length} Ideas (winnowed from ${rawIdeas.length} raw)`,
          ...top5.map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`),
          `\n### Complementary Ideas (${expandedIdeas.length})`,
          ...expandedIdeas.map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`),
        ].join("\n");

        const reviewChoice = await ctx.ui.select(
          `🔬 Phase 3 complete — ${allIdeas.length} ideas ready.\n\n${ideasSummary}\n\nHow do you want to proceed?`,
          [
            `✅ Accept all ${allIdeas.length} — present these for goal selection`,
            "🔍 Select subset — choose which to present",
            "🔄 Refine further — run discovery again",
            "❌ Discard — start over",
          ]
        );

        if (!reviewChoice) {
          oc.orchestratorActive = false;
          oc.setPhase("idle", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "Deep discovery review cancelled. Orchestration stopped." }],
            details: { profile, scanResult, funnel: true, cancelled: true },
          };
        }

        let finalIdeas = allIdeas;

        if (reviewChoice.startsWith("❌")) {
          // User wants to start over — reset funnel state and restart
          oc.state.funnelRawIdeas = undefined;
          oc.state.funnelWinnowedIds = undefined;
          oc.state.candidateIdeas = undefined;
          oc.setPhase("profiling", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "Discarded. Call `orch_profile` to start the discovery funnel again." }],
            details: { profile, scanResult, funnel: true, discarded: true },
          };
        } else if (reviewChoice.startsWith("🔄")) {
          // User wants to refine further — re-run orch_profile with deep discovery
          oc.state.funnelRawIdeas = undefined;
          oc.state.funnelWinnowedIds = undefined;
          oc.state.candidateIdeas = undefined;
          oc.setPhase("profiling", ctx);
          oc.persistState();
          return {
            content: [{ type: "text", text: "Resetting for another round. Call `orch_profile` and choose deep discovery again to refine further." }],
            details: { profile, scanResult, funnel: true, refined: true },
          };
        } else if (reviewChoice.startsWith("🔍")) {
          // User wants to select a subset — show each idea with confirm
          ctx.ui.notify("Select which ideas to pursue (confirm each one):", "info");
          const selectedIdeas: typeof allIdeas = [];
          for (const idea of allIdeas) {
            const keep = await ctx.ui.confirm(
              `Keep "${idea.title}"?`,
              `[${idea.category}] ${idea.description}`
            );
            if (keep) selectedIdeas.push(idea);
          }
          if (selectedIdeas.length === 0) {
            ctx.ui.notify("No ideas selected. Using all ideas instead.", "warning");
          } else {
            finalIdeas = selectedIdeas;
            ctx.ui.notify(`Selected ${finalIdeas.length} idea(s) to pursue.`, "info");
          }
        }
        // else "✅ Accept all" — present allIdeas in the normal goal-selection step

        oc.state.candidateIdeas = finalIdeas;
        oc.state.funnelWinnowedIds = finalIdeas.filter((i) => i.tier === "top").map((i) => i.id);
        oc.setPhase("awaiting_selection", ctx);
        oc.persistState();

        return {
          content: [{
            type: "text",
            text: `**Workflow:** ${roadmap}\n\n**NEXT: Call \`agent_flywheel_select\` NOW to present these ${finalIdeas.length} ideas to the user.**\n\n---\n\n🔬 Deep discovery complete (30→5→${allIdeas.length} funnel, ${finalIdeas.length} selected)\n\n### Top Ideas (tier: top)\n${finalIdeas.filter(i => i.tier === "top").map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`).join("\n")}\n\n### Complementary Ideas (tier: honorable)\n${finalIdeas.filter(i => i.tier !== "top").map((i, n) => `${n + 1}. **${i.title}** [${i.category}] — ${i.description}`).join("\n")}`,
          }],
          details: { profile, scanResult, funnel: true, rawCount: rawIdeas.length, winnowedCount: top5.length, expandedCount: expandedIdeas.length, selectedCount: finalIdeas.length },
        };
      }

      // Reactivate deferred beads
      if (discoveryMode?.startsWith("♻️")) {
        ctx.ui.notify(`♻️ Reactivating ${deferredBeadIds.length} deferred bead(s)...`, "info");
        let reactivated = 0;
        for (const id of deferredBeadIds) {
          const reactivateResult = await brExec(oc.pi, ["update", id, "--status", "open"], {
            cwd: ctx.cwd,
            timeout: 5000,
          });
          if (reactivateResult.ok) {
            reactivated++;
          }
        }
        ctx.ui.notify(`✅ Reactivated ${reactivated} bead(s).`, "info");
        oc.orchestratorActive = true;
        oc.setPhase("implementing", ctx);
        oc.persistState();
        const { implementerInstructions } = await import("../prompts.js");
        const { readMemory } = await import("../memory.js");
        const { formatBeadSkillRecommendations } = await import("../skill-awareness.js");
        const { readyBeads } = await import("../beads.js");
        const memRules = readMemory(ctx.cwd);
        const ready = await readyBeads(oc.pi, ctx.cwd);
        const nextBead = ready[0];
        if (!nextBead) {
          return {
            content: [{ type: "text", text: `♻️ Reactivated ${reactivated} bead(s). Run \`br ready\` to see what\'s unblocked.` }],
            details: { profile, scanResult },
          };
        }
        const beadProfile = oc.state.repoProfile ?? profile;
        const prevResults = Object.values(oc.state.beadResults ?? {});
        const skillRecs1 = formatBeadSkillRecommendations(nextBead.description, [], ctx.cwd);
        return {
          content: [{
            type: "text",
            text: implementerInstructions(nextBead, beadProfile, prevResults, memRules, skillRecs1 || undefined),
          }],
          details: { profile, scanResult, implementingBead: nextBead.id },
        };
      }

      // Work on existing beads
      if (discoveryMode?.startsWith("▶️")) {
        oc.orchestratorActive = true;
        oc.setPhase("implementing", ctx);
        oc.persistState();
        const { implementerInstructions } = await import("../prompts.js");
        const { readMemory } = await import("../memory.js");
        const { formatBeadSkillRecommendations } = await import("../skill-awareness.js");
        const { readyBeads } = await import("../beads.js");
        const memRules = readMemory(ctx.cwd);
        // Pick the first ready (unblocked) bead
        const ready = await readyBeads(oc.pi, ctx.cwd);
        const nextBead = ready[0];
        if (!nextBead) {
          return {
            content: [{ type: "text", text: "No ready beads found (all may be blocked by dependencies). Run `br ready` to check." }],
            details: { profile, scanResult },
          };
        }
        const beadProfile = oc.state.repoProfile ?? profile;
        const prevResults = Object.values(oc.state.beadResults ?? {});
        const skillRecs2 = formatBeadSkillRecommendations(nextBead.description, [], ctx.cwd);
        return {
          content: [{
            type: "text",
            text: implementerInstructions(nextBead, beadProfile, prevResults, memRules, skillRecs2 || undefined),
          }],
          details: { profile, scanResult, implementingBead: nextBead.id },
        };
      }

      // Cancel
      if (!discoveryMode || discoveryMode.startsWith("❌")) {
        oc.orchestratorActive = false;
        oc.setPhase("idle", ctx);
        oc.persistState();
        return {
          content: [{ type: "text", text: "Orchestration cancelled." }],
          details: { profile, scanResult, cancelled: true },
        };
      }

      // Clear beads
      if (discoveryMode.startsWith("🗑️")) {
        let deleted = 0;
        if (allBeadIds.length > 0) {
          // --force bypasses dependent checks; --hard prunes tombstones from JSONL immediately
          const hardDeleteResult = await brExec(oc.pi, ["delete", ...allBeadIds, "--force", "--hard"], {
            cwd: ctx.cwd,
            timeout: 15000,
          });
          if (hardDeleteResult.ok) {
            deleted = allBeadIds.length;
            ctx.ui.notify(`🗑️ Deleted ${deleted} bead(s).`, "info");
          } else {
            // Fallback: try without --hard in case version doesn't support it
            const forceDeleteResult = await brExec(oc.pi, ["delete", ...allBeadIds, "--force"], {
              cwd: ctx.cwd,
              timeout: 15000,
            });
            if (forceDeleteResult.ok) {
              deleted = allBeadIds.length;
              ctx.ui.notify(`🗑️ Deleted ${deleted} bead(s).`, "info");
            } else {
              ctx.ui.notify("⚠️ Failed to delete beads — try \`br delete --force\` manually.", "warning");
            }
          }
        }
        oc.setPhase("idle", ctx);
        oc.persistState();
        // Auto-restart orchestration so user doesn't have to manually re-run
        oc.pi.sendUserMessage("/agent-flywheel", { deliverAs: "followUp" });
        return {
          content: [{ type: "text", text: `🗑️ Cleared ${deleted} bead(s). Starting fresh...` }],
          details: { profile, scanResult, cleared: true },
        };
      }

      // Standard discovery (default)
      const modeInstructions = discoveryInstructions(profile, scanResult);
      const discoveryPrompt = `**NEXT: Call \`agent_flywheel_discover\` with your top 5 ideas and next 5-10 honorable mentions NOW.**\n\n${modeInstructions}`;

      return {
        content: [
          {
            type: "text",
            text: `**Workflow:** ${roadmap}\n\n${discoveryPrompt}\n\n---\n\nRepository profiled successfully.\n\n${scanSourceLine}\n${coordLine}${upgradeHint}${foundationWarning}\n\n${formatted}${memoryContext}`,
          },
        ],
        details: { profile, scanResult },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("agent_flywheel_profile ")) +
          theme.fg("dim", "scanning repository..."),
        0, 0
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "📊 Scanning..."), 0, 0);
      const d = result.details as any;
      let text = theme.fg("success", "📊 Repository profiled");
      if (d?.scanResult?.source) {
        const sourceLabel = d.scanResult.source === "ccc" ? "ccc" : "built-in";
        text += theme.fg("dim", ` via ${sourceLabel}`);
      }
      if (d?.profile) {
        text += theme.fg("dim", ` — ${d.profile.name}`);
        text += theme.fg("dim", ` [${d.profile.languages?.join(", ")}]`);
      }
      if (expanded && d?.profile) {
        text += `\n  Frameworks: ${d.profile.frameworks?.join(", ") || "none"}`;
        text += `\n  Tests: ${d.profile.hasTests ? "yes" : "no"}`;
        text += `\n  TODOs: ${d.profile.todos?.length ?? 0}`;
      }
      return new Text(text, 0, 0);
    },
  });
  }
}
