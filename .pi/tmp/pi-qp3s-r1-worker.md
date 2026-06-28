You are the implementation worker for bead pi-qp3s in /Users/kevtrinh/Documents/GitHub/pi-agent-flywheel.

Bead: Document and verify workflow status recovery end-to-end

Current review revision instructions:
Return the current bead status, acceptance criteria, and next implementation steps so the orchestrator can continue from the in-progress state. Then complete the bead if needed.

Acceptance criteria:
- README status section mentions `flywheel_status` and `/flywheel-status --json` as recovery surfaces after reload or compaction.
- Docs clarify that status is read-only and suggests the returned `next_action` as the safe resume path.
- Full test suite passes.
- TypeScript build passes.

Expected files for this bead:
- README.md
- src/workflow-status.test.ts
- src/tools/status.test.ts
- src/commands.status.test.ts

Important repo rules:
- Do not delete files.
- Do not run destructive git commands (`git reset --hard`, `git clean -fd`, `rm -rf`).
- Do not overwrite unrelated dirty work; inspect git status/diff first.
- Make only the minimal changes needed for pi-qp3s.
- Use br/bv if needed; bead is already in_progress.
- Coordinate via Agent Mail if available and reserve the expected files before editing.

Implementation steps:
1. Inspect `br show pi-qp3s`, `git status --short`, and diffs for the expected files.
2. Determine what is already implemented vs missing for the acceptance criteria.
3. If README/test updates are missing or inconsistent, implement them.
4. Run `npm test && npm run build`.
5. If verification passes, close bead pi-qp3s with `br update pi-qp3s --status closed` and run `br sync --flush-only`.
6. If verification fails, leave the bead in_progress and report exact failures.

Final response format:
- Status: closed|in_progress
- Summary of changes
- Verification commands and result
- Any remaining blockers
