## pi-subagents Implementation Coordination Contract

You are an AgentFlywheel implementation worker using normal repository tools directly in this checkout. This is a clear-context pi worker fallback because the interactive subagent launch surface failed twice before creating a session file. Coordinate through beads and MCP Agent Mail where available; do not run pane/tmux robot loops.

Repository: /Users/kevtrinh/Documents/GitHub/pi-agent-flywheel
Ready bead candidates: pi-ule5
Assigned bead: pi-ule5. Inspect it with `br show pi-ule5` and claim/keep it `in_progress` before editing.
Already completed in this run: pi-jp4p. Do not reopen or duplicate those beads.

### 1. Context-first onboarding
- Read ALL of AGENTS.md and README.md carefully before editing, then follow the repo-local instructions they contain.
- Investigate the code architecture before changing files: inspect relevant modules, tests, package scripts, and the launch/review path touched by your bead.
- Review recent commits with git history and check current workspace state so you understand active changes and avoid overwriting other agents.

### 2. MCP Agent Mail coordination
- Register with MCP Agent Mail at the start using a fresh callsign, reserve the bead's file scope when possible, and introduce yourself on thread `pi-ule5` or `general`.
- If Agent Mail returns Unauthorized/unreachable/unhealthy after a bounded attempt, record degraded status in your report and continue carefully.

### 3. Bead tracking
- Inspect `br show pi-ule5`, keep changes within its `### Files:` scope unless a focused test file is necessary.
- Close only after the bead verification contract passes, then run `br sync --flush-only`.

### 4. Implementation and verification
- Implement bead `pi-ule5` from its description, acceptance criteria, and file scope.
- Add or adjust focused tests to prove the acceptance criteria.
- Run the exact verification command: `npm test -- src/tools/approve.test.ts src/coordination.test.ts src/agent-mail.test.ts src/swarm.test.ts && npm run build`.
- Do a fresh-eyes self-review of modified files.
- Commit only your bead changes with message `bead pi-ule5: <summary>` if verification passes.
- Mark the bead closed with `br update pi-ule5 --status closed` and `br sync --flush-only` after verification passes.
- Final report must include bead id, commit hash, changed files, exact verification output, Agent Mail status, and blockers.

### Source Research Card
Source Research Card: not required because this bead changes local orchestration/coordination logic and tests; no external API/library/service contract integration is required beyond inspecting local Agent Mail and subagent tool assumptions in existing code.

If there is no safe path due to conflicting shared checkout changes, report that with evidence and exit. Do not wait idle.
