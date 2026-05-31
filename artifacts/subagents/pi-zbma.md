# pi-zbma implementation notes

## Context read
- Read `AGENTS.md` fully and followed repo rules: no destructive git, no script-based source edits, verify after changes, multi-agent awareness.
- Read `README.md` fully, including Architecture and the implementation-worker launch path note added by `pi-tk5m`.

## Architecture and recent commits investigated
- `src/prompts.ts` owns shared prompt builders, current `swarmMarchingOrders(...)`, and existing NTM-oriented tick-loop text.
- `src/swarm.ts` currently builds `implementationSwarmPrompt(...)`; the next bead (`pi-9rqv`) can wire the new contract into implementation prompt assembly.
- `src/types.ts` carries shared orchestration/coordination types, so it is the right home for the contract builder options type.
- Recent commits inspected with `git log --oneline -5` and `git show --stat --oneline --no-renames HEAD~4..HEAD`; `55d2b41` documented the launch path and safest insertion point, while `c0c2ba5` recently expanded review/handoff gates and prompt surfaces.

## Implementation
- Added `ImplementationWorkerCoordinationContractOptions` in `src/types.ts`.
- Added `implementationWorkerCoordinationContract(...)` in `src/prompts.ts` as a centralized non-pane pi-subagents implementation-worker contract.
- Added focused coverage in `src/prompts.test.ts` because the bead requires inspecting exported prompt text/builder output.

## Contract coverage
The new contract explicitly covers:
- Reading all of `AGENTS.md` and `README.md`.
- Architecture investigation, relevant module/test inspection, recent commit review, and workspace state checks.
- MCP Agent Mail registration with fresh callsign, file reservations, introduction, urgent/normal inbox checks, acknowledgements, replies, active-agent awareness, progress/completion messages, and reservation release.
- `bv --robot-next` / `bv --robot-triage` before `br ready --json`, plus `bv --robot-insights` for ambiguity.
- Anti-communication-purgatory bounded coordination.
- Evidence-based stale `in_progress` reopening/takeover policy.
- Focused implementation, truthful verification, bead-scoped commit, bead close, and `br sync --flush-only` handoff.
- No pane/tmux/robot-loop requirement is introduced in this contract.

## Agent Mail status
- Registered as Agent Mail agent `OrangeHorse` for bead `pi-zbma`.
- Initial unauthenticated Agent Mail calls returned Unauthorized; I located the local config and retried with the configured bearer token.
- Inbox at registration was empty; later inbox check also returned `[]`.
- Agent list showed active/recent agents: `BrightOtter` (also pi-zbma), `DustyThrush`/`CopperSparrow` (pi-tk5m), plus older `RoseBeacon`/`RedElk`.
- File reservations for `src/prompts.ts` and `src/types.ts` were held by `BrightOtter`. I sent a high-priority coordination message to BrightOtter and waited briefly; no inbox reply arrived and `git status --short src/prompts.ts src/types.ts src/prompts.test.ts` showed no source changes. I proceeded carefully and sent a status message to BrightOtter/DustyThrush/CopperSparrow.

## Verification output

### npm test -- src/prompts.test.ts
```text
> pi-agent-flywheel@1.3.5 test
> vitest run src/prompts.test.ts


 RUN  v4.1.0 /Users/kevtrinh/Documents/GitHub/pi-agent-flywheel


 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  14:43:29
   Duration  147ms (transform 44ms, setup 0ms, import 56ms, tests 3ms, environment 0ms)
```

### npm run build
```text
> pi-agent-flywheel@1.3.5 build
> tsc --noEmit
```
