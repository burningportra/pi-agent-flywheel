import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { SwarmForecastFixture } from "./swarm-forecast.js";
import { buildSwarmForecastOperatorDrill } from "./swarm-forecast-drill.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const fixtureRoot = join(repoRoot, "tests", "fixtures", "swarm_forecast");

function readFixture(id: string): SwarmForecastFixture {
  return JSON.parse(readFileSync(join(fixtureRoot, "scenarios", `${id}.json`), "utf8")) as SwarmForecastFixture;
}

describe("swarm forecast operator drill", () => {
  it("runs red and green slices from saved fixtures only", () => {
    const drill = buildSwarmForecastOperatorDrill([
      { id: "high_cardinality_120", phase: "red", input: readFixture("high_cardinality_120").input, expect: { riskKinds: ["high-cardinality"], minRiskCount: 1, maxMutationActions: 0 } },
      { id: "file_contention", phase: "red", input: readFixture("file_contention").input, expect: { riskKinds: ["file-contention"], minRiskCount: 1, maxMutationActions: 0 } },
      { id: "build_lane_saturation", phase: "red", input: readFixture("build_lane_saturation").input, expect: { riskKinds: ["build-lane-saturation"], minRiskCount: 1, maxMutationActions: 0 } },
      { id: "stale_agent_handoff", phase: "red", input: readFixture("stale_agent_handoff").input, expect: { riskKinds: ["stale-agent-handoff"], minRiskCount: 1, maxMutationActions: 0 } },
      { id: "empty_queue", phase: "green", input: readFixture("empty_queue").input, expect: { maxRiskCount: 0, maxMutationActions: 0 } },
    ], "2026-05-10T15:00:00.000Z");

    expect(drill.schema).toBe("swarm-forecast-operator-drill.v1");
    expect(drill.summary).toEqual({ red_count: 4, green_count: 1, passed_count: 5, failed_count: 0 });
    expect(drill.mutation_guard).toEqual({
      live_agent_mail: false,
      live_beads: false,
      live_git: false,
      live_dashboard: false,
      live_trading: false,
      writes_only_output_dir: true,
    });
    expect(drill.slices.every((slice) => slice.passed)).toBe(true);
  });

  it("documents safety boundaries and fail-open behavior", () => {
    const runbook = readFileSync(join(repoRoot, "docs", "runbooks", "swarm-forecast.md"), "utf8");
    expect(runbook).toContain("does not assign agents");
    expect(runbook).toContain("mutation: \"none\"");
    expect(runbook).toContain("fail-open");
    expect(runbook).toMatch(/dashboard\/API pieces/i);
    expect(runbook).toContain("cheen-machine reference");
  });
});
