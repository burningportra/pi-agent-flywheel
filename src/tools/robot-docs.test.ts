import { describe, it, expect } from "vitest";
import { buildRobotDocs } from "./robot-docs.js";
import { TOOL_FAMILIES, canonicalName } from "./shared.js";
import { CANONICAL_PHASES, ERROR_CATEGORIES } from "./capabilities.js";

describe("R-003: flywheel_robot_docs handbook", () => {
  it("references every canonical phase tool", () => {
    const docs = buildRobotDocs();
    for (const p of CANONICAL_PHASES) {
      expect(docs, `phase tool ${p.canonical_tool}`).toContain(p.canonical_tool);
    }
  });

  it("references every error code", () => {
    const docs = buildRobotDocs();
    for (const code of Object.keys(ERROR_CATEGORIES)) {
      expect(docs, `error code ${code}`).toContain(code);
    }
  });

  it("references the canonical capabilities/triage/doctor tools", () => {
    const docs = buildRobotDocs();
    expect(docs).toContain(canonicalName("capabilities"));
    expect(docs).toContain(canonicalName("triage"));
    expect(docs).toContain(canonicalName("doctor"));
    expect(docs).toContain(canonicalName("robot_docs"));
  });

  it("documents both deprecation env vars", () => {
    const docs = buildRobotDocs();
    expect(docs).toContain("FLYWHEEL_SUPPRESS_DEPRECATION");
    expect(docs).toContain("FLYWHEEL_CHECKPOINT_TTL_DAYS");
  });

  it("output is stable bytes across calls", () => {
    expect(buildRobotDocs()).toBe(buildRobotDocs());
  });

  it("starts with the expected header", () => {
    expect(buildRobotDocs()).toMatch(/^# pi-agent-flywheel — Agent Handbook/);
  });
});
