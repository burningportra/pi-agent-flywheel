# Plan: Teach profiling to find project agent guidance files

## Goal
Fix the profile foundation-gap detector so it recognizes existing project agent guidance files in common locations instead of reporting a missing `AGENTS.md` when one is available. Add regression coverage that profiles a fixture/repo with guidance files and avoids false guidance-gap warnings.

## 1. Architecture Overview

### Current system relationship
- The AgentFlywheel workflow starts with repository profiling, then discovery, selection, planning, bead approval, implementation, and review.
- The profile output currently includes a “Foundation gaps detected” section. In this run it reported `No AGENTS.md found` even though this repository has an `AGENTS.md` loaded by the pi project context at `/Users/kevtrinh/Documents/GitHub/pi-agent-flywheel/AGENTS.md`.
- The likely implementation area is the profiling/scan path behind the `agent_flywheel_profile` / `orch_profile` / `flywheel_profile` tool aliases. Existing project context identifies `src/index.ts` as the extension entrypoint and `src/prompts.ts`, `src/beads.ts`, and `src/tools/*` as important orchestration modules. The implementation phase must inspect the concrete profile implementation before editing.

### Proposed design
Introduce one small, reusable guidance-file detector that is called by the profile/foundation-gap code instead of any single-path or cwd-fragile `AGENTS.md` check.

The detector should:
1. Accept an explicit repository root.
2. Check a prioritized list of supported guidance file locations.
3. Return structured detection results, not just a boolean, so the profile output can explain what was found when needed.
4. Treat missing guidance as a gap only when no supported guidance file exists.

### Supported guidance locations
Initial common locations should include:
- `AGENTS.md` at repository root.
- `.agents.md` at repository root, if the codebase already recognizes lowercase/dotfile variants.
- `CLAUDE.md` at repository root, because many AI-agent projects use it as repository guidance.
- `.github/copilot-instructions.md`, if this project wants to support GitHub Copilot guidance as agent guidance.

Implementation should confirm existing conventions before finalizing the list. If existing code only documents `AGENTS.md`, keep the first patch intentionally minimal: root `AGENTS.md` detection plus path-normalization fix. Additional guidance aliases can be separate beads if broader support is controversial.

### Key decisions and trade-offs
- **Centralize detection** rather than patching profile output inline. This prevents future scan, doctor, and triage tools from drifting.
- **Use synchronous filesystem checks** if the surrounding profile code is already synchronous; otherwise follow the existing async style. Avoid introducing new dependencies.
- **Return evidence paths** for debuggability. A boolean fixes the immediate bug, but structured results help future diagnostics and tests.
- **Avoid claiming a guidance file was read** unless the profile actually consumes it. This bead only concerns foundation-gap detection; loading and injecting guidance content is a separate concern.

## 2. User Workflows

### Existing broken workflow
1. User starts `/agent-flywheel` in a repository that has `AGENTS.md`.
2. Profiling scans the repository.
3. Profile output incorrectly reports `Foundation gaps detected: No AGENTS.md found`.
4. Discovery/planning may treat the repository as lacking agent guidance, creating noise and lower trust.

### Fixed workflow
1. User starts `/agent-flywheel` in a repository that has supported guidance at the repo root.
2. Profiling resolves the intended repository root and calls the shared guidance detector.
3. The detector finds `AGENTS.md` and returns its relative path.
4. The foundation-gap section omits the missing-guidance warning.
5. Optional: profile output may include a positive concise signal such as `Agent guidance: AGENTS.md` if that matches existing output style.

### Workflow with no guidance file
1. User starts `/agent-flywheel` in a repository without supported guidance files.
2. Detector returns no matches.
3. Profile output continues to report a foundation gap recommending an agent guidance file.

### Impact to existing workflows
- No change to the phase order or tool aliases.
- No change to bead planning, approval, implementation, or review behavior.
- The only user-visible change is removal of a false warning when guidance exists, and possibly a more precise warning when it does not.

## 3. Data Model / Types

Add or reuse a small type near the profiling code:

```ts
export interface AgentGuidanceDetection {
  found: boolean;
  files: string[]; // repository-relative paths, prioritized order
  checked: string[]; // repository-relative candidates checked, useful for tests/debug
}
```

If the codebase prefers narrower types, the minimum viable shape is:

```ts
export interface AgentGuidanceDetection {
  path: string | null;
}
```

Potential constants:

```ts
export const AGENT_GUIDANCE_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
] as const;
```

Keep paths relative in public/profile data and convert to absolute paths only internally for filesystem checks.

## 4. API Surface

### New internal function
Preferred signature:

```ts
export function detectAgentGuidanceFiles(repoRoot: string): AgentGuidanceDetection;
```

Behavior:
- Normalizes `repoRoot` with `path.resolve`.
- Checks each candidate with `fs.existsSync`/`statSync` or project-equivalent async calls.
- Counts only regular files.
- Returns repository-relative matches using POSIX-style separators if existing profile output expects stable snapshots.

### Profile integration
Find the profile/foundation-gap builder and replace any inline missing-`AGENTS.md` logic with:

