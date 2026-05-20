import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCommands } from "./commands.js";
import { createInitialState, type OrchestratorContext, type OrchestratorPhase } from "./types.js";

type StartupEventKind =
  | "terminal.log"
  | "terminal.clear"
  | "ui.select"
  | "ui.notify"
  | "pi.send"
  | "phase"
  | "persist";

interface StartupEvent {
  seq: number;
  ts: string;
  elapsedMs: number;
  scenario: string;
  kind: StartupEventKind;
  detail: string;
}

interface StartupRun {
  scenario: string;
  artifactPath: string;
  events: StartupEvent[];
}

const restoredStdoutDescriptors: Array<() => void> = [];

function recordEvent(events: StartupEvent[], scenario: string, startedAt: number, kind: StartupEventKind, detail: string): void {
  events.push({
    seq: events.length + 1,
    ts: new Date().toISOString(),
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
    scenario,
    kind,
    detail,
  });
}

function makeTempDir(prefix = "pi-agent-flywheel-startup-e2e-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function artifactDir(): string {
  const configured = process.env.STARTUP_CEREMONY_E2E_LOG_DIR;
  const dir = configured && configured.trim().length > 0 ? configured : makeTempDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(scenario: string, events: StartupEvent[]): string {
  const path = join(artifactDir(), `${scenario}-events.json`);
  writeFileSync(path, JSON.stringify({ scenario, generatedAt: new Date().toISOString(), events }, null, 2));
  return path;
}

function forceTtyStdout(): void {
  const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");

  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });

  restoredStdoutDescriptors.push(() => {
    if (isTtyDescriptor) Object.defineProperty(process.stdout, "isTTY", isTtyDescriptor);
    else delete (process.stdout as Partial<NodeJS.WriteStream>).isTTY;

    if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
    else delete (process.stdout as Partial<NodeJS.WriteStream>).columns;
  });
}

function buildContext(events: StartupEvent[], scenario: string, startedAt: number, cwd: string) {
  return {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionDir: () => cwd,
    },
    ui: {
      select: vi.fn(async (message: string, choices?: string[]) => {
        recordEvent(events, scenario, startedAt, "ui.select", `${message.split("\n")[0]} choices=${choices?.length ?? 0}`);
        if (message.startsWith("🌟 Start AgentFlywheel:")) return choices?.[0];
        return undefined;
      }),
      notify: vi.fn((message: string) => recordEvent(events, scenario, startedAt, "ui.notify", message)),
      confirm: vi.fn(async () => false),
      input: vi.fn(async () => undefined),
      onTerminalInput: vi.fn(() => () => {}),
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
      custom: vi.fn(),
      pasteToEditor: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn(() => ""),
      editor: vi.fn(async () => undefined),
      setEditorComponent: vi.fn(),
    },
    modelRegistry: {},
    model: undefined,
    isIdle: () => true,
    abort: vi.fn(),
    hasPendingMessages: () => false,
    shutdown: vi.fn(),
    getContextUsage: () => undefined,
    compact: vi.fn(),
    getSystemPrompt: () => "",
  } as any;
}

function buildOrchestrator(events: StartupEvent[], scenario: string, startedAt: number): { oc: OrchestratorContext; commands: Map<string, any> } {
  const commands = new Map<string, any>();
  let orchestratorActive = false;

  const pi = {
    registerCommand: (name: string, options: any) => {
      commands.set(name, options);
    },
    sendUserMessage: vi.fn((content: string) => {
      recordEvent(events, scenario, startedAt, "pi.send", content.split("\n")[0] ?? content);
    }),
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
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
    version: "e2e-test",
    setPhase: (phase: OrchestratorPhase) => {
      recordEvent(events, scenario, startedAt, "phase", phase);
      oc.state.phase = phase;
    },
    persistState: () => recordEvent(events, scenario, startedAt, "persist", "state persisted"),
    updateWidget: vi.fn(),
    runHitMeAgents: vi.fn(async () => ({ text: "", diff: "" })),
    agentMailRPC: vi.fn(async () => ({})),
    ensureAgentMailProject: vi.fn(async () => undefined),
  } as unknown as OrchestratorContext;

  registerCommands(oc);
  return { oc, commands };
}

async function runStartupScenario(scenario: string, prepare?: (cwd: string, oc: OrchestratorContext) => void): Promise<StartupRun> {
  const cwd = makeTempDir();
  const events: StartupEvent[] = [];
  const startedAt = performance.now();
  const { oc, commands } = buildOrchestrator(events, scenario, startedAt);
  prepare?.(cwd, oc);

  forceTtyStdout();
  const consoleSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    recordEvent(events, scenario, startedAt, "terminal.log", String(message ?? ""));
  });
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...args: unknown[]) => {
    recordEvent(events, scenario, startedAt, "terminal.clear", String(chunk));
    const callback = args.find((arg): arg is () => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write);

  try {
    const handler = commands.get("agent-flywheel")?.handler;
    expect(handler, "agent-flywheel command should be registered").toBeTypeOf("function");
    await handler("", buildContext(events, scenario, startedAt, cwd));
  } finally {
    consoleSpy.mockRestore();
    writeSpy.mockRestore();
  }

  const artifactPath = writeArtifact(scenario, events);
  return { scenario, artifactPath, events };
}

function expectCeremonyBefore(run: StartupRun, kind: StartupEventKind): void {
  const terminalIndex = run.events.findIndex((event) => event.kind === "terminal.log" && event.detail.includes("AGENTFLYWHEEL"));
  const laterIndex = run.events.findIndex((event) => event.kind === kind);

  expect(terminalIndex, `${run.scenario} should log terminal-visible ceremony output; see ${run.artifactPath}`).toBeGreaterThanOrEqual(0);
  expect(laterIndex, `${run.scenario} should emit ${kind}; see ${run.artifactPath}`).toBeGreaterThanOrEqual(0);
  expect(terminalIndex, `${run.scenario} ceremony must happen before ${kind}; see ${run.artifactPath}`).toBeLessThan(laterIndex);
}

afterEach(() => {
  while (restoredStdoutDescriptors.length > 0) {
    restoredStdoutDescriptors.pop()?.();
  }
  vi.restoreAllMocks();
});

describe("/agent-flywheel startup ceremony end-to-end harness", () => {
  it("records terminal-visible fresh-start event order with timestamps", async () => {
    const run = await runStartupScenario("fresh-start");

    expectCeremonyBefore(run, "ui.select");
    expectCeremonyBefore(run, "pi.send");
    expect(run.events.some((event) => event.kind === "terminal.clear"), `expected animated terminal control writes; see ${run.artifactPath}`).toBe(true);
    expect(run.events.every((event, index, all) => index === 0 || event.elapsedMs >= all[index - 1].elapsedMs), `timestamps should be monotonic; see ${run.artifactPath}`).toBe(true);
  });

  it("records terminal-visible resume-menu event order with timestamps", async () => {
    const run = await runStartupScenario("resume-menu", (cwd, oc) => {
      mkdirSync(join(cwd, ".beads"), { recursive: true });
      oc.state.phase = "discovering";
    });

    expectCeremonyBefore(run, "ui.select");
    expect(run.events.some((event) => event.kind === "ui.select" && event.detail.includes("Existing orchestration detected")), `expected resume menu selection; see ${run.artifactPath}`).toBe(true);
    expect(run.events.every((event, index, all) => index === 0 || event.elapsedMs >= all[index - 1].elapsedMs), `timestamps should be monotonic; see ${run.artifactPath}`).toBe(true);
  });
});
