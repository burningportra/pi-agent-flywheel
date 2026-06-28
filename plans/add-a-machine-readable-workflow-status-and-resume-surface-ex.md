# Plan: Machine-readable workflow status and resume surface

## Goal

Expose the current AgentFlywheel phase, selected goal, pending beads, approval state, and next valid action through a stable machine-readable surface so agents can recover after compaction, reloads, or interrupted menu flows without guessing.

## 1. Architecture Overview

The repository already has most of the recovery intelligence in `src/session-state.ts`: `detectSessionStage()` combines `OrchestratorState`, bead statuses, plan artifacts, and planning workflow stages into a `SessionStage` with `phase`, `goal`, bead counts, `nextAction`, `resumePrompt`, `confidence`, and `inferredFrom`. The new work should treat that module as the source of truth rather than reimplementing phase inference.

Add a small status layer that:

1. reads live beads with `readBeads(pi, ctx.cwd)` from `src/beads.ts`, falling back to an empty bead list if the project has no beads yet;
2. calls `detectSessionStage(oc.state, beads)`;
3. enriches the stage with explicit pending bead IDs, current bead metadata, approval-state booleans, canonical next tool, and copy-paste resume command text;
4. returns JSON via a new canonical tool, preferably `flywheel_status`, with legacy aliases if the project keeps the alias pattern;
5. updates the existing slash status path in `src/commands.ts` so `/flywheel-status` and legacy `/agent-flywheel-status` / `/orchestrate-status` can show the same status and optionally emit JSON when invoked with `--json`.

Key decisions:

- **Reuse `SessionStage` instead of creating a parallel state machine.** This avoids drift with the startup resume menu already used by `/agent-flywheel`.
- **Expose a contract version.** Follow the pattern in `src/tools/capabilities.ts` and `src/tools/triage.ts` (`contract_version`, `generated_at`, stable typed object) so agents can parse the output safely.
- **Keep status read-only.** The status tool and command must not mutate `oc.state`, bead statuses, checkpoints, or worktrees. Recovery actions should remain explicit next commands.
- **Prefer canonical names.** `src/tools/shared.ts` already defines canonical tool families and slash alias deprecation. Add status there so agents discover it through `flywheel_capabilities` and do not need source spelunking.

## 2. User Workflows

### Agent recovers after context compaction

1. Agent loses conversational context or reloads.
2. Agent calls `flywheel_status`.
3. Tool returns JSON including `phase`, `selected_goal`, `beads.pending`, `approval_state`, `next_action.canonical_tool`, and `resume_prompt`.
4. Agent follows the exact `next_action` without guessing.

### User checks status from the slash command

1. User runs `/flywheel-status`.
2. Command renders a concise human summary using the same underlying status builder.
3. User runs `/flywheel-status --json` when they want copyable machine-readable state.
4. Existing legacy commands `/agent-flywheel-status` and `/orchestrate-status` continue to work and emit deprecation warnings through the existing wrapper.

### Existing startup resume flow remains intact

`/agent-flywheel` continues to use `detectSessionStage()`, `formatSessionContext()`, and `buildResumeLabel()`. The new status layer should call the same detector but not replace the interactive startup menu.

## 3. Data Model / Types

Add a new status contract, likely in a new `src/workflow-status.ts` module to keep `src/session-state.ts` focused on detection and formatting.

Suggested types:

```ts
export interface WorkflowStatusOutput {
  contract_version: string;
  generated_at: string;
  ttl_seconds: number;
  active: boolean;
  phase: SessionStage["phase"];
  label: string;
  confidence: SessionStage["confidence"];
  selected_goal: string | null;
  plan_document: string | null;
  approval_state: {
    awaiting_plan_approval: boolean;
    awaiting_bead_approval: boolean;
    creating_beads: boolean;
    reviewing_or_iterating: boolean;
  };
  beads: {
    total: number;
    open: number;
    in_progress: number;
    closed: number;
    deferred: number;
    current: { id: string; title?: string; status: string } | null;
    pending: Array<{ id: string; title: string; status: string; unblocked?: boolean }>;
  };
  next_action: {
    summary: string;
    canonical_tool: string | null;
    command: string | null;
    resume_prompt: string;
  };
  inferred_from: string[];
  warnings: string[];
}
```

The exact shape can be tightened during implementation, but the contract should include the required goal fields: phase, selected goal, pending beads, approval state, and next valid action.

## 4. API Surface

### New functions

- `buildWorkflowStatus(oc: OrchestratorContext, beads: Bead[]): WorkflowStatusOutput`
  - Pure builder that accepts already-read beads and returns the stable status object.
- `formatWorkflowStatus(status: WorkflowStatusOutput): string`
  - Human-readable formatting for slash command output.
- `canonicalToolForStage(stage: SessionStage): string | null`
  - Maps existing `OrchestratorPhase` values to canonical tools. This should cover the richer phase names in `src/types.ts`, not just the simplified mapping in `src/tools/triage.ts`.

### New tool

Register a new tool in `src/tools/status.ts`:

- canonical name: `flywheel_status`
- aliases if following current compatibility pattern: `agent_flywheel_status`, `orch_status`
- parameters: empty object for v1
- result: JSON text plus `details: { status }`

### Slash commands

