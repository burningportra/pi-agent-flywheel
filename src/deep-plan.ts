import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { enforceGoogleOpenRouterModel, isAnthropicModel, isDirectGoogleModel, isOpenRouterGoogleModel } from "./model-policy.js";

export interface DeepPlanAgent {
  name: string;
  task: string;
  model?: string;
}

export interface DeepPlanResult {
  name: string;
  model: string;
  plan: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

function ntmLabelForAgent(name: string, index: number): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const base = /^[a-z0-9]/.test(cleaned) ? cleaned : `dp-${cleaned || "agent"}`;
  const suffix = `${Date.now().toString(36)}-${index}`;
  return `${base.slice(0, Math.max(1, 48 - suffix.length))}-${suffix}`;
}

function ntmCcArgForModel(model: string | undefined): string {
  const lower = model?.toLowerCase() ?? "";
  if (lower.includes("opus")) return "--cc=1:opus";
  if (lower.includes("sonnet")) return "--cc=1:sonnet";
  if (lower.includes("haiku")) return "--cc=1:haiku";
  return "--cc=1";
}

function taskWithFileOutputContract(task: string, outputFile: string): string {
  return `${task}

---

## Mandatory completion contract
Write your final answer verbatim to this absolute file path before you stop:

FINAL_ANSWER_PATH=${outputFile}

Use normal filesystem write/edit tools. Do not summarize instead of writing the file. The orchestration process will read that file as your complete result.`;
}

async function runAnthropicAgentViaNtmCc(
  pi: ExtensionAPI,
  cwd: string,
  agent: DeepPlanAgent,
  taskFile: string,
  outputFile: string,
  index: number,
  signal?: AbortSignal
): Promise<{ plan: string; exitCode: number; error?: string }> {
  const project = basename(cwd);
  const label = ntmLabelForAgent(agent.name, index);
  const session = `${project}--${label}`;
  const prompt = `Read the complete task file at ${taskFile}, follow it exactly, write the final answer to the FINAL_ANSWER_PATH specified inside it, then stop.`;

  let spawnError: string | undefined;
  try {
    const spawn = await pi.exec("ntm", [
      "spawn",
      project,
      "--label", label,
      "--no-user",
      ntmCcArgForModel(agent.model),
      "--prompt", prompt,
    ], {
      timeout: 60000,
      cwd,
      signal,
    });
    if (spawn.code !== 0) {
      spawnError = `ntm spawn exited ${spawn.code}${spawn.stderr?.trim() ? `: ${spawn.stderr.trim()}` : ""}`;
    }
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
  }

  if (!spawnError) {
    try {
      await pi.exec("ntm", [
        `--robot-wait=${session}`,
        "--wait-until=idle",
        "--timeout=10m",
      ], {
        timeout: 660000,
        cwd,
        signal,
      });
    } catch {
      // A wait timeout is not necessarily fatal; the cc pane may have already
      // written the contracted output file. Read it before reporting failure.
    }
  }

  const plan = existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "";
  if (plan.length > 0) {
    return { plan, exitCode: 0 };
  }

  let tail = "";
  if (!spawnError) {
    try {
      const tailResult = await pi.exec("ntm", [`--robot-tail=${session}`, "--lines=120"], {
        timeout: 30000,
        cwd,
        signal,
      });
      tail = tailResult.stdout?.trim() || tailResult.stderr?.trim() || "";
    } catch (err) {
      tail = err instanceof Error ? err.message : String(err);
    }
  }

  const error = spawnError
    ?? `NTM cc pane did not write ${outputFile}${tail ? `; tail: ${tail.slice(-1000)}` : ""}`;
  return { plan: "", exitCode: 1, error };
}

/**
 * Launch a planner in a managed NTM Cursor (`agent`) pane.
 *
 * Google/Gemini models must run in a visible Cursor pane (per AGENTS.md), never
 * a hidden `pi --print` subprocess or `--gmi` pane. The model ID is routed
 * through OpenRouter (`openrouter/google/...`) before it reaches the pane, so a
 * configured Gemini model like `google/gemini-3.1-pro-preview` runs against the
 * OpenRouter endpoint the plugin already assumes for Google work.
 */
async function runGoogleAgentViaNtmCursor(
  pi: ExtensionAPI,
  cwd: string,
  agent: DeepPlanAgent,
  taskFile: string,
  outputFile: string,
  index: number,
  signal?: AbortSignal,
): Promise<{ plan: string; exitCode: number; error?: string }> {
  const project = basename(cwd);
  const label = ntmLabelForAgent(agent.name, index);
  const session = `${project}--${label}`;
  const prompt = `Read the complete task file at ${taskFile}, follow it exactly, write the final answer to the FINAL_ANSWER_PATH specified inside it, then stop.`;
  const model = agent.model ? enforceGoogleOpenRouterModel(agent.model) : "gemini-3.1-pro-preview";

  let spawnError: string | undefined;
  try {
    const spawn = await pi.exec("ntm", [
      "spawn",
      project,
      "--label", label,
      "--no-user",
      `--cursor=1:${model}`,
      "--prompt", prompt,
    ], {
      timeout: 60000,
      cwd,
      signal,
    });
    if (spawn.code !== 0) {
      spawnError = `ntm spawn exited ${spawn.code}${spawn.stderr?.trim() ? `: ${spawn.stderr.trim()}` : ""}`;
    }
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
  }

  if (!spawnError) {
    try {
      await pi.exec("ntm", [
        `--robot-wait=${session}`,
        "--wait-until=idle",
        "--timeout=10m",
      ], {
        timeout: 660000,
        cwd,
        signal,
      });
    } catch {
      // A wait timeout is not necessarily fatal; the cursor pane may have already
      // written the contracted output file. Read it before reporting failure.
    }
  }

  const plan = existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "";
  if (plan.length > 0) {
    return { plan, exitCode: 0 };
  }

  let tail = "";
  if (!spawnError) {
    try {
      const tailResult = await pi.exec("ntm", [`--robot-tail=${session}`, "--lines=120"], {
        timeout: 30000,
        cwd,
        signal,
      });
      tail = tailResult.stdout?.trim() || tailResult.stderr?.trim() || "";
    } catch (err) {
      tail = err instanceof Error ? err.message : String(err);
    }
  }

  const error = spawnError
    ?? `NTM cursor pane did not write ${outputFile}${tail ? `; tail: ${tail.slice(-1000)}` : ""}`;
  return { plan: "", exitCode: 1, error };
}

