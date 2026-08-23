import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { OrchestratorState } from "./types.js";

export interface HandoffInput {
  cwd: string;
  state: OrchestratorState;
  reason: string;
  changedFiles?: string[];
  validationResults?: string[];
  deviations?: string[];
  blockers?: string[];
  openQuestions?: string[];
  nextSteps?: string[];
  suggestedSkills?: string[];
}

export interface HandoffTriggerInput {
  event: "session_length" | "review_failure" | "status_request" | "stop";
  state: OrchestratorState;
  sessionMessageCount?: number;
  reviewFailureCount?: number;
  threshold?: number;
}

export function shouldGenerateHandoff(input: HandoffTriggerInput): boolean {
  if (input.event === "session_length") return (input.sessionMessageCount ?? 0) >= (input.threshold ?? 80);
  if (input.event === "review_failure") return (input.reviewFailureCount ?? 0) >= 2;
  if (input.event === "status_request") return input.state.phase !== "idle" || Boolean(input.state.currentBeadId);
  if (input.event === "stop") {
    const hasActiveWork = Boolean(input.state.currentBeadId) ||
      (input.state.activeBeadIds?.length ?? 0) > 0 ||
      Object.values(input.state.beadResults ?? {}).some((result) => result.status !== "success");
    return hasActiveWork;
  }
  return false;
}

function bulletList(items: string[] | undefined, empty: string): string {
  return items && items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${empty}`;
}

export function generateHandoffMarkdown(input: HandoffInput): string {
  const st = input.state;
  const activeBead = st.currentBeadId ?? st.activeBeadIds?.find((id) => st.beadResults?.[id]?.status !== "success") ?? st.activeBeadIds?.[0] ?? "none";
  const planRefs = [
    st.planDocument ? `- Plan artifact: ${st.planDocument}` : undefined,
    st.planningWorkflow?.specArtifact ? `- Spec artifact: ${st.planningWorkflow.specArtifact}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return [
    "# AgentFlywheel Handoff",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Reason: ${input.reason}`,
    `Repository: ${input.cwd}`,
    "",
    "## Goal",
    st.selectedGoal ?? "Unknown goal",
    "",
    "## Active Work",
    `- Phase: ${st.phase}`,
    `- Active bead/todo: ${activeBead}`,
    st.activeBeadIds?.length ? `- Active bead set: ${st.activeBeadIds.join(", ")}` : "- Active bead set: none recorded",
    "",
    "## Changed Files",
    bulletList(input.changedFiles, "No changed files captured."),
    "",
    "## Validation Results",
    bulletList(input.validationResults, "No validation results captured."),
    "",
    "## Deviations From Plan",
    bulletList(input.deviations, "No deviations recorded."),
    "",
    "## Blockers",
    bulletList(input.blockers, "No blockers recorded."),
    "",
    "## Open Questions",
    bulletList(input.openQuestions, "No open questions recorded."),
    "",
    "## Next Steps",
    bulletList(input.nextSteps, "Resume with `bv --robot-next`, inspect the active bead, and continue through `flywheel_review`."),
    "",
    "## Suggested Skills",
    bulletList(input.suggestedSkills, "Use codebase-archaeology for orientation; use beads-workflow for bead repair."),
    "",
    "## Referenced Artifacts",
    planRefs.length > 0 ? planRefs.join("\n") : "- No plan/spec artifact recorded.",
  ].join("\n");
}

export function writeHandoffArtifact(input: HandoffInput): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-flywheel-handoff-"));
  const path = join(dir, "handoff.md");
  writeFileSync(path, generateHandoffMarkdown(input), "utf8");
  return path;
}
