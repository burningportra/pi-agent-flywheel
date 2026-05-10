import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  SWARM_FORECAST_FIXTURE_SCHEMA,
  SWARM_FORECAST_FIXTURES_SCHEMA,
  SWARM_FORECAST_INPUT_SCHEMA,
  SWARM_FORECAST_OUTPUT_SCHEMA,
  collectFixtureActionViolations,
  forecastAgentFit,
  forecastBuildLanes,
  forecastFromInput,
  sanitizeForecastEvidence,
  summarizeForecastInput,
  type SwarmForecastFixture,
  type SwarmForecastFixtureManifest,
} from "./swarm-forecast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const fixtureRoot = join(repoRoot, "tests", "fixtures", "swarm_forecast");
const scenarioRoot = join(fixtureRoot, "scenarios");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function loadManifest(): SwarmForecastFixtureManifest {
  return readJson<SwarmForecastFixtureManifest>(join(fixtureRoot, "manifest.json"));
}

function loadFixture(entryPath: string): SwarmForecastFixture {
  return readJson<SwarmForecastFixture>(join(fixtureRoot, entryPath));
}

describe("swarm forecast fixture corpus", () => {
  it("contains the expected baseline scenarios", () => {
    const manifest = loadManifest();
    expect(manifest.schema).toBe(SWARM_FORECAST_FIXTURES_SCHEMA);
    expect(manifest.scenarios.map((item) => item.id)).toEqual([
      "empty_queue",
      "single_critical_path",
      "file_contention",
      "build_lane_saturation",
      "agent_capability_mix",
      "stale_agent_handoff",
      "high_cardinality_120",
    ]);
    for (const entry of manifest.scenarios) {
      expect(existsSync(join(fixtureRoot, entry.path))).toBe(true);
    }
  });

  it("includes a schema file and scenario directory", () => {
    expect(existsSync(join(fixtureRoot, "schema.v1.json"))).toBe(true);
    expect(readdirSync(scenarioRoot).filter((name) => name.endsWith(".json")).sort()).toHaveLength(7);
  });

  it("all fixtures load with required saved-input and forecast sections", () => {
    for (const entry of loadManifest().scenarios) {
      const fixture = loadFixture(entry.path);
      expect(fixture.schema).toBe(SWARM_FORECAST_FIXTURE_SCHEMA);
      expect(fixture.id).toBe(entry.id);
      expect(fixture.input.schema).toBe(SWARM_FORECAST_INPUT_SCHEMA);
      expect(Array.isArray(fixture.input.beads)).toBe(true);
      expect(Array.isArray(fixture.input.agents)).toBe(true);
      expect(Array.isArray(fixture.input.agent_activity)).toBe(true);
      expect(Array.isArray(fixture.input.file_reservations)).toBe(true);
      expect(Array.isArray(fixture.input.build_lanes)).toBe(true);
      expect(Array.isArray(fixture.input.validation_history)).toBe(true);
      expect(fixture.expected_output.schema).toBe(SWARM_FORECAST_OUTPUT_SCHEMA);
      expect(fixture.expected_output.summary).toBeDefined();
      expect(Array.isArray(fixture.expected_output.risks)).toBe(true);
      expect(Array.isArray(fixture.expected_output.suggested_dry_run_actions)).toBe(true);
      expect(fixture.expected_output.confidence).toBeDefined();
    }
  });

  it("keeps every expected action dry-run-only and non-mutating", () => {
    for (const entry of loadManifest().scenarios) {
      const fixture = loadFixture(entry.path);
      expect(collectFixtureActionViolations(fixture), entry.id).toEqual([]);
    }
  });

  it("stores deterministic manifest hashes for scenario inputs", () => {
    for (const entry of loadManifest().scenarios) {
      const fixture = loadFixture(entry.path);
      expect(entry.input_sha256).toBe(canonicalSha256(fixture.input));
    }
  });

  it("high-cardinality fixture covers at least 100 beads and agents", () => {
    const fixture = loadFixture("scenarios/high_cardinality_120.json");
    const counts = summarizeForecastInput(fixture.input);
    expect(counts.beads).toBeGreaterThanOrEqual(100);
    expect(counts.agents).toBeGreaterThanOrEqual(100);
    expect(fixture.expected_output.summary.truncated_sections).toEqual({ actions: 5, risks: 5 });
  });

  it("covers stale holders, file contention, and build-lane saturation explicitly", () => {
    const stale = loadFixture("scenarios/stale_agent_handoff.json");
    expect(stale.input.file_reservations.some((item) => item.state === "expired")).toBe(true);
    expect(stale.expected_output.risks.some((risk) => risk.kind === "stale-agent-handoff")).toBe(true);

    const contention = loadFixture("scenarios/file_contention.json");
    expect(contention.expected_output.risks.some((risk) => risk.kind === "file-contention")).toBe(true);
    expect(contention.expected_output.risks[0]?.affected_paths).toContain("src/tools/review.ts");

    const lanes = loadFixture("scenarios/build_lane_saturation.json");
    expect(lanes.input.build_lanes.some((lane) => lane.running + lane.queued > lane.capacity)).toBe(true);
    expect(lanes.expected_output.risks.some((risk) => risk.kind === "build-lane-saturation")).toBe(true);
  });
});

