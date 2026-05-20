# Startup Ceremony E2E Harness

The startup ceremony harness exercises `/agent-flywheel` startup with the real `runOpeningCeremony` implementation and records terminal/session event order with timestamps.

Run it locally:

```bash
node scripts/startup-ceremony-e2e.mjs
```

By default, JSON event artifacts are written under `tmp/startup-ceremony-e2e/`. Override the location with:

```bash
STARTUP_CEREMONY_E2E_LOG_DIR=/tmp/flywheel-startup node scripts/startup-ceremony-e2e.mjs
```

The harness covers:

- fresh-start startup path
- resume-menu startup path
- terminal-visible ceremony frames
- terminal control writes used by animated mode
- UI/follow-up event order after the ceremony

Each artifact contains ordered events with `seq`, ISO timestamp, elapsed milliseconds, scenario name, event kind, and detail text. Use these logs when diagnosing startup-order regressions.
