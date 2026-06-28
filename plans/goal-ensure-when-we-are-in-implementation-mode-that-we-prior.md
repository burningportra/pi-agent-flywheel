# Plan: Implementation-Mode Sub-Agent Context and Agent Mail Coordination

## Goal
Ensure implementation-mode work is delegated to clear-context **pi-subagents** (not NTM panes), coordinated via MCP Agent Mail, prioritized with `bv`, protected from communication-only stalls, and able to reopen clearly stale in-progress beads when evidence supports it.

## Scope
- Implementation mode only.
- No new dependencies.
- Improve prompts, preflight/handoff behavior, and test coverage around implementation-worker coordination.

## 1. Architecture Overview

### Current architecture touchpoints
The extension is a TypeScript pi extension centered around the scan → choose → plan → approve → implement → review loop described in `README.md`. Existing implementation-mode orchestration is likely concentrated in:

- `src/tools/approve.ts` — approval flow and transition into implementation.
- `src/tools/review.ts` — per-bead review and next-bead selection.
- `src/prompts.ts` — prompt templates and bead-planning instructions.
- `src/deep-plan.ts` — multi-model planning agents.
- `src/beads.ts` — bead reading/validation helpers.
- `src/types.ts` — shared interfaces.

`AGENTS.md` currently describes an NTM-managed implementation swarm policy, but this plan applies a human override: implementation mode should prefer **pi-subagents** instead of NTM panes. The retained coordination policies are:

- Workers should coordinate using MCP Agent Mail.
- Workers should use fresh callsigns and acknowledge inbox requests promptly.
- Workers should prefer `bv --robot-next` / `bv --robot-triage` over `br ready`.
- Workers should avoid “communication purgatory” by coordinating quickly and then starting useful bead work.

### Proposed design
Add an implementation-worker coordination contract that is injected into every **pi-subagent** implementation prompt and represented in tests as a stable, reusable prompt section.

Core behavior:

1. Centralize the long `/goal ...` implementation-worker instruction into a named prompt builder or constant.
2. Ensure pi-subagent implementation handoff paths include this contract before worker-specific bead instructions.
3. Add an implementation preflight/checklist section that tells workers to:
   - read `AGENTS.md` and `README.md` fully;
   - inspect recent commits;
   - investigate architecture before editing;
   - register with MCP Agent Mail using a fresh callsign;
   - introduce themselves and track active agents;
   - check and acknowledge inbox messages;
   - announce bead claims/completions;
   - use `bv --robot-next` / `bv --robot-triage` when choosing work;
   - avoid “communication purgatory” by starting actionable beads after coordination;
   - identify clearly stale in-progress beads and reopen them only with evidence.
4. Add prompt/preflight tests to prevent regressions.

### Key decisions and trade-offs

- **Centralized prompt contract vs. duplicated inline instructions:** Centralization reduces drift and makes tests straightforward. Inline call-site additions may be faster but risk inconsistent implementation-worker prompts.
- **Prompt-level enforcement vs. runtime enforcement:** The stated implementation notes are “Prompt + preflight” and “Mail + time,” with no new dependencies. Prompt/preflight enforcement is lower risk than building a complete runtime stale-bead detector, but should still be backed by tests asserting the worker contract is present.
- **Evidence-based stale bead reopening:** Reopening stalled beads can disrupt active work. The prompt must require evidence such as old `updated_at`/status plus no recent commits or mail activity, and should tell workers to announce reopening via Agent Mail.

## 2. User Workflows

### Existing implementation workflow
1. User starts AgentFlywheel.
2. Repo is profiled and goal is selected.
3. A plan and beads are approved.
4. Implementation workers are launched or guided to work beads.
5. Reviews run and completion checks occur.

