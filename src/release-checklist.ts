import { readFileSync } from "fs";
import { join } from "path";

export type ReleaseChecklistSeverity = "info" | "warning";

export interface PackageVersionStatus {
  packageJsonVersion?: string;
  packageLockVersion?: string;
  packageLockRootVersion?: string;
  versionsMatch: boolean;
  issues: string[];
}

export interface DirtyFileGroup {
  label: string;
  files: string[];
  severity: ReleaseChecklistSeverity;
}

export interface ReleaseChecklistResult {
  version: PackageVersionStatus;
  dirtyScopeKnown: boolean;
  dirtyFiles: DirtyFileGroup[];
  recommendedChecks: string[];
  nextSteps: string[];
}

interface DirtyStatusEntry {
  path: string;
  status: string;
}

function readJsonFile(path: string): { ok: true; value: Record<string, unknown> } | { ok: false; issue: string } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, issue: `${path} does not contain a JSON object` };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issue: `Could not read ${path}: ${message}` };
  }
}

function stringField(obj: Record<string, unknown>, field: string): string | undefined {
  return typeof obj[field] === "string" ? obj[field] : undefined;
}

export function readPackageVersionStatus(cwd: string): PackageVersionStatus {
  const issues: string[] = [];
  let packageJsonVersion: string | undefined;
  let packageLockVersion: string | undefined;
  let packageLockRootVersion: string | undefined;

  const packageJson = readJsonFile(join(cwd, "package.json"));
  if (packageJson.ok) {
    packageJsonVersion = stringField(packageJson.value, "version");
    if (!packageJsonVersion) issues.push("package.json is missing a string version field");
  } else {
    issues.push(packageJson.issue);
  }

  const packageLock = readJsonFile(join(cwd, "package-lock.json"));
  if (packageLock.ok) {
    packageLockVersion = stringField(packageLock.value, "version");
    const packages = packageLock.value.packages;
    if (typeof packages === "object" && packages !== null && !Array.isArray(packages)) {
      const root = (packages as Record<string, unknown>)[""];
      if (typeof root === "object" && root !== null && !Array.isArray(root)) {
        packageLockRootVersion = stringField(root as Record<string, unknown>, "version");
      }
    }
    if (!packageLockVersion) issues.push("package-lock.json is missing a string top-level version field");
    if (!packageLockRootVersion) issues.push("package-lock.json is missing packages[\"\"].version");
  } else {
    issues.push(packageLock.issue);
  }

  const expected = packageJsonVersion;
  if (expected && packageLockVersion && packageLockVersion !== expected) {
    issues.push(`package-lock.json version ${packageLockVersion} does not match package.json version ${expected}`);
  }
  if (expected && packageLockRootVersion && packageLockRootVersion !== expected) {
    issues.push(`package-lock.json packages[\"\"].version ${packageLockRootVersion} does not match package.json version ${expected}`);
  }

  return {
    packageJsonVersion,
    packageLockVersion,
    packageLockRootVersion,
    versionsMatch: issues.length === 0,
    issues,
  };
}

