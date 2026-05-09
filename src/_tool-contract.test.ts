import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TOOL_FAMILIES, TOOL_CANONICAL_PREFIX, canonicalName, emitToolDeprecationWarning, _resetDeprecationCache, SLASH_CANONICAL, emitSlashDeprecationWarning, _resetSlashDeprecationCache } from "./tools/shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, "tools");

const FAMILY_FILES: Record<keyof typeof TOOL_FAMILIES, string> = {
  profile: "profile.ts",
  discover: "discover.ts",
  select: "select.ts",
  plan: "plan.ts",
  approve_beads: "approve.ts",
  review: "review.ts",
  memory: "memory-tool.ts",
  doctor: "doctor.ts",
  verify_beads: "verify-beads.ts",
  audit_beads: "compliance-audit.ts",
  capabilities: "capabilities.ts",
  robot_docs: "robot-docs.ts",
  triage: "triage.ts",
};

describe("R-009: tool contract — canonical names pinned", () => {
  it("every TOOL_FAMILIES canonical name uses the flywheel_ prefix", () => {
    for (const family of Object.keys(TOOL_FAMILIES) as (keyof typeof TOOL_FAMILIES)[]) {
      const canon = canonicalName(family);
      expect(canon, `family '${family}' canonical='${canon}'`).toMatch(new RegExp(`^${TOOL_CANONICAL_PREFIX}`));
    }
  });

  it("the 10 legacy tool families all have exactly 3 names (agent_flywheel_*, orch_*, flywheel_*)", () => {
    const legacyFamilies = [
      "profile", "discover", "select", "plan", "approve_beads",
      "review", "memory", "doctor", "verify_beads", "audit_beads",
    ] as const;
    for (const family of legacyFamilies) {
      const names = TOOL_FAMILIES[family];
      expect(names.length, `family '${family}'`).toBe(3);
      expect(names[names.length - 1], `${family}: canonical (last)`).toMatch(/^flywheel_/);
    }
  });

  it("each tool source file references its declared TOOL_FAMILIES names", () => {
    for (const [family, file] of Object.entries(FAMILY_FILES)) {
      const names = TOOL_FAMILIES[family as keyof typeof TOOL_FAMILIES];
      // Some tools (capabilities, robot-docs, triage) are added in subsequent recs.
      // Skip if the file does not yet exist.
      let src: string;
      try {
        src = readFileSync(join(TOOLS_DIR, file), "utf8");
      } catch {
        continue;
      }
      for (const n of names) {
        expect(src, `${file} should reference tool name '${n}'`).toContain(n);
      }
    }
  });

  it("deprecation warning fires only on non-canonical names and is one-shot per pair", () => {
    _resetDeprecationCache();
    const warns: string[] = [];
    const orig = console.warn;
    const prevSuppress = process.env.FLYWHEEL_SUPPRESS_DEPRECATION;
    delete process.env.FLYWHEEL_SUPPRESS_DEPRECATION;
    console.warn = (msg: string) => warns.push(msg);
    try {
      emitToolDeprecationWarning("agent_flywheel_select", "flywheel_select");
      emitToolDeprecationWarning("agent_flywheel_select", "flywheel_select"); // duplicate, suppressed
      emitToolDeprecationWarning("flywheel_select", "flywheel_select"); // canonical, suppressed
      emitToolDeprecationWarning("orch_select", "flywheel_select"); // distinct alias, fires
    } finally {
      console.warn = orig;
      if (prevSuppress !== undefined) process.env.FLYWHEEL_SUPPRESS_DEPRECATION = prevSuppress;
    }
    expect(warns.length).toBe(2);
    expect(warns[0]).toContain("agent_flywheel_select");
    expect(warns[0]).toContain("flywheel_select");
    expect(warns[1]).toContain("orch_select");
  });

  it("FLYWHEEL_SUPPRESS_DEPRECATION env var suppresses warnings", () => {
    _resetDeprecationCache();
    const warns: string[] = [];
    const orig = console.warn;
    const prev = process.env.FLYWHEEL_SUPPRESS_DEPRECATION;
    console.warn = (msg: string) => warns.push(msg);
    process.env.FLYWHEEL_SUPPRESS_DEPRECATION = "1";
    try {
      emitToolDeprecationWarning("agent_flywheel_select", "flywheel_select");
    } finally {
      console.warn = orig;
      if (prev === undefined) delete process.env.FLYWHEEL_SUPPRESS_DEPRECATION;
      else process.env.FLYWHEEL_SUPPRESS_DEPRECATION = prev;
    }
    expect(warns.length).toBe(0);
  });

  it("no error throw in src/tools/*.ts references legacy prefixes", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(TOOLS_DIR)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(TOOLS_DIR, file), "utf8");
      const re = /throw new Error\([^)]*?(orch_[a-z_]+|agent_flywheel_[a-z_]+)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders, `legacy-prefix names in throws: ${offenders.join(", ")}`).toEqual([]);
  });

  it("R-005: SLASH_CANONICAL maps every legacy alias to a flywheel-* canonical", () => {
    for (const [alias, canonical] of Object.entries(SLASH_CANONICAL)) {
      expect(canonical, `alias ${alias} -> ${canonical}`).toMatch(/^flywheel-/);
      expect(alias).not.toBe(canonical);
    }
  });

  it("R-005: slash deprecation warning fires for legacy aliases and is one-shot", () => {
    _resetSlashDeprecationCache();
    const warns: string[] = [];
    const orig = console.warn;
    const prevSuppress = process.env.FLYWHEEL_SUPPRESS_DEPRECATION;
    delete process.env.FLYWHEEL_SUPPRESS_DEPRECATION;
    console.warn = (msg: string) => warns.push(msg);
    try {
      emitSlashDeprecationWarning("agent-flywheel-doctor"); // legacy alias
      emitSlashDeprecationWarning("agent-flywheel-doctor"); // duplicate
      emitSlashDeprecationWarning("flywheel-doctor"); // canonical, suppressed
      emitSlashDeprecationWarning("memory"); // not in map, suppressed
    } finally {
      console.warn = orig;
      if (prevSuppress !== undefined) process.env.FLYWHEEL_SUPPRESS_DEPRECATION = prevSuppress;
    }
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("agent-flywheel-doctor");
    expect(warns[0]).toContain("flywheel-doctor");
  });

  it("R-011: codebaseAuditOptions is registered under all 3 audit aliases", () => {
    const src = readFileSync(join(__dirname, "commands.ts"), "utf8");
    expect(src).toContain('pi.registerCommand("flywheel-audit", codebaseAuditOptions)');
    expect(src).toContain('pi.registerCommand("orchestrate-audit", { ...codebaseAuditOptions');
    expect(src).toContain('pi.registerCommand("agent-flywheel-audit", { ...codebaseAuditOptions');
  });

  it("doctor.ts has 3-name symmetry matching the other 9 tool families", () => {
    const src = readFileSync(join(TOOLS_DIR, "doctor.ts"), "utf8");
    for (const n of TOOL_FAMILIES.doctor) {
      expect(src, `doctor.ts should reference '${n}'`).toContain(n);
    }
    expect(src).toMatch(/for\s*\(\s*const\s+toolName\s+of/);
  });
});
