import { readFileSync } from "node:fs";
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

  it("references the canonical capabilities/status/triage/doctor tools", () => {
    const docs = buildRobotDocs();
    expect(docs).toContain(canonicalName("capabilities"));
    expect(docs).toContain(canonicalName("status"));
    expect(docs).toContain(canonicalName("triage"));
    expect(docs).toContain(canonicalName("doctor"));
    expect(docs).toContain(canonicalName("robot_docs"));
  });

  it("documents flywheel_status as the recovery-first call after reload or compaction", () => {
    const docs = buildRobotDocs();
    expect(docs).toContain("flywheel_status       # recovery-first");
    expect(docs).toContain("after reload, compaction, or handoff");
  });

  it("docs drop the removed FLYWHEEL_SUPPRESS_DEPRECATION env var", () => {
    const docs = buildRobotDocs();
    expect(docs).not.toContain("FLYWHEEL_SUPPRESS_DEPRECATION");
    expect(docs).toContain("FLYWHEEL_CHECKPOINT_TTL_DAYS");
  });

  it("output is stable bytes across calls", () => {
    expect(buildRobotDocs()).toBe(buildRobotDocs());
  });

  it("starts with the expected header", () => {
    expect(buildRobotDocs()).toMatch(/^# pi-agent-flywheel — Agent Handbook/);
  });

  it("documents NTM implementation pane mix", () => {
    const docs = buildRobotDocs();
    expect(docs).toContain("## 7. NTM implementation panes");
    expect(docs).toContain("--cursor");
    expect(docs).toContain("official Cursor Agent CLI command `agent`");
    expect(docs).toContain("preferred over `--gmi`");
  });

  it("documents provider preflight diagnostics and unauthorized repair guidance", () => {
    const docs = buildRobotDocs();
    expect(docs).toContain("provider_preflight.not_checked");
    expect(docs).toContain("bounded provider/model preflight probes");
    expect(docs).toContain("OAuth 403");
    expect(docs).toContain("switch provider/model");
    expect(docs).toContain("downgrade worker count");
  });

  it("documents the read-only release checklist workflow", () => {
    const docs = buildRobotDocs();
    expect(docs).toContain("/flywheel-release-checklist        # canonical");
    expect(docs).toContain("/agent-flywheel-release-checklist  # legacy alias");
    expect(docs).not.toContain("/orchestrate-release-checklist");
    expect(docs).toContain("package.json/package-lock consistency");
    expect(docs).toContain("dirty scope unknown");
    expect(docs).toContain("build/test/UBS");
    expect(docs).toContain("docs/release-checklist.md");
    expect(docs).toContain("never commits, tags, publishes, bumps versions, resets, cleans, or mutates files");
  });

  it("keeps the user-facing release checklist guide aligned with robot guidance", () => {
    const guide = readFileSync("docs/release-checklist.md", "utf8");
    expect(guide).toContain("/agent-flywheel-release-checklist");
    expect(guide).toContain("package.json");
    expect(guide).toContain("package-lock.json");
    expect(guide).toContain("Dirty-file scope");
    expect(guide).toContain("build, test, and UBS");
    expect(guide).toContain("does **not**");
    expect(guide).toContain("commit changes");
    expect(guide).toContain("mutate files");
  });
});
