import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFile, execFileSync } from "child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { profileRepo } from "./profiler.js";
import {
  foundationGapsForProfile,
  MISSING_AGENTS_MD_WARNING,
} from "./tools/profile.js";

function makeTempRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  return root;
}

function makeExecPi(): Pick<ExtensionAPI, "exec"> {
  return {
    exec(command, args = [], options = {}) {
      return new Promise((resolve) => {
        execFile(command, args, {
          cwd: options.cwd,
          timeout: options.timeout,
        }, (error, stdout, stderr) => {
          const exitError = error as { code?: number } | null;
          resolve({
            code: typeof exitError?.code === "number" ? exitError.code : 0,
            stdout,
            stderr,
            killed: false,
          });
        });
      });
    },
  };
}

function profileFoundationFields(keyFiles: Record<string, string>) {
  return {
    keyFiles,
    hasTests: true,
    hasCI: true,
    ciPlatform: "github",
    recentCommits: [{ hash: "abc1234", message: "init", date: "now", author: "test" }],
  };
}

describe("profile foundation gaps — AGENTS.md detection", () => {
  it("does not report the missing AGENTS.md warning when the resolved repo root has AGENTS.md", async () => {
    const root = makeTempRepo("flywheel-agents-present-");
    writeFileSync(join(root, "AGENTS.md"), "# AGENTS.md\n\nGuidance.\n", "utf8");
    writeFileSync(join(root, "package.json"), "{\"scripts\":{\"test\":\"vitest\"}}", "utf8");

    const profile = await profileRepo(makeExecPi() as ExtensionAPI, root);
    const gaps = foundationGapsForProfile(profileFoundationFields(profile.keyFiles));

    expect(profile.keyFiles).toHaveProperty("AGENTS.md");
    expect(gaps).not.toContain(MISSING_AGENTS_MD_WARNING);
  });

  it("reports the existing missing AGENTS.md warning when the resolved repo root has no AGENTS.md", async () => {
    const root = makeTempRepo("flywheel-agents-missing-");
    writeFileSync(join(root, "package.json"), "{\"scripts\":{\"test\":\"vitest\"}}", "utf8");

    const profile = await profileRepo(makeExecPi() as ExtensionAPI, root);
    const gaps = foundationGapsForProfile(profileFoundationFields(profile.keyFiles));

    expect(profile.keyFiles).not.toHaveProperty("AGENTS.md");
    expect(gaps).toContain(MISSING_AGENTS_MD_WARNING);
  });

  it("uses the git resolved repo root instead of a nested cwd for AGENTS.md detection", async () => {
    const root = makeTempRepo("flywheel-agents-nested-");
    const nested = join(root, "src", "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# AGENTS.md\n\nRoot guidance.\n", "utf8");
    writeFileSync(join(root, "package.json"), "{\"scripts\":{\"test\":\"vitest\"}}", "utf8");

    const profile = await profileRepo(makeExecPi() as ExtensionAPI, nested);
    const gaps = foundationGapsForProfile(profileFoundationFields(profile.keyFiles));

    expect(profile.keyFiles).toHaveProperty("AGENTS.md");
    expect(gaps).not.toContain(MISSING_AGENTS_MD_WARNING);
  });
});
