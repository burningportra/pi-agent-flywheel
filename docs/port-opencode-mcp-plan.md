# Port Mapping: Flywheel → OpenChamber (MCP)

Status: APPROVED — decisions resolved (2026-08-09). Stage 1 scope agreed; no code written yet.

Resolved decisions:
- Base: **cursor-agent-flywheel** (already MCP). pi is not the port base.
- Sub-agent primitive (Stage 4): **OpenChamber dispatched sessions** (not NTM, not host subagent). The repo's NTM-first default applies only to its Cursor/Claude installs; for OpenChamber, the two-phase contracts (`graderStdout`, `afterTask`, "spawn agent specs") are adapted to dispatched sessions.

## TL;DR

**Start from `cursor-agent-flywheel`, not `pi-agent-flywheel`.** The Cursor repo
(`~/Documents/GitHub/cursor-agent-flywheel`, plugin
`plugins/cursor-orchestrator`) is **already a production MCP server** — 30+
`flywheel_*` tools over stdio JSON-RPC (`mcp-server/src/server.ts`), ships a
clean `ToolContext` seam, a `HookAdapter` platform seam, and structured
`askQuestion` user-gates. OpenChamber already consumes MCP natively (the repo's
own `opencode.json` wires `mcp-agent-mail` the same way). So the OpenChamber
port is a **thin adaptation** of cursor-agent-flywheel, not a rebuild and not a
port from pi.

`pi-agent-flywheel` is the odd one out: it's an in-process pi ExtensionAPI
orchestrator with no host-agnostic seam and no MCP server. Treat it as upstream
inspiration, not the port base.

## 1. What already fits OpenChamber (no work needed)

- **MCP transport** — `@modelcontextprotocol/sdk`, `StdioServerTransport`, 30+
  `flywheel_*` tools registered in `server.ts`. OpenChamber supports stdio/SSE MCP.
- **ToolContext seam** (`types.ts:753`) — `{ exec, cwd, state, saveState, clearState, signal }`.
  Purely host-agnostic; no Cursor types leak in. Every tool runner consumes this.
- **State & persistence** — disk-backed `.pi-flywheel/checkpoint.json`, `.beads/`,
  completion attestation files. No in-process session manager needed.
- **External primitives** — `br`/`bv`, agent-mail (MCP HTTP at `127.0.0.1:8765/mcp`),
  NTM panes, CASS/cm, guru/rubric. All driven via `exec` → host-agnostic.
- **`orch_*` deprecated aliases** — already set up for rename; we can just drop the
  Cursor-native aliasing and keep the canonical set.
- **Tests** — Vitest suites, hard constraints documented in the plugin AGENTS.md
  (no stdout logging, strict TS, NodeNext, ESM, `.js` import suffixes).

## 2. What must change for OpenChamber (the actual port)

Two seams are where Cursor leaks in. Both are already abstracted; the port fills
them with OpenChamber implementations.

### 2.1 User gates: `askQuestion` / `AskUserQuestion` → OpenChamber

Cursor renders flywheel's structured gate payloads as native `AskQuestion`
menus (`cursor-user-gates.ts`, `buildAskQuestionFromGate`, `toCompactGatePayload`).
Tools like `flywheel_wave_review_gate`, `flywheel_wrap_up_gate`,
`flywheel_bead_approval_gate`, `flywheel_start_menu` return a `data.askQuestion`
object and instruct the caller to "map selection via `data.actions`, re-call with
`confirmAction`".

**OpenChamber adaptation:** OpenChamber has no `AskQuestion` tool. Options:

- **(A) Ask via the model + return to caller (recommended).** The gate tools
  already emit compact human-readable text + a structured menu. In OpenChamber,
  the agent presents the options as a normal message and reads the user's typed/
  picked reply, then re-calls the gate tool with the chosen `confirmAction`. No
  MCP change needed — it's a **skill/instructions difference**, not a code change.
  The `askQuestion` field remains present for future OpenChamber UI rendering but
  the blocking path is conversational.
