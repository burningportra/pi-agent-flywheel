# pi-0srl — Coordination prompt regression tests

## Summary
- Read `AGENTS.md` and `README.md` before changing code.
- Reviewed recent commits `2ac8ade` (centralized pi-subagents coordination contract) and `8e70884` (wired clear-context pi-subagent handoff through approval/review implementation paths).
- Added focused regression coverage in `src/_verify-implementation-coordination.test.ts` for:
  - MCP Agent Mail registration, fresh callsign, inbox acknowledgement, file reservations, progress/completion messaging.
  - bv-first prioritization (`bv --robot-next` / `bv --robot-triage`) before `br ready --json` fallback.
  - anti-communication-purgatory / bounded coordination guidance.
  - evidence-based stale `in_progress` bead policy and non-disruption of active work.
  - coordination contract ordering before bead-specific task text.
  - representative handoff assembly via `formatImplementationWorkerHandoff(...)`.
  - no NTM worker pane / `NTM Tick Loop` / `ntm --` launch requirement in pi-subagents handoffs.
- Updated stale test expectations in `src/tools/approve.test.ts` and `src/swarm-forecast-report.test.ts` to match the current `pi-subagents` implementation handoff path from bead `pi-9rqv`.

## Coordination
- Intended Agent Mail callsign: CopperLark.
- MCP Agent Mail registration attempts against `http://127.0.0.1:8765/api` returned `{"detail":"Unauthorized"}` for both the current repo path and the older `/Users/kevtrinh/Code/pi-agent-flywheel` human key, so no Agent Mail session was established and no inbox messages could be acknowledged.
- `bv --robot-next` identified `pi-0srl` as the current in-progress P1 item.
- Checked `br list --json`; only `pi-0srl` was `in_progress`, so no clearly stalled active beads were disrupted.

## Verification
- `npm test -- src/_verify-implementation-coordination.test.ts` passed: 1 file, 4 tests.
- `npm test -- src/_verify-implementation-coordination.test.ts src/tools/approve.test.ts src/swarm-forecast-report.test.ts` passed: 3 files, 70 tests.
- `npm run build` passed (`tsc --noEmit`).
- `npm test` passed: 82 files, 1288 tests.

## Bead state
- `pi-0srl` was claimed with `br update pi-0srl --status in_progress`.
- `pi-0srl` was closed with `br update pi-0srl --status closed`.
- `br sync --flush-only` was run after closing; output: `Nothing to export (no dirty issues)`.
