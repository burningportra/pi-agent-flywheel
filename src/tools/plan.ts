import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { runDeepPlanAgents, type DeepPlanAgent, type DeepPlanResult } from "../deep-plan.js";
import type { OrchestratorContext, OrchestratorState } from "../types.js";
import {
  competingPlanAgentPrompt,
  planSynthesisPrompt,
  planDocumentPrompt,
  superpowersSpecPrompt,
  implementationPlanFromSpecPrompt,
  DEEP_PLAN_MODELS,
  withSubagentAutoExitInstruction,
} from "../prompts.js";
import { findSessionArtifactPath, sessionArtifactPath } from "../session-artifacts.js";
import { getDeepPlanModels, detectAvailableModels, formatDetectedModels } from "../model-detection.js";
import { enforceGoogleOpenRouterModel, launchModeForModel, providerPolicyNoteForModel } from "../model-policy.js";
import { readMemory } from "../memory.js";

import { FlywheelError } from "../errors.js";
import {
  checkPlanningToolOrdering,
  planningDocumentKindFor,
  type PlanningDocumentKind,
} from "../workflows/runner.js";
import {
  SUPERPOWERS_ADAPTER_ID,
  initSuperpowersWorkflow,
} from "../workflows/superpowers.js";
import { finalPlanArtifactName, specArtifactName } from "../workflows/artifacts.js";
import { nativePlanningAdapter, NATIVE_ADAPTER_ID } from "../workflows/native.js";
/**
 * Save a plan snapshot to docs/plans/ in the project repo.
 * Filenames: docs/plans/<date>-<slug>-<suffix>.md
 * Best-effort — errors are silently swallowed.
 */
export function saveDocsPlan(cwd: string, goal: string, suffix: "original" | "final", content: string): string | undefined {
  try {
    const slug = slugifyGoal(goal);
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(cwd, "docs", "plans");
    mkdirSync(dir, { recursive: true });
    const filename = `${date}-${slug}-${suffix}.md`;
    const dest = join(dir, filename);
    writeFileSync(dest, content, "utf8");
    return `docs/plans/${filename}`;
  } catch {
    return undefined;
  }
}

export function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan";
}

export function singleModelPlanArtifactName(goal: string) {
  return `plans/${slugifyGoal(goal)}.md`;
}

export function multiModelPlanArtifactNames(goal: string) {
  const slug = slugifyGoal(goal);
  const baseDir = `plans/${slug}-multi-model`;
  return {
    final: `plans/${slug}-multi-model.md`,
    planners: {
      correctness: `${baseDir}/correctness.md`,
      robustness: `${baseDir}/robustness.md`,
      ergonomics: `${baseDir}/ergonomics.md`,
    },
  };
}

