import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";
import type { OrchestratorContext } from "../types.js";
import { profileRepo } from "../profiler.js";
import { sessionArtifactPath } from "../session-artifacts.js";
import { researchHandoffPrompt } from "../prompts.js";
import { extractProjectName, runResearchPhase } from "../research-pipeline.js";

const RESEARCH_PHASES: Array<{ phase: string; label: string; emoji: string }> = [
  { phase: "investigate",  label: "Investigating external project", emoji: "📚" },
  { phase: "deepen",       label: "Deepening analysis",             emoji: "🔍" },
  { phase: "inversion",    label: "Inversion analysis",             emoji: "🔄" },
  { phase: "blunder_hunt", label: "5x blunder hunt",                emoji: "🔨" },
  { phase: "user_review",  label: "User review",                    emoji: "📝" },
  { phase: "multi_model",  label: "Multi-model feedback",           emoji: "🧠" },
  { phase: "synthesis",    label: "Synthesizing feedback",          emoji: "🔗" },
];

function normalizeResearchUrl(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerResearchTool(oc: OrchestratorContext) {
  for (const toolName of ["agent_flywheel_research", "orch_research", "flywheel_research"] as const) {
  oc.pi.registerTool({
    name: toolName,
    label: "Research External Repo",
    description: "Study an external GitHub project and reimagine its ideas for the current repo. Use this instead of flywheel_profile when the user asks for /flywheel-research or /agent-flywheel-research with a URL.",
    promptSnippet: "Research an external repo URL and turn it into an AgentFlywheel proposal",
    parameters: Type.Object({
      url: Type.String({ description: "GitHub repository URL to research, e.g. https://github.com/org/repo" }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const url = normalizeResearchUrl(params.url);
      if (!url) {
        return {
          content: [{ type: "text", text: "Error: url is required. Call flywheel_research({ url: \"https://github.com/org/repo\" })." }],
          details: { error: true, code: "NO_URL" },
        };
      }

      const externalName = extractProjectName(url);
      const artifactName = `research/${externalName}-proposal.md`;
      const artifactPath = sessionArtifactPath(ctx, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });

      if (!oc.state.repoProfile) {
        ctx.ui.notify("📊 No repo profile found — running quick profile before research...", "info");
        try {
          oc.state.repoProfile = await profileRepo(oc.pi, ctx.cwd);
          oc.persistState();
          ctx.ui.notify(`✅ Profiled current repo: ${oc.state.repoProfile.name} (${oc.state.repoProfile.languages.join(", ")})`, "info");
        } catch (err: any) {
          ctx.ui.notify(`⚠️ Could not profile current repo: ${err.message ?? err}. Continuing without profile.`, "warning");
        }
      }

      const projectName = oc.state.repoProfile?.name ?? "this project";
      const existingResearch = oc.state.researchState;
      const isResumingSameUrl = existingResearch?.url === url;
      const alreadyCompleted = new Set<string>(
        isResumingSameUrl ? (existingResearch?.phasesCompleted ?? []) : []
      );

      let initialProposal = "";
      if (isResumingSameUrl && existsSync(artifactPath)) {
        try { initialProposal = readFileSync(artifactPath, "utf8"); } catch { /* ignore */ }
      }

      if (isResumingSameUrl && alreadyCompleted.size > 0) {
        ctx.ui.notify(
          `🔁 Resuming research for \`${externalName}\` — skipping ${alreadyCompleted.size} completed phase(s): ${[...alreadyCompleted].join(", ")}`,
          "info"
        );
      }

      const pipelineState = {
        externalUrl: url,
        externalName,
        projectName,
        currentPhase: "investigate" as const,
        proposal: initialProposal,
        artifactName,
        phasesCompleted: [...alreadyCompleted] as string[],
      };

      oc.orchestratorActive = true;
      oc.setPhase("researching", ctx);
      oc.state.researchState = { url, externalName, artifactName, phasesCompleted: [...alreadyCompleted] };
      oc.persistState();

      const userReviewCallback = async (proposal: string): Promise<{ accepted: boolean; editedProposal?: string }> => {
        const PREVIEW_CHARS = 2000;
        const preview = proposal.length > PREVIEW_CHARS
          ? proposal.slice(0, PREVIEW_CHARS) + `\n...\n*(${proposal.length - PREVIEW_CHARS} more chars — full proposal at ${artifactName})*`
          : proposal;

        const choice = await ctx.ui.select(
          `📝 **User Review — proposal after 5x blunder hunt**\n\n` +
          `Saved to: \`${artifactName}\`\n\n` +
          `**Preview:**\n${preview}\n\n` +
          `Tip: Open the artifact file to read or edit the full proposal before continuing.`,
          [
            "✅ Accept and continue to multi-model feedback",
            "✏️  Pause — I will edit the file manually, then rerun",
            "⏸️  Pause pipeline (resume manually)",
          ]
        );

        if (choice?.startsWith("✏️")) {
          ctx.ui.notify(
            `Pipeline paused for manual editing.\n` +
            `Edit the proposal at:\n  ${artifactPath}\n\n` +
            `When done, rerun \`/flywheel-research ${url}\` or call \`flywheel_research({ url: \"${url}\" })\` to resume.`,
            "info"
          );
          return { accepted: false };
        }

        if (!choice || choice.startsWith("⏸️")) {
          ctx.ui.notify(
            `Research pipeline paused.\nProposal saved to: ${artifactName}\n\n` +
            `Rerun \`/flywheel-research ${url}\` or call \`flywheel_research({ url: \"${url}\" })\` to resume.`,
            "info"
          );
          return { accepted: false };
        }

        return { accepted: true };
      };

      const phaseLog: string[] = [];

      for (const { phase, label, emoji } of RESEARCH_PHASES) {
        if (alreadyCompleted.has(phase)) {
          phaseLog.push(`⏭️ ${emoji} **${label}** — skipped (completed in prior session)`);
          continue;
        }

        ctx.ui.notify(`${emoji} Phase ${RESEARCH_PHASES.findIndex(p => p.phase === phase) + 1}/7: ${label}...`, "info");
        (pipelineState as any).currentPhase = phase;
        const reviewCb = phase === "user_review" ? userReviewCallback : undefined;

        try {
          const result = await runResearchPhase(oc.pi, ctx.cwd, phase as any, pipelineState as any, signal, reviewCb);
          if (result.proposal) {
            pipelineState.proposal = result.proposal;
            writeFileSync(artifactPath, pipelineState.proposal, "utf8");
          }

          if (!result.success) {
            if (phase === "user_review") {
              oc.state.researchState = {
                url, externalName, artifactName,
                phasesCompleted: [...pipelineState.phasesCompleted],
              };
              oc.persistState();
              return {
                content: [{ type: "text", text: `Research pipeline paused at user review. Proposal artifact: \`${artifactName}\`.` }],
                details: { paused: true, phase, artifactName, artifactPath },
              };
            }
            // If investigate failed with no proposal there is nothing to deepen/stress-test.
            // Abort rather than running subsequent phases on empty content.
            if (phase === "investigate" && !pipelineState.proposal) {
              const errDetail = result.error ?? "investigate agent returned no output";
              ctx.ui.notify(
                `❌ ${emoji} **${label}** failed — aborting pipeline: ${errDetail}`,
                "error"
              );
              oc.orchestratorActive = false;
              oc.setPhase("idle", ctx);
              oc.state.researchState = undefined;
              oc.persistState();
              return {
                content: [{ type: "text", text: `Research pipeline aborted at investigate phase.\n\n${errDetail}\n\nVerify your model and API key are configured, then retry.` }],
                details: { error: true, phase: "investigate", errDetail },
              };
            }
            const warnDetail = result.error
              ?? [
                  `phase=${phase}`,
                  result.model ? `model=${result.model}` : null,
                  `proposal-length=${pipelineState.proposal.length}`,
                  "no error detail returned",
                ].filter(Boolean).join(" | ");
            const warn = `⚠️ ${emoji} **${label}** had issues: ${warnDetail}. Continuing.`;
            ctx.ui.notify(warn, "warning");
            phaseLog.push(warn);
          } else {
            pipelineState.phasesCompleted.push(phase);
            alreadyCompleted.add(phase);
            oc.state.researchState = {
              url, externalName, artifactName,
              phasesCompleted: [...pipelineState.phasesCompleted],
            };
            oc.persistState();

            if (phase !== "user_review" && phase !== "multi_model") {
              const snippet = pipelineState.proposal.slice(0, 300).replace(/\n+/g, " ");
              const hasProposal = pipelineState.proposal.length > 100;
              const status = hasProposal
                ? `✅ ${emoji} **${label}** complete${result.model ? ` (${result.model})` : ""} — proposal ${pipelineState.proposal.length} chars\n\n> ${snippet}${pipelineState.proposal.length > 300 ? "..." : ""}\n\n_Artifact: ${artifactName}_`
                : `⚠️ ${emoji} **${label}** produced no output — check that the repo URL is accessible.`;
              phaseLog.push(status);
              ctx.ui.notify(status, hasProposal ? "info" : "warning");
            }
          }
        } catch (err: any) {
          const errMsg = `❌ ${emoji} **${label}** failed: ${err.message ?? err}. Continuing with current proposal.`;
          ctx.ui.notify(errMsg, "error");
          phaseLog.push(errMsg);
        }
      }

      const selectedGoal = `Research-reimagine: ${externalName} ideas for ${projectName}`;
      oc.state.selectedGoal = selectedGoal;
      oc.state.planDocument = artifactName;
      oc.state.planRefinementRound = 0;
      oc.state.researchState = undefined;
      oc.setPhase("awaiting_plan_approval", ctx);
      oc.persistState();

      const completedCount = pipelineState.phasesCompleted.length;
      const handoff = researchHandoffPrompt(
        externalName,
        selectedGoal,
        artifactName,
        completedCount,
        RESEARCH_PHASES.length,
        !!oc.state.repoProfile
      );

      return {
        content: [{ type: "text", text: handoff }],
        details: {
          externalUrl: url,
          externalName,
          projectName,
          artifactName,
          artifactPath,
          completedCount,
          totalPhases: RESEARCH_PHASES.length,
          phaseLog,
          next: "flywheel_approve_beads",
        },
      };
    },

    renderResult(result, _options, theme) {
      const artifact = (result?.details as any)?.artifactName;
      return new Text(theme.fg("success", `flywheel_research${artifact ? ` → ${artifact}` : ""}`), 0, 0);
    },
  });
  }
}