- **(B) Native menu via openchamber's tool-plugin.** Wrap the gate tools behind
  the thin `openchamber-plugin.js` action bridge so the desktop can render a real
  menu (like your existing `openchamber` tool). Higher effort; only worth it if
  conversational fails.

Recommend A first (zero MCP code), keep `data.askQuestion` in payloads for B
later.

### 2.2 Sub-agent / Task spawning → OpenChamber (DECIDED: dispatched sessions)

Cursor uses its native **`Task`** tool for: fresh-eyes reviewers
(`flywheel_review` hit-me), deep-plan lane agents, dueling wizards, compliance
audit, and the `grader_deferred` outcome grader. This is the main host-specific
dependency. Where `Task` appears:

| Tool | Cursor default | OpenChamber replacement (DECIDED) |
|---|---|---|
| `flywheel_review` (hit-me) | `Task` per reviewer | OpenChamber **dispatched session** per reviewer |
| `flywheel_plan` mode=deep | 3 Cursor Task lane agents | OpenChamber dispatched sessions |
| `flywheel_duel` | Cursor Task wizards (or NTM if `FW_DUEL_BACKEND=ntm`) | OpenChamber dispatched sessions |
| `flywheel_compliance_audit` | `Task` + afterTask | dispatched session + re-call |
| `flywheel_grade_outcome` | `grader_deferred` → Task → `graderStdout` | dispatched session + `graderStdout` re-call (already the two-phase contract) |

Good news: the two-phase patterns (`grader_deferred` → re-call with stdout;
`afterTask` re-call; deep-plan returns "spawn these agent configs" and the host
does the spawning) are **already written so the *host* does the fan-out**. The
MCP server returns agent task specs; only the actual spawn primitive is
Cursor-specific. So the port is: swap `Task` invocations for **OpenChamber
dispatched sessions**, and the skills/instructions that say "call Task" say
"dispatch an OpenChamber session". Notes:
- Where the MCP server *currently* shells out to NTM backends there's no change;
  the OpenChamber path uses dispatched sessions for the Cursor-`Task` sites.
- The host subagent is out of scope for v1.

### 2.3 Platform adapter: the `HookAdapter` seam

`detect.ts` + `ClaudeCodeAdapter.ts` only handle Claude Code / Cursor plugin
registration and doctor checks (`pluginRoot()`, `installedPluginManifestPath()`,
`worktreeScanRoots()`, `validateHooks()`, `checkPluginRegistration()`,
`getInstalledVersion()`).

**OpenChamber adapter:** add an `OpenChamberAdapter` implementing the same
`HookAdapter` interface:
- `pluginRoot()` → OpenChamber's plugin/config root (e.g. `~/.config/opencode/plugins`
  or the agent-tool directory in `~/.config/openchamber/`)
- `installedPluginManifestPath()` → look for the flywheel manifest/config there
- `worktreeScanRoots()` → same `.pi-flywheel/worktrees`, `.ntm/worktrees`, `.claude/worktrees`
- `validateHooks()` → for OpenChamber, no `.claude/settings.json`; return green/skip,
  or check the OpenChamber MCP config(s) wiring flywheel
- `checkPluginRegistration()` / `getInstalledVersion()` → from the OpenChamber root

`detectPlatform()` gains `FLYWHEEL_PLATFORM=opencode` (or `openchamber`) and an
env-based detection. Because every adapter method is pure/sync and returns a
`DiagnosticResult` row, this is ~1 file + a detect switch — the documented "one-file
diff" path the seam was built for.

### 2.4 Runner aliases + tool rename

- Drop the `orch_*` alias generation (`server.ts:801`) or keep — cosmetic.
- If shipping under a distinct plugin identity, rename the tool prefix from
  `flywheel_` — but recommended to **keep `flywheel_*`** to reuse all skills,
  prompts, docs, and the `flywheel_get_skill('agent-flywheel:<name>')` namespacing
  unchanged. Renaming costs far more than it saves.

## 3. Wiring flywheel into OpenChamber

