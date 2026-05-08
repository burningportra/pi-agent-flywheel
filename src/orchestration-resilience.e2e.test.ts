import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBeads, readyBeads, getBeadById } from "./beads.js";
import { brExec, brExecJson } from "./cli-exec.js";
import { DashboardController } from "./dashboard/controller.js";
import type { DashboardSnapshot } from "./dashboard/types.js";
import type { Bead, OrchestratorState } from "./types.js";

/**
 * End-to-end resilience harness for br failure scenarios.
 *
 * Local run:
 *   npm test -- src/orchestration-resilience.e2e.test.ts --reporter=verbose
 *
 * To print the full stage log while debugging:
 *   ORCH_RESILIENCE_E2E_LOG=1 npm test -- src/orchestration-resilience.e2e.test.ts --reporter=verbose
 *
 * The harness intentionally exercises real orchestration-facing helpers instead
 * of isolated parser functions. Each scenario records stage, injected br failure,
 * observed fallback, and the command sequence so a broken fallback is diagnosable.
 */

type ExecOutput = { code: number; stdout: string; stderr: string; killed?: boolean };
type ExecHandler = (args: string[], command: string) => Promise<ExecOutput> | ExecOutput;

type StageEntry = {
  stage: string;
  event: string;
  detail: string;
};

class StageLogger {
  readonly entries: StageEntry[] = [];

  log(stage: string, event: string, detail: string) {
    this.entries.push({ stage, event, detail });
  }

  text() {
    return this.entries
      .map((entry, index) => `${String(index + 1).padStart(2, "0")} [${entry.stage}] ${entry.event}: ${entry.detail}`)
      .join("\n");
  }

  flushIfRequested() {
    if (process.env.ORCH_RESILIENCE_E2E_LOG === "1") {
      console.info(`\n--- orchestration resilience e2e log ---\n${this.text()}\n--- end log ---`);
    }
  }
}

const CWD = "/tmp/pi-agent-flywheel-resilience-e2e";

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "pi-demo",
    title: "Demo bead",
    description: "Exercise fallback behavior.\n\n### Files:\n- src/demo.ts",
    status: "open",
    priority: 2,
    type: "task",
    labels: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    phase: "implementing",
    phaseStartedAt: Date.now(),
    activeBeadIds: ["dash-1"],
    beadResults: {},
    beadReviews: {},
    selectedGoal: "prove br resilience",
    repoProfile: {
      name: "pi-agent-flywheel",
      languages: ["TypeScript"],
      frameworks: [],
      keyFiles: {},
      hasGit: true,
      todos: [],
      recentCommits: [],
      entrypoints: [],
      structure: "src/",
      hasTests: true,
      hasDocs: true,
      hasCI: false,
    },
    ...overrides,
  } as OrchestratorState;
}

function scriptedPi(logger: StageLogger, handlers: Record<string, ExecHandler>): ExtensionAPI {
  const exec = vi.fn(async (command: string, args: string[]) => {
    const key = command === "br" ? `br ${args.slice(0, 2).join(" ")}` : command;
    const fallbackKey = command === "br" ? `br ${args[0]}` : command;
    const handler = handlers[key] ?? handlers[fallbackKey] ?? handlers[command];

    logger.log("exec", "command", `${command} ${args.join(" ")}`.trim());

    if (!handler) {
      throw new Error(`unexpected command in resilience harness: ${command} ${args.join(" ")}`);
    }

    const result = await handler(args, command);
    return { killed: false, ...result };
  });

  return { exec } as unknown as ExtensionAPI;
}

async function deleteWithHardThenSoftFallback(
  pi: ExtensionAPI,
  logger: StageLogger,
  beadIds: string[],
): Promise<boolean> {
  logger.log("clear", "start", `delete ${beadIds.length} bead(s), first with --hard`);

  const hardDelete = await brExec(pi, ["delete", ...beadIds, "--force", "--hard"], {
    cwd: CWD,
    timeout: 15_000,
    maxRetries: 0,
    logWarnings: false,
  });

  if (hardDelete.ok) {
    logger.log("clear", "observed", "hard delete succeeded; soft fallback not needed");
    return true;
  }

  logger.log(
    "clear",
    "fallback",
    `hard delete failed exit=${hardDelete.error.exitCode}; retrying without --hard`,
  );

  const softDelete = await brExec(pi, ["delete", ...beadIds, "--force"], {
    cwd: CWD,
    timeout: 15_000,
    maxRetries: 0,
    logWarnings: false,
  });

  logger.log("clear", "observed", softDelete.ok ? "soft delete fallback succeeded" : "soft delete fallback failed");
  return softDelete.ok;
}

