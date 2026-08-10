# Plan: Make AgentFlywheel compaction-aware with explicit resume reasons

## Goal

Use Pi extension compaction metadata (`reason`, `willRetry`) to save AgentFlywheel workflow state, inject targeted resume instructions, and make status/recovery UX distinguish manual compaction, threshold auto-compaction, and overflow retry flows.

Grounding:
- Pi changelog 0.79.10 added `reason` and `willRetry` to `session_before_compact` / `session_compact` extension events.
- Pi changelog 0.80.3 fixed pre-prompt compaction to stop after compaction instead of continuing immediately.
- This repo is a TypeScript Pi extension with workflow tools in `src/tools/*`, prompts in `src/prompts.ts`, shared types in `src/types.ts`, and entrypoint registration in `src/index.ts`.
- Existing project rules require robust post-compaction recovery: re-read `AGENTS.md` and current orchestration state before continuing.

## 1. Architecture Overview

### High-level design

Add a small compaction-awareness layer that sits between Pi extension lifecycle events and AgentFlywheel's existing workflow/status tools:

```text
Pi extension runtime
  ├─ session_before_compact({ reason, willRetry, ... })
  ├─ session_compact({ reason, willRetry, ... })
  ↓
AgentFlywheel compaction module
  ├─ normalize event payloads across Pi versions
  ├─ persist latest compaction context in workflow state/session artifact
  ├─ build targeted resume guidance
  └─ expose status summary
  ↓
Existing AgentFlywheel surfaces
  ├─ flywheel_status / agent_flywheel_status
  ├─ phase tool prompts and error messages
  ├─ plan/approve/review resume instructions
  └─ tests and docs
```

### Key decisions

1. **Version-tolerant event handling**
   - Treat `reason` and `willRetry` as optional because older Pi versions may not send them.
   - Normalize unknown/missing `reason` to `unknown` and missing `willRetry` to `undefined`, not `false`, so the UI does not imply certainty.

2. **Minimal persistent state**
   - Store only the latest compaction context and a short history of recent events, not full transcripts.
   - Keep data serializable and safe to include in status output.

3. **Resume guidance is generated, not hardcoded into every prompt**
   - Add helper functions that convert normalized compaction context into short instructions.
   - Existing tools can call the helper instead of duplicating logic.

4. **Do not fight Pi's corrected compaction behavior**
   - Pi 0.80.3 stops after pre-prompt compaction rather than continuing immediately. AgentFlywheel should prepare resume state and guidance, not automatically run the next phase without user/tool control.

### Trade-offs

- A dedicated module adds a small amount of code, but avoids scattering event parsing across `src/index.ts`, `src/tools/status.ts`, and prompt generation.
- Persisting only lightweight metadata avoids privacy/noise risks, but means deeper recovery still depends on existing workflow state and bead data.

## 2. User Workflows

### Workflow A: Manual `/compact`

1. User runs AgentFlywheel through discovery/planning/implementation.
2. User manually triggers compaction.
3. Pi emits compaction metadata with `reason` indicating manual compaction and `willRetry` indicating whether the original request will be retried.
4. AgentFlywheel records:
   - phase before compaction,
   - selected goal if available,
   - bead summary if available,
   - `reason=manual`,
   - `willRetry` value.
5. On resume/status, AgentFlywheel shows:
   - "Last compaction: manual";
   - "Resume by checking AgentFlywheel status, then continue the next required phase";
   - if `willRetry` is true, "Pi may retry the interrupted request; avoid issuing duplicate phase actions until status is inspected."

### Workflow B: Threshold auto-compaction

1. Long orchestration approaches context threshold.
2. Pi emits compaction metadata with threshold/auto reason.
3. AgentFlywheel stores context and prepares a resume instruction emphasizing state validation.
4. Status output says:
   - "Last compaction: automatic threshold compaction";
   - "Recommended next action: call AgentFlywheel status, re-read project instructions if needed, then continue the reported next tool."

### Workflow C: Overflow retry compaction