### New implementation workflow
1. User reaches implementation mode after plan/bead approval.
2. AgentFlywheel delegates implementation to pi-subagents rather than NTM panes.
3. Each pi-subagent implementation worker receives a clear context-first `/goal` prompt.
4. Worker reads `AGENTS.md` and `README.md`, reviews recent commits, and investigates architecture before editing.
5. Worker registers with MCP Agent Mail, introduces itself, checks inbox, acknowledges requests, and records active agent names.
6. Worker chooses work using assigned beads or `bv --robot-next` / `bv --robot-triage`.
7. Worker marks beads appropriately, announces claims and completions, and proceeds with implementation.
8. Worker checks for stale in-progress beads using time and communication evidence, then reopens only clearly abandoned beads while announcing the action.
9. Worker avoids blocking on indefinite coordination when useful work is available.

### Impact on existing workflows
- Planning and approval workflows remain unchanged.
- Implementation prompts become more prescriptive and context-heavy.
- Worker coordination becomes explicit and testable.
- Implementation delegation uses pi-subagents rather than NTM panes.
- No new CLI commands or dependencies are required.

## 3. Data Model / Types

Likely minimal or no persistent data-model changes.

Potential additions if existing prompt code benefits from typed options:

```ts
export interface ImplementationCoordinationPromptOptions {
  includeStaleBeadPolicy?: boolean;
  includeAgentMailPolicy?: boolean;
  includeBvPrioritization?: boolean;
}
```

This type is optional. Prefer no new type if a simple exported prompt builder is enough.

No bead schema changes are required. Stale detection can rely on existing bead metadata exposed by `br`/`bv` and instructions to verify evidence before changing status.

## 4. API Surface

### Internal prompt builder
Add or update an internal function in `src/prompts.ts` such as:

```ts
export function buildImplementationWorkerGoalPrompt(): string;
```

or, if the codebase already has implementation prompt builders, extend the existing function rather than adding a new surface.

Expected prompt contents:

- `/goal` prefix or equivalent goal framing.
- Full-context reading requirement for `AGENTS.md` and `README.md`.
- Code investigation and recent commit review requirement.
- MCP Agent Mail registration and introduction requirement.
- Inbox checking and acknowledgement requirement.
- Active-agent awareness requirement.
- Bead progress tracking through `br`/`bv` and Agent Mail.
- `bv --robot-next` / `bv --robot-triage` prioritization guidance.
- Anti-stall instruction: coordinate, then start useful work.
- Stale in-progress bead reopening policy requiring evidence and announcement.

### Implementation launch integration
Update implementation-mode launch/handoff code to prepend or include the builder output in pi-subagent worker prompts. Candidate files to inspect and modify:

- `src/tools/approve.ts`
- `src/tools/review.ts`
- `src/prompts.ts`
- any NTM/subagent launch helpers discovered by searching for implementation prompt construction.

No public CLI/API changes are expected.

## 5. Testing Strategy

### Unit tests
Add or update Vitest tests to assert the implementation worker prompt includes:

- `AGENTS.md` and `README.md` reading requirements.
- Recent commit inspection requirement.
- MCP Agent Mail registration/introduction.
- Inbox checking and acknowledgement.
- Active agent awareness.
- `bv --robot-next` or `bv --robot-triage` prioritization.
- Avoiding communication purgatory.
- Stale in-progress bead reopening with evidence.

Likely test locations:

- Existing prompt tests if present.
- New `src/_verify-implementation-coordination.test.ts` or similar if the repo uses `_verify-*.test.ts` naming, as evidenced by `src/_verify-templates.test.ts` in `AGENTS.md`.

### Integration tests
If launch prompts are assembled in a separate module, add a test that builds a representative implementation-worker handoff and verifies the coordination contract is present exactly once and appears before bead-specific instructions.

### Regression checks
Run:

```bash
npm run build
npm test
```

Both are required by `AGENTS.md` after changes.

## 6. Edge Cases & Failure Modes

### Agent Mail unavailable
Prompt should tell workers to register/check Agent Mail, but if MCP Agent Mail is unavailable, workers should report the failure and continue useful local bead work rather than stall indefinitely.

