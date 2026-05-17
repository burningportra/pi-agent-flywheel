# UBS Triage: Command Startup Paths

Bead: `pi-28k`

Scope scanned:

```bash
ubs src/commands.ts src/commands.orchestrate-startup.test.ts src/startup-ceremony.e2e.test.ts --format=jsonl --ci
```

Result: UBS exited `0`; no scanner-blocking failures. It reported 40 summary findings: 14 `good`, 20 `info`, and 6 `warning` groups. Scanner totals after cleanup were `critical=0`, `warning=60`, and `info=646`.

## Landed cleanup

- Reworked `/agent-flywheel --mode ...` parsing to avoid a non-null assertion on the regex match. UBS no longer reports that startup argument path as unsafe narrowing.
- Hardened startup bead-age formatting so malformed `created_at` timestamps render as `unknown` instead of producing `NaN` in the resume menu.

## Warning triage

| UBS warning group | Triage | Rationale / follow-up |
| --- | --- | --- |
| Potentially unsafe type narrowing (`commands.ts:947`, `2012`, `2035`) | Accepted false positives | The remaining highlighted paths have explicit guard returns before use: `entry`, `pathChoice`, and `focusChoice` are checked and returned before later access. No startup-path bug found. |
| JSON.parse without error handling | Accepted false positive | The `JSON.parse` calls in `src/commands.ts` are already wrapped in `try/catch` or gated through parse-failure handling. No unhandled startup-path parse crash found. |
| Blocking dialogs - poor UX | Accepted for this extension | `ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.input` are the intended pi command-menu primitives. Replacing them would be a UX redesign, not a startup bug fix. |
| Function declarations in blocks | Deferred cleanup | This is a style/hoisting warning. No affected startup path has behavior dependent on function hoisting. Defer until a broader commands.ts simplification bead. |
| Nested ternary operators - unreadable | Deferred cleanup | Readability debt exists in `src/commands.ts`, but broad ternary rewrites are high-risk for a startup triage bead. Fix them only when touching specific branches with tests. |
| Significant technical debt | Deferred cleanup | UBS correctly flags `src/commands.ts` as large and multi-responsibility. This needs a separate refactor plan rather than incidental edits during startup triage. |

## Info finding triage

- Deep property access, type comparisons, string concatenation, async function counts, date construction, and arrow-function return-shape notices are broad heuristics across command code.
- The startup ceremony path is covered by `src/commands.orchestrate-startup.test.ts` and `src/startup-ceremony.e2e.test.ts` after this triage.
- The actionable info-level issue was malformed date display in the startup menu; this now renders as `unknown` instead of `NaN`.

## Deferred cleanup candidates

Create separate beads before changing these areas:

1. Split `src/commands.ts` startup/menu code into smaller units with focused tests.
2. Replace dense nested ternaries only where tests can lock behavior first.
3. Add narrow helper functions for repeated UI choice formatting after the startup menu stabilizes.
