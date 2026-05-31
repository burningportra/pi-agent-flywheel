# pi-9rqv — Wire implementation coordination contract

## Summary
- Added `implementationWorkerPrompt(...)` in `src/prompts.ts`, which prepends the centralized `implementationWorkerCoordinationContract(...)` before the bead-specific implementation task section.
- Added `formatImplementationWorkerHandoff(...)` for approval/review implementation handoffs. The handoff targets clear-context pi-subagents using normal repository tools, preserves Agent Mail and bv-first instructions via the centralized contract, and does not require pane launch/tick-loop instructions.
- Updated `src/tools/approve.ts` and `src/tools/review.ts` implementation handoff paths to use the new pi-subagents handoff instead of NTM launch instructions.
- Added focused prompt tests in `src/prompts.test.ts` because the bead verification contract asks for representative prompt assembly/order coverage.
- Inspected `src/deep-plan.ts`; no changes were needed because it is planning-model execution, not the approval/review implementation-worker handoff path.

## Agent Mail status
- Fresh callsign attempted: `SkylineMoth`.
- MCP Agent Mail registration attempt via `macro_start_session` at `http://127.0.0.1:8765/api` returned `{"detail":"Unauthorized"}`.
- Because Agent Mail was unavailable after a bounded attempt, I continued with direct repo/bead tooling and extra care.

## Verification output

### `npm test -- src/prompts.test.ts`
```text
> pi-agent-flywheel@1.3.5 test
> vitest run src/prompts.test.ts


 RUN  v4.1.0 /Users/kevtrinh/Documents/GitHub/pi-agent-flywheel


 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  14:55:00
   Duration  127ms (transform 35ms, setup 0ms, import 44ms, tests 3ms, environment 0ms)
```

### `npm run build`
```text
> pi-agent-flywheel@1.3.5 build
> tsc --noEmit
```

## Notes
- Pre-existing dirty/untracked files were present before this bead work (`.claude/settings.local.json`, `.beads/.br_recovery/*`, `plans/`, and existing `.beads/issues.jsonl` changes from prior beads). I staged only this bead's source/test/artifact files for the code commit.
