import { describe, expect, it } from "vitest";
import type { Bead } from "./types.js";
import {
  buildSwarmForecastInput,
  inferValidationLanes,
  normalizeForecastActivity,
  normalizeForecastAgents,
  normalizeForecastReservations,
} from "./swarm-forecast-adapter.js";

function bead(id: string, status: Bead["status"], description: string, labels: string[] = []): Bead {
  return { id, title: `Title ${id}`, description, status, priority: 1, type: "task", labels };
}

const description = `Implement a thing.

### Verification:
- Commands/checks: run npm test -- src/swarm-forecast.test.ts and npm run build. Also run br dep cycles.
- Success looks like: tests pass.
- Manual proof fallback: inspect output.

### Files:
- src/swarm-forecast.ts
- tests/fixtures/swarm_forecast/schema.v1.json`;

describe("swarm forecast input adapter", () => {
  it("maps beads, dependencies, files, labels, statuses, and validation lanes deterministically", () => {
    const input = buildSwarmForecastInput({
      beads: [bead("b", "open", description, ["swarm"]), bead("a", "closed", description, ["tests"])],
      dependencyMap: { b: ["a"] },
    });
    expect(input.schema).toBe("swarm-forecast-input.v1");
    expect(input.beads.map((item) => item.id)).toEqual(["a", "b"]);
    expect(input.beads[1]).toMatchObject({ id: "b", status: "open", depends_on: ["a"], labels: ["swarm"] });
    expect(input.beads[1].files).toEqual(["src/swarm-forecast.ts", "tests/fixtures/swarm_forecast/schema.v1.json"]);
    expect(input.beads[1].validation_lanes).toEqual(["cli-check", "npm-build", "npm-test"]);
    expect(input.build_lanes.map((lane) => lane.id)).toEqual(["cli-check", "npm-build", "npm-test"]);
  });

  it("infers common validation lanes from contract text", () => {
    expect(inferValidationLanes("run vitest run and tsc --noEmit and pytest tests")).toEqual(["npm-build", "npm-test", "python-unittest"]);
  });

  it("normalizes reservations and stale holders without live calls", () => {
    const reservations = normalizeForecastReservations([
      { id: "7", agent_name: "AgentA", path_pattern: "src/a.ts", state: "expired", exclusive: true },
      { agent: "AgentB", path: "token=abc123", active: false },
    ]);
    expect(reservations).toEqual([
      { id: 2, agent: "AgentB", path_pattern: "token=<redacted>", state: "released", exclusive: true, expires_at: undefined },
      { id: 7, agent: "AgentA", path_pattern: "src/a.ts", state: "expired", exclusive: true, expires_at: undefined },
    ]);
  });

  it("normalizes optional agents and activity with redaction", () => {
    expect(normalizeForecastAgents([{ agent_name: "Runner", status: "stuck", current_bead: "b", capabilities: ["tests"] }])).toEqual([
      { name: "Runner", status: "inactive", last_active_at: undefined, current_bead: "b", capabilities: ["tests"] },
    ]);
    const activity = normalizeForecastActivity([{ agent_name: "Runner", source: "log", summary: "Bearer abc123 token=secret", paths: ["src/a.ts"], tags: ["tests"] }]);
    expect(JSON.stringify(activity)).not.toContain("abc123");
    expect(JSON.stringify(activity)).toContain("Bearer <redacted>");
    expect(JSON.stringify(activity)).toContain("token=<redacted>");
  });

  it("records source warnings and works with unavailable optional data", () => {
    const input = buildSwarmForecastInput({ beads: [bead("solo", "in_progress", "No verification yet.")], sourceWarnings: ["agent mail unavailable"] });
    expect(input.agents).toEqual([]);
    expect(input.file_reservations).toEqual([]);
    expect(input.source_warnings).toEqual(["agent mail unavailable"]);
    expect(input.beads[0]).toMatchObject({ id: "solo", status: "in_progress", validation_lanes: [] });
  });
});
