import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext } from "../types.js";
import { formatRepoProfile, beadCreationPrompt } from "../prompts.js";
import { runGoalRefinement, extractConstraints } from "../goal-refinement.js";
import { initSuperpowersWorkflow } from "../workflows/superpowers.js";

import { emitToolDeprecationWarning, canonicalName } from "./shared.js";
import { FlywheelError } from "../errors.js";
export function registerSelectTool(oc: OrchestratorContext) {
  for (const toolName of ["agent_flywheel_select", "orch_select", "flywheel_select"] as const) {
  oc.pi.registerTool({
    name: toolName,
    label: "Select Idea",
    description:
      "Present the discovered ideas to the user and let them select one (or enter a custom goal). Returns the selected goal string. [phase 3/6, prereq: flywheel_discover, next: flywheel_plan]",
    promptSnippet: "Present ideas to user for selection",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      emitToolDeprecationWarning(toolName, canonicalName("select"));
      if (!oc.state.candidateIdeas || oc.state.candidateIdeas.length === 0) {
        throw new FlywheelError("NO_IDEAS");
      }

      // Group ideas by tier for display
      const topIdeas = oc.state.candidateIdeas.filter((i) => i.tier === "top");
      const honorableIdeas = oc.state.candidateIdeas.filter((i) => i.tier === "honorable" || !i.tier);
      const hasMixedTiers = topIdeas.length > 0 && honorableIdeas.length > 0;

      // Build display options — ideas in tier order, each with rationale subtitle
      const orderedIdeas = hasMixedTiers ? [...topIdeas, ...honorableIdeas] : oc.state.candidateIdeas;
      const options: string[] = [];

      for (let i = 0; i < orderedIdeas.length; i++) {
        const idea = orderedIdeas[i];
        const rationaleSnippet = idea.rationale
          ? `\n     → ${idea.rationale.length > 120 ? idea.rationale.slice(0, 117) + "..." : idea.rationale}`
          : "";
        // Add tier header as a visual separator
        if (hasMixedTiers && i === 0) {
          options.push(`── Top Picks ──`);
        }
        if (hasMixedTiers && i === topIdeas.length) {
          options.push(`── Also Worth Considering ──`);
        }
        options.push(
          `[${idea.category}] ${idea.title} (effort: ${idea.effort}, impact: ${idea.impact})${rationaleSnippet}`
        );
      }
      options.push("✏️  Enter a custom goal");

      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(
          "🎯 Select a project idea to implement:",
          options
        );
      } catch (err) {
        ctx.ui.notify(`Select failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        oc.orchestratorActive = false;
        oc.setPhase("idle", ctx);
        oc.persistState();
        return {
          content: [{ type: "text", text: `Selection dialog failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { selected: false, error: true },
        };
      }

      if (choice === undefined) {
        oc.orchestratorActive = false;
        oc.setPhase("idle", ctx);
        oc.persistState();
        return {
          content: [
            { type: "text", text: "User cancelled selection. Orchestration stopped." },
          ],
          details: { selected: false },
        };
      }

      let goal: string;
      let refinementUsed = false;
      if (choice === "✏️  Enter a custom goal") {
        const custom = await ctx.ui.input(
          "Enter your goal:",
          "e.g., Add API rate limiting with Redis"
        );
        if (!custom) {
          oc.orchestratorActive = false;
          oc.setPhase("idle", ctx);
          oc.persistState();
          return {
            content: [
              { type: "text", text: "No goal entered. Orchestration stopped." },
            ],
            details: { selected: false },
          };
        }

        // Refine the goal via LLM-generated questionnaire
        const refinement = await runGoalRefinement(custom, oc.state.repoProfile!, oc.pi, ctx);
        goal = refinement.enrichedGoal;
        refinementUsed = !refinement.skipped;

        if (refinementUsed) {
          oc.state.constraints = extractConstraints(refinement.answers);
        }
      } else if (choice.startsWith("──")) {
        // User selected a tier header — treat as no selection
        oc.orchestratorActive = false;
        oc.setPhase("idle", ctx);
        oc.persistState();
        return {
          content: [{ type: "text", text: "No idea selected. Orchestration stopped." }],
          details: { selected: false },
        };
      } else {
        // Map selected option back to the idea in orderedIdeas
        const choiceIndex = options.indexOf(choice);
        // Count how many tier headers precede this choice
        const headersBefore = options.slice(0, choiceIndex).filter((o) => o.startsWith("──")).length;
        const ideaIndex = choiceIndex - headersBefore;
        const idea = orderedIdeas[ideaIndex];
        goal = `${idea.title}: ${idea.description}`;

        // System-generated ideas are already well-defined (title + description + rationale + scoring).
        // Skip refinement questionnaire — it adds latency without proportional value.
        // Refinement is still offered for custom goals (the "✏️ Enter a custom goal" path above)
        // and for "I know what I want" in profile.ts.
      }

      oc.state.selectedGoal = goal;
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

      // ── Workflow choice: plan first, deep plan, direct to beads, or Superpowers spec-first ──
      const workflowOptions = [
        "📋 Plan first — generate a single plan document before creating beads",
        "🧠 Multi-model plan — competing planners synthesize one plan document",
        "🧠 Deep plan (beads) — multi-model planning agents create beads",
        "⚡ Direct to beads — jump straight to bead creation",
        "🪄 Superpowers Planning — spec-first: brainstorm → spec → approve → plan",
      ];

      let workflowChoice: string | undefined;
      try {
        workflowChoice = await ctx.ui.select(
          "🛤️ Choose a workflow:",
          workflowOptions
        );
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

      const repoContext = oc.state.repoProfile ? formatRepoProfile(oc.state.repoProfile) : "";

      if (workflowChoice.startsWith("📋")) {
        // Plan-first workflow: stay in planning phase
        oc.state.planRefinementRound = 0;
        oc.setPhase("planning", ctx);
        oc.persistState();

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Call \`orch_plan\` with mode \`single_model\` NOW.**\n\nGoal: "${goal}"${oc.state.constraints.length > 0 ? `\nConstraints: ${oc.state.constraints.join(", ")}` : ""}\n\nGenerate a detailed implementation plan as a markdown artifact. Stay inside the orchestrate workflow: after the plan is written, return to \`orch_approve_beads\` for plan approval before creating beads.`,
            },
          ],
          details: { selected: true, goal, constraints: oc.state.constraints, workflow: "plan_first" },
        };
      }

      if (workflowChoice.startsWith("🧠 Multi-model")) {
        oc.state.planRefinementRound = 0;
        oc.setPhase("planning", ctx);
        oc.persistState();

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Call \`orch_plan\` with mode \`multi_model\` NOW.**\n\nGoal: "${goal}"${oc.state.constraints.length > 0 ? `\nConstraints: ${oc.state.constraints.join(", ")}` : ""}\n\nRun competing planners for correctness, robustness, and ergonomics, then synthesize them into one plan document artifact. Stay inside the orchestrate workflow: after synthesis, return to \`orch_approve_beads\` for plan approval before creating beads.`,
            },
          ],
          details: { selected: true, goal, constraints: oc.state.constraints, workflow: "multi_model_plan" },
        };
      }

      if (workflowChoice.startsWith("🧠 Deep plan")) {
        // Deep plan workflow: delegate to deep-plan agents
        oc.setPhase("planning", ctx);
        oc.persistState();

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Run deep planning with multi-model agents.**\n\nGoal: "${goal}"${oc.state.constraints.length > 0 ? `\nConstraints: ${oc.state.constraints.join(", ")}` : ""}\n\nUse the deep planning system to generate beads via multi-model triangulation.`,
            },
          ],
          details: { selected: true, goal, constraints: oc.state.constraints, workflow: "deep_plan" },
        };
      }

      if (workflowChoice.startsWith("🪄")) {
        // Superpowers spec-first workflow: stash adapter state and stay in planning phase.
        oc.state.planRefinementRound = 0;
        oc.state.planningWorkflow = initSuperpowersWorkflow({
          goal,
          constraints: oc.state.constraints,
        });
        oc.setPhase("planning", ctx);
        oc.persistState();

        return {
          content: [
            {
              type: "text",
              text: `**NEXT: Call \`orch_plan\` with mode \`superpowers\` NOW.**\n\nGoal: "${goal}"${oc.state.constraints.length > 0 ? `\nConstraints: ${oc.state.constraints.join(", ")}` : ""}\n\nGenerate the Superpowers spec artifact (stored at \`planningWorkflow.specArtifact\`, NOT \`planDocument\`). After the spec is approved via \`orch_approve_beads\`, the implementation plan stage runs and only then are beads created.`,
            },
          ],
          details: {
            selected: true,
            goal,
            constraints: oc.state.constraints,
            workflow: "superpowers",
            planningWorkflow: oc.state.planningWorkflow,
          },
        };
      }

      // Default: Direct to beads
      const instructions = beadCreationPrompt(goal, repoContext, oc.state.constraints);
      oc.setPhase("creating_beads", ctx);
      oc.persistState();

      return {
        content: [
          {
            type: "text",
            text: `**NEXT: Draft a structured staged bead mutation plan for this goal, then call \`orch_approve_beads\` to validate/apply it before implementation.**\n\nGoal: "${goal}"${oc.state.constraints.length > 0 ? `\nConstraints: ${oc.state.constraints.join(", ")}` : ""}\n\nStay inside the orchestrate workflow: once the staged plan is ready, return to \`orch_approve_beads\` for validation and bead approval before implementation.\n\n---\n\n${instructions}`,
          },
        ],
        details: { selected: true, goal, constraints: oc.state.constraints, workflow: "direct" },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("orch_select ")) +
          theme.fg("dim", "awaiting user selection..."),
        0, 0
      );
    },

    renderResult(result, _options, theme) {
      const d = result.details as any;
      if (!d?.selected) return new Text(theme.fg("warning", "🚫 Selection cancelled"), 0, 0);
      return new Text(
        theme.fg("success", `🎯 Selected: `) +
          theme.fg("accent", d.goal?.slice(0, 80) ?? ""),
        0, 0
      );
    },
  });
  }
}
