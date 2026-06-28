## Review

- Correct: Guidance detection is now easy to follow from the profile scan path: `profileRepo` records `agentGuidance` immediately after collecting raw repo signals (`src/profiler.ts:26-27`) and includes it in `RepoProfile` (`src/profiler.ts:57`, `src/types.ts:26-27`).
- Correct: The user-visible foundation-gap check uses the explicit target repo root, not ambient `process.cwd()`: `registerProfileTool` calls `buildFoundationGaps(profile, ctx.cwd)` (`src/tools/profile.ts:218-221`), and `buildFoundationGaps` calls `detectAgentGuidanceFiles(repoRoot)` when a root is supplied (`src/tools/profile.ts:40-47`).
- Correct: Regression coverage is readable and targets the important maintainer questions: root `AGENTS.md` suppresses the warning, stale `keyFiles` evidence is not trusted when a target root is provided, nested ambient cwd does not matter, directories named `AGENTS.md` do not count, and other warnings are preserved (`src/tools/profile-continuation.test.ts:33-100`). Detector unit tests cover found/missing/directory/relative-root behavior (`src/profiler.test.ts:21-65`).
- Fixed: Added two clarifying comments in `src/profiler.ts`: the candidate list is explicitly called the central list for supported project-level guidance files, and the detector comment now says it records file presence only and does not load guidance contents (`src/profiler.ts:6-8`, `src/profiler.ts:64-71`). This should help a new maintainer understand why `agentGuidance` is evidence for the foundation warning rather than prompt content injection.
- Blocker: None found.
- Note: Requested root files `plan.md` and `progress.md` were absent. I reviewed the matching plan artifacts instead: `plans/teach-profiling-to-find-project-agent-guidance-files-fix-the.md` and the two `docs/plans/2026-06-01-teach-profiling-to-find-project-agent-guidance-files-fix-the-*.md` files. No `progress.md` was found anywhere under the repo.
- Note: The candidate list currently supports only root `AGENTS.md` (`src/profiler.ts:6-8`). That aligns with the plan’s intentionally minimal fallback if broader aliases are controversial, and the new comment points maintainers to update warning wording if aliases are added later.
- Note: The detector uses `lstatSync(...).isFile()` (`src/profiler.ts:78-82`), so symlinked `AGENTS.md` paths are not counted. The comments now describe regular file presence; if symlinked guidance should be accepted, this should be an explicit follow-up with a test.

## Commands

- Agent Mail bootstrap: `curl -s -i -X POST http://127.0.0.1:8765/api ... macro_start_session ...` → `401 Unauthorized`; degraded and continued.
- `git status --short` → dirty/untracked workspace confirmed; no pull/rebase attempted.
- `npm test -- src/profiler.test.ts src/tools/profile-continuation.test.ts` → passed, 2 files / 24 tests.
- `npm run build` → passed (`tsc --noEmit`).

## Agent Mail status

- Degraded: bootstrap returned `HTTP/1.1 401 Unauthorized` with `{"detail":"Unauthorized"}`.