1. **MCP server registration.** OpenChamber reads `opencode.json`-style MCP config
   (the pi repo already registers `mcp-agent-mail` there). Add:
   ```json
   // opencode.json (project) or OpenChamber project config
   "mcp": {
     "agent-mail": { "type": "http", "url": "http://127.0.0.1:8765/mcp" },
     "agent-flywheel": { "type": "stdio",
        "command": "node",
        "args": ["/path/to/cursor-agent-flywheel/plugins/cursor-orchestrator/mcp-server/dist/server.js"] }
   }
   ```
2. **Entry/skills (the "how to run the flywheel" instructions).** Cursor ships
   `/start` skill + `.cursor/rules/*.mdc`. For OpenChamber, port these to
   OpenChamber's agent/skill mechanism (OpenCode skills under `.opencode/skills/`
   or `AGENTS.md`) so the agent knows the canonical loop:
   `flywheel_observe` → `flywheel_profile` → `flywheel_discover` →
   `flywheel_select` → `flywheel_plan` → `br create` → approval gate →
   implement → `flywheel_advance_wave`/`flywheel_impl_tick` → review gates →
   wrap-up. The skill bodies reference `Task`/`AskQuestion`; those references are
   rewritten per §2.1/§2.2.
3. **Thin agent-tool plugin (optional).** Mirror `openchamber-plugin.js`: a single
   `flywheel` tool whose `execute` POSTs `{action}` to a tiny local daemon used only
   to nudge a phase / render a menu from the desktop. Should NOT duplicate MCP logic.
   Defer unless the conversational path is insufficient.

## 4. Build plan (each stage shippable + testable)

Existing gates to keep green: `cd plugins/cursor-orchestrator/mcp-server && npm test
&& npm run build` (dist/ is committed; no stdout in server code).

- **Stage 1 — adapt, don't port.** Add `OpenChamberAdapter` (§2.3) + `detect.ts`
  case + `FLYWHEEL_PLATFORM=opencode`. Ship the MCP config wiring (§3.1). Nothing else
  changes. Verify: OpenChamber lists the 30+ `flywheel_*` tools; `flywheel_doctor`
  and `flywheel_observe` respond green.
- **Stage 2 — vertical slice (profile→plan→approve).** Run the loop
  `flywheel_observe` → `profile` → `discover` → `select` → `plan(mode=standard)` →
  `br create` → `flywheel_bead_approval_gate`. Use **conversational** gates (§2.1A).
  No parallel spawns yet. Get sign-off.
- **Stage 3 — gates.** `flywheel_wave_review_gate`, `flywheel_wrap_up_gate`
  conversational confirm-action flows; confirm replay/idempotence still holds.
- **Stage 4 — parallel spawns.** Use **OpenChamber dispatched sessions** (§5).
  Port `flywheel_review` hit-me, `flywheel_plan` deep, `flywheel_duel`,
  `flywheel_compliance_audit`, `flywheel_grade_outcome`. Largest single decision.
- **Stage 5 — skills/onboarding.** Port the `/start` loop into OpenChamber skills
  (`AGENTS.md` / `.opencode/skills/`), rewrite `Task`/`AskQuestion` refs.

## 5. Open decisions (resolve before Stage 1 code)

- ~~Base repo~~ **Resolved**: cursor-agent-flywheel.
- ~~Parallel spawn primitive~~ **Resolved**: OpenChamber dispatched sessions (NTM
  env-overrides remain where flywheel already supports them).
- **Gates** (§2.1): conversational (A) vs native menu plugin (B). Recommend A first.
- **Tool rename**: keep `flywheel_*` (recommended) vs prefix for OpenChamber identity.

## 6. Out of scope for v1

- Rewriting MCP infra or state layer (already good).
- Native `AskQuestion` UI rendering in OpenChamber unless (B) is explicitly chosen.
- Porting the optional Activity Bar VS Code extension.
- Multi-host parity (codex/gemini legacy backends) beyond what flywheel already does.