async function optionalApproveDependencyLookup(
  pi: ExtensionAPI,
  logger: StageLogger,
  beadId: string,
): Promise<string[]> {
  logger.log("approve", "start", `optional br dep list lookup for ${beadId}`);

  const depResult = await brExecJson<{ dependencies?: Array<{ type?: string; depends_on_id?: string }> }>(
    pi,
    ["dep", "list", beadId, "--json"],
    { cwd: CWD, maxRetries: 0, logWarnings: false },
  );

  if (!depResult.ok) {
    logger.log("approve", "fallback", `dependency lookup failed exit=${depResult.error.exitCode}; skipping optional deps`);
    return [];
  }

  const deps = (depResult.value.dependencies ?? [])
    .filter((dep) => dep.type === "blocks")
    .map((dep) => dep.depends_on_id)
    .filter((id): id is string => Boolean(id));
  logger.log("approve", "observed", `${deps.length} dependencies parsed`);
  return deps;
}

describe("orchestration br resilience e2e harness", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("logs discovery, dashboard, clear, and review/approve fallbacks stage by stage", async () => {
    const logger = new StageLogger();

    logger.log("discovery", "start", "simulate br list failure while /agent-flywheel checks existing beads");
    const discoveryPi = scriptedPi(logger, {
      "br list": () => ({ code: 2, stdout: "", stderr: "database unavailable during list" }),
    });
    const discoveredBeads = await readBeads(discoveryPi, CWD);
    logger.log("discovery", "fallback", `readBeads returned ${discoveredBeads.length} bead(s); fresh discovery can continue`);
    expect(discoveredBeads).toEqual([]);

    logger.log("dashboard", "start", "simulate br ready failure while dashboard has known active beads");
    const dashboardPi = scriptedPi(logger, {
      "br ready": () => ({ code: 2, stdout: "", stderr: "ready unavailable" }),
    });
    const dashboardUpdates: DashboardSnapshot[] = [];
    const dashboard = new DashboardController({
      readBeadsFn: async () => [makeBead({ id: "dash-1", title: "Dashboard bead" })],
      getUnblockedBeadsFn: async () => (await readyBeads(dashboardPi, CWD)).map((bead) => bead.id),
      getState: () => makeState(),
      getTenderSummary: () => undefined,
      onUpdate: (snapshot) => {
        dashboardUpdates.push(snapshot);
        logger.log(
          "dashboard",
          "observed",
          `snapshot beads=${snapshot.beads.length}, unblocked=${snapshot.beads.filter((bead) => bead.unblocked).length}, stale=${snapshot.staleData}`,
        );
      },
      activeIntervalMs: 10_000,
    });
    await dashboard.refreshNow();
    dashboard.dispose();
    expect(dashboardUpdates).toHaveLength(1);
    expect(dashboardUpdates[0].beads).toHaveLength(1);
    expect(dashboardUpdates[0].beads[0].unblocked).toBe(false);

    const clearPi = scriptedPi(logger, {
      "br delete pi-demo": (args) => {
        if (args.includes("--hard")) {
          return { code: 2, stdout: "", stderr: "unknown flag: --hard" };
        }
        return { code: 0, stdout: "deleted pi-demo", stderr: "" };
      },
    });
    await expect(deleteWithHardThenSoftFallback(clearPi, logger, ["pi-demo"])).resolves.toBe(true);

    logger.log("review", "start", "simulate failed optional bead lookup helper during review context refresh");
    const reviewPi = scriptedPi(logger, {
      "br show": () => ({ code: 2, stdout: "", stderr: "bead missing during lookup" }),
    });
    const missingReviewBead = await getBeadById(reviewPi, CWD, "missing-review-bead");
    logger.log("review", "fallback", `getBeadById returned ${missingReviewBead === null ? "null" : "a bead"}; caller can present not-found path`);
    expect(missingReviewBead).toBeNull();

    const approvePi = scriptedPi(logger, {
      "br dep": () => ({ code: 2, stdout: "", stderr: "dependency graph temporarily unavailable" }),
    });
    const deps = await optionalApproveDependencyLookup(approvePi, logger, "pi-demo");
    expect(deps).toEqual([]);

    const logText = logger.text();
    expect(logText).toContain("[discovery] fallback: readBeads returned 0 bead(s)");
    expect(logText).toContain("[dashboard] observed: snapshot beads=1, unblocked=0");
    expect(logText).toContain("[clear] fallback: hard delete failed");
    expect(logText).toContain("[review] fallback: getBeadById returned null");
    expect(logText).toContain("[approve] fallback: dependency lookup failed");

    logger.flushIfRequested();
  });
});