Update `src/commands.ts`:

- register canonical `/flywheel-status`;
- keep `/agent-flywheel-status` and `/orchestrate-status` as aliases;
- support `--json` to notify or print a JSON representation if the command API supports only notify-style output;
- keep the existing best-effort feedback stats/handoff behavior only if it does not obscure the primary status summary.

### Capabilities and triage

Update:

- `src/tools/shared.ts`: add a `status` family to `TOOL_FAMILIES`; add slash canonical aliases if missing or verify existing entries.
- `src/tools/capabilities.ts`: add a `status` tool description and include it in machine-readable capabilities.
- `src/tools/robot-docs.ts`: mention `flywheel_status` as the recovery-first call after reload/compaction.
- `src/tools/triage.ts`: either embed the richer status object or derive its quick ref from the new status builder so `next_canonical_tool` is consistent.
- `src/index.ts`: import and register the new status tool.

## 5. Testing Strategy

Use Vitest, matching the repository's existing test style.

### Unit tests

Add `src/workflow-status.test.ts`:

- idle state with no beads returns `phase: idle`, `active: false`, next tool `flywheel_profile`;
- selected goal with `phase: planning` returns the goal and next tool `flywheel_plan`;
- `awaiting_plan_approval` with `planDocument` sets `approval_state.awaiting_plan_approval = true` and next tool `flywheel_approve_beads`;
- open and in-progress beads populate pending/current bead fields and map to implementation/review next action;
- complete state with all beads closed returns no pending beads and no required next tool;
- low/medium/high confidence values from `detectSessionStage()` are preserved.

### Tool registration tests

Add or extend tests near `src/_tool-contract.test.ts` and `src/tools/*`:

- `flywheel_capabilities` includes `flywheel_status` with aliases and no phase-position requirement unless chosen;
- `flywheel_status` returns parseable JSON and puts the same object in `details.status`;
- legacy aliases emit deprecation warnings through existing helper behavior.

### Slash command tests

Extend `src/commands.orchestrate-startup.test.ts` or create `src/commands.status.test.ts`:

- `/flywheel-status` is registered;
- `/agent-flywheel-status` and `/orchestrate-status` remain registered;
- `--json` includes the contract version, phase, and next action;
- status command does not mutate `oc.state.phase` or bead statuses.

### Integration edge tests

- If `readBeads` fails because `.beads/` does not exist, status should still return a valid object with warning text rather than throwing.
- If a current bead ID is set in state but not found on disk, status should include a warning and still compute pending beads from disk.

## 6. Edge Cases & Failure Modes

- **No active session:** return `active: false`, `phase: idle`, `next_action.command: flywheel_profile`, and an empty bead summary.
- **Checkpoint or stale state mismatch:** do not restore checkpoints in the status tool unless existing startup code already does so. Status should report current in-memory state plus live bead evidence and include `confidence`/`inferred_from` so the agent understands uncertainty.
- **Beads CLI unavailable:** catch bead read failures and return warnings; do not fail the whole status surface.
- **Plan document present but artifact missing:** include `plan_document`, set awaiting-plan approval when the detector says so, and add a warning if the implementation checks artifact existence.
- **Multiple in-progress beads:** choose the first as `current` only for compatibility with `SessionStage`, but include all in-progress beads in `pending` and warn that multiple current candidates exist.
- **Research workflow:** preserve the special `researching` phase and return `flywheel_research` or a rerun instruction, matching `src/session-state.ts` metadata.
- **Non-native planning workflows:** use `state.planningWorkflow.stage` through `detectSessionStage()`, not custom checks, so Superpowers/spec stages remain accurate.

## 7. File Structure

Likely files to modify:

- `src/workflow-status.ts` — new pure builder and formatter.
- `src/workflow-status.test.ts` — new unit tests.
- `src/tools/status.ts` — new registered tool.
- `src/tools/status.test.ts` — tool execution tests if not covered elsewhere.
- `src/tools/shared.ts` — add status tool family and slash alias entries if needed.
- `src/tools/capabilities.ts` — expose the new tool contract.
- `src/tools/triage.ts` — align quick ref with status builder.
- `src/tools/robot-docs.ts` — document status recovery usage.
- `src/index.ts` — register the new tool.
- `src/commands.ts` — canonical `/flywheel-status`, JSON mode, legacy aliases.
- `README.md` — update status command documentation if the current section is human-only.

## 8. Sequencing

1. **Contract and builder first.** Implement `src/workflow-status.ts` and unit tests using synthetic `OrchestratorState` and bead arrays. No pi tool wiring yet.
2. **Tool wiring.** Add `src/tools/status.ts`, register it from `src/index.ts`, and update `src/tools/shared.ts` / `src/tools/capabilities.ts`.
3. **Command wiring.** Refactor the existing status command handler in `src/commands.ts` to use the same builder and add `/flywheel-status --json`.
4. **Triage/docs integration.** Update `src/tools/triage.ts`, `src/tools/robot-docs.ts`, and README references.
5. **Verification.** Run `npm test` and `npm run build`.

Parallelization:

- Builder/tests can be implemented independently of slash command docs.
- Tool/capabilities wiring should wait for the builder contract.
- Command refactor should wait for the formatter to avoid duplicating status rendering.
