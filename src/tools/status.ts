import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext, Bead } from "../types.js";
import { buildWorkflowStatus, type WorkflowStatusOutput } from "../workflow-status.js";
import { brExecJson, type CliExecError } from "../cli-exec.js";
import { TOOL_FAMILIES } from "./shared.js";

export interface FlywheelStatusResult {
  status: WorkflowStatusOutput;
  warnings: string[];
}

function normalizeBead(raw: any): Bead {
  return {
    ...raw,
    type: raw?.type ?? raw?.issue_type ?? "task",
    labels: Array.isArray(raw?.labels) ? raw.labels : [],
  } as Bead;
}

function formatBeadReadWarning(error: CliExecError): string {
  const message =
    error.brError?.message ??
    (error.stderr.trim() || undefined) ??
    (error.lastError instanceof Error ? error.lastError.message : undefined) ??
    "unknown bead read failure";
  return `Could not read beads via ${error.command}: ${message}`;
}

async function readBeadsForStatus(oc: OrchestratorContext, cwd: string): Promise<{ beads: Bead[]; warnings: string[] }> {
  const result = await brExecJson<Bead[] | { issues?: Bead[] }>(oc.pi, [
    "list",
    "--json",
    "--fields", "id,title,description,status,priority,issue_type,labels,estimate,parent,created_at,updated_at,closed_at",
    "--deferred",
  ], { timeout: 10000, cwd, maxRetries: 0, logWarnings: false });

  if (!result.ok) {
    return { beads: [], warnings: [formatBeadReadWarning(result.error)] };
  }

  const data = result.value;
  const beads = (Array.isArray(data) ? data : data.issues ?? []).map(normalizeBead);
  return { beads, warnings: [] };
}

export async function buildStatusResult(oc: OrchestratorContext, cwd: string): Promise<FlywheelStatusResult> {
  const { beads, warnings } = await readBeadsForStatus(oc, cwd);
  return {
    status: buildWorkflowStatus(oc.state, beads),
    warnings,
  };
}

export function registerStatusTool(oc: OrchestratorContext) {
  // Registrations: agent_flywheel_status, orch_status, flywheel_status.
  for (const toolName of TOOL_FAMILIES.status) {
    oc.pi.registerTool({
      name: toolName,
      label: "Flywheel Status",
      description: "Return the machine-readable AgentFlywheel workflow status contract: phase, goal, bead summary, confidence, and next action. Use this first after reload or compaction.",
      promptSnippet: "Return machine-readable AgentFlywheel workflow status JSON",
      parameters: Type.Object({}),

      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const result = await buildStatusResult(oc, ctx.cwd);
        return {
          content: [{ type: "text", text: JSON.stringify(result.status, null, 2) }],
          details: { status: result.status, warnings: result.warnings },
        };
      },

      renderResult(result, _options, theme) {
        const status = (result.details as any)?.status as WorkflowStatusOutput | undefined;
        if (!status) return new Text("Flywheel status completed", 0, 0);
        const compaction = status.compaction?.latest
          ? ` | compaction: ${status.compaction.latest.guidance.title}`
          : "";
        return new Text(theme.fg("success", `flywheel_status: ${status.phase} (${status.confidence})${compaction}`), 0, 0);
      },
    });
  }
}
