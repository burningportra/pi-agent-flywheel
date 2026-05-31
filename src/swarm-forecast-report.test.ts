import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { SwarmForecastFixture } from "./swarm-forecast.js";
import {
  buildSwarmForecastReport,
  canonicalForecastJson,
  formatSwarmForecastLaunchAdvisory,
  renderSwarmForecastMarkdown,
  strictBreaches,
  writeSwarmForecastReport,
} from "./swarm-forecast-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const fixtureRoot = join(repoRoot, "tests", "fixtures", "swarm_forecast");

function readFixture(id: string): SwarmForecastFixture {
  return JSON.parse(readFileSync(join(fixtureRoot, "scenarios", `${id}.json`), "utf8")) as SwarmForecastFixture;
}

describe("swarm forecast report artifacts", () => {
  it("builds the combined report envelope", () => {
    const fixture = readFixture("file_contention");
    const report = buildSwarmForecastReport({
      input: fixture.input,
      source: { kind: "fixture", path: "file_contention.json" },
      generatedAt: "2026-05-10T14:30:00.000Z",
      artifacts: { json: "out/latest.json", markdown: "out/latest.md" },
    });
    expect(report.schema).toBe("swarm-forecast-report.v1");
    expect(report.source).toEqual({ kind: "fixture", path: "file_contention.json" });
    expect(report.input_counts.beads).toBe(3);
    expect(report.forecast.risks[0]?.kind).toBe("file-contention");
    expect(report.build_lanes.summary.dominant_constraint).toBe("file-bound");
    expect(report.agent_fit.schema).toBe("swarm-forecast-agent-fit.v1");
    expect(report.artifacts.json).toBe("out/latest.json");
  });

  it("renders required operator sections in Markdown", () => {
    const fixture = readFixture("build_lane_saturation");
    const report = buildSwarmForecastReport({ input: fixture.input, source: { kind: "fixture" }, generatedAt: "2026-05-10T14:30:00.000Z" });
    const markdown = renderSwarmForecastMarkdown(report);
    expect(markdown).toContain("# Swarm Forecast Report");
    expect(markdown).toContain("## Forecast Summary");
    expect(markdown).toContain("## Top Bottlenecks");
    expect(markdown).toContain("## Critical Path");
    expect(markdown).toContain("## File Contention");
    expect(markdown).toContain("## Build-Lane Pressure");
    expect(markdown).toContain("## Agent Fit and Stale Holders");
    expect(markdown).toContain("## Dry-Run Actions");
    expect(markdown).toContain("## What Not To Automate");
    expect(markdown).toContain("mutation=none; dry_run_only=true");
  });

  it("writes stable JSON and Markdown artifacts to the requested directory only", () => {
    const tmp = mkdtempSync(join(tmpdir(), "swarm-forecast-report-"));
    try {
      const fixture = readFixture("agent_capability_mix");
      const report = writeSwarmForecastReport({
        input: fixture.input,
        source: { kind: "fixture", path: "agent_capability_mix.json" },
        generatedAt: "2026-05-10T14:30:00.000Z",
        outputDir: tmp,
        basename: "latest",
      });
      const jsonPath = join(tmp, "latest.json");
      const mdPath = join(tmp, "latest.md");
      expect(report.artifacts).toEqual({ json: jsonPath, markdown: mdPath });
      expect(readFileSync(jsonPath, "utf8")).toBe(canonicalForecastJson(report));
      expect(readFileSync(mdPath, "utf8")).toContain("Swarm Forecast Report");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("strict threshold breaches are deterministic", () => {
    const fixture = readFixture("stale_agent_handoff");
    const report = buildSwarmForecastReport({
      input: fixture.input,
      source: { kind: "fixture" },
      strictThresholds: { max_critical_risks: 0, max_saturated_lanes: 0, max_stale_holders: 0 },
    });
    expect((report.strict as { breach_count: number }).breach_count).toBe(2);
    expect((report.strict as { breaches: Array<{ id: string }> }).breaches.map((item) => item.id)).toEqual(["critical-risks", "stale-holders"]);
  });

  it("strictBreaches returns no breaches for green empty queue", () => {
    const fixture = readFixture("empty_queue");
    const report = buildSwarmForecastReport({ input: fixture.input, source: { kind: "fixture" } });
    expect(strictBreaches(report.forecast, report.build_lanes, report.agent_fit, {
      max_critical_risks: 0,
      max_saturated_lanes: 0,
      max_stale_holders: 0,
    })).toEqual([]);
  });

  it("formats launch advisory as read-only copy guidance", () => {
    const fixture = readFixture("file_contention");
    const report = buildSwarmForecastReport({ input: fixture.input, source: { kind: "fixture" } });
    const advisory = formatSwarmForecastLaunchAdvisory(report);
    expect(advisory).toContain("Swarm Forecast (read-only)");
    expect(advisory).toContain("file-contention");
    expect(advisory).toContain("mutation=none, dry_run_only=true");
    expect(advisory).toContain("do not auto-assign agents");
  });

  it("review parallel-launch branch invokes forecast as fail-open advisory before pi-subagent launch text", () => {
    const reviewSource = readFileSync(join(__dirname, "tools", "review.ts"), "utf8");
    expect(reviewSource).toContain("buildSwarmForecastInput");
    expect(reviewSource).toContain("writeSwarmForecastReport");
    expect(reviewSource).toContain("formatSwarmForecastLaunchAdvisory");
    expect(reviewSource.indexOf("formatSwarmForecastLaunchAdvisory")).toBeLessThan(reviewSource.indexOf("Launch clear-context pi-subagents for implementation"));
    expect(reviewSource).toContain("Failing open: launch instructions are still shown.");
    expect(reviewSource).not.toContain("forceReleaseFileReservation(");
    expect(reviewSource).not.toContain("sendMessage(exec");
    expect(reviewSource).not.toContain("Launch the NTM implementation swarm now");
  });
});
