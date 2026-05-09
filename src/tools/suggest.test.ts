import { describe, it, expect } from "vitest";
import { findClosestToolName, allRegisteredToolNames } from "./suggest.js";

describe("R-007: flywheel_suggest typo / wrong-prefix correction", () => {
  it("exact canonical match returns distance 0", () => {
    const r = findClosestToolName("flywheel_doctor");
    expect(r.canonical).toBe("flywheel_doctor");
    expect(r.distance).toBe(0);
    expect(r.is_registered).toBe(true);
    expect(r.is_legacy_alias).toBe(false);
  });

  it("legacy alias resolves to canonical with is_legacy_alias=true", () => {
    const r = findClosestToolName("orch_doctor");
    expect(r.canonical).toBe("flywheel_doctor");
    expect(r.is_registered).toBe(true);
    expect(r.is_legacy_alias).toBe(true);
    expect(r.hint).toContain("legacy alias");
  });

  it("typo (drop char) suggests the correct canonical", () => {
    const r = findClosestToolName("flywhel_doctor"); // drop "e"
    expect(r.canonical).toBe("flywheel_doctor");
    expect(r.is_registered).toBe(false);
    expect(r.distance).toBeGreaterThan(0);
    expect(r.hint).toMatch(/Did you mean|Closest match/);
  });

  it("wrong-prefix typo suggests the canonical equivalent", () => {
    const r = findClosestToolName("fwheel_doctor");
    expect(r.canonical).toBe("flywheel_doctor");
    expect(r.hint).toContain("flywheel_doctor");
  });

  it("totally unrelated string returns distance > 4 with no canonical", () => {
    const r = findClosestToolName("xyzfoobar");
    expect(r.canonical).toBe(null);
    expect(r.distance).toBeGreaterThan(4);
    expect(r.hint).toContain("flywheel_capabilities");
  });

  it("legacy alias for the discover family resolves to flywheel_discover", () => {
    expect(findClosestToolName("agent_flywheel_discover").canonical).toBe("flywheel_discover");
    expect(findClosestToolName("orch_discover").canonical).toBe("flywheel_discover");
  });

  it("allRegisteredToolNames contains every legacy + canonical name (>= 30 entries)", () => {
    expect(allRegisteredToolNames().length).toBeGreaterThanOrEqual(30);
  });
});
