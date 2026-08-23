import { describe, it, expect, afterEach } from "vitest";
import { isInsideHerdr, defaultSwarmLaunchMode, formatPiSwarmLaunchInstructions } from "./pi-swarm.js";

const SAVED: Record<string, string | undefined> = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(restoreEnv);

describe("isInsideHerdr", () => {
  it("is true when HERDR_ENV is set to 1", () => {
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_BIN_PATH;
    process.env.HERDR_ENV = "1";
    expect(isInsideHerdr()).toBe(true);
  });

  it("is true when a Herdr socket path is set", () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_BIN_PATH;
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock";
    expect(isInsideHerdr()).toBe(true);
  });

  it("is false when no Herdr signals are present", () => {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_BIN_PATH;
    expect(isInsideHerdr()).toBe(false);
  });
});

describe("defaultSwarmLaunchMode", () => {
  it("defaults to NTM panes", () => {
    expect(defaultSwarmLaunchMode()).toBe("ntm");
  });
});

describe("formatPiSwarmLaunchInstructions", () => {
  const prompt = "Register with MCP Agent Mail\nPick a bead via `bv --robot-next`.\nWork it.";
  const out = formatPiSwarmLaunchInstructions({
    cwd: "/repo",
    agentCount: 3,
    prompt,
    label: "swarm",
    model: "openrouter/deepseek/deepseek-v4-flash-vision-exp",
    workerNames: ["swarm-1-foo", "swarm-2-bar", "swarm-3-baz"],
  });

  it("launches the requested number of pi workers via herdr", () => {
    expect(out).toContain("3 pi worker");
    expect(out).toContain("herdr pane split");
    expect(out).toContain('herdr agent start "swarm-1-foo" --kind pi --pane');
    expect(out).toContain('herdr agent start "swarm-3-baz" --kind pi --pane');
  });

  it("writes the marching orders to a temp file via a quoted heredoc", () => {
    expect(out).toContain("ORDERS=$(mktemp");
    expect(out).toContain("<<'SWARM_ORDERS'");
    expect(out).toContain(prompt);
    expect(out).toContain("SWARM_ORDERS");
  });

  it("includes the model flag and the supervisor loop cadence", () => {
    expect(out).toContain("--model \"openrouter/deepseek/deepseek-v4-flash-vision-exp\"");
    expect(out).toContain("herdr agent prompt");
    expect(out).toContain("herdr agent read");
    expect(out).toContain("herdr agent list");
    expect(out).toContain("Every ~4 min");
    expect(out).toContain("anti-slop");
  });
});