export function buildMultiModelPlanSubagentConfigs(
  cwd: string,
  goal: string,
  profile: OrchestratorContext["state"]["repoProfile"],
  scanResult: OrchestratorContext["state"]["scanResult"],
  ctx?: ExtensionContext,
  approvedSpec?: string,
) {
  const artifactNames = multiModelPlanArtifactNames(goal);

  // Use detected models if context is available, otherwise fall back to defaults
  const models = ctx ? getDeepPlanModels(ctx) : DEEP_PLAN_MODELS;

  // Fetch CASS context for planning (GAP 24)
  const cassContext = readMemory(cwd, goal) || undefined;

  const planners = [
    {
      name: "correctness",
      model: models.correctness,
      task: competingPlanAgentPrompt("correctness", goal, profile!, scanResult, cassContext, approvedSpec),
      artifactName: artifactNames.planners.correctness,
    },
    {
      name: "robustness",
      model: models.robustness,
      task: competingPlanAgentPrompt("robustness", goal, profile!, scanResult, cassContext, approvedSpec),
      artifactName: artifactNames.planners.robustness,
    },
    {
      name: "ergonomics",
      model: models.ergonomics,
      task: competingPlanAgentPrompt("ergonomics", goal, profile!, scanResult, cassContext, approvedSpec),
      artifactName: artifactNames.planners.ergonomics,
    },
  ] as const;

  return planners.map((planner) => {
    const model = enforceGoogleOpenRouterModel(planner.model);
    const launchMode = launchModeForModel(model);
    const policyNote = providerPolicyNoteForModel(model);
    return {
      name: `plan-${planner.name}`,
      agent: launchMode === "ntm_cc" ? "cc" : launchMode === "ntm_agent" ? "agent" : "planner",
      cwd,
      model,
      launchMode,
      launchInstruction: launchMode === "ntm_cc"
        ? "Launch this planner in a managed NTM Claude Code (`cc`) pane; do not use the subagent tool for Anthropic/Claude models."
        : launchMode === "ntm_agent"
          ? "Launch this planner in a managed NTM Cursor (`--cursor`) pane backed by the official Cursor Agent CLI command `agent`; do not use the subagent tool or `--gmi` panes for Google/Gemini models."
          : "Launch this planner with the subagent tool.",
      interactive: false,
      task: withSubagentAutoExitInstruction(
        `${policyNote ? `${policyNote}\n\n` : ""}${planner.task}\n\n` +
        `After you finish the plan, save it with write_artifact using exactly this name: \`${planner.artifactName}\`.\n` +
        `Do not create beads. In your final response, mention that you wrote \`${planner.artifactName}\`.`
      ),
    };
  });
}

/**
 * Make sure `state.planningWorkflow` exists before the first planning call.
 *
 * For sessions that never opted into a non-native adapter, this initializes
 * a native workflow record with `generationMode: "native"`. That way the
 * persisted `generationMode` is available on resume (acceptance criterion in
 * pi-18ly) without changing native behavior. Sessions that already have a
 * `planningWorkflow` (e.g. Superpowers selection from the goal pickers) are
 * left alone.
 */
function ensurePlanningWorkflowInitialized(state: OrchestratorState): void {
  if (state.planningWorkflow) return;
  state.planningWorkflow = nativePlanningAdapter.createInitialState();
}

/**
 * Load the approved Superpowers spec body for the active session, if any.
 * Returns the trimmed spec text or undefined when no spec artifact is
 * resolvable on disk. The Superpowers planning path uses this both to feed
 * the single-agent implementation-plan prompt and to inject spec context
 * into competing multi-model planners.
 */
function loadApprovedSpecBody(
  ctx: ExtensionContext,
  state: OrchestratorState,
): string | undefined {
  const wf = state.planningWorkflow;
  if (!wf) return undefined;
  const specName = wf.specArtifact;
  if (!specName) return undefined;
  const filePath = findSessionArtifactPath(ctx, specName) ?? sessionArtifactPath(ctx, specName);
  if (!filePath || !existsSync(filePath)) return undefined;
  try {
    const body = readFileSync(filePath, "utf8").trim();
    return body.length > 0 ? body : undefined;
  } catch {
    return undefined;
  }
}

function loadPlannerArtifacts(ctx: ExtensionContext, goal: string): DeepPlanResult[] {
  const artifactNames = multiModelPlanArtifactNames(goal);
  const models = getDeepPlanModels(ctx);
  const plannerEntries = [
    ["correctness", artifactNames.planners.correctness, models.correctness],
    ["robustness", artifactNames.planners.robustness, models.robustness],
    ["ergonomics", artifactNames.planners.ergonomics, models.ergonomics],
  ] as const;

  return plannerEntries.flatMap(([name, artifactName, model]) => {
    const filePath = findSessionArtifactPath(ctx, artifactName);
    if (!filePath) {
      return [];
    }
    const plan = readFileSync(filePath, "utf8").trim();
    if (!plan) {
      return [];
    }
    return [{ name, model, plan, exitCode: 0, elapsed: 0 } satisfies DeepPlanResult];
  });
}

