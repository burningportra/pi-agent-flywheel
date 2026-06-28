# Plan: Preflight Model/Provider Auth Before Launching Workers

## Goal

Add a bounded preflight that checks whether configured worker providers can actually launch before AgentFlywheel starts implementation or review swarms. If a provider is unauthorized or unavailable, the launch path should route around it, downgrade parallelism, or present a clear repair hint before work begins.

This plan is grounded in the current repository shape:

- Worker launch decisions currently live around implementation/review flow code in `src/tools/approve.ts`, `src/tools/review.ts`, `src/swarm.ts`, and coordination helpers in `src/coordination.ts`.
- The repo already has a bounded Agent Mail preflight in `src/agent-mail.ts` and launch-safety decision logic in `src/coordination.ts`.
- Status/doctor/capabilities surfaces exist in `src/tools/status.ts`, `src/tools/doctor.ts`, `src/tools/capabilities.ts`, `src/tools/triage.ts`, and `src/tools/robot-docs.ts`.
- The live workflow failure that motivated this goal was a worker launch failure with an OAuth 403: `OAuth authentication is currently not allowed for this organization.`

## 1. Architecture Overview

### High-level design

Introduce a provider-preflight layer that runs before worker launch paths assemble or execute implementation/review swarms.

Core components:

1. **Provider auth classifier**
   - Pure functions that classify provider/tool launch failures into stable categories.
   - Handles at minimum: available, unauthorized, unavailable/missing tool, rate-limited, unknown failure, and not checked.

2. **Bounded provider preflight runner**
   - Uses lightweight, time-bounded checks against the local pi/tool environment.
   - Does not perform destructive actions and does not launch long-running workers.
   - Returns structured evidence and repair guidance.

3. **Launch-plan integration**
   - Extends existing `decideImplementationLaunchSafety` inputs/outputs with provider readiness.
   - If a required provider is unauthorized/unavailable, route around it when alternatives exist; otherwise downgrade to one safe worker or present a repair hint.

4. **Review-gate integration**
   - Peer-review / hit-me review agent launch should use the same provider preflight so review gates do not wedge after spawning failing agents.
   - The gate should distinguish between degraded/missing review capacity and successful peer review.

5. **Diagnostics surfaces**
   - `flywheel_doctor`, `flywheel_triage`, and optionally `flywheel_status` should expose provider readiness when available.
   - These surfaces remain read-only.

### Key architectural decisions

- **Fail open only for optional capacity, not for required evidence.** If a swarm can safely run fewer workers, downgrade. If a review gate requires peer evidence and no provider is available, report degraded review capacity instead of pretending the review passed.
- **Classify, do not guess.** Store exact evidence such as command exit code, stderr snippet, and recognized error shape.
- **Reuse existing launch safety.** Extend `src/coordination.ts` rather than creating a parallel launch decision engine.
- **Keep preflight bounded.** Checks should have short timeouts and no retry loops that can become communication purgatory.
- **No destructive repair.** Repair guidance is text only unless a future bead adds explicit user-approved repair actions.

## 2. User Workflows

### Workflow A: Implementation launch with healthy provider

1. User approves beads.
2. AgentFlywheel computes ready beads and current execution mode.
3. Provider preflight verifies the worker surface/model route is launchable.
4. Existing launch-safety checks continue: Agent Mail, file scopes, worktree/parallel choice.
5. Response tells the user/agent which worker mode to launch.

Expected result: current behavior continues, with extra readiness evidence available in details.

### Workflow B: Implementation launch with unauthorized provider

1. User approves beads.
2. Provider preflight detects an unauthorized provider response, such as OAuth 403.
3. Launch decision either:
   - routes to an available alternative provider/surface,
   - reduces worker count to a safe available route,
   - or blocks/downgrades with explicit repair guidance.
4. Response includes exact degraded reason and next safe action.

Expected result: the user sees the auth issue before spawning multiple failed workers.

### Workflow C: Peer-review gate provider failure

1. A bead passes self-review and enters automatic peer/fresh-eyes review.
2. Provider preflight checks reviewer launch surfaces first.
3. If some reviewers can launch, run those and mark the others degraded.
4. If none can launch, return a review-gate result that says peer review is unavailable and names the provider/auth repair hint.
5. The orchestrator can ask the user to retry after auth repair, accept a degraded gate explicitly, or regress to implementation if review capacity is mandatory.

Expected result: review gate does not silently fail or wedge waiting for workers that cannot start.

### Workflow D: Doctor/triage diagnostics

1. User calls `flywheel_doctor` or `flywheel_triage`.
2. Output includes provider auth readiness summary when checks are cheap and safe.
3. If checks are skipped, the output says they were not checked and how to run them.

Expected result: provider readiness becomes discoverable before a workflow reaches launch.

## 3. Data Model / Types

Add provider preflight types in a focused module, likely `src/provider-preflight.ts`.