```ts
const guidance = detectAgentGuidanceFiles(repoRoot);
if (!guidance.found) {
  foundationGaps.push('No AGENTS.md found. Consider creating one for agent guidance.');
}
```

If supporting non-`AGENTS.md` guidance aliases, adjust message to avoid mismatch:

```ts
foundationGaps.push('No agent guidance file found. Consider creating AGENTS.md.');
```

### No public CLI/API changes
This is an internal reliability fix for the existing profile tools. Public tool names and workflow phases remain unchanged.

## 5. Testing Strategy

### Unit tests
Add tests for the detector:
- Finds root `AGENTS.md`.
- Finds `CLAUDE.md` or `.github/copilot-instructions.md` only if those are intentionally supported.
- Returns no match when no candidate exists.
- Ignores directories named `AGENTS.md`.
- Handles relative and absolute repo root input.

Use temporary directories from Node/Vitest utilities. Avoid depending on the developer’s actual checkout for unit tests.

### Profile integration regression
Add a regression test around the profile/foundation-gap function:
- Create a temp repo-like directory with `AGENTS.md`.
- Run the profile/foundation-gap builder against that root.
- Assert the output does not include `No AGENTS.md found`.
- Create another temp repo-like directory without guidance.
- Assert the missing-guidance warning still appears.

If the profile tool is difficult to invoke directly, extract the foundation-gap builder into a testable pure/helper function in the same module.

### Existing test suite
Run:

```bash
npm test
npm run build
```

Per repository guidance, both must pass after code changes.

## 6. Edge Cases & Failure Modes

- **Wrong cwd / nested cwd:** Profile may run from a nested directory or from the extension directory. Ensure the detector receives the actual target repo root used by the rest of profiling, not `process.cwd()` unless that is already the established profile root.
- **Symlinks:** If a guidance candidate is a symlink to a file, either accept it if existing `stat` behavior follows symlinks, or document/cover the chosen behavior.
- **Directory named `AGENTS.md`:** Do not count directories as valid guidance files.
- **Permission errors:** Treat inaccessible candidates as not found and avoid crashing the profile. If existing scan code has warning collection, add a non-fatal warning; otherwise silently skip.
- **Multiple guidance files:** Return all matches, but only one is needed to suppress the foundation gap. Prefer deterministic candidate order.
- **Case sensitivity:** Do not add broad case-insensitive matching unless there is repo precedent; it can hide casing problems across platforms.
- **No `AGENTS.md` but `CLAUDE.md` exists:** If alias support is added, update warning wording from `No AGENTS.md found` to `No agent guidance file found` to avoid false negatives.

## 7. File Structure

Implementation must first locate the actual profile/foundation-gap code. Likely files to inspect:
- `src/index.ts` — extension/tool registration and profile entrypoint wiring.
- `src/prompts.ts` — profile/discovery prompt text may include foundation gap wording.
- `src/tools/*` — likely home of individual tool handlers.
- Any files matching profile/scan naming, found via `rg "Foundation gaps|No AGENTS|AGENTS.md|profile" src test`.

Expected modifications:
- Profile implementation file: integrate shared detector.
- New or existing helper module: add `detectAgentGuidanceFiles` and candidate constants.
- Test file near existing Vitest conventions, likely `src/*.test.ts` or `test/*.test.ts`: add detector and profile regression coverage.

Avoid adding new packages or broad rewrites.

## 8. Sequencing

### Bead 1: Locate and characterize current foundation-gap logic
- Use `rg` to find `No AGENTS.md found`, `Foundation gaps`, `AGENTS.md`, and profile builder code.
- Identify the repository root variable used by profile.
- Document whether guidance support should be only root `AGENTS.md` or multiple common guidance files.
- Acceptance: exact code path and integration seam are identified.

### Bead 2: Add guidance detector helper and unit tests
- Implement `detectAgentGuidanceFiles(repoRoot)` near the profile code.
- Add focused Vitest tests using temporary directories.
- Acceptance: detector tests cover found/missing/directory edge cases.

### Bead 3: Wire detector into foundation-gap output with regression test
- Replace inline missing-guidance logic with detector call.
- Add integration regression verifying `AGENTS.md` suppresses false warning.
- Keep missing-guidance warning for repos without guidance.
- Acceptance: regression fails before the fix and passes after.

### Bead 4: Run verification and update docs only if behavior/wording changes
- Run `npm test` and `npm run build`.
- If warning wording changes from `No AGENTS.md found` to `No agent guidance file found`, update any docs/tests that assert old wording.
- Acceptance: build and tests pass; final report includes commands and outputs.

### Parallelization
- Bead 1 must happen first.
- Bead 2 and part of Bead 3 test drafting can be parallelized after the seam is known, but final integration is sequential.
- Bead 4 must happen last.

## Acceptance Criteria
- Profiling a repository with root `AGENTS.md` no longer reports `No AGENTS.md found`.
- Profiling a repository without supported guidance still reports an actionable foundation-gap warning.
- Detection logic is centralized and covered by Vitest tests.
- Tests and TypeScript build pass with `npm test` and `npm run build`.
