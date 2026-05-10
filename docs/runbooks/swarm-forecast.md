# Swarm forecast runbook

Swarm forecasting is a read-only decision-support surface for Flywheel implementation mode. It answers one question: where will coordination, file contention, validation capacity, or stale ownership slow the swarm next?

It does not assign agents, release reservations, reopen beads, close beads, send Agent Mail, commit to Git, or mutate runtime state. It writes evidence artifacts and copyable coordination text only.

## Artifact path

During the parallel-launch branch of `orch_review`, Flywheel writes:

- `.pi-agent-flywheel/swarm-forecast/latest.json`
- `.pi-agent-flywheel/swarm-forecast/latest.md`

If forecasting fails, launch instructions still render with a warning. That fail-open behavior keeps implementation mode usable.

## Safety invariants

- Forecast input is saved JSON built from injected bead/coordination data.
- The pure engine never reads live Beads, Agent Mail, Git, dashboard, database, or network state.
- Every suggested action has `mutation: "none"` and `dry_run_only: true`.
- Forecast output is advisory. Operators decide whether to serialize, stagger, or contact a holder.
- Dashboard/API pieces from the cheen-machine reference are not required for this first Flywheel integration.

## Implementation-mode behavior

When a bead passes review and multiple ready beads become available, Flywheel:

1. Builds a saved forecast input from current beads.
2. Runs the pure forecast engine.
3. Writes JSON and Markdown artifacts.
4. Inserts a concise `Swarm Forecast (read-only)` advisory before subagent launch JSON.
5. Continues with the existing launch flow.

The forecast can highlight:

- `critical-path`: dependency chain to watch.
- `file-contention`: ready beads touching the same path.
- `build-lane-saturation`: validation lane pressure.
- `stale-agent-handoff`: holder/reservation needs human contact.
- `high-cardinality`: large swarm output is bounded.

## Operator drill

The regression drill uses saved fixtures only. Red slices cover:

- high-cardinality scale contention
- exact-path file contention
- build-lane saturation
- stale-agent handoff

The green slice is `empty_queue`.

Run focused checks:

```bash
npm test -- src/swarm-forecast.test.ts src/swarm-forecast-report.test.ts src/swarm-forecast-adapter.test.ts src/swarm-forecast-drill.test.ts
npm run build
```

## Troubleshooting

- Missing artifact: treat as unavailable; rerun the review step or inspect the fail-open warning.
- Unexpected mutation guidance: this is a bug. Tests should fail if any action is not `mutation=none` and `dry_run_only=true`.
- Source uncertainty: missing Agent Mail data is allowed. The adapter records warnings instead of throwing.
- Large forecasts: read the summary first; high-cardinality fixtures intentionally bound top risks/actions.

## Porting note

The design came from the cheen-machine reference implementation. Flywheel adapted the portable parts: saved fixtures, pure forecast engine, report artifacts, adapter, implementation-mode advisory, and drill tests. It intentionally skipped the reference dashboard/API layer for now.