```ts
export type ProviderPreflightStatus =
  | "available"
  | "unauthorized"
  | "unavailable"
  | "rate_limited"
  | "misconfigured"
  | "unknown_failure"
  | "not_checked";

export interface ProviderPreflightCheck {
  id: string;
  label: string;
  provider?: string;
  model?: string;
  surface: "subagent" | "ntm" | "claude-code" | "cursor-agent" | "codex" | "unknown";
  required: boolean;
}

export interface ProviderPreflightResult {
  status: ProviderPreflightStatus;
  check: ProviderPreflightCheck;
  launchable: boolean;
  evidence: string[];
  repairGuidance: string[];
}

export interface ProviderPreflightSummary {
  status: ProviderPreflightStatus;
  launchableCount: number;
  requiredUnavailable: boolean;
  results: ProviderPreflightResult[];
  selectedCheckIds: string[];
  downgradeReasons: string[];
  repairGuidance: string[];
}
```

Extend `ImplementationLaunchSafetyDecision` in `src/coordination.ts` with optional provider fields:

```ts
providerPreflight?: ProviderPreflightSummary;
providerStatus?: ProviderPreflightStatus;
```

Keep these fields optional so old tests and sessions remain compatible.

## 4. API Surface

### New pure classifier helpers

```ts
export function classifyProviderAuthEvidence(input: {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: unknown;
}): ProviderPreflightStatus;
```

Recognition examples:

- `403` plus `permission_error` / `OAuth authentication is currently not allowed` → `unauthorized`
- `401` / `Unauthorized` → `unauthorized`
- `429` / `rate limit` → `rate_limited`
- `ENOENT` / missing command → `unavailable`
- empty/unknown nonzero output → `unknown_failure`

### New preflight runner

```ts
export async function preflightWorkerProviders(input: {
  pi: Pick<OrchestratorContext["pi"], "exec">;
  cwd: string;
  checks: ProviderPreflightCheck[];
  timeoutMs?: number;
}): Promise<ProviderPreflightSummary>;
```

Implementation detail: the runner should rely on safe local probes. It should not launch real long-running agents. Depending on existing pi/tool support, acceptable checks include:

- tool availability (`ntm --help`, `cc --help`, cursor/codex help where used),
- environment/tool-surface discovery,
- tiny dry-run commands only if they already exist and are documented in repo/tool code.

If no safe dry-run exists for a provider, report `not_checked` with guidance rather than hallucinating success.

### Launch integration

Extend `decideImplementationLaunchSafety(input)` to accept:

```ts
providerPreflight?: ProviderPreflightSummary;
```

Rules:

- If `providerPreflight.requiredUnavailable` is true and no alternative launchable check exists, select sequential/degraded mode and include repair guidance.
- If at least one launchable provider exists, select only routes that match launchable checks.
- Keep existing Agent Mail/file-scope/worktree rules intact.

### Review-gate integration

Add helper for review worker launch planning:

```ts
export function decideReviewWorkerLaunchSafety(input: {
  reviewers: ProviderPreflightCheck[];
  providerPreflight: ProviderPreflightSummary;
  minRequiredReviewers?: number;
}): {
  launchableReviewerIds: string[];
  degradedReviewerIds: string[];
  canProceed: boolean;
  explanation: string;
  repairGuidance: string[];
};
```

This can live in `src/provider-preflight.ts` or `src/coordination.ts` depending on dependency direction.

## 5. Testing Strategy

### Unit tests

Create `src/provider-preflight.test.ts` covering:

1. Classifies OAuth 403 permission error as `unauthorized`.
2. Classifies 401 Unauthorized as `unauthorized`.
3. Classifies rate-limit text/status as `rate_limited`.
4. Classifies missing command as `unavailable`.
5. Classifies unknown nonzero output as `unknown_failure`.
6. Produces bounded repair guidance for unauthorized provider.
7. Summarizes multiple provider checks and selects launchable alternatives.
8. Does not retry endlessly on unauthorized evidence.

### Coordination tests

Extend `src/coordination.test.ts`:

1. Same-checkout parallel launch remains allowed when Agent Mail, file scopes, supervision, and provider preflight are all green.
2. Unauthorized required provider downgrades launch and includes provider repair guidance.
3. Optional unavailable provider is routed around when another provider is launchable.
4. Existing worktree and sequential behavior remains stable.

### Review/approve tests

Extend source-contract or behavior tests in:

- `src/tools/approve.test.ts`
- `src/tools/review.test.ts` or existing review test file if present

Coverage:

1. Approve path calls provider preflight before returning multi-worker launch handoff.
2. Review peer/hit-me path checks provider readiness before spawning reviewers.
3. Failed provider does not produce a fake successful peer review.
4. Response text includes exact status and repair hint.

### Doctor/triage tests

If provider readiness is added to diagnostics, extend:

- `src/tools/doctor.test.ts` if present
- `src/tools/triage.test.ts`
- `src/tools/robot-docs.test.ts` if docs mention the preflight

### Verification commands

Run:

```bash
npm test -- src/provider-preflight.test.ts src/coordination.test.ts src/tools/approve.test.ts src/tools/review.test.ts
npm run build
npm test
```

If some focused files do not exist, run the nearest existing suite plus full `npm test`.

## 6. Edge Cases & Failure Modes

### Unauthorized provider

