import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TOOL_FAMILIES, TOOL_CANONICAL_PREFIX, canonicalName } from "./tools/shared.js";

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
  status: "status.ts",
  verify_beads: "verify-beads.ts",
  audit_beads: "compliance-audit.ts",
  research: "research.ts",
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

  it("every TOOL_FAMILIES canonical name is flywheel_ (aliases are agent_flywheel_/orch_)", () => {
    for (const family of Object.keys(TOOL_FAMILIES) as (keyof typeof TOOL_FAMILIES)[]) {
      const names = TOOL_FAMILIES[family];
      const canon = names[names.length - 1];
      expect(canon, `family '${family}'`).toMatch(new RegExp(`^${TOOL_CANONICAL_PREFIX}`));
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

  it("R-011: codebaseAuditOptions is registered under both audit aliases", () => {
    const src = readFileSync(join(__dirname, "commands.ts"), "utf8");
    expect(src).toContain('pi.registerCommand("flywheel-audit", codebaseAuditOptions)');
    expect(src).toContain('pi.registerCommand("agent-flywheel-audit", { ...codebaseAuditOptions');
  });

  it("doctor.ts registers agent_flywheel_doctor, orch_doctor, flywheel_doctor", () => {
    const src = readFileSync(join(TOOLS_DIR, "doctor.ts"), "utf8");
    for (const n of TOOL_FAMILIES.doctor) {
      expect(src, `doctor.ts should reference '${n}'`).toContain(n);
    }
    expect(src).toMatch(/for\s*\(\s*const\s+toolName\s+of/);
  });
});