### `bv` unavailable or no actionable result
Prompt should prefer `bv`, but allow fallback to `br ready --json` if `bv` is unavailable or reports no actionable items, matching `AGENTS.md`.

### Stale bead false positives
Workers must not reopen active work merely because a bead is `in_progress`. The stale policy should require evidence:

- long-unmodified bead status;
- no recent commits referencing the bead;
- no recent Agent Mail activity from the claimant;
- announcement before/after reopening.

### Prompt bloat
The context prompt is intentionally detailed, but should be centralized to avoid duplicating large text across files. Tests should check key obligations rather than snapshotting huge prose unless snapshot patterns already exist.

### NTM policy conflict
`AGENTS.md` currently mentions NTM pane policy, but the human override for this plan is explicit: implementation mode should use pi-subagents instead of NTM. The implementation should avoid NTM tick-loop/pane requirements in the new coordination contract while preserving Agent Mail and `bv` routing behavior.

## 7. File Structure

### Files to inspect
- `src/prompts.ts`
- `src/tools/approve.ts`
- `src/tools/review.ts`
- `src/deep-plan.ts`
- `src/types.ts`
- existing `*.test.ts` files
- `README.md`
- `AGENTS.md`

### Files likely to modify
- `src/prompts.ts` — add centralized implementation coordination prompt builder or extend existing implementation prompt.
- Implementation launch module discovered during code investigation, likely `src/tools/approve.ts` or a related helper — ensure builder is included in pi-subagent implementation worker prompts.
- Test file(s), likely under `src/` — add prompt and launch assembly coverage.

### Files not expected to change
- No new dependency files.
- No bead schema migration.
- No README changes unless implementation behavior is user-visible and existing docs describe worker launch prompts.

## 8. Sequencing

### Step 1 — Investigate prompt and launch architecture
- Read all of `AGENTS.md` and `README.md`.
- Search for implementation launch/prompt construction (`implementation`, `subagent`, `ntm`, `Agent Mail`, `bv --robot`, `goal`).
- Identify the single best insertion point for implementation-worker coordination instructions.

### Step 2 — Add centralized coordination prompt
- Implement a builder/constant in `src/prompts.ts` or the existing prompt module.
- Keep wording clear and action-oriented.
- Include stale-bead policy and non-stalling fallback behavior.

### Step 3 — Wire prompt into implementation mode
- Update implementation launch/handoff code so every pi-subagent implementation worker receives the contract.
- Ensure prompt ordering gives global context before bead-specific work.
- Prefer pi-subagents over NTM panes for implementation routing.

### Step 4 — Add tests
- Unit-test the prompt contract.
- Integration-test representative implementation prompt assembly if practical.
- Avoid brittle full snapshots unless that is the existing project convention.

### Step 5 — Verify
- Run `npm run build`.
- Run `npm test`.
- Fix any failures.

## Proposed Beads

### Bead 1: Map implementation-worker prompt launch path
Acceptance criteria:
- Read `AGENTS.md` and `README.md` fully.
- Identify concrete files/functions that assemble implementation-worker prompts.
- Document where the coordination contract should be inserted.

### Bead 2: Add implementation coordination prompt contract
Acceptance criteria:
- Add centralized prompt text/builder for context-first implementation work.
- Include Agent Mail coordination, `bv` prioritization, anti-stall behavior, and stale-bead reopening policy.
- No new dependencies.

### Bead 3: Wire contract into implementation-mode worker prompts
Acceptance criteria:
- Pi-subagent implementation workers launched from approval/review flow receive the contract.
- Contract appears before bead-specific task text.
- NTM pane/tick-loop requirements are not used for implementation routing.

### Bead 4: Add regression tests for coordination prompt behavior
Acceptance criteria:
- Tests assert key coordination obligations are present.
- Tests cover prompt assembly or launch handoff if a builder exists.
- `npm run build` and `npm test` pass.