- Classify as `unauthorized`.
- Do not retry endlessly.
- Include repair guidance: verify provider auth, switch model/provider, or use a visible alternative worker surface.

### Provider command unavailable

- Classify as `unavailable`.
- Downgrade or route around.
- Mention missing command/tool in evidence.

### Safe dry-run unavailable

- Classify as `not_checked` rather than `available`.
- Do not block single-worker flows solely because a dry-run API does not exist.
- For multi-worker/review swarms, include uncertainty in launch explanation.

### Mixed provider availability

- Use available alternatives if the launch recipe supports them.
- Degrade unavailable optional reviewers/workers individually.
- Keep selected worker count consistent with available capacity.

### Agent Mail unavailable and provider unavailable

- Existing Agent Mail preflight and file-scope safety should still decide same-checkout safety.
- Provider preflight should add another downgrade reason, not replace coordination safety.

### Review gate with zero launchable reviewers

- Return a degraded review-gate state with repair guidance.
- Do not mark peer review as clean/passed.
- Offer retry/explicit skip only through review workflow.

### Provider rate limit

- Classify separately from auth failure.
- Suggested action: wait/change provider/reduce worker count.
- Avoid immediate repeated retries.

## 7. File Structure

### New files

- `src/provider-preflight.ts`
  - Provider preflight types, classifier, summary builder, and review launch helper.
- `src/provider-preflight.test.ts`
  - Focused tests for classification and summary behavior.

### Modified files

- `src/coordination.ts`
  - Extend launch safety decision with provider preflight input/output and downgrade logic.
- `src/coordination.test.ts`
  - Add provider-driven launch downgrade tests.
- `src/tools/approve.ts`
  - Call provider preflight before implementation handoff launch decisions.
- `src/tools/approve.test.ts`
  - Assert approve path wires provider preflight and explains downgrade.
- `src/tools/review.ts`
  - Call provider preflight before peer/hit-me review workers, or route through a helper that does.
- `src/tools/review.test.ts` or existing review tests
  - Cover review-gate degraded provider path.
- `src/tools/doctor.ts` and tests if diagnostics are included in this implementation slice.
- `src/tools/triage.ts` and tests if triage includes provider readiness.
- `src/tools/robot-docs.ts` / `README.md` if user-facing repair guidance is added.

## 8. Sequencing

### Step 1: Build provider preflight core

- Add types and pure classifier in `src/provider-preflight.ts`.
- Add tests for OAuth 403, 401, rate limit, missing command, unknown failure.
- This is independent and should be implemented first.

### Step 2: Add summary and launch filtering helpers

- Implement `preflightWorkerProviders` with bounded safe probes.
- Implement summary aggregation and repair guidance.
- Add unit tests with mocked `pi.exec`.

### Step 3: Extend implementation launch safety

- Add optional provider preflight input to `decideImplementationLaunchSafety`.
- Preserve existing Agent Mail/file-scope/worktree behavior.
- Add coordination tests for provider-driven downgrade/routing.

### Step 4: Wire approve implementation handoff

- In `src/tools/approve.ts`, build provider preflight checks before implementation launch decision.
- Include provider evidence in response details and human explanation.
- Add/adjust approve tests.

### Step 5: Wire review worker gates

- In `src/tools/review.ts`, preflight reviewer providers before peer/hit-me workers are spawned.
- Add degraded review output that does not claim success for missing reviewers.
- Add review tests.

### Step 6: Diagnostics/docs

- Add concise provider auth readiness to doctor/triage/robot docs if the implementation can do so without broad scope creep.
- Otherwise leave a bead for diagnostics expansion.

### Step 7: Full verification

- Run focused suites.
- Run `npm run build`.
- Run full `npm test`.

## Dependency Notes

Sequential dependencies:

1. Provider classifier and types must exist before launch integration.
2. Coordination launch decision must accept provider preflight before approve/review can use it cleanly.
3. Approve/review wiring should happen after the pure pieces are tested.

Parallelizable work:

- Doctor/triage documentation can be implemented after the provider summary shape is stable.
- Review-gate tests and approve-path tests can be drafted in parallel once helper signatures are defined.

## Risks and Mitigations

- **Risk: no reliable dry-run for some providers.** Mitigation: represent `not_checked` explicitly and avoid claiming availability.
- **Risk: preflight slows common launches.** Mitigation: short timeouts, only run before multi-worker/review swarms or when configured.
- **Risk: launch logic becomes too complex.** Mitigation: keep provider readiness as an input to existing coordination decisions, not a separate planner.
- **Risk: failed review providers are treated as passed.** Mitigation: review-gate helper must make degraded reviewers explicit and require workflow-level acknowledgement.

## Acceptance Criteria for the Implementation

- Provider auth preflight classifies the observed OAuth 403 permission error as unauthorized.
- Unauthorized providers do not trigger endless retries.
- Implementation launch decisions can downgrade or route around unavailable providers before spawning workers.
- Review worker launch decisions expose failed/degraded reviewers instead of silently passing.
- Human-facing launch text includes provider status and repair hints when degraded.
- Tests cover classifier behavior, implementation launch downgrade, and review-gate provider failure.
- `npm test` and `npm run build` pass.
