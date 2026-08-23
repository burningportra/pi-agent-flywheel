# pi-agent-flywheel

<div align="center">

```text
        ┌────────────────────────────────────────────────────────────┐
        │                    pi-agent-flywheel                       │
        │  scan → choose → plan → approve → implement → review → learn │
        └────────────────────────────────────────────────────────────┘
```

[![CI](https://github.com/burningportra/pi-agent-flywheel/actions/workflows/ci.yml/badge.svg)](https://github.com/burningportra/pi-agent-flywheel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub issues](https://img.shields.io/github/issues/burningportra/pi-agent-flywheel)](https://github.com/burningportra/pi-agent-flywheel/issues)
[![GitHub stars](https://img.shields.io/github/stars/burningportra/pi-agent-flywheel)](https://github.com/burningportra/pi-agent-flywheel/stargazers)

**A pi extension that turns a vague improvement goal into dependency-tracked beads, parallel agent execution, review gates, and durable learnings.**

Inspired by the **Agentic Coding Flywheel** invented by [Dicklesworthstone](https://github.com/Dicklesworthstone). This extension is an implementation/adaptation of that loop for `pi`, not the origin of the idea.

### Quick Install

```bash
pi install git:github.com/burningportra/pi-agent-flywheel
```

Then open any repository in `pi` and type:

```text
/agent-flywheel
```

</div>

---

## TL;DR

**The Problem:** Coding agents are good at individual edits, but large repo improvements still fall apart in the gaps: weak discovery, vague plans, parallel agents stepping on each other, review theater, and forgotten lessons.

**The Solution:** `pi-agent-flywheel` wraps the full loop in one pi command. It profiles the repo, proposes work, turns the selected goal into beads, coordinates implementation, runs reviews and compliance audits, and records memory for the next run.

### Why Use pi-agent-flywheel?

| Feature | What It Does | Example |
|---------|--------------|---------|
| **One-command flywheel** | Runs discovery, planning, approval, execution, review, and memory from `/agent-flywheel` | Start in any repo, choose an improvement, approve beads, let agents work |
| **Bead-based execution** | Converts plans into `br` tasks with dependencies and acceptance criteria | `add-users-endpoint` depends on `extract-user-service` |
| **Multi-model planning** | Lets multiple models propose plans, then synthesizes the strongest path | Gemini + GPT + Claude-style planning lanes when available |
| **Dueling Idea Wizards** | Launches interactive wizard sub-agents, then scores competing improvement ideas on a 0–1000 scale with rebuttals and blind-spot probes | Pick the most leveraged improvement before writing code |
| **Custom-goal brainstorming** | For user-entered goals, asks clarifying questions, compares approaches, and saves a deterministic decision record under `brainstorming/` | Adapt a Superpowers-style brainstorming process without changing generated-idea discovery |
| **Review gates** | Auto-decides review-agent passes, then runs fresh-eyes, polish, ergonomics, reality-check, and bead-compliance flows | Closed beads are treated as claims that require evidence |
| **Crash recovery** | Checkpoints state after phase changes so interrupted runs can resume | Restart `/agent-flywheel` and resume from the latest checkpoint |
| **Graceful degradation** | Optional tools (`ccc`, CASS, MCP Agent Mail, beads, `ntm`) improve the loop but are not mandatory | Missing `ccc` falls back to the built-in profiler |

### Recommended “Runs Nicely” Stack

`pi-agent-flywheel` can limp along with only `pi`, Node, and git, but the intended flywheel experience assumes three coordination primitives are available:

| Tooling | Why It Matters |
|---------|----------------|
| **Beads (`br` + `bv`)** | Turns plans into dependency-tracked work items and picks the next safe bead instead of relying on a giant free-form prompt |
| **MCP Agent Mail** | Gives parallel agents identities, inboxes, file reservations, and coordination threads so they do not silently overwrite each other |
| **`ntm`** | Launches/tends multi-agent panes and makes swarm execution observable instead of “hope the background agents are fine” |

Without these, `/agent-flywheel` is still useful for scanning, planning, and review. With them, it becomes the actual multi-agent flywheel.

---

## Quick Example

```bash
# 1. Install the extension once
pi install git:github.com/burningportra/pi-agent-flywheel

# 2. Open a project you want agents to improve
cd ~/Code/my-app
pi

# 3. Start the flywheel
/agent-flywheel

# 4. Or skip discovery and give it a goal directly
/agent-flywheel reduce flaky auth tests and add regression coverage

# 5. Check progress during a run or recover after reload/compaction
/flywheel-status

# 6. Before a release handoff, inspect versions, dirty scope, and recommended checks
/flywheel-release-checklist

# 7. If something gets stuck, inspect prerequisites and runtime state
/agent-flywheel-doctor

# 8. Stop active orchestration if you need to take over manually
/agent-flywheel-stop
```

Typical flow:

```text
You: /agent-flywheel

→ Choose: profile this repo, research an external repo, or load a saved plan
→ Scan: ccc first when available, built-in profiler otherwise
→ Discover: 3–7 ranked improvement ideas, optionally via interactive Dueling Idea Wizard sub-agents
→ Select: pick an idea or type your own goal
→ Brainstorm: custom goals are clarified, approach-selected, and saved as a decision record; generated ideas skip this step
→ Plan: create beads with dependencies and acceptance criteria
→ Approve: refine the bead plan before any implementation starts
→ Execute: implement ready beads in dependency order
→ Review: run guided review gates and remediation loops
→ Audit: verify closed beads against evidence, not vibes
→ Learn: save useful session memory for the next flywheel
```

---

## Design Philosophy

1. **Human approval before expensive autonomy**  
   Agents can propose a plan, but implementation waits until the bead graph is readable, scoped, and approved.

2. **Tasks are contracts, not vibes**  
   A bead should include the rationale, acceptance criteria, and file scope needed by a fresh agent. Template shorthand is rejected before it can leak into execution.

3. **Optional power tools, safe fallback path**  
   `ccc`, CASS, `br`, `bv`, `ntm`, and agent-mail can make the loop stronger, but the extension keeps moving when optional integrations are absent.

4. **Parallelism needs coordination**  
   Multi-agent work is only useful when file ownership, task dependencies, review order, and recovery paths are explicit.

5. **Review should create evidence**  
   The final audit treats “done” as a claim. The extension asks for evidence packs, checks scope drift, and pushes remediation when claims do not match the diff.

### Bead verification contracts

Every implementation bead should include a `### Verification:` section before `### Files:`. Treat it as a small contract between the planner, implementer, and reviewer:

- **Commands/checks** — the exact command(s), inspection steps, or manual checks to perform.
- **Success expectations** — what passing output, status, or behavior looks like.
- **Manual proof fallback** — what evidence is acceptable if automation cannot cover the work or cannot run in the local environment.

Good contract:

```markdown
### Verification:
- Commands/checks: run npm test -- src/bead-review.test.ts and npm run build.
- Success looks like: the focused tests pass, TypeScript compiles, and both commands exit 0.
- Manual proof fallback: if the commands cannot run, capture the exact blocker and manually inspect the changed review prompt and test assertions.

### Files:
- src/bead-review.ts
- src/bead-review.test.ts
```

Bad contract — too vague and missing the manual fallback:

```markdown
### Verification:
- Run tests.
- Success looks like: everything works.
```

Review evidence must match the same contract. For the good contract above, this is acceptable:

```text
Verified:
- npm test -- src/bead-review.test.ts passed.
- npm run build passed.
```

This is not acceptable because it is too generic for a contract that named exact commands:

```text
All tests passed. Looks good.
```

### Structured bead mutation approval

AgentFlywheel planning now treats bead creation as a staged mutation plan instead of a planner-authored shell script. Planners return structured JSON with bead `localId`s, descriptions, verification contracts, file lists, and dependency edges. The approval flow validates that data before writing `.beads/`, then applies the transaction through one controlled mutation path.

Validation catches the common failure modes before implementation starts:

- dependency cycles or duplicate/self dependency edges
- dependencies that point at missing bead references
- unresolved template placeholders such as `{{featureName}}`
- final bead text that still says `Use template:` or `see template`
- missing `### Verification:` or `### Files:` sections

If validation fails, fix the staged plan rather than manually patching `.beads/`: expand template text fully, add the missing verification/files sections, correct the local IDs in dependency edges, and split or reorder beads to remove cycles.

### Implementation-time fresh-eyes review

During implementation, AgentFlywheel can run a separate fresh-eyes reviewer instead of waiting until the end of the whole run. The monitor records the git baseline when implementation starts, checks progress on a 7-minute cadence, and launches a full review only after 5 new commits since the last baseline or previous fresh-eyes review. After a launch, the baseline advances to the reviewed head so the same commit range is not reviewed twice.

The reviewer coordinates through MCP Agent Mail on the current bead thread when the bead id is safe to use as a thread id. Its prompt includes the bead context, baseline/head refs, commit count, full-review scope, severity guidance, and instructions to report actionable findings without duplicating the implementer's work. Actionable findings are appended to the current bead under `## Fresh-Eyes Review Findings` with an idempotency marker such as `<!-- fresh-eyes-review:<key> -->`; clean-pass notes or low-signal comments do not create noisy bead churn.

Examples:

```text
Append: HIGH: src/tools/review.ts drops reviewer severity metadata.
Evidence: appendFreshEyesReviewToBead receives the whole raw log, so later agents cannot tell what is actionable.
Action: parse reviewer output before appending and include severity, evidence, files, and fix guidance.
```

```text
Do not append as a finding: LGTM overall, no actionable findings.
```

Troubleshooting:

- **Reviewer never launches:** confirm at least 5 new commits exist since the implementation baseline or previous fresh-eyes review, and that at least 7 minutes elapsed since the last monitor check.
- **No findings appear:** a clean pass or low-signal response is summarized as no actionable findings rather than appending noise.
- **Agent Mail or launch is unavailable:** the workflow records a degraded fresh-eyes status and keeps implementation moving.
- **The bead is not updated:** inspect the append warning, current bead id, and `## Fresh-Eyes Review Findings` marker; duplicate markers intentionally suppress repeat appends for the same reviewer/head/thread key.

---

## How pi-agent-flywheel Compares

| Capability | pi-agent-flywheel | Plain pi session | Manual `br`/`bv` workflow | Generic coding agent |
|------------|-------------------|------------------|----------------------------|----------------------|
| Repo discovery | ✅ Guided profiling + optional `ccc` | ⚠️ Manual prompts | ⚠️ Manual | ⚠️ Usually ad hoc |
| Idea ranking | ✅ Ranked proposals + Dueling Idea Wizards | ❌ | ❌ | ❌ |
| Dependency-tracked tasks | ✅ Creates and validates beads | ❌ | ✅ Manual | ❌ |
| Approval gate before implementation | ✅ Built in | ⚠️ You must enforce it | ✅ If disciplined | ❌ |
| Parallel execution support | ✅ Worktrees, swarm status, coordination hooks | ⚠️ Manual | ⚠️ Manual | ⚠️ Often unsafe |
| Review gates | ✅ Multi-role review + compliance audit | ⚠️ Prompt manually | ⚠️ Manual | ⚠️ Varies |
| Crash recovery | ✅ Checkpointed phases | ⚠️ Session history only | ❌ | ⚠️ Varies |
| Memory integration | ✅ CASS/MemPalace-style hooks when available | ⚠️ Manual | ❌ | ⚠️ Varies |
| Best for | Repo improvement loops | Single interactive tasks | Teams already fluent in beads | Small isolated edits |

**Use pi-agent-flywheel when:**

- You have a repo-level improvement goal, not a single obvious edit.
- You want agents to split work into reviewable tasks before coding.
- You need parallel work but do not want agents colliding blindly.
- You care about post-implementation review and completion evidence.

**Use something simpler when:**

- You already know the exact one-line change.
- You do not want any task-tracker state in the repository.
- You are working in a repo where agents must never create worktrees or run local commands.

---

## Installation

### 1. Install from GitHub with pi (recommended)

```bash
pi install git:github.com/burningportra/pi-agent-flywheel
```

Verify it loaded:

```bash
pi list | grep pi-agent-flywheel
```

Open any project and run the preferred status command:

```text
/flywheel-status
```

Expected idle-state output is a phase/status summary rather than a missing-command error. Older installs may also expose `/agent-flywheel-status` as a legacy alias.

### 2. Install from a local checkout

```bash
git clone https://github.com/burningportra/pi-agent-flywheel.git
cd pi-agent-flywheel
npm install
npm run build
pi install .
```

This is the best path if you want to edit the extension and keep using your local copy.

### 3. Load temporarily for development

```bash
git clone https://github.com/burningportra/pi-agent-flywheel.git
cd pi-agent-flywheel
npm install
pi -e ./src/index.ts
```

This loads the extension for that `pi` session only.

### 4. Project-local install for a team repo

```bash
cd ~/Code/team-project
pi install -l git:github.com/burningportra/pi-agent-flywheel
```

`-l` writes to `.pi/settings.json`, so the project can declare the package for everyone who opens it with pi.

---

## Prerequisites

| Requirement | Version | Required? | Why |
|-------------|---------|-----------|-----|
| [`pi`](https://github.com/badlogic/pi-mono) | Latest | Yes | Runtime that loads the extension |
| Node.js | ≥ 18 | Yes for development/local install | TypeScript extension dependencies |
| git | ≥ 2.20 | Yes | Worktree support and repo inspection |
| `br` | Current | Strongly recommended | Bead/task creation and dependency tracking |
| `bv` | Current | Strongly recommended | Graph-aware next-bead selection |
| MCP Agent Mail | Current | Strongly recommended for swarms | Agent identities, inboxes, file reservations, coordination threads |
| `ntm` | Current | Strongly recommended for swarms | Launching, tending, and observing parallel agents |
| [`ccc`](https://github.com/cocoindex-io/cocoindex-code) | Current | Optional | Richer codebase scanning |
| CASS `cm` | Current | Optional | Procedural memory retrieval/storage |

If strongly recommended tools are missing, `/agent-flywheel` can still help with discovery/planning/review, but the full multi-agent execution loop is much smoother with beads, MCP Agent Mail, and `ntm` installed.

---

## Quick Start

### Profile this repo and choose from generated ideas

```bash
cd ~/Code/my-project
pi
```

Inside pi:

```text
/agent-flywheel
```

Then follow the prompts:

1. Choose “profile this repo”.
2. Review ranked improvement ideas.
3. Pick one or type a custom goal.
4. If you type a custom goal, answer the brainstorming prompts and choose an approach.
5. Choose standard or deep planning.
6. Review and refine proposed beads.
7. Approve implementation.
8. Use status/doctor/stop commands as needed.

### Plan a specific goal directly

```text
/agent-flywheel add an admin audit log for user role changes
```

### Research an external repository for ideas

```text
/agent-flywheel-research https://github.com/example/inspiring-project
```

This is useful when you want to adapt patterns from another codebase into the current project.

### Custom-goal brainstorming

When you type a custom goal, AgentFlywheel runs a bounded brainstorming pass before planning: it asks clarifying questions one at a time, proposes a few approaches, and formats a deterministic decision record under `brainstorming/<goal-slug>-decision.md`. This applies only to custom goals. Generated/scored ideas skip brainstorming so discovery remains fast, and the record is not stored under `plans/`, not written to CASS or MemPalace, and not treated as a replacement for plan generation.

If the brainstorming model call, user interaction, or artifact write degrades, AgentFlywheel keeps moving: malformed output falls back where possible, skip/cancel uses the original goal, and artifact write failures return the enriched goal with a warning.

See [Custom-goal brainstorming](docs/brainstorming.md) for the exact scope and degraded paths.

---

## Command Reference

### `/agent-flywheel`

Start the full scan → plan → implement → review loop.

```text
/agent-flywheel
```

Use this when you want the extension to discover improvement ideas first.

### `/agent-flywheel [goal]`

Skip idea discovery and plan against a specific goal.

```text
/agent-flywheel make the checkout flow resilient to Stripe webhook retries
```

### `/agent-flywheel-research <github-url>`

Research an external repository and adapt useful ideas into the current project.

```text
/agent-flywheel-research https://github.com/charmbracelet/bubbletea
```

### `/flywheel-status` (preferred) and `/agent-flywheel-status` (legacy alias)

Show the current orchestration phase and progress without changing checkpoints, beads, or orchestration state. Use this read-only surface first after reload, context compaction, or handoff:

- `flywheel_status` tool for tool-driven recovery
- `/flywheel-status --json` for slash-command recovery

```text
/flywheel-status
/flywheel-status --json
```

Treat the returned `next_action` as the safe resume path before issuing additional workflow commands. The human-readable command is useful for a quick live check; prefer `flywheel_status` or `/flywheel-status --json` when another agent needs stable fields.

Compact recovery example:

```json
{
  "contract_version": 1,
  "phase": "implementing",
  "selected_goal": "Ship workflow status recovery",
  "approval_state": "approved",
  "beads": {
    "total": 2,
    "open": 1,
    "in_progress": 1,
    "closed": 0,
    "deferred": 0,
    "current": [{ "id": "pi-123", "title": "Wire status command", "status": "in_progress", "priority": 1, "type": "feature", "updated_at": "2026-06-01T00:00:00Z" }],
    "pending": [{ "id": "pi-124", "title": "Document status recovery", "status": "open", "priority": 2, "type": "task", "updated_at": "2026-06-01T00:05:00Z" }]
  },
  "next_action": "Continue the current bead pi-123, then run the configured verification.",
  "resume_prompt": "Resume AgentFlywheel from the implementing phase...",
  "confidence": "high",
  "inferred_from": ["persisted phase implementing", "in-progress bead pi-123"]
}
```

#### Compaction-aware recovery

When the installed Pi runtime exposes session compaction lifecycle events, AgentFlywheel records lightweight recovery context from `session_before_compact` and `session_compact`. This context is observation-only: it is persisted for `flywheel_status`, can appear in the JSON status as `compaction.latest` and `compaction.recent`, and does not advance phases, create beads, launch workers, or block the core workflow.

Compaction metadata is best-effort. Older Pi installs, unsupported lifecycle hooks, or compacted sessions without reason fields may omit the `compaction` block, report `reason: "unknown"`, or omit `will_retry` in JSON output. Human-readable guidance may describe that missing retry metadata as unreported. Treat missing metadata as context absence, not as a hard failure and not as proof that retry is false. Continue from the normal status contract.

Use this recovery order after any reload or compaction:

1. Inspect AgentFlywheel status with `flywheel_status` or `/flywheel-status --json`.
2. Re-read project instructions such as `AGENTS.md` if the compacted transcript no longer contains the current rules.
3. Inspect bead status and the worktree before repeating commands that mutate files, tasks, network state, or external systems.
4. Continue the reported `next_action`, including required phase tools such as approval or review instead of skipping ahead.

Known compaction reasons are surfaced as guidance:

| Reason | Meaning | Recovery note |
|--------|---------|---------------|
| `manual` | A user or operator requested compaction. | Resume from status and re-read project instructions if needed. |
| `threshold` | Pi compacted automatically after reaching a context threshold; aliases such as `auto` may normalize here. | Rehydrate repo rules, bead state, and recent file state before editing. |
| `overflow_retry` | Pi compacted during overflow recovery and may retry the interrupted request. | Treat duplicate side-effect risk as high until bead status and file state are checked. |
| `unknown` with `raw_reason` | Pi reported a future or unrecognized reason. | Preserve the raw reason for debugging and recover conservatively from durable workflow state. |

If `will_retry` is `true`, Pi may retry the interrupted request. Do not repeat bead creation, file edits, launches, network calls, or other side effects until you have checked `flywheel_status`, `br show`/`br list`, and `git status --short`. If `will_retry` is absent, do not treat the missing field as `false`; older or partial metadata simply means AgentFlywheel cannot tell whether retry will happen.

### `/agent-flywheel-doctor`

Run a read-only diagnostic for runtime prerequisites and common failure points.

```text
/agent-flywheel-doctor
```

Checks include git, Node, `br`/`bv`, `ntm`, CASS `cm`, agent-mail, checkpoints, orphaned worktrees, and provider preflight readiness. Doctor/triage remain read-only: they report provider readiness as `not_checked` unless launch-time probes have run. If a worker launch reports unauthorized provider evidence such as OAuth 403, 401, or `Unauthorized`, repair OAuth/API-key/account/org permissions, switch provider/model, retry after repair, or downgrade worker count/parallelism instead of retrying endlessly.

### `/agent-flywheel-release-checklist`

Prepare a read-only release/version handoff checklist.

```text
/agent-flywheel-release-checklist
```

Use this before tagging, publishing, or handing a release to another agent. It checks `package.json`/`package-lock.json` version consistency, summarizes dirty-file scope, and recommends copy/paste-ready build, test, and UBS commands. It never commits, tags, publishes, bumps versions, resets, cleans, or mutates files.

### `/agent-flywheel-stop`

Cancel an active run and clean up active orchestration state.

```text
/agent-flywheel-stop
```

### `/agent-flywheel-cleanup`

Safely remove orphaned worktrees left by interrupted runs.

```text
/agent-flywheel-cleanup
```

### `/agent-flywheel-audit-beads`

Start a bead compliance audit against closed beads.

```text
/agent-flywheel-audit-beads
```

Use this when you want to verify that completed beads actually match the implementation evidence.

### `/agent-flywheel-swarm-status`

Show active swarm health.

```text
/agent-flywheel-swarm-status
```

### `/agent-flywheel-swarm-stop`

Stop swarm monitoring and print landing guidance.

```text
/agent-flywheel-swarm-stop
```

### Compatibility aliases

`/flywheel*` and `/agent-flywheel*` are both supported. The former `/orchestrate*` commands have been removed — use `/flywheel*` or `/agent-flywheel*` instead.

### Tool names exposed to pi

Preferred tool names use the `agent_flywheel_*` prefix:

| Tool | Purpose |
|------|---------|
| `agent_flywheel_profile` | Build or refresh repo profile context |
| `agent_flywheel_discover` | Generate improvement ideas |
| `agent_flywheel_select` | Select or refine the chosen goal |
| `agent_flywheel_plan` | Create a bead-based implementation plan |
| `agent_flywheel_approve_beads` | Approve/refine beads before execution |
| `agent_flywheel_review` | Review implemented work |
| `agent_flywheel_memory` | Retrieve/store memory context |
| `agent_flywheel_verify_beads` | Validate bead hygiene and completion state |
| `agent_flywheel_audit_beads` | Run completion compliance audit |

Legacy `orch_*` and `flywheel_*` tool aliases remain for compatibility.

---

## Configuration

Most configuration is discovered from your repo and pi settings. A typical project-local setup looks like this:

```jsonc
// .pi/settings.json
{
  "packages": [
    "git:github.com/burningportra/pi-agent-flywheel"
  ]
}
```

Optional model/provider configuration lives in pi itself. In pi, run:

```text
/models
```

Then choose available models during deep planning.

### Optional integration setup

#### ccc codebase scanning

```bash
pipx install cocoindex-code
cd ~/Code/my-project
ccc init -f
ccc index
```

#### CASS memory

```bash
npm install -g cass-memory
cm init --starter typescript
cm doctor --json
```

#### Beads and graph-aware routing

```bash
br list --json
bv --robot-next     # PREFERRED (graph-aware)
bv --robot-triage    # PREFERRED for swarms
br ready --json      # fallback only
bv --robot-insights
```

See [`docs/setup.md`](docs/setup.md) for more detailed setup notes.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                           pi command layer                            │
│ /agent-flywheel  /flywheel-status  /agent-flywheel-doctor             │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       AgentFlywheel state machine                     │
│ scan → discover → select → plan → approve → execute → review → learn  │
│ checkpoints after phase transitions for crash recovery                │
└──────────────────────────────────────────────────────────────────────┘
          │                 │                    │                │
          ▼                 ▼                    ▼                ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Scan providers  │ │ Planning agents │ │ Execution layer │ │ Review gates    │
│ - ccc           │ │ - standard plan │ │ - br beads      │ │ - fresh eyes    │
│ - profiler      │ │ - deep plan     │ │ - worktrees     │ │ - polish        │
│ - git/history   │ │ - idea wizards  │ │ - cli wrapper   │ │ - ergonomics    │
└─────────────────┘ └─────────────────┘ └─────────────────┘ │ - compliance   │
          │                 │                    │           └─────────────────┘
          └─────────────────┴──────────┬─────────┴──────────────────┘
                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Optional coordination                         │
│ agent-mail reservations · CASS memory · MemPalace mining │
└──────────────────────────────────────────────────────────────────────┘
```

Key files:

| File | Role |
|------|------|
| `src/index.ts` | Extension registration and top-level command wiring |
| `src/commands.ts` | Command handlers and orchestration entry points |
| `src/beads.ts` | Bead helpers, validation, template hygiene checks |
| `src/bead-templates.ts` | Built-in bead template library |
| `src/tools/approve.ts` | Bead approval and refinement flow |
| `src/tools/review.ts` | Per-bead review and next-bead selection |
| `src/prompts.ts` | Planning prompts and bead instructions |
| `src/deep-plan.ts` | Multi-model planning agents |
| `src/cli-exec.ts` | Structured CLI execution wrapper with retry/fallback behavior |

### Implementation-worker launch path (for coordination contract changes)

- `src/tools/approve.ts` launches implementation mode by building NTM launch instructions and passing `implementationSwarmPrompt(...)` as the worker prompt payload.
- `src/tools/review.ts` uses the same `implementationSwarmPrompt(...)` handoff path when routing to the next bead or parallel ready-bead set after a pass.
- `src/prompts.ts` provides shared worker-facing instruction blocks via `swarmMarchingOrders(...)` and `ntmOperatorTickLoopInstructions()`.
- `src/deep-plan.ts` handles planning-model execution (including Anthropic NTM `cc` lanes), not implementation-mode bead worker handoff.
- `src/types.ts` carries implementation coordination state (`coordinationBackend`, `coordinationMode`, `agentMailSessionActive`, `currentBeadId`, `workspaceChangeBaseline`) that launch logic relies on.

Safest insertion point for a new implementation-worker coordination contract: centralize the contract text in `src/prompts.ts` and feed it through the shared swarm prompt path used by both approve/review launch flows, so behavior stays consistent across single-bead and parallel launches.

---

## Bead Template Library

Built-in templates:

| Template | Use When |
|----------|----------|
| `add-api-endpoint` | Adding an HTTP/API entry point with implementation and tests |
| `refactor-module` | Restructuring an existing module while preserving behavior |
| `add-tests` | Adding focused coverage for an existing behavior |

Templates are drafting aids, not final task syntax. Final beads must be expanded and self-contained.

Correct drafting flow:

```text
Start from template add-api-endpoint with placeholders:
- {{endpointPath}} = /api/users
- {{moduleName}} = user-management
- {{endpointPurpose}} = return a filtered user list
- {{httpMethod}} = GET
- {{implementationFile}} = src/api/users.ts
- {{testFile}} = src/api/users.test.ts

Final bead id: add-users-endpoint
Final bead title: Add users endpoint
```

The bead that gets created must not contain unresolved markers such as:

```text
[Use template: add-api-endpoint]
see template
{{endpointPath}}
```

Validation in `src/beads.ts` rejects unresolved template artifacts before planning continues.

---

## Development

```bash
git clone https://github.com/burningportra/pi-agent-flywheel.git
cd pi-agent-flywheel
npm install
npm run build
npm test
pi -e ./src/index.ts
```

When changing orchestration internals, prefer `src/cli-exec.ts` over new raw `pi.exec(...)` calls. The wrapper gives user-facing flows structured failures, transient retry where appropriate, and predictable fallback behavior.

### Package dependency policy

This extension uses the current `@earendil-works/*` pi packages:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

They are also present in `devDependencies` so local TypeScript builds and tests work outside pi.

---

## Troubleshooting

### “Unknown command: /agent-flywheel”

The extension is not installed or not enabled.

```bash
pi list | grep pi-agent-flywheel
pi install git:github.com/burningportra/pi-agent-flywheel
```

If it is installed but disabled, run:

```bash
pi config
```

Then enable the extension resources.

### “ccc not found” or codebase scanning is shallow

`ccc` is optional. Install and index if you want richer scan context:

```bash
pipx install cocoindex-code
ccc init -f
ccc index
```

Without `ccc`, the built-in profiler still uses repository structure, commits, TODOs, and available context.

### `br` or `bv` commands fail

Run the doctor command first:

```text
/agent-flywheel-doctor
```

Then verify bead tooling manually:

```bash
br list --json
bv --robot-insights
bv --robot-next   # PREFERRED
bv --robot-triage
br ready --json  # fallback only
```

If your repo has no bead database yet, initialize or create beads according to your local `br` workflow.

### Worktrees were left behind after a crash

Use the cleanup command:

```text
/agent-flywheel-cleanup
```

You can also inspect Git worktrees manually:

```bash
git worktree list
```

### Deep planning does not offer multiple models

Check pi model configuration:

```text
/models
```

Deep planning needs multiple configured models. Standard planning works with one model.

### `npm run build` cannot resolve pi packages

Refresh dependencies:

```bash
npm install
npm run build
```

The project expects the `@earendil-works/*` packages and `typebox` listed in `devDependencies`.

---

## Limitations

- **It is a pi extension, not a standalone CLI.** You use it from inside `pi`.
- **Parallel execution depends on your environment.** Worktrees, model availability, local tooling, and shell permissions determine how much autonomy is practical.
- **Optional integrations are best-effort.** Missing `ccc`, CASS, or agent-mail reduces capability but should not block the basic workflow.
- **Review gates are not formal verification.** They improve discipline and evidence collection, but you still own the final merge decision.
- **Large repo scans can be noisy.** The approval gate exists because generated plans should be edited before implementation.
- **No npm package is documented here.** The supported install path is through `pi install` from GitHub or a local checkout.

---

## FAQ

### Is this replacing pi?

No. It is a pi package that adds `/agent-flywheel` commands and tools. You still use pi for the session, model configuration, and tool execution.

### Do I need `ccc`?

No. `ccc` improves scan quality, but the extension falls back to its built-in profiler if `ccc` is missing or fails.

### Do I need multiple model subscriptions?

No for the standard workflow. Multi-model deep planning and Dueling Idea Wizards are better with multiple models, but a single-model path remains available.

### What are beads?

Beads are dependency-tracked tasks managed by the `br` CLI. In this project, beads act as contracts: title, rationale, acceptance criteria, and file scope should be clear enough for a fresh agent to execute.

### Can I use it in a repo that already has tasks/issues?

Yes, but the extension is designed around local beads. If your repo uses another tracker, treat the bead plan as the execution breakdown and manually map it to your external issue system if needed.

### Does it commit or push automatically?

The workflow can guide implementation and review, but you should inspect the final diff and control commits/pushes according to your repo policy.

### What happens if my pi session crashes?

The extension checkpoints phase state. Restart `/agent-flywheel`; when a resumable checkpoint exists, it offers to continue from the saved state.

### What happened to the `/orchestrate*` commands?

They were removed. This plugin uses `/flywheel*` (canonical) with `/agent-flywheel*` as aliases for the older AgentFlywheel naming.

---

## Acknowledgments

The core **Agentic Coding Flywheel** concept was invented by [Dicklesworthstone](https://github.com/Dicklesworthstone). `pi-agent-flywheel` exists because that workflow is powerful enough to deserve first-class automation inside `pi`: discover high-leverage work, plan it into agent-executable tasks, run the work, review honestly, and feed the lessons back into the next cycle.

## About Contributions

*About Contributions:* Please don't take this the wrong way, but I do not accept outside contributions for any of my projects. I simply don't have the mental bandwidth to review anything, and it's my name on the thing, so I'm responsible for any problems it causes; thus, the risk-reward is highly asymmetric from my perspective. I'd also have to worry about other "stakeholders," which seems unwise for tools I mostly make for myself for free. Feel free to submit issues, and even PRs if you want to illustrate a proposed fix, but know I won't merge them directly. Instead, I'll have Codex or Codex review submissions via `gh` and independently decide whether and how to address them. Bug reports in particular are welcome. Sorry if this offends, but I want to avoid wasted time and hurt feelings. I understand this isn't in sync with the prevailing open-source ethos that seeks community contributions, but it's the only way I can move at this velocity and keep my sanity.

---

## Learn More

- [Setup & Configuration](docs/setup.md) — prerequisites, `ccc`, subscriptions, CASS
- [Architecture](docs/architecture.md) — scan pipeline, context priority, bead templates, workflow internals
- [Planning & Review](docs/planning-and-review.md) — planning, approval, and review behavior
- [Coordination & Swarm](docs/coordination-and-swarm.md) — multi-agent coordination notes
- [Bead System](docs/bead-system.md) — bead conventions and validation
- [Release Checklist](docs/release-checklist.md) — read-only release/version handoff workflow
- [Custom-goal Brainstorming](docs/brainstorming.md) — Superpowers-style custom-goal clarification and decision records

---

## License

MIT
