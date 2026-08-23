# Setup & Configuration

## Prerequisites

| Requirement | Version | Why |
|-------------|---------|-----|
| [pi](https://github.com/badlogic/pi-mono) | Latest | The coding agent harness this extension runs inside |
| Node.js | ≥ 18 | Required by pi and this extension |
| git | ≥ 2.20 | Worktree support (`git worktree add`) for parallel execution |

## Installation

```bash
pi install git:github.com/burningportra/pi-agent-flywheel
```

Verify it loaded:

```bash
pi
# Then type: /flywheel-status
# Expected output: "Phase: idle" (no active session)
```

## ccc Codebase Scanning (Optional, Recommended)

pi-agent-flywheel tries ccc first because it provides more detailed codebase context than the built-in profiler. ccc findings are paired with the existing repo profile shape so the rest of the workflow keeps working.

### What ccc changes

- **Primary codebase signal** — ccc findings are shown ahead of commits, TODOs, and memory during discovery/planning
- **Richer scan context** — the orchestrator can surface structural insights and recommendation inputs from semantic code search
- **Graceful fallback** — if ccc is missing, not initialized, or errors, the orchestrator falls back to the built-in profiler and keeps the workflow moving

### Install ccc

```bash
pipx install cocoindex-code
```

### Initialize ccc in a repo

```bash
cd your-project
ccc init -f
ccc index
```

### What if I skip ccc?

Nothing breaks. `/flywheel-start` still works — it just uses the built-in profiler instead of ccc-backed codebase analysis.

## Subscription Setup (Multi-Model Features)

Parallel agent features (deep planning, creative brainstorm) require access to multiple model providers.

### What a subscription unlocks

| Feature | What happens | Models needed |
|---------|-------------|---------------|
| **Deep planning** | 3 competing plans from different models, then synthesis | 3 models (e.g. Gemini + GPT + Claude) |
| **Creative brainstorm** | 3 parallel agents (innovator / hardener / simplifier) | 3 models |
| **Peer review** | 4 parallel review agents with different focuses | Works with 1 model, better with variety |

### How to enable

1. **Check available models** — in pi, run `/models` to see what's configured
2. **Add providers** — follow [pi's model docs](https://github.com/badlogic/pi-mono) to add API keys for providers you want (OpenAI, Google, Anthropic, etc.)
3. **During deep planning** — the orchestrator shows available models sorted by context window; pick any 3

> **No subscription?** Everything still works — use "Standard" planning (single model) instead of "Deep plan". Reviews run with your default model.

## Optional Configuration

### CASS Memory (Optional, Recommended)

The orchestrator uses [CASS](https://github.com/Dicklesworthstone/cass_memory_system) (cm CLI) for procedural memory — relevance-scored rules, anti-pattern tracking, and cross-session learning.

```bash
npm install -g cass-memory
cm init --starter typescript
cm doctor --json  # verify setup
```

Once installed, the orchestrator automatically:
- Queries relevant rules at the start of each session via `cm context`
- Prompts the LLM to add learnings via `cm add` at completion
- Supports rule feedback via `cm mark` (helpful/harmful)

> **No cm CLI?** Memory is skipped silently. Everything else works the same.

### Development mode

To hack on the extension itself:

```bash
git clone https://github.com/burningportra/pi-agent-flywheel.git
cd pi-agent-flywheel && npm install

# Run pi with the local extension
pi -e ./src/index.ts
```
