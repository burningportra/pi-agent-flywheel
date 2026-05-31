---
name: agent-mail-debug
description: Fast diagnostic and recovery workflow for MCP Agent Mail failures in pi/agent swarms. Use when Agent Mail is degraded, MCP tools are missing, mail cannot send/fetch, port 8765 is down, SQLite durability/corruption appears, or the user says agent mail is broken/fucking up.
---

# Agent Mail Debug

Use this before broad investigation. Goal: restore local Agent Mail MCP to green with minimal mutation and clear evidence.

## Fast path

1. Check service and doctor:
   ```bash
   curl -sS --max-time 3 http://127.0.0.1:8765/health || true
   am --version && mcp-agent-mail --version
   am service status || true
   am doctor check --verbose || true
   ```
2. Check Pi MCP visibility with the `mcp` tool. If `mcp-agent-mail` is absent, inspect `/Users/kevtrinh/.pi/agent/mcp.json`.
3. If needed, add Pi MCP entry using token from `/Users/kevtrinh/Library/LaunchAgents/com.agent-mail.plist` → `HTTP_BEARER_TOKEN`:
   ```json
   "mcp-agent-mail": {
     "url": "http://127.0.0.1:8765/mcp/",
     "headers": { "Authorization": "Bearer <token>" },
     "lifecycle": "lazy"
   }
   ```
4. After changing Pi MCP config, arm `reload_and_resume_runtime` and ask user to run `/reload`.
5. Connect: `mcp({"connect":"mcp-agent-mail"})`; expect ~45 tools. Run `mcp_agent_mail_health_check`; expect `status: ok`, `health_level: green`.

## Common fixes

### Service down or wedged
```bash
am service restart
sleep 2
curl -sS --max-time 5 http://127.0.0.1:8765/health
```

### SQLite durability/corruption/index errors
Back up first:
```bash
ROOT=/Users/kevtrinh/.mcp_agent_mail_git_mailbox_repo
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$ROOT/backups/manual-$STAMP"
cp -p "$ROOT/storage.sqlite3" "$ROOT/backups/manual-$STAMP/storage.sqlite3"
[ -f "$ROOT/storage.sqlite3-wal" ] && cp -p "$ROOT/storage.sqlite3-wal" "$ROOT/backups/manual-$STAMP/storage.sqlite3-wal" || true
[ -f "$ROOT/storage.sqlite3-shm" ] && cp -p "$ROOT/storage.sqlite3-shm" "$ROOT/backups/manual-$STAMP/storage.sqlite3-shm" || true
```
Diagnose:
```bash
sqlite3 "$ROOT/storage.sqlite3" 'PRAGMA quick_check; PRAGMA integrity_check;' 2>&1 | head -80
am doctor fix --dry-run || true
am doctor reconstruct --dry-run || true
```
If integrity output is only bad/out-of-order indexes, `REINDEX` is usually sufficient:
```bash
sqlite3 "$ROOT/storage.sqlite3" 'REINDEX; PRAGMA quick_check; PRAGMA integrity_check; PRAGMA wal_checkpoint(TRUNCATE);'
am service restart
```
If doctor flags truncated WAL/SHM, prefer:
```bash
am doctor repair --dry-run
am doctor repair -y || true
am service restart
```
If repair says mailbox lock is busy, restart service and re-run `am doctor check` before doing anything else.

### Update Agent Mail
```bash
am self-update --check
am self-update
```
If self-update prints an official installer fallback, use it exactly, then restart:
```bash
bash /tmp/agent-mail-install.sh --version vX.Y.Z --verify --yes
am service restart
```

## Expected green evidence

Report:
- `/health` → `status:"ready"`, `durability_state:"healthy"`, expected version.
- `am doctor check` → healthy/all checks passed; list warnings separately.
- Pi `mcp` → `mcp-agent-mail` connected with tools visible.
- `mcp_agent_mail_health_check` → `status:"ok"`, `health_level:"green"`.

## Usually non-blocking warnings

- `archive_hygiene` duplicate canonical message files.
- missing guard hooks in current repo.
- bearer token drift in other clients if Pi MCP and HTTP endpoint work.
- update-check cache warning right after install.

## Safety rules

- Never delete DB/WAL/SHM manually; use backups and `am doctor repair`.
- Never use destructive git or remove installer-created repo files unless user explicitly approves.
- Before mutating global configs, create timestamped `.bak-*` copies.
- Preserve unrelated working-tree changes.