describe("swarm forecast contracts", () => {
  it("summarizeForecastInput returns stable input section counts", () => {
    const fixture = loadFixture("scenarios/agent_capability_mix.json");
    expect(summarizeForecastInput(fixture.input)).toEqual({
      beads: 2,
      agents: 3,
      agent_activity: 2,
      file_reservations: 0,
      build_lanes: 0,
      validation_history: 0,
    });
  });

  it("source contract module has no live collection imports or calls", () => {
    const source = readFileSync(join(__dirname, "swarm-forecast.ts"), "utf8");
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/\bexec\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bcurl\b/);
    expect(source).not.toMatch(/brExec|brExecJson|agentMailRPC|sendMessage|forceRelease|releaseReservation/);
  });
});

describe("swarm forecast pure engine", () => {
  it("matches committed golden outputs for every fixture", () => {
    for (const entry of loadManifest().scenarios) {
      const fixture = loadFixture(entry.path);
      expect(forecastFromInput(fixture.input), entry.id).toEqual(fixture.expected_output);
    }
  });

  it("adding independent work does not increase existing contention", () => {
    const fixture = loadFixture("scenarios/file_contention.json");
    const original = forecastFromInput(fixture.input);
    const expanded = forecastFromInput({
      ...fixture.input,
      beads: [
        ...fixture.input.beads,
        {
          id: "forecast-independent",
          title: "Independent docs cleanup",
          status: "open",
          priority: 3,
          depends_on: [],
          labels: ["docs"],
          files: ["docs/independent.md"],
          validation_lanes: [],
        },
      ],
    });
    expect(expanded.risks[0]?.kind).toBe("file-contention");
    expect(expanded.risks[0]?.affected_beads).toEqual(original.risks[0]?.affected_beads);
    expect(expanded.risks[0]?.affected_paths).toEqual(original.risks[0]?.affected_paths);
  });

  it("closing an upstream blocker does not lengthen the critical path", () => {
    const fixture = loadFixture("scenarios/single_critical_path.json");
    const originalLength = forecastFromInput(fixture.input).summary.critical_path.length;
    const closedInput = {
      ...fixture.input,
      beads: fixture.input.beads.map((bead) => bead.id === "forecast-a" ? { ...bead, status: "closed" as const } : bead),
    };
    expect(forecastFromInput(closedInput).summary.critical_path.length).toBeLessThanOrEqual(originalLength);
  });

  it("build-lane forecast respects capacity overrides", () => {
    const fixture = loadFixture("scenarios/build_lane_saturation.json");
    const defaultForecast = forecastBuildLanes(fixture.input);
    const constrained = forecastBuildLanes(fixture.input, { cpu_cores: 1, ram_mb: 512, max_parallel_validation_jobs: 1 });
    expect(defaultForecast.summary.dominant_constraint).toBe("build-lane-bound");
    expect(constrained.config.cpu_cores).toBe(1);
    expect(constrained.summary.saturated_lanes).toContain("npm-test");
  });

  it("agent-fit evidence is sanitized", () => {
    const fixture = loadFixture("scenarios/agent_capability_mix.json");
    const fit = forecastAgentFit(fixture.input);
    const raw = JSON.stringify(fit);
    expect(raw).not.toContain("secret-value");
    expect(raw).not.toContain("Bearer abc123");
    expect(raw).toContain("token=<redacted>");
    expect(raw).toContain("Bearer <redacted>");
    expect(sanitizeForecastEvidence("api_key=abc123 sk-testsecret12345")).toBe("api_key=<redacted> sk-<redacted>");
  });
});
