import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  buildRecommendedChecks,
  buildReleaseChecklist,
  classifyDirtyFiles,
  formatReleaseChecklist,
  readPackageVersionStatus,
} from "./release-checklist.js";

function makeTempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "release-checklist-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function packageJson(version: string): string {
  return JSON.stringify({ name: "demo", version }, null, 2);
}

function packageLock(version: string, rootVersion = version): string {
  return JSON.stringify({
    name: "demo",
    version,
    lockfileVersion: 3,
    packages: {
      "": { name: "demo", version: rootVersion },
    },
  }, null, 2);
}

describe("readPackageVersionStatus", () => {
  it("reports matching package and lock versions", () => {
    const cwd = makeTempProject({
      "package.json": packageJson("1.2.3"),
      "package-lock.json": packageLock("1.2.3"),
    });

    expect(readPackageVersionStatus(cwd)).toEqual({
      packageJsonVersion: "1.2.3",
      packageLockVersion: "1.2.3",
      packageLockRootVersion: "1.2.3",
      versionsMatch: true,
      issues: [],
    });
  });

  it("reports top-level package-lock mismatches", () => {
    const cwd = makeTempProject({
      "package.json": packageJson("1.2.3"),
      "package-lock.json": packageLock("1.2.4", "1.2.3"),
    });

    const status = readPackageVersionStatus(cwd);
    expect(status.versionsMatch).toBe(false);
    expect(status.issues).toContain("package-lock.json version 1.2.4 does not match package.json version 1.2.3");
  });

  it("reports root package package-lock mismatches", () => {
    const cwd = makeTempProject({
      "package.json": packageJson("1.2.3"),
      "package-lock.json": packageLock("1.2.3", "1.2.4"),
    });

    const status = readPackageVersionStatus(cwd);
    expect(status.versionsMatch).toBe(false);
    expect(status.issues).toContain('package-lock.json packages[""].version 1.2.4 does not match package.json version 1.2.3');
  });

  it("handles missing and malformed files without throwing", () => {
    const missingLock = makeTempProject({ "package.json": packageJson("1.0.0") });
    expect(readPackageVersionStatus(missingLock).issues.some((issue) => issue.includes("package-lock.json"))).toBe(true);

    const malformed = makeTempProject({
      "package.json": "{bad json",
      "package-lock.json": packageLock("1.0.0"),
    });
    expect(readPackageVersionStatus(malformed).issues.some((issue) => issue.includes("package.json"))).toBe(true);
  });
});

describe("classifyDirtyFiles", () => {
  it("groups release-relevant dirty files by scope", () => {
    const groups = classifyDirtyFiles([
      " M package.json",
      " M src/index.ts",
      " M src/index.test.ts",
      " M README.md",
      " M .beads/issues.jsonl",
      "?? .pi-flywheel/state.json",
      "?? scripts/release.mjs",
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "Bead metadata",
      "Docs",
      "Generated/runtime metadata",
      "Package metadata",
      "Source",
      "Tests",
      "Unknown",
    ]);
    expect(groups.find((group) => group.label === "Package metadata")?.severity).toBe("warning");
    expect(groups.find((group) => group.label === "Tests")?.files).toEqual(["M src/index.test.ts"]);
  });

  it("handles rename status lines by using the destination path", () => {
    const groups = classifyDirtyFiles(["R  docs/old.md -> docs/new.md"]);
    expect(groups).toEqual([{ label: "Docs", files: ["R docs/new.md"], severity: "info" }]);
  });
});

describe("buildRecommendedChecks", () => {
  it("recommends build, full test suite, and UBS over changed non-bead files", () => {
    expect(buildRecommendedChecks([" M package.json", " M .beads/issues.jsonl", "?? src/new.ts"])).toEqual([
      "npm run build",
      "npm test",
      "ubs 'package.json' 'src/new.ts'",
    ]);
  });

  it("shell-quotes UBS paths so copy-pasted checks cannot expand shell syntax", () => {
    expect(buildRecommendedChecks(["?? src/weird $(touch pwned)'file.ts"] as string[])).toContain(
      "ubs 'src/weird $(touch pwned)'\\''file.ts'",
    );
  });

  it("falls back to UBS over the repo when no changed files are known", () => {
    expect(buildRecommendedChecks([])).toContain("ubs .");
  });
});

describe("buildReleaseChecklist and formatReleaseChecklist", () => {
  it("builds a non-mutating checklist with next steps", () => {
    const cwd = makeTempProject({
      "package.json": packageJson("2.0.0"),
      "package-lock.json": packageLock("2.0.0"),
    });
    const checklist = buildReleaseChecklist({ cwd, statusLines: [" M package.json", "?? src/release-checklist.ts"] });
    const formatted = formatReleaseChecklist(checklist);

    expect(checklist.version.versionsMatch).toBe(true);
    expect(checklist.recommendedChecks).toContain("ubs 'package.json' 'src/release-checklist.ts'");
    expect(formatted).toContain("Read-only advisory: no files, git state, package metadata, or bead state were mutated.");
    expect(formatted).toContain("### Copy/paste-ready next steps");
    expect(formatted).toContain("npm run build");
    expect(formatted).toContain("npm test");
  });

  it("reports unknown dirty scope instead of claiming clean checkout when git status is unavailable", () => {
    const cwd = makeTempProject({
      "package.json": packageJson("2.0.0"),
      "package-lock.json": packageLock("2.0.0"),
    });
    const checklist = buildReleaseChecklist({ cwd, statusLines: [], dirtyScopeKnown: false });
    const formatted = formatReleaseChecklist(checklist);

    expect(checklist.dirtyScopeKnown).toBe(false);
    expect(formatted).toContain("Dirty-file scope is unknown");
    expect(formatted).not.toContain("No dirty files detected");
    expect(formatted).toContain("inspect dirty scope manually with `git status --short`");
  });

  it("does not include mutating release commands in recommended checks", () => {
    const cwd = makeTempProject({
      "package.json": packageJson("2.0.0"),
      "package-lock.json": packageLock("2.0.0"),
    });
    const formatted = formatReleaseChecklist(buildReleaseChecklist({ cwd, statusLines: [] }));

    expect(formatted).not.toContain("npm version");
    expect(formatted).not.toContain("git tag");
    expect(formatted).not.toContain("npm publish");
    expect(formatted).not.toContain("git reset");
    expect(formatted).not.toContain("git clean");
  });
});
