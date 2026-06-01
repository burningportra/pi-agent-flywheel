import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { detectAgentGuidanceFiles } from "./profiler.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-guidance-detector-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("detectAgentGuidanceFiles", () => {
  it("finds a root AGENTS.md file and returns repository-relative evidence", () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Agent guidance\n", "utf8");

    const detection = detectAgentGuidanceFiles(tmpDir);

    expect(detection).toEqual({
      found: true,
      files: ["AGENTS.md"],
      checked: ["AGENTS.md"],
    });
    expect(detection.files[0]).not.toContain(tmpDir);
  });

  it("returns no match when no candidate file exists", () => {
    const detection = detectAgentGuidanceFiles(tmpDir);

    expect(detection).toEqual({
      found: false,
      files: [],
      checked: ["AGENTS.md"],
    });
  });

  it("does not count a directory named AGENTS.md as guidance", () => {
    mkdirSync(join(tmpDir, "AGENTS.md"));

    const detection = detectAgentGuidanceFiles(tmpDir);

    expect(detection.found).toBe(false);
    expect(detection.files).toEqual([]);
    expect(detection.checked).toEqual(["AGENTS.md"]);
  });

  it("handles a relative repo root by resolving it before checking candidates", () => {
    writeFileSync(join(tmpDir, "AGENTS.md"), "# Agent guidance\n", "utf8");
    const relativeRoot = relative(process.cwd(), tmpDir);

    const detection = detectAgentGuidanceFiles(relativeRoot);

    expect(detection.found).toBe(true);
    expect(detection.files).toEqual(["AGENTS.md"]);
    expect(detection.checked).toEqual(["AGENTS.md"]);
  });
});