export function registerPlanTool(oc: OrchestratorContext) {
  for (const toolName of ["agent_flywheel_plan", "orch_plan", "flywheel_plan"] as const) {
  oc.pi.registerTool({
    name: toolName,
    label: "Generate Plan",
    description:
      "Generate a plan document for the selected goal. Supports single-model and multi-model competing-plan synthesis. [phase 4/6, prereq: flywheel_select, next: flywheel_approve_beads]",
    promptSnippet: "Generate a detailed plan document",
    parameters: Type.Object({
      mode: Type.Union([
        Type.Literal("single_model"),
        Type.Literal("multi_model"),
        Type.Literal("superpowers"),
      ]),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!oc.state.selectedGoal || !oc.state.repoProfile) {
        throw new FlywheelError("NO_GOAL", "No selected goal or repo profile. Call flywheel_profile and flywheel_select first.");
      }

      // Persist generationMode on first planning call so resume can read it.
      ensurePlanningWorkflowInitialized(oc.state);

      const orderingRejection = checkPlanningToolOrdering("flywheel_plan", oc.state);
      if (orderingRejection) {
        throw new FlywheelError("OUT_OF_ORDER_TOOL_CALL", orderingRejection.message, {
          suggestion: orderingRejection.recommendedTool ?? "flywheel_approve_beads",
        });
      }

      const mode = params.mode as "single_model" | "multi_model" | "superpowers";
      const goal = oc.state.selectedGoal;
      const profile = oc.state.repoProfile;
      const scanResult = oc.state.scanResult;
      const adapterId = oc.state.planningWorkflow?.adapterId ?? NATIVE_ADAPTER_ID;
      const documentKind: PlanningDocumentKind = planningDocumentKindFor(oc.state);

      // ─── Superpowers branch — spec or implementation plan ────
      // The adapter is responsible for the spec/plan vocabulary; the tool
      // layer just chooses single-agent vs competing-planner generation
      // based on `mode`. `mode === "superpowers"` is treated as single-agent
      // so the goal-picker handoff text stays valid.
      if (adapterId === SUPERPOWERS_ADAPTER_ID) {
        // Make sure the workflow has constraints captured for fingerprinting
        // and prompt builders. initSuperpowersWorkflow already runs in the
        // goal pickers, but resume from a partially-initialized session is
        // safe here too.
        if (oc.state.planningWorkflow?.stage === "idle") {
          oc.state.planningWorkflow = initSuperpowersWorkflow({
            goal,
            constraints: oc.state.constraints ?? [],
            brainstormDecisionArtifact: oc.state.planningWorkflow.brainstormDecisionArtifact,
          });
        }

        if (documentKind === "spec") {
          const artifactName = specArtifactName(goal);
          const workflow = oc.state.planningWorkflow!;
          oc.state.planningWorkflow = {
            ...workflow,
            stage: "awaiting_spec_approval",
            specArtifact: artifactName,
            specRefinementRound: workflow.specRefinementRound ?? 0,
          };
          // Invariant: do NOT touch oc.state.planDocument during spec generation —
          // saved-plan discovery reserves that field for final implementation plans.
          oc.setPhase("planning", ctx);
          oc.persistState();
          const constraints = oc.state.constraints ?? [];
          return {
            content: [{
              type: "text",
              text:
                `**NEXT: Generate a Superpowers spec and save it as a session artifact using \`write_artifact\` NOW.**\n\n` +
                `Use exactly this artifact name: \`${artifactName}\` (do NOT save under \`plans/...\`).\n\n` +
                `${superpowersSpecPrompt(goal, profile, constraints, scanResult)}\n\n` +
                `After writing the spec, call \`agent_flywheel_approve_beads\` so the user can approve the spec ` +
                `before the implementation plan is generated.`,
            }],
            details: {
              mode,
              goal,
              artifactName,
              documentKind: "spec",
              adapter: SUPERPOWERS_ADAPTER_ID,
            },
          };
        }

        // documentKind === "plan" — spec was approved, generate impl plan.
        const approvedSpec = loadApprovedSpecBody(ctx, oc.state);
        if (!approvedSpec) {
          throw new FlywheelError(
            "NO_PLAN",
            `Cannot generate the Superpowers implementation plan: the approved spec artifact ` +
              `(\`${oc.state.planningWorkflow?.specArtifact ?? "<unset>"}\`) was not found. ` +
              `Approve the spec via \`agent_flywheel_approve_beads\` first, or restart the spec stage.`,
            { suggestion: "agent_flywheel_approve_beads" },
          );
        }
        const constraints = oc.state.constraints ?? [];

        if (mode === "multi_model") {
          // Run competing planners with the approved spec injected. We
          // intentionally skip the seed-plan step here — the approved spec
          // already plays that role.
          const artifactNames = multiModelPlanArtifactNames(goal);
          const detectedModels = getDeepPlanModels(ctx);
          const cassContext = readMemory(ctx.cwd, goal) || undefined;
          const savedPlannerResults = loadPlannerArtifacts(ctx, goal);
          const planners: DeepPlanAgent[] = [
            {
              name: "correctness",
              model: detectedModels.correctness,
              task: competingPlanAgentPrompt("correctness", goal, profile, scanResult, cassContext, approvedSpec),
            },
            {
              name: "robustness",
              model: detectedModels.robustness,
              task: competingPlanAgentPrompt("robustness", goal, profile, scanResult, cassContext, approvedSpec),
            },
            {
              name: "ergonomics",
              model: detectedModels.ergonomics,
              task: competingPlanAgentPrompt("ergonomics", goal, profile, scanResult, cassContext, approvedSpec),
            },
          ];
          const completedNames = new Set(savedPlannerResults.map((r) => r.name));
          const pendingPlanners = planners.filter((p) => !completedNames.has(p.name));
          const newPlanResults = pendingPlanners.length > 0
            ? await runDeepPlanAgents(oc.pi, ctx.cwd, pendingPlanners, signal, { approvedSpec })
            : [];
          const planResults = [...savedPlannerResults, ...newPlanResults];
          const successfulPlans = planResults.filter(
            (result) => result.exitCode === 0 && result.plan.trim().length > 0,
          );
          if (successfulPlans.length === 0) {
            const failures = planResults
              .map((r) => `  - ${r.name} (${r.model}): exit=${r.exitCode}${r.error ? `, error=${r.error}` : ""}${r.plan ? `, output=${r.plan.slice(0, 200)}` : ""}`)
              .join("\n");
            const detected = detectAvailableModels(ctx);
            const detectedInfo = formatDetectedModels(detected);
            throw new FlywheelError(
              "PLAN_SYNTH_FAILED",
              `All competing planning agents failed. Details:\n${failures}\n\n${detectedInfo}\n\n` +
                `Try \`flywheel_plan({ mode: "superpowers" })\` as a single-agent fallback.`,
              { suggestion: "flywheel_plan({ mode: 'superpowers' })" },
            );
          }
          const synthesisResult = await runDeepPlanAgents(
            oc.pi,
            ctx.cwd,
            [{ name: "synthesis", model: detectedModels.synthesis, task: planSynthesisPrompt(successfulPlans) }],
            signal,
            { approvedSpec },
          );
          const synthesizedPlan = synthesisResult[0]?.plan?.trim();
          if (!synthesizedPlan) {
            throw new FlywheelError("PLAN_SYNTH_FAILED");
          }
          const artifactName = artifactNames.final;
          const artifactPath = sessionArtifactPath(ctx, artifactName);
          mkdirSync(dirname(artifactPath), { recursive: true });
          writeFileSync(artifactPath, synthesizedPlan, "utf8");
          saveDocsPlan(ctx.cwd, goal, "original", synthesizedPlan);

          const workflow = oc.state.planningWorkflow!;
          oc.state.planningWorkflow = {
            ...workflow,
            stage: "awaiting_plan_approval",
          };
          oc.state.planDocument = artifactName;
          oc.state.planRefinementRound = 0;
          oc.setPhase("awaiting_plan_approval", ctx);
          oc.persistState();

          const plannerSummary = successfulPlans
            .map((result) => `- ${result.name} (${result.model})${result.elapsed > 0 ? ` — ${result.elapsed}s` : " — artifact"}`)
            .join("\n");

          return {
            content: [{
              type: "text",
              text:
                `**NEXT: Call \`agent_flywheel_approve_beads\` NOW to review the implementation plan in-menu.**\n\n` +
                `Saved synthesized multi-model implementation plan to session artifact \`${artifactName}\`.\n\n` +
                `Planner runs (each anchored to the approved spec):\n${plannerSummary}\n\n` +
                `Every plan section traces back to the approved spec at \`${oc.state.planningWorkflow.specArtifact}\`. ` +
                `Stay inside the AgentFlywheel workflow: review/approve the plan first, then create beads via the menu flow.`,
            }],
            details: {
              mode,
              goal,
              artifactName,
              plannerCount: successfulPlans.length,
              documentKind: "plan",
              adapter: SUPERPOWERS_ADAPTER_ID,
              specArtifact: oc.state.planningWorkflow.specArtifact,
            },
          };
        }

        // Single-agent implementation plan from approved spec.
        const artifactName = finalPlanArtifactName(goal);
        const workflow = oc.state.planningWorkflow!;
        oc.state.planningWorkflow = {
          ...workflow,
          stage: "awaiting_plan_approval",
        };
        oc.state.planDocument = artifactName;
        oc.state.planRefinementRound = 0;
        oc.setPhase("planning", ctx);
        oc.persistState();
        return {
          content: [{
            type: "text",
            text:
              `**NEXT: Generate the Superpowers implementation plan from the approved spec and save it as a session artifact using \`write_artifact\` NOW.**\n\n` +
              `Use exactly this artifact name: \`${artifactName}\`.\n\n` +
              `${implementationPlanFromSpecPrompt(goal, approvedSpec, profile, constraints, scanResult)}\n\n` +
              `After writing the artifact, call \`agent_flywheel_approve_beads\` to review the implementation plan in-menu.`,
          }],
          details: {
            mode,
            goal,
            artifactName,
            documentKind: "plan",
            adapter: SUPERPOWERS_ADAPTER_ID,
            specArtifact: oc.state.planningWorkflow.specArtifact,
          },
        };
      }

      // ─── Native branch — unchanged single/multi-model paths ──

      if (mode === "superpowers") {
        // Native workflow but caller requested Superpowers — reject so we
        // don't accidentally produce a spec under a native session.
        throw new FlywheelError(
          "INVALID_INPUT",
          `mode="superpowers" requires a Superpowers planning workflow but the active session uses ` +
            `adapter="${adapterId}". Re-select the goal with the Superpowers workflow choice first.`,
          { suggestion: "agent_flywheel_select" },
        );
      }

      if (mode === "single_model") {
        const artifactName = singleModelPlanArtifactName(goal);
        oc.state.planDocument = artifactName;
        oc.state.planRefinementRound = 0;
        oc.setPhase("planning", ctx);
        oc.persistState();
        return {
          content: [{
            type: "text",
            text:
              `**NEXT: Generate a single-model plan document and save it as a session artifact using \`write_artifact\` NOW.**\n\n` +
              `Use exactly this artifact name: \`${artifactName}\`.\n\n` +
              `${planDocumentPrompt(goal, profile, scanResult)}\n\n` +
              `After writing the artifact, immediately continue the workflow by calling \`agent_flywheel_approve_beads\` to review the plan in-menu.`,
          }],
          details: { mode, goal, artifactName },
        };
      }

      const artifactNames = multiModelPlanArtifactNames(goal);
      const interactivePlannerConfigs = buildMultiModelPlanSubagentConfigs(ctx.cwd, goal, profile, scanResult, ctx);
      const savedPlannerResults = loadPlannerArtifacts(ctx, goal);

      if (ctx.hasUI && savedPlannerResults.length < interactivePlannerConfigs.length) {
        oc.state.planDocument = undefined;
        oc.setPhase("planning", ctx);
        oc.persistState();

        const completed = new Set(savedPlannerResults.map((result) => result.name));
        const pendingConfigs = interactivePlannerConfigs.filter((config) => !completed.has(config.name.replace(/^plan-/, "")));
        const statusLine = completed.size > 0
          ? `Completed planners: ${[...completed].join(", ")}\nPending planners: ${pendingConfigs.map((config) => config.name.replace(/^plan-/, "")).join(", ")}`
          : "No planner artifacts found yet.";

        return {
          content: [{
            type: "text",
            text:
              `**NEXT: Launch the pending autonomous planners NOW.**\n\n` +
              `${statusLine}\n\n` +
              `Launch planners according to each config's \`launchMode\`: use \`subagent\` only for \`subagent\` configs, managed NTM \`cc\` panes for \`ntm_cc\`, and managed NTM Cursor \`--cursor\` panes (using CLI command \`agent\`) for \`ntm_agent\` (preferred over \`gmi\`). ` +
              `Never launch Anthropic/Claude models with the subagent tool, and never use direct Google/Gemini provider IDs instead of \`openrouter/google/...\`. ` +
              `Each planner writes its draft to a session artifact, sends one final response, and exits. After all planners complete, call \`agent_flywheel_plan\` with mode \`multi_model\` again to synthesize the final plan.\n\n` +
              `\`\`\`json\n${JSON.stringify(pendingConfigs, null, 2)}\n\`\`\``,
          }],
          details: {
            mode,
            goal,
            interactive: false,
            awaitingPlannerArtifacts: true,
            plannerArtifacts: artifactNames.planners,
            pendingPlannerCount: pendingConfigs.length,
          },
        };
      }

      // Use detected models for non-interactive path
      const detectedModels = getDeepPlanModels(ctx);

      // GAP 24: fetch CASS context to inject into planning prompts
      const cassContext = readMemory(ctx.cwd, goal) || undefined;

      // GAP 23: seed plan step — generate (or reuse) an initial plan before competing agents
      let seedPlanText: string | undefined;
      const seedArtifactName = `plans/${slugifyGoal(goal)}-seed.md`;
      const seedArtifactPath = sessionArtifactPath(ctx, seedArtifactName);
      if (existsSync(seedArtifactPath)) {
        seedPlanText = readFileSync(seedArtifactPath, "utf8").trim() || undefined;
      }
      if (!seedPlanText && savedPlannerResults.length === 0) {
        // Spawn one seed agent using the synthesis model (strongest available)
        const seedResults = await runDeepPlanAgents(
          oc.pi,
          ctx.cwd,
          [{ name: "seed", model: detectedModels.synthesis, task: planDocumentPrompt(goal, profile, scanResult) }],
          signal
        );
        seedPlanText = seedResults[0]?.exitCode === 0 ? seedResults[0].plan.trim() : undefined;
        if (seedPlanText) {
          mkdirSync(dirname(seedArtifactPath), { recursive: true });
          writeFileSync(seedArtifactPath, seedPlanText, "utf8");
        }
      }
      const seedAppendix = seedPlanText
        ? `\n\nHere is an initial plan draft — use it as a starting point, critique it, and improve it from your focus lens perspective:\n\n${seedPlanText}`
        : "";

      const planners: DeepPlanAgent[] = [
        {
          name: "correctness",
          model: detectedModels.correctness,
          task: competingPlanAgentPrompt("correctness", goal, profile, scanResult, cassContext) + seedAppendix,
        },
        {
          name: "robustness",
          model: detectedModels.robustness,
          task: competingPlanAgentPrompt("robustness", goal, profile, scanResult, cassContext) + seedAppendix,
        },
        {
          name: "ergonomics",
          model: detectedModels.ergonomics,
          task: competingPlanAgentPrompt("ergonomics", goal, profile, scanResult, cassContext) + seedAppendix,
        },
      ];

      // Only re-run planners that aren't already cached — preserve partial progress
      // on retry so we don't waste API calls re-running completed planners.
      const completedNames = new Set(savedPlannerResults.map((r) => r.name));
      const pendingPlanners = planners.filter((p) => !completedNames.has(p.name));
      const newPlanResults = pendingPlanners.length > 0
        ? await runDeepPlanAgents(oc.pi, ctx.cwd, pendingPlanners, signal)
        : [];
      const planResults = [...savedPlannerResults, ...newPlanResults];
      const successfulPlans = planResults.filter((result) => result.exitCode === 0 && result.plan.trim().length > 0);
      if (successfulPlans.length === 0) {
        const failures = planResults
          .map((r) => `  - ${r.name} (${r.model}): exit=${r.exitCode}${r.error ? `, error=${r.error}` : ""}${r.plan ? `, output=${r.plan.slice(0, 200)}` : ""}`)
          .join("\n");
        
        // Show detected models for debugging
        const detected = detectAvailableModels(ctx);
        const detectedInfo = formatDetectedModels(detected);
        
        throw new FlywheelError("PLAN_SYNTH_FAILED",
          `All competing planning agents failed. Details:\n${failures}\n\n` +
          `${detectedInfo}\n\n` +
          `Try \`flywheel_plan({ mode: "single_model" })\` as a fallback.`,
          { suggestion: "flywheel_plan({ mode: 'single_model' })" }
        );
      }

      const synthesisResult = await runDeepPlanAgents(
        oc.pi,
        ctx.cwd,
        [{ name: "synthesis", model: detectedModels.synthesis, task: planSynthesisPrompt(successfulPlans) }],
        signal
      );
      const synthesizedPlan = synthesisResult[0]?.plan?.trim();
      if (!synthesizedPlan) {
        throw new FlywheelError("PLAN_SYNTH_FAILED");
      }

      const artifactName = artifactNames.final;
      const artifactPath = sessionArtifactPath(ctx, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, synthesizedPlan, "utf8");
      saveDocsPlan(ctx.cwd, goal, "original", synthesizedPlan);

      oc.state.planDocument = artifactName;
      oc.state.planRefinementRound = 0;
      oc.setPhase("awaiting_plan_approval", ctx);
      oc.persistState();

      const plannerSummary = successfulPlans
        .map((result) => `- ${result.name} (${result.model})${result.elapsed > 0 ? ` — ${result.elapsed}s` : " — artifact"}`)
        .join("\n");

      return {
        content: [{
          type: "text",
          text:
            `**NEXT: Call \`agent_flywheel_approve_beads\` NOW to review the synthesized plan in-menu.**\n\n` +
            `Saved synthesized multi-model plan to session artifact \`${artifactName}\`.\n\n` +
            `Planner runs:\n${plannerSummary}\n\n` +
            `Stay inside the AgentFlywheel workflow: review/approve the plan first, then create beads from the approved plan via the menu flow.`,
        }],
        details: {
          mode,
          goal,
          artifactName,
          plannerCount: successfulPlans.length,
        },
      };
    },

    renderCall(args, theme) {
      const mode = (args as { mode?: string } | undefined)?.mode ?? "single_model";
      const label =
        mode === "multi_model" ? "multi-model"
        : mode === "superpowers" ? "Superpowers spec/plan"
        : "single-model";
      return new Text(
        theme.fg("toolTitle", theme.bold("agent_flywheel_plan ")) +
          theme.fg("dim", `generating ${label} plan...`),
        0, 0
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as {
        artifactName?: string;
        mode?: string;
        awaitingPlannerArtifacts?: boolean;
        pendingPlannerCount?: number;
      } | undefined;
      if (details?.awaitingPlannerArtifacts) {
        return new Text(
          theme.fg("accent", "🧠 Planner swarm") +
            theme.fg("dim", ` → waiting on ${details.pendingPlannerCount ?? 0} planner artifact(s)`),
          0, 0
        );
      }
      return new Text(
        theme.fg("success", "📋 Plan ready") +
          theme.fg("dim", details?.artifactName ? ` → ${details.artifactName}` : ""),
        0, 0
      );
    },
  });
  }
}
