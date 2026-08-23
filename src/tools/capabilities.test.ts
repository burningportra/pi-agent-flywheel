import { describe, it, expect } from "vitest";
import { buildCapabilities, CAPABILITIES_CONTRACT_VERSION, CANONICAL_PHASES, ERROR_CATEGORIES, ENV_VARS } from "./capabilities.js";
import { TOOL_FAMILIES, canonicalName } from "./shared.js";

describe("R-002: flywheel_capabilities contract", () => {
  it("returns contract_version 1.0", () => {
    const caps = buildCapabilities("9.9.9");
    expect(caps.contract_version).toBe(CAPABILITIES_CONTRACT_VERSION);
  });

  it("canonical_prefix is flywheel_", () => {
    const caps = buildCapabilities("9.9.9");
    expect(caps.canonical_prefix).toBe("flywheel_");
  });

  it("every TOOL_FAMILIES entry appears in capabilities.tools", () => {
    const caps = buildCapabilities("9.9.9");
    const toolFamilies = caps.tools.map((t) => t.family);
    for (const family of Object.keys(TOOL_FAMILIES)) {
      expect(toolFamilies).toContain(family);
    }
  });

  it("every tool's canonical_name uses flywheel_ prefix", () => {
    const caps = buildCapabilities("9.9.9");
    for (const t of caps.tools) {
      expect(t.canonical_name, `family ${t.family}`).toMatch(/^flywheel_/);
    }
  });

  it("no tool has any deprecated_aliases (legacy prefixes removed)", () => {
    const caps = buildCapabilities("9.9.9");
    for (const t of caps.tools) {
      expect(t.deprecated_aliases.length, `family ${t.family}`).toBe(0);
    }
  });

  it("phases are 1..6 and reference canonical names", () => {
    const caps = buildCapabilities("9.9.9");
    expect(caps.phases.length).toBe(6);
    for (const [i, p] of caps.phases.entries()) {
      expect(p.position).toBe(i + 1);
      expect(p.canonical_tool).toMatch(/^flywheel_/);
    }
  });

  it("every error_category fix_command references a real canonical name (or `br` external)", () => {
    const caps = buildCapabilities("9.9.9");
    const canonicalNames = caps.tools.map((t) => t.canonical_name);
    for (const [code, cat] of Object.entries(caps.error_categories)) {
      expect(cat.code, `error category ${code}`).toBe(code);
      const fixToken = cat.fix_command.split(/[\s({]/)[0];
      const isCanonical = canonicalNames.includes(fixToken);
      const isExternalBr = fixToken === "br";
      expect(isCanonical || isExternalBr, `fix_command '${cat.fix_command}' should reference a registered canonical tool or 'br'`).toBe(true);
    }
  });

  it("env_vars no longer include the removed FLYWHEEL_SUPPRESS_DEPRECATION", () => {
    const caps = buildCapabilities("9.9.9");
    const names = caps.env_vars.map((e) => e.name);
    expect(names).not.toContain("FLYWHEEL_SUPPRESS_DEPRECATION");
  });

  it("doctor_ref / triage_ref / robot_docs_ref all point at canonical names", () => {
    const caps = buildCapabilities("9.9.9");
    expect(caps.doctor_ref).toBe(canonicalName("doctor"));
    expect(caps.triage_ref).toBe(canonicalName("triage"));
    expect(caps.robot_docs_ref).toBe(canonicalName("robot_docs"));
  });

  it("output is JSON-serializable and stable across repeated calls (excluding generated_at)", () => {
    const a = buildCapabilities("1.2.12");
    const b = buildCapabilities("1.2.12");
    delete (a as any).generated_at;
    delete (b as any).generated_at;
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
