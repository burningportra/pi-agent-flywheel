import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerCommands } from "./commands.js";
import { createInitialState, type AgentFlywheelCompactionContext, type Bead, type OrchestratorContext, type OrchestratorPhase } from "./types.js";

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
    runHitMeAgents: vi.fn(async () => ({ text: "", diff: "", hadOutputCount: 0, emptyOutputCount: 0 })),
    agentMailRPC: vi.fn(async () => ({})),
    ensureAgentMailProject: vi.fn(async () => undefined),
  } as unknown as OrchestratorContext;

  registerCommands(oc);
  return { oc, commands, piExec };
}

describe("/flywheel-status slash command", () => {
  beforeEach(() => {
    beadFixtures.beads = [];
    vi.restoreAllMocks();
  });

  it("registers canonical and legacy status commands", () => {
    const { commands } = buildOrchestrator();

    expect(commands.get("flywheel-status")?.handler).toBeTypeOf("function");
    expect(commands.get("agent-flywheel-status")?.handler).toBeTypeOf("function");
    expect(commands.get("agent-flywheel-status")?.description).toContain("Legacy alias");
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
    expect(message).not.toContain("### Compaction");
  });

  it.each([
    ["manual", "Manual compaction", {}],
    ["threshold", "Automatic threshold compaction", { rawReason: "auto" }],
    ["overflow_retry", "Overflow retry compaction", { willRetry: true }],
    ["unknown", "Unknown compaction", { rawReason: "future_reason" }],
  ] satisfies Array<[AgentFlywheelCompactionContext["reason"], string, Partial<AgentFlywheelCompactionContext>]>)(
    "prints reason-specific compaction status for %s compaction",
    async (reason, title, overrides) => {
      const { oc, commands } = buildOrchestrator();
      oc.state.phase = "implementing";
      oc.state.compaction = {
        latest: {
          eventName: "session_compact",
          reason,
          timestamp: "2026-07-09T12:00:00.000Z",
          ...overrides,
        },
      };
      const ctx = buildContext();

      await commands.get("flywheel-status").handler("", ctx);

      const [message, level] = ctx.ui.notify.mock.calls[0];
      const compactionOverrides = overrides as Partial<AgentFlywheelCompactionContext>;
      expect(level).toBe("info");
      expect(message).toContain("### Compaction");
      expect(message).toContain(`- Last compaction: ${title} (reason: ${reason})`);
      expect(message).toContain("- Event: session_compact");
      expect(message).toContain("- Safe recovery sequence:");
      expect(message).toMatch(/  1\. .+/);
      if (compactionOverrides.rawReason) expect(message).toContain(`- Raw reason: ${compactionOverrides.rawReason}`);
      if (compactionOverrides.willRetry === true) {
        expect(message).toContain("- willRetry: true");
        expect(message).toContain("- Duplicate side-effect risk: yes");
        expect(message).toContain("Pi may retry the interrupted request");
        expect(message).toContain("before repeating side-effecting work");
      }
    }
  );

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
});
