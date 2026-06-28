# Peer Reality Review R2

## Review
- Correct: Core gap appears closed. `profileRepo()` now records `agentGuidance` from the explicit profiled `cwd` (`src/profiler.ts:14-28`, `src/profiler.ts:57`), and `buildFoundationGaps()` uses either the explicit target repo root or captured profile evidence instead of ambient `process.cwd()` (`src/tools/profile.ts:40-47`). The profile tool passes `ctx.cwd` into that helper (`src/tools/profile.ts:218-221`).
- Correct: Regression coverage exists for the false warning: target repo with `AGENTS.md` suppresses `- No AGENTS.md found...`, missing repo still warns, nested ambient cwd does not affect the explicit repo root, and a directory named `AGENTS.md` does not count (`src/tools/profile-continuation.test.ts:33-105`). Detector unit tests cover found/missing/directory/relative-root cases (`src/profiler.test.ts:21-65`).
- Correct: Verification passed during this review: `npm run build` exited 0; focused tests `npm test -- src/profiler.test.ts src/tools/profile-continuation.test.ts src/swarm.test.ts` passed 53 tests; full `npm test` passed 83 files / 1296 tests. `git diff --check` produced no whitespace errors.
- Correct: Related bead JSONL shows the intended chain closed: `pi-ahjh` -> `pi-sh0b` -> `pi-d0m9` -> `pi-pbu4`, with `pi-pbu4` as terminal verification. Recent commits also match that sequence: `2a81915`, `89ee1c9`, `4b338a7`.
- Note: Agent Mail bootstrap degraded exactly as instructed: localhost returned `{\"detail\":\"Unauthorized\"}`. Continued review without Agent Mail.
- Note: Requested root `/Users/kevtrinh/Documents/GitHub/pi-agent-flywheel/plan.md` and `progress.md` do not exist. I reviewed the available plan at `plans/teach-profiling-to-find-project-agent-guidance-files-fix-the.md` plus matching docs plan copies instead. No progress file was available.
- Note: `br list --json` returned `total: 0` and `br ready --json` returned `[]`, while `.beads/issues.jsonl` contains the closed relevant beads. `bv --robot-next` reported no actionable items. There are untracked `.beads/.br_recovery/*` files. This does not invalidate the code fix, but bead DB/index health is degraded or out of sync with JSONL evidence.
- Note: The current working tree includes unrelated uncommitted changes in `src/swarm.ts` and `src/swarm.test.ts` (pane-spec fallback). They pass tests, but I found no related bead in the inspected guidance-file plan/chain. Treat these as NO_BEAD for this goal unless another active workstream owns them.

## Vision Checklist
| Area | Status | Evidence |
| --- | --- | --- |
| Agent Mail bootstrap | PARTIAL | Attempted; API returned Unauthorized. |
| Plan/progress inputs | PARTIAL | Root `plan.md`/`progress.md` absent; available plan under `plans/` reviewed. |
| Bead graph for guidance fix | WORKING | Relevant JSONL beads closed with sane dependencies; no actionable items from bv. |
| Bead CLI health | PARTIAL | `br list --json` showed zero issues despite JSONL contents and recovery files. |
| Central guidance detector | WORKING | `detectAgentGuidanceFiles(repoRoot)` checks explicit root and returns structured evidence (`src/profiler.ts:73-94`). |
| Suppress false missing `AGENTS.md` warning | WORKING | Explicit-root and captured-profile paths covered (`src/tools/profile.ts:40-47`; tests at `src/tools/profile-continuation.test.ts:33-58`). |
| Preserve true missing-guidance warning | WORKING | Missing repo and directory cases still warn (`src/tools/profile-continuation.test.ts:60-99`). |
| Wrong/nested cwd regression | WORKING | Test changes cwd to nested dir and still suppresses warning using target root (`src/tools/profile-continuation.test.ts:71-87`). |
| Directory-not-file edge case | WORKING | Detector/foundation tests reject directory named `AGENTS.md`. |
| Symlink guidance edge case | UNPROVEN | Current code uses `lstatSync(...).isFile()` (`src/profiler.ts:80-82`), so symlink-to-file is not covered/accepted. Non-blocking unless symlink guidance should count. |
| Non-AGENTS guidance aliases (`CLAUDE.md`, copilot instructions) | NOT_STARTED | Candidate list is only `AGENTS.md` (`src/profiler.ts:6-8`); plan allowed minimal root-AGENTS implementation if broader aliases are deferred. |
| Full verification | WORKING | `npm run build` and full `npm test` passed in review. |
| Scope cleanliness | PARTIAL | Guidance changes are focused, but swarm changes are unrelated to this goal and appear NO_BEAD. |

## Blockers
- None for the stated core gap: profiling a repo with root `AGENTS.md` should no longer emit the false missing-AGENTS foundation warning, and regression tests/build pass.

## Missing beads/dependencies
- No missing dependency found in the guidance-fix bead chain (`pi-ahjh` -> `pi-sh0b` -> `pi-d0m9` -> `pi-pbu4`).
- Potential NO_BEAD: unrelated `src/swarm.ts` / `src/swarm.test.ts` working-tree changes are not represented in the inspected guidance-file bead chain.

## Completed work broken/incomplete
- I did not find broken completed guidance-file work. The remaining gaps are non-blocking/unproven edges: symlink guidance behavior, broader guidance aliases, and degraded bead CLI/DB state.
