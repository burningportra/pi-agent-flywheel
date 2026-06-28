## Review
- Correct: `profileRepo` now captures guidance detection from the explicit repository root (`cwd`) and stores it on the profile (`src/profiler.ts:26-58`, `src/types.ts:2-27`). This avoids relying on `process.cwd()` or the legacy `keyFiles` seam.
- Correct: foundation-gap detection uses the explicit target repo root in the tool path (`buildFoundationGaps(profile, ctx.cwd)` at `src/tools/profile.ts:218-221`) and falls back to captured `profile.agentGuidance` when no repo root is supplied (`src/tools/profile.ts:40-47`). Regression tests cover root `AGENTS.md`, no guidance, stale keyFiles fallback, nested ambient cwd, directory named `AGENTS.md`, and preserving other warnings (`src/tools/profile-continuation.test.ts:33-98`).
- Correct: detector tests verify repository-relative evidence, missing candidates, directory rejection, and relative repo roots (`src/profiler.test.ts:21-78`).
- Fixed: The detector was using `lstatSync`, which would miss an `AGENTS.md` symlink to a real guidance file. Restored `statSync` so paths that resolve to regular files count while directories still do not (`src/profiler.ts:1`, `src/profiler.ts:78-86`), and added symlink regression coverage (`src/profiler.test.ts:55-69`).
- Note: Candidate support is currently root `AGENTS.md` only (`src/profiler.ts:6-8`). That matches the current warning text and acceptance target. If future aliases such as `CLAUDE.md` are added, the warning text should be generalized as the comment notes.
- Note: Unrelated dirty `src/swarm.ts` / `src/swarm.test.ts` change was inspected. It defensively derives a model roster from pane specs and falls back to `cursor-agent` when empty (`src/swarm.ts:219-232`) with coverage (`src/swarm.test.ts:116-126`); I found no blocker there.
- Blocker: None found.

## Commands / evidence
- Agent Mail bootstrap attempted for human_key `/Users/kevtrinh/Documents/GitHub/pi-agent-flywheel`: `Unauthorized`; continued in degraded status.
- Root `/Users/kevtrinh/Documents/GitHub/pi-agent-flywheel/plan.md` and `progress.md` were absent. I inspected the matching plan artifacts under `plans/` and `docs/plans/`.
- `git status --short` showed intentional dirty/untracked files, including `.beads/issues.jsonl`, `src/profiler.ts`, `src/profiler.test.ts`, `src/tools/profile.ts`, `src/tools/profile-continuation.test.ts`, `src/types.ts`, unrelated `src/swarm.ts`/`src/swarm.test.ts`, and untracked plan/artifact/recovery files.
- Recent commits inspected: `4b338a7`, `89ee1c9`, `2a81915`, `f2c2ac1`, `56d83af`.
- `npm test -- src/profiler.test.ts src/tools/profile-continuation.test.ts` — passed, 2 files / 25 tests.
- `npm run build` — passed (`tsc --noEmit`).
- `npm test` — passed, 83 files / 1297 tests.
