import { describe, expect, it, vi } from "vitest";
import { createInitialState } from "../types.js";
import { registerStatusTool, buildStatusResult } from "./status.js";

function buildOc(overrides: any = {}) {
  const registeredTools = new Map<string, any>();
  const exec = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify([]),
    stderr: "",
    killed: false,
  }));

  const oc: any = {
    pi: {
      exec,
      registerTool: vi.fn((spec: any) => registeredTools.set(spec.name, spec)),
    },
    state: { ...createInitialState(), ...overrides },
    get _tools() { return registeredTools; },
  };

  return oc;
}

const ctx = { cwd: "/tmp/pi-agent-flywheel" } as any;

describe("flywheel_status tool", () => {
  it("registers canonical and compatibility aliases", () => {
    const oc = buildOc();
    registerStatusTool(oc);

    expect([...oc._tools.keys()]).toEqual([
      "agent_flywheel_status",
      "orch_status",
      "flywheel_status",
    ]);
  });

  it("returns parseable status JSON and mirrors it in details.status", async () => {
    const oc = buildOc({ phase: "implementing", selectedGoal: "Ship status" });
    oc.pi.exec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([
        {
          id: "pi-a",
          title: "Current bead",
          description: "desc",
          status: "in_progress",
          priority: 2,
          issue_type: "feature",
          labels: ["status"],
          updated_at: "2026-06-01T00:00:00Z",
        },
      ]),
      stderr: "",
      killed: false,
    });
    registerStatusTool(oc);

    const result = await oc._tools.get("flywheel_status").execute("call-1", {}, undefined, () => {}, ctx);
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(result.details.status);
    expect(parsed).toMatchObject({
      contract_version: 1,
      phase: "implementing",
      selected_goal: "Ship status",
      approval_state: "approved",
      confidence: "high",
    });
    expect(parsed.beads.current).toMatchObject([
      { id: "pi-a", status: "in_progress", type: "feature" },
    ]);
    expect(result.details.warnings).toEqual([]);
  });

  it("degrades to an empty bead set with warnings when beads cannot be read", async () => {
    const oc = buildOc({ phase: "idle" });
    oc.pi.exec.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "br database not found",
      killed: false,
    });

    const result = await buildStatusResult(oc, ctx.cwd);

    expect(result.status.contract_version).toBe(1);
    expect(result.status.beads.total).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Could not read beads via br list --json");
  });
});
