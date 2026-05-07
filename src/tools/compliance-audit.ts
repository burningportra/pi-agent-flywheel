import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { OrchestratorContext } from "../types.js";
import {
  DEFAULT_AUDIT_THRESHOLD,
  MAX_AUDIT_PARALLELISM,
  prepareComplianceAuditPlan,
  type ComplianceAuditMode,
  type ComplianceRemediationPolicy,
} from "../compliance-audit.js";

const MODES = [
  "triage",
  "standard",
  "comprehensive",
  "tripwire",
  "single-bead",
  "re-verification",
  "onboarding",
  "sample",
] as const;

const POLICIES = ["completion-debt", "reopen", "report-only"] as const;

export function registerComplianceAuditTool(oc: OrchestratorContext) {
  for (const toolName of ["agent_flywheel_audit_beads", "orch_audit_beads", "flywheel_audit_beads"] as const) {
    oc.pi.registerTool({
      name: toolName,
      label: "Audit Beads Completion",
      description:
        "Bootstrap a beads compliance audit: br doctor preflight, tier/mode selection, and a 10-phase evidence-based prompt for verifying closed bead completion claims.",
      promptSnippet: "Audit closed beads for actual completion with evidence packs",
      parameters: Type.Object({
        mode: Type.Optional(StringEnum(MODES, {
          description: "Audit depth/mode. Omit to auto-select from closed-bead count and existing audit dir.",
        })),
        threshold: Type.Optional(Type.Number({
          description: `False-closed threshold, 0-1000. Default ${DEFAULT_AUDIT_THRESHOLD}.`,
          minimum: 0,
          maximum: 1000,
        })),
        remediationPolicy: Type.Optional(StringEnum(POLICIES, {
          description: "What to do with false-closed beads. Tripwire defaults to report-only; other modes default to completion-debt.",
        })),
        parallelism: Type.Optional(Type.Number({
          description: `Desired subagent fan-out. Hard-capped at ${MAX_AUDIT_PARALLELISM}.`,
          minimum: 1,
          maximum: MAX_AUDIT_PARALLELISM,
        })),
        beadId: Type.Optional(Type.String({
          description: "Specific bead ID for single-bead mode.",
        })),
        sampleSize: Type.Optional(Type.Number({
          description: "Sample size for sample mode (1-50; defaults to 15-50 depending on universe size).",
          minimum: 1,
          maximum: 50,
        })),
        testExecutionOk: Type.Optional(Type.Boolean({
          description: "Set true only after confirming tests/fuzzers/e2e are safe to run in this checkout.",
        })),
        autoStart: Type.Optional(Type.Boolean({
          description: "If true, send the generated audit prompt as a follow-up message so the agent starts the pass.",
        })),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await prepareComplianceAuditPlan(oc.pi, ctx.cwd, {
          mode: params.mode as ComplianceAuditMode | undefined,
          threshold: params.threshold as number | undefined,
          remediationPolicy: params.remediationPolicy as ComplianceRemediationPolicy | undefined,
          parallelism: params.parallelism as number | undefined,
          beadId: params.beadId as string | undefined,
          sampleSize: params.sampleSize as number | undefined,
          testExecutionOk: params.testExecutionOk === true,
        });

        if (!result.ok) {
          const detail = result.error
            ? `\n\nCommand: \`${result.error.command}\`\nExit: ${result.error.exitCode}\n${result.error.stderr ? `stderr: ${result.error.stderr.slice(0, 1000)}` : ""}`
            : "";
          return {
            content: [{ type: "text", text: `❌ Beads compliance audit preflight failed at ${result.stage}: ${result.message}${detail}` }],
            details: { ok: false, stage: result.stage, error: result.error, doctor: result.doctor },
          };
        }

        const { plan } = result;
        const startNote = params.autoStart === true
          ? "\n\n✅ Sent audit prompt as a follow-up message."
          : "\n\nTo run it now, call this tool again with `autoStart: true` after confirming test execution, or paste the prompt below into the agent.";

        if (params.autoStart === true) {
          oc.pi.sendUserMessage(plan.prompt, { deliverAs: "followUp" });
        }

        return {
          content: [{ type: "text", text: `${plan.summary}${startNote}\n\n---\n\n## Audit prompt\n\n${plan.prompt}` }],
          details: { ok: true, plan, autoStarted: params.autoStart === true },
        };
      },

      renderResult(result, _options, theme) {
        const details = result.details as any;
        if (!details?.ok) {
          return new Text(theme.fg("error", "Beads compliance audit preflight failed"), 0, 0);
        }
        const plan = details.plan as { mode: string; closedCount: number; tier: string } | undefined;
        return new Text(
          theme.fg("success", `Audit ready: ${plan?.mode ?? "mode"} (${plan?.closedCount ?? 0} closed, ${plan?.tier ?? "tier"})`),
          0,
          0,
        );
      },
    });
  }
}