1. Provider request overflows context and Pi compacts before retrying.
2. Event has `willRetry=true`.
3. AgentFlywheel stores a higher-severity recovery context.
4. Status/recovery prompt says:
   - "Last compaction: overflow retry";
   - "Pi intends to retry; do not duplicate external side effects. Re-check bead status and file state before making changes."

### Existing workflows affected

- `agent_flywheel_status` gains a compaction section, but normal output remains unchanged when no compaction event is recorded.
- Tool prompts can include a short "Compaction recovery" note only when relevant.
- Planning/approve/review flows continue to use their existing phase ordering.

## 3. Data Model / Types

Add shared types in `src/types.ts` or a new focused module imported by `src/types.ts`:

```ts
export type CompactionReason =
  | 'manual'
  | 'threshold'
  | 'overflow_retry'
  | 'unknown';

export interface RawPiCompactionEvent {
  reason?: string;
  willRetry?: boolean;
  [key: string]: unknown;
}

export interface AgentFlywheelCompactionContext {
  reason: CompactionReason;
  rawReason?: string;
  willRetry?: boolean;
  eventName: 'session_before_compact' | 'session_compact';
  observedAt: string;
  phase?: string;
  goal?: string;
  selectedBeadId?: string;
  beadSummary?: string;
}

export interface CompactionResumeGuidance {
  severity: 'info' | 'warning';
  title: string;
  summary: string;
  nextSteps: string[];
}
```

If there is an existing workflow-state interface, extend it with:

```ts
compaction?: {
  latest?: AgentFlywheelCompactionContext;
  recent?: AgentFlywheelCompactionContext[];
};
```

Design notes:
- `rawReason` preserves future Pi reason strings without blocking on a release.
- `willRetry?: boolean` preserves unknown vs false.
- `eventName` helps distinguish pre/post compaction event timing.

## 4. API Surface

Create `src/compaction.ts` with pure helpers:

```ts
export function normalizeCompactionReason(rawReason: unknown, willRetry?: boolean): CompactionReason;

export function normalizeCompactionEvent(
  eventName: 'session_before_compact' | 'session_compact',
  payload: RawPiCompactionEvent,
  snapshot?: Partial<Pick<AgentFlywheelCompactionContext, 'phase' | 'goal' | 'selectedBeadId' | 'beadSummary'>>
): AgentFlywheelCompactionContext;

export function buildCompactionResumeGuidance(
  context?: AgentFlywheelCompactionContext
): CompactionResumeGuidance | undefined;

export function formatCompactionStatus(context?: AgentFlywheelCompactionContext): string[];
```

Integrate with `src/index.ts` extension registration:

- Register/handle `session_before_compact` and `session_compact` events if the local Pi extension API exposes them.
- Handler should:
  1. capture a lightweight workflow snapshot;
  2. normalize the event;
  3. persist/update in existing workflow state;
  4. avoid launching tools or side-effectful continuation.

Integrate with status/recovery tools:

- `src/tools/status.ts` (or the file that implements `agent_flywheel_status`) should call `formatCompactionStatus`.
- Prompt builders in `src/prompts.ts` can call `buildCompactionResumeGuidance` when constructing post-compaction continuation text.

Potential public status addition:

```json
{
  "compaction": {
    "latest": {
      "reason": "threshold",
      "willRetry": false,
      "observedAt": "2026-07-09T...Z"
    },
    "guidance": {
      "severity": "info",
      "nextSteps": ["Call agent_flywheel_status", "Continue the reported NEXT tool"]
    }
  }
}
```

## 5. Testing Strategy

### Unit tests

Add `src/compaction.test.ts` covering:

- reason normalization:
  - manual strings map to `manual`;
  - threshold/auto strings map to `threshold`;
  - overflow/context-limit retry strings or `willRetry=true` map to `overflow_retry` when appropriate;
  - unknown/missing values map to `unknown`.
- `willRetry` unknown is preserved as `undefined`.
- guidance text differs for:
  - manual;
  - threshold;
  - overflow retry;
  - unknown.
- status formatter emits nothing or a neutral empty result when no context exists.

### Integration-style tests

Add or extend tests around the status tool:

- Given workflow state with no compaction context, status output remains backward-compatible.
- Given latest compaction context, status output includes reason, retry semantics, and next steps.
- Unknown future reason strings are displayed safely with `rawReason` but do not crash.

### Event handler tests

If the extension registration is testable:

- Simulate `session_before_compact` payload with `{ reason: 'manual', willRetry: false }` and assert state update.
- Simulate older Pi payload `{}` and assert graceful unknown context.
- Simulate `willRetry=true` and assert guidance warns against duplicate side effects.

### Verification commands

After implementation:

```bash
npm run build
npm test
```

## 6. Edge Cases & Failure Modes

1. **Older Pi versions do not send metadata**
   - Behavior: show `unknown` only if an event was captured; otherwise omit compaction section.
   - Do not fail startup or tool registration.

2. **Future Pi reason strings**
   - Behavior: preserve as `rawReason`, normalize to `unknown`, and show a neutral message.

3. **Both before and after compaction events fire**
   - Behavior: keep the latest event and short history; prefer `session_compact` for final status if both are present close together.

4. **`willRetry=true` after a side-effectful step**
   - Behavior: guidance warns to inspect bead/file state before duplicating work.

5. **State persistence unavailable**
   - Behavior: return best-effort in-memory guidance during the active session; do not block core workflow.

6. **Compaction during bead approval menu**
   - Behavior: resume guidance should say to inspect current workflow status and re-enter approval rather than creating beads twice.

7. **Compaction during implementation/review**
   - Behavior: guidance should emphasize checking bead status and working tree before continuing.

## 7. File Structure

Expected files to modify/create:

- `src/compaction.ts` — new pure compaction normalization, guidance, and formatting helpers.
- `src/compaction.test.ts` — unit tests for normalization/guidance/status formatting.
- `src/types.ts` — exported compaction types or workflow state extension.
- `src/index.ts` — hook Pi lifecycle events into the new compaction module, if the extension API supports these event names in the installed Pi version.
- `src/tools/status.ts` or current status implementation file — include compaction context in machine-readable and human-readable status.
- `src/prompts.ts` — add optional post-compaction guidance snippets to continuation/recovery prompts.
- `README.md` or docs section — mention compaction-aware recovery behavior if there is already a status/recovery feature section.

Before implementation, verify actual status tool file names with `rg "agent_flywheel_status|flywheel_status|session_compact|session_before_compact" src`.

## 8. Sequencing

### Bead 1: Add pure compaction model and tests

- Create `src/compaction.ts`.
- Add types and normalization/guidance helpers.
- Add unit tests.
- No dependency on Pi runtime hooks.

Parallelization: can be done independently.

### Bead 2: Persist and expose compaction context in workflow status

- Locate current workflow state/status implementation.
- Extend state shape with optional compaction context.
- Render machine-readable and human-readable status section.
- Add status tests.

Dependency: Bead 1.

### Bead 3: Wire Pi compaction lifecycle events

- Inspect existing extension setup in `src/index.ts`.
- Register handlers for `session_before_compact` and `session_compact` if supported.
- Capture lightweight phase/goal/bead snapshot.
- Persist context through helper from Bead 1.

Dependency: Bead 2.

### Bead 4: Add targeted resume prompt snippets

- Update `src/prompts.ts` or relevant prompt helpers to include guidance after compaction.
- Ensure manual, threshold, and overflow retry flows have distinct copy.
- Add snapshot/unit tests if prompts are tested.

Dependency: Beads 1-3.

### Bead 5: Documentation and verification

- Document behavior and fallback semantics.
- Run `npm run build` and `npm test`.
- Address failures.

Dependency: Beads 1-4.

## Acceptance Criteria

- AgentFlywheel records compaction context from Pi lifecycle events when metadata is available.
- Manual, threshold, overflow retry, and unknown compaction cases produce distinct safe resume guidance.
- Status output exposes the latest compaction reason and retry semantics without breaking no-compaction output.
- Older Pi installs or missing event metadata degrade gracefully.
- Tests cover normalization, guidance, and status integration.
- `npm run build` and `npm test` pass.