function parseStatusLine(line: string): DirtyStatusEntry | null {
  const trimmed = line.trimEnd();
  if (!trimmed) return null;
  const status = trimmed.slice(0, 2).trim() || trimmed.slice(0, 2);
  const rawPath = trimmed.slice(3).trim();
  if (!rawPath) return null;
  const renamePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() ?? rawPath : rawPath;
  return { status, path: renamePath.replace(/^\.\//, "") };
}

function dirtyGroupForPath(path: string): { label: string; severity: ReleaseChecklistSeverity } {
  if (path === "package.json" || path === "package-lock.json" || path === "npm-shrinkwrap.json") {
    return { label: "Package metadata", severity: "warning" };
  }
  if (path.startsWith("src/") && /(?:test|spec)\.[cm]?[tj]sx?$/.test(path)) {
    return { label: "Tests", severity: "info" };
  }
  if (path.startsWith("src/")) {
    return { label: "Source", severity: "warning" };
  }
  if (path.startsWith("docs/") || path === "README.md" || path.endsWith(".md")) {
    return { label: "Docs", severity: "info" };
  }
  if (path.startsWith(".beads/")) {
    return { label: "Bead metadata", severity: "info" };
  }
  if (path.startsWith(".pi-flywheel/") || path.startsWith(".pi-agent-flywheel/") || path.startsWith(".ntm/") || path.startsWith("tmp/")) {
    return { label: "Generated/runtime metadata", severity: "info" };
  }
  return { label: "Unknown", severity: "warning" };
}

export function classifyDirtyFiles(statusLines: string[]): DirtyFileGroup[] {
  const groups = new Map<string, DirtyFileGroup>();
  for (const line of statusLines) {
    const entry = parseStatusLine(line);
    if (entry) {
      const groupInfo = dirtyGroupForPath(entry.path);
      const existing = groups.get(groupInfo.label) ?? { label: groupInfo.label, files: [], severity: groupInfo.severity };
      existing.files.push(`${entry.status} ${entry.path}`.trim());
      if (groupInfo.severity === "warning") existing.severity = "warning";
      groups.set(groupInfo.label, existing);
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function changedFilePaths(statusLines: string[]): string[] {
  const paths: string[] = [];
  for (const line of statusLines) {
    const entry = parseStatusLine(line);
    if (entry) paths.push(entry.path);
  }
  return [...new Set(paths)];
}

function shellQuotePath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function buildRecommendedChecks(statusLines: string[]): string[] {
  const changed = changedFilePaths(statusLines).filter((path) => !path.startsWith(".beads/"));
  const ubsTarget = changed.length > 0 ? changed.map(shellQuotePath).join(" ") : ".";
  return [
    "npm run build",
    "npm test",
    `ubs ${ubsTarget}`,
  ];
}

export function buildReleaseChecklist(input: { cwd: string; statusLines: string[]; dirtyScopeKnown?: boolean }): ReleaseChecklistResult {
  const version = readPackageVersionStatus(input.cwd);
  const dirtyScopeKnown = input.dirtyScopeKnown ?? true;
  const dirtyFiles = dirtyScopeKnown ? classifyDirtyFiles(input.statusLines) : [];
  const recommendedChecks = buildRecommendedChecks(dirtyScopeKnown ? input.statusLines : []);
  const nextSteps = [
    version.versionsMatch
      ? "Package versions match; no version metadata action is needed."
      : "Fix package.json/package-lock.json version mismatches manually, then re-run the checklist.",
    !dirtyScopeKnown
      ? "Git status was unavailable; inspect dirty scope manually with `git status --short` before release."
      : dirtyFiles.length === 0
        ? "Checkout is clean; run the verification commands below before release."
        : "Review dirty-file groups and confirm each file belongs in the intended release scope.",
    `Run verification: ${recommendedChecks.join(" && ")}`,
    "If verification is green, handle commit/tag/publish steps manually according to the project release process.",
  ];
  return { version, dirtyScopeKnown, dirtyFiles, recommendedChecks, nextSteps };
}

export function formatReleaseChecklist(result: ReleaseChecklistResult): string {
  const lines: string[] = [
    "## Release/version checklist",
    "",
    "Read-only advisory: no files, git state, package metadata, or bead state were mutated.",
    "",
    "### Version consistency",
    `- package.json: ${result.version.packageJsonVersion ?? "(missing)"}`,
    `- package-lock.json: ${result.version.packageLockVersion ?? "(missing)"}`,
    `- package-lock root package: ${result.version.packageLockRootVersion ?? "(missing)"}`,
    `- Status: ${result.version.versionsMatch ? "✅ versions match" : "⚠️ version issues found"}`,
  ];

  if (result.version.issues.length > 0) {
    lines.push("- Issues:");
    for (const issue of result.version.issues) lines.push(`  - ${issue}`);
  }

  lines.push("", "### Dirty-file scope");
  if (!result.dirtyScopeKnown) {
    lines.push("- ⚠️ Dirty-file scope is unknown because `git status --short` could not be read.");
  } else if (result.dirtyFiles.length === 0) {
    lines.push("- ✅ No dirty files detected.");
  } else {
    for (const group of result.dirtyFiles) {
      const marker = group.severity === "warning" ? "⚠️" : "ℹ️";
      lines.push(`- ${marker} ${group.label}: ${group.files.length} file(s)`);
      for (const file of group.files.slice(0, 8)) lines.push(`  - ${file}`);
      if (group.files.length > 8) lines.push(`  - …and ${group.files.length - 8} more`);
    }
  }

  lines.push("", "### Recommended checks", "```bash");
  for (const check of result.recommendedChecks) lines.push(check);
  lines.push("```", "", "### Copy/paste-ready next steps");
  for (const step of result.nextSteps) lines.push(`- ${step}`);

  return lines.join("\n");
}
