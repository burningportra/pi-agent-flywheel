import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerCommands } from "./commands.js";
import { _resetSlashDeprecationCache } from "./tools/shared.js";
import { createInitialState, type Bead, type OrchestratorContext, type OrchestratorPhase } from "./types.js";

const beadFixtures = vi.hoisted(() => ({ beads: [] as Bead[] }));

vi.mock("./beads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./beads.js")>();
  return {
    ...actual,
    readBeads: vi.fn(async () => beadFixtures.beads),
  };
});

function makeBead(id: string, status: Bead["status"], overrides: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `Bead ${id}`,
    description: "Test bead",
    status,
    priority: 2,
    type: "feature",
    labels: [],
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function buildContext(cwd = "/tmp/pi-agent-flywheel-status") {
  return {
    cwd,
    ui: {
      notify: vi.fn(),
    },
  } as any;
}

function buildOrchestrator(): { oc: OrchestratorContext; commands: Map<string, any>; piExec: ReturnType<typeof vi.fn> } {
  const commands = new Map<string, any>();
  const piExec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  let orchestratorActive = false;

  const pi = {
    registerCommand: (name: string, options: any) => {
      commands.set(name, options);
    },
    sendUserMessage: vi.fn(),
    exec: piExec,
  } as any;

  const oc: OrchestratorContext = {
    pi,
    state: createInitialState(),
    get orchestratorActive() {
      return orchestratorActive;
    },
    set orchestratorActive(value: boolean) {
      orchestratorActive = value;
    },
    version: "test",
    setPhase: vi.fn((phase: OrchestratorPhase) => {
      oc.state.phase = phase;
    }),
    persistState: vi.fn(),
    updateWidget: vi.fn(),
    runHitMeAgents: vi.fn(async () => ({ text: "", diff: "" })),
    agentMailRPC: vi.fn(async () => ({})),
    ensureAgentMailProject: vi.fn(async () => undefined),
  } as unknown as OrchestratorContext;

  registerCommands(oc);
  return { oc, commands, piExec };
}

describe("/flywheel-status slash command", () => {
  beforeEach(() => {
    beadFixtures.beads = [];
    _resetSlashDeprecationCache();
    vi.restoreAllMocks();
  });

  it("registers canonical and legacy status commands", () => {
    const { commands } = buildOrchestrator();

    expect(commands.get("flywheel-status")?.handler).toBeTypeOf("function");
    expect(commands.get("agent-flywheel-status")?.handler).toBeTypeOf("function");
    expect(commands.get("orchestrate-status")?.handler).toBeTypeOf("function");
    expect(commands.get("agent-flywheel-status")?.description).toContain("Legacy alias");
    expect(commands.get("orchestrate-status")?.description).toContain("Legacy alias");
  });

  it("prints human-readable status from the workflow status builder", async () => {
    beadFixtures.beads = [
      makeBead("pi-current", "in_progress", { title: "Wire status command" }),
      makeBead("pi-next", "open", { title: "Document status recovery" }),
    ];
    const { oc, commands } = buildOrchestrator();
    oc.state.phase = "implementing";
    oc.state.selectedGoal = "Ship workflow status";
    const ctx = buildContext();

    await commands.get("flywheel-status").handler("", ctx);

    const [message, level] = ctx.ui.notify.mock.calls[0];
    expect(level).toBe("info");
    expect(message).toContain("## Flywheel Status");
    expect(message).toContain("- Phase: implementing");
    expect(message).toContain("- Goal: Ship workflow status");
    expect(message).toContain("- Current beads: pi-current — Wire status command (in_progress)");
    expect(message).toContain("- Pending beads: 1 pending: pi-next — Document status recovery (open)");
    expect(message).toContain("- Confidence: high");
    expect(message).toContain("- Next action:");
  });

  it("emits parseable JSON for --json without mutating orchestration state or beads", async () => {
    beadFixtures.beads = [makeBead("pi-current", "in_progress"), makeBead("pi-next", "open")];
    const { oc, commands, piExec } = buildOrchestrator();
    oc.state.phase = "implementing";
    oc.state.selectedGoal = "Ship workflow status";
    const stateBefore = JSON.stringify(oc.state);
    const beadsBefore = JSON.stringify(beadFixtures.beads);
    const ctx = buildContext();

    await commands.get("flywheel-status").handler("--json", ctx);

    const [message, level] = ctx.ui.notify.mock.calls[0];
    const parsed = JSON.parse(message);
    expect(level).toBe("info");
    expect(parsed).toMatchObject({
      contract_version: 1,
      phase: "implementing",
      selected_goal: "Ship workflow status",
      approval_state: "approved",
      confidence: "high",
    });
    expect(parsed.beads.current.map((bead: { id: string }) => bead.id)).toEqual(["pi-current"]);
    expect(parsed.beads.pending.map((bead: { id: string }) => bead.id)).toEqual(["pi-next"]);
    expect(JSON.stringify(oc.state)).toBe(stateBefore);
    expect(JSON.stringify(beadFixtures.beads)).toBe(beadsBefore);
    expect(oc.setPhase).not.toHaveBeenCalled();
    expect(oc.persistState).not.toHaveBeenCalled();
    expect(oc.updateWidget).not.toHaveBeenCalled();
    expect(piExec).not.toHaveBeenCalled();
  });

  it("keeps legacy aliases working through slash deprecation handling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { commands } = buildOrchestrator();
    const ctx = buildContext();

    await commands.get("agent-flywheel-status").handler("--json", ctx);
    await commands.get("orchestrate-status").handler("--json", ctx);
    await commands.get("flywheel-status").handler("--json", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(3);
    expect(() => JSON.parse(ctx.ui.notify.mock.calls[0][0])).not.toThrow();
    expect(() => JSON.parse(ctx.ui.notify.mock.calls[1][0])).not.toThrow();
    expect(() => JSON.parse(ctx.ui.notify.mock.calls[2][0])).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("/agent-flywheel-status");
    expect(warn.mock.calls[0][0]).toContain("/flywheel-status");
    expect(warn.mock.calls[1][0]).toContain("/orchestrate-status");
    expect(warn.mock.calls[1][0]).toContain("/flywheel-status");
  });
});
