/**
 * Herdr pi-multi swarm launcher.
 *
 * When /flywheel-swarm runs inside Herdr it can optionally launch a swarm of
 * multiple pi worker agents as Herdr panes (--kind pi) instead of the default
 * NTM cc/cod/cursor panes. Each pi worker is a real pi agent that receives the
 * swarm marching orders (which already require MCP Agent Mail registration,
 * self-introduction, file reservations, and coordinated bead work).
 */

export type SwarmLaunchMode = "ntm" | "pi";

/**
 * Detect whether the current session is running inside a Herdr workspace.
 * Herdr exposes HERDR_ENV / HERDR_SOCKET_PATH / HERDR_BIN_PATH to its panes.
 */
export function isInsideHerdr(): boolean {
  return (
    process.env.HERDR_ENV === "1" ||
    Boolean(process.env.HERDR_SOCKET_PATH) ||
    Boolean(process.env.HERDR_BIN_PATH)
  );
}

/** Default launch mode is always the NTM-pane path (visible cc/cod/cursor). */
export function defaultSwarmLaunchMode(): SwarmLaunchMode {
  return "ntm";
}

function shellArg(value: string): string {
  return JSON.stringify(value);
}

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]+/g, "-") || "pi-swarm";
}

/**
 * Build a Herdr launch script that splits the current tab into N panes, starts a
 * pi agent (`--kind pi`) in each, and prompts it with the swarm marching orders.
 * The marching orders are written to a temp file and referenced by path so shell
 * quoting never mangles the backticks/`$` inside the prompt.
 */
export function formatPiSwarmLaunchInstructions(options: {
  cwd: string;
  agentCount: number;
  prompt: string;
  label?: string;
  model?: string;
  workerNames?: string[];
}): string {
  const count = Math.max(1, Math.min(10, options.agentCount));
  const label = safeLabel(options.label ?? "pi-swarm");
  const modelFlag = options.model && options.model !== "auto"
    ? ` --model ${shellArg(options.model)}`
    : "";
  const names = options.workerNames ?? Array.from({ length: count }, (_, i) => `swarm-${i + 1}`);
  const pane = (i: number) => `SWARM_PANE_${i}`;

  const paneSplitLoop = Array.from({ length: count }, (_, idx) =>
    `  ${pane(idx + 1)}=$(herdr pane split --current --direction right --ratio 0.5 --cwd ${shellArg(options.cwd)} 2>&1 | tail -1)`
  ).join("\n");

  const startLoop = Array.from({ length: count }, (_, idx) => {
    const i = idx + 1;
    return [
      `  herdr agent start "${names[idx]}" --kind pi --pane "${pane(i)}" --timeout 90000${modelFlag}`,
      `  herdr agent prompt "${names[idx]}" "You are an AgentFlywheel swarm worker. Read the marching orders at \\"$ORDERS\\" and follow them completely: register with MCP Agent Mail, introduce yourself, reserve your file scope, pick a bead via bv, work it, and report back." --wait --until idle --timeout 120000`,
    ].join("\n");
  }).join("\n");

  return [
    `## 🐝 Herdr pi Swarm Launch (${count} pi worker${count === 1 ? "" : "s"})`,
    "",
    `Launch **${count} pi worker agent${count === 1 ? "" : "s"}** as Herdr panes (\`--kind pi\`). Each is a real pi agent given the swarm marching orders (register with MCP Agent Mail, introduce yourself, coordinated bead work). Do **not** implement inline in the current chat.`,
    "",
    "```bash",
    `cd ${shellArg(options.cwd)}`,
    "# Write the marching orders to a temp file so shell quoting is safe.",
    `ORDERS=$(mktemp /tmp/${label}-orders-XXXX.md)`,
    "cat > \"$ORDERS\" <<'SWARM_ORDERS'",
    options.prompt,
    "SWARM_ORDERS",
    "",
    "# Split this tab into N panes and start a pi agent in each.",
    paneSplitLoop,
    startLoop,
    "herdr agent list",
    "```",
    "",
    "### Supervisor / loop cadence",
    "Send fresh instructions to idle pi workers with `herdr agent prompt <name> \"<marching orders>\" --wait`; see who is idle with `herdr agent list`. Collect output with `herdr agent read <name> --lines 80`.",
    "",
    "Every ~4 min, instruct any idle worker with a bv-picked ready bead. Every 6 commits, run the anti-slop skill + a fresh-eyes pass and add follow-up beads. Reopen clearly-stalled `in_progress` beads via `br update <id> --status open` + `br sync --flush-only`.",
  ].join("\n");
}