/**
 * Optional runner-level inputs that apply to every agent in the call.
 *
 * `approvedSpec` is injected into each agent's task as a labeled "Approved
 * Spec" section so competing planners that were not handed the spec via a
 * prompt builder still receive it. Injection is idempotent: if the agent's
 * task already contains a marker section ("## Approved Spec"), no second
 * copy is appended.
 */
export interface DeepPlanRunOptions {
  approvedSpec?: string;
}

const APPROVED_SPEC_MARKER = "## Approved Spec";

/**
 * Augment an agent task with an "Approved Spec" preamble when the caller has
 * one to inject. Idempotent: skips injection if the task already references
 * an approved spec section, so prompt builders that embed the spec do not
 * end up double-stuffing the context window.
 */
function withApprovedSpecContext(task: string, approvedSpec?: string): string {
  if (!approvedSpec || !approvedSpec.trim()) return task;
  if (task.includes(APPROVED_SPEC_MARKER)) return task;
  return `${task}\n\n---\n\n${APPROVED_SPEC_MARKER} (source of truth — every recommendation MUST trace back to this)\n${approvedSpec.trim()}\n`;
}

/**
 * Run deep planning agents directly via pi CLI with --no-extensions.
 * This avoids the Gemini patternProperties schema issue caused by
 * extensions like autoresearch registering tools with unsupported
 * JSON Schema features.
 *
 * When `options.approvedSpec` is provided, each agent's task gains an
 * Approved-Spec preamble before dispatch (idempotent — see
 * {@link withApprovedSpecContext}). Callers generating the final
 * implementation plan from an approved Superpowers spec must set this so
 * competing planners stay anchored to the approved contract.
 */
export async function runDeepPlanAgents(
  pi: ExtensionAPI,
  cwd: string,
  agents: DeepPlanAgent[],
  signal?: AbortSignal,
  options?: DeepPlanRunOptions,
): Promise<DeepPlanResult[]> {
  // Write each agent's task to a temp file and spawn pi in print mode
  const outputDir = join(tmpdir(), `pi-deep-plan-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  const promises = agents.map(async (agent, i) => {
    const startTime = Date.now();
    const taskFile = join(outputDir, `${agent.name}-task.md`);
    const outputFile = join(outputDir, `${agent.name}-output.md`);
    const runViaNtmCc = isAnthropicModel(agent.model);
    const runViaNtmCursor = isDirectGoogleModel(agent.model) || isOpenRouterGoogleModel(agent.model);
    const effectiveTask = withApprovedSpecContext(agent.task, options?.approvedSpec);
    writeFileSync(taskFile, (runViaNtmCc || runViaNtmCursor) ? taskWithFileOutputContract(effectiveTask, outputFile) : effectiveTask, "utf8");

    try {
      if (runViaNtmCc) {
        const result = await runAnthropicAgentViaNtmCc(pi, cwd, agent, taskFile, outputFile, i, signal);
        return {
          name: agent.name,
          model: agent.model ?? "default",
          plan: result.plan,
          exitCode: result.exitCode,
          elapsed: Math.floor((Date.now() - startTime) / 1000),
          error: result.error,
        } as DeepPlanResult;
      }

      if (runViaNtmCursor) {
        const result = await runGoogleAgentViaNtmCursor(pi, cwd, agent, taskFile, outputFile, i, signal);
        return {
          name: agent.name,
          model: agent.model ?? "default",
          plan: result.plan,
          exitCode: result.exitCode,
          elapsed: Math.floor((Date.now() - startTime) / 1000),
          error: result.error,
        } as DeepPlanResult;
      }

      const args = [
        "--print",            // non-interactive, output to stdout
        "--no-extensions",    // no extensions — avoids patternProperties issue
        "--no-skills",        // no skills needed for planning
        "--no-prompt-templates",
        "--tools", "read,bash,grep,find,ls",  // read-only tools
      ];

      if (agent.model) {
        args.push("--model", agent.model);
      }

      args.push(`@${taskFile}`);

      const result = await pi.exec("pi", args, {
        timeout: 180000, // 3 min timeout per planner
        cwd,
        signal,
      });

      const plan = result.stdout.trim();
      writeFileSync(outputFile, plan, "utf8");

      return {
        name: agent.name,
        model: agent.model ?? "default",
        plan,
        exitCode: result.code,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
      } as DeepPlanResult;
    } catch (err) {
      return {
        name: agent.name,
        model: agent.model ?? "default",
        plan: "",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: err instanceof Error ? err.message : String(err),
      } as DeepPlanResult;
    }
  });

  // Run all in parallel
  return Promise.all(promises);
}
