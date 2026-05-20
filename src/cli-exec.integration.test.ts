import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brExec, brExecJson, type RawExecOutput } from "./cli-exec.js";
import { readBeads } from "./beads.js";

interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

interface BrWorkspace {
  cwd: string;
  logs: string[];
}

const hasBr = await commandSucceeds("br", ["--version"]);
const describeWithBr = hasBr ? describe : describe.skip;

const workspaces: BrWorkspace[] = [];

async function commandSucceeds(cmd: string, args: string[]): Promise<boolean> {
  try {
    const result = await spawnExec(cmd, args, { timeout: 5000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

function makeRealPi(logs: string[]): ExtensionAPI {
  return {
    exec: async (cmd: string, args: string[], opts?: ExecOptions) => {
      const result = await spawnExec(cmd, args, opts);
      logs.push(formatExecLog(cmd, args, opts, result));
      return result;
    },
  } as unknown as ExtensionAPI;
}

async function spawnExec(
  cmd: string,
  args: string[],
  opts?: ExecOptions,
): Promise<RawExecOutput> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = opts?.timeout
      ? setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
      }, opts.timeout)
      : undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0, killed });
    });
  });
}

function formatExecLog(
  cmd: string,
  args: string[],
  opts: ExecOptions | undefined,
  result: RawExecOutput,
): string {
  return [
    `$ ${cmd} ${args.join(" ")}`,
    `cwd=${opts?.cwd ?? process.cwd()} code=${result.code} killed=${result.killed}`,
    `stdout=${JSON.stringify(result.stdout.slice(0, 500))}`,
    `stderr=${JSON.stringify(result.stderr.slice(0, 500))}`,
  ].join("\n");
}

async function createWorkspace(): Promise<BrWorkspace> {
  const workspace: BrWorkspace = {
    cwd: await mkdtemp(join(tmpdir(), "pi-agent-flywheel-br-")),
    logs: [],
  };
  workspaces.push(workspace);
  const pi = makeRealPi(workspace.logs);
  const init = await pi.exec("br", ["init"], { cwd: workspace.cwd, timeout: 10000 });
  workspace.logs.push(`[setup] br init completed code=${init.code}`);
  expectWithLogs(init.code, workspace).toBe(0);
  return workspace;
}

function expectWithLogs<T>(value: T, workspace: BrWorkspace) {
  return expect(value, workspace.logs.join("\n\n"));
}

afterEach(async () => {
  while (workspaces.length > 0) {
    const workspace = workspaces.pop();
    if (workspace) await rm(workspace.cwd, { recursive: true, force: true });
  }
});

describeWithBr("cli-exec br CLI integration", () => {
  it("runs brExec against a real temporary br workspace and captures success stdout/stderr/code", async () => {
    const workspace = await createWorkspace();
    const pi = makeRealPi(workspace.logs);

    const create = await brExec(pi, ["create", "--title", "Integration One", "--description", "real brExec test", "--json"], {
      cwd: workspace.cwd,
      timeout: 10000,
      logWarnings: false,
    });

    expectWithLogs(create.ok, workspace).toBe(true);
    if (!create.ok) return;
    expectWithLogs(create.value.code, workspace).toBe(0);
    expectWithLogs(create.value.stdout, workspace).toContain("Integration One");
    expectWithLogs(create.value.stderr, workspace).toMatch(/Auto-flush complete|^$/);
  });

  it("returns structured non-zero brExec errors with real stdout/stderr/code shapes", async () => {
    const workspace = await createWorkspace();
    const pi = makeRealPi(workspace.logs);

    const result = await brExec(pi, ["show", "missing-bead", "--json"], {
      cwd: workspace.cwd,
      timeout: 10000,
      maxRetries: 0,
      logWarnings: false,
    });

    expectWithLogs(result.ok, workspace).toBe(false);
    if (result.ok) return;
    expectWithLogs(result.error.exitCode, workspace).toBe(3);
    expectWithLogs(result.error.stdout, workspace).toBe("");
    expectWithLogs(result.error.stderr, workspace).toContain("ISSUE_NOT_FOUND");
    expectWithLogs(result.error.brError?.code, workspace).toBe("ISSUE_NOT_FOUND");
    expectWithLogs(result.error.isTransient, workspace).toBe(false);
  });

  it("returns a permanent brExecJson parse error after a real successful non-JSON br command", async () => {
    const workspace = await createWorkspace();
    const pi = makeRealPi(workspace.logs);

    const result = await brExecJson(pi, ["--help"], {
      cwd: workspace.cwd,
      timeout: 10000,
      logWarnings: false,
    });

    expectWithLogs(result.ok, workspace).toBe(false);
    if (result.ok) return;
    expectWithLogs(result.error.exitCode, workspace).toBe(0);
    expectWithLogs(result.error.stdout, workspace).toContain("Usage:");
    expectWithLogs(result.error.stderr, workspace).toContain("JSON parse error");
    expectWithLogs(result.error.isTransient, workspace).toBe(false);
  });

  it("covers a real degraded caller path by mapping failed brExecJson to an empty bead list", async () => {
    const workspace = await createWorkspace();
    const pi = makeRealPi(workspace.logs);

    const nonWorkspace = await mkdtemp(join(tmpdir(), "pi-agent-flywheel-no-br-"));
    workspaces.push({ cwd: nonWorkspace, logs: workspace.logs });
    await mkdir(join(nonWorkspace, "subdir"));
    const beads = await readBeads(pi, join(nonWorkspace, "subdir"));

    expectWithLogs(beads, workspace).toEqual([]);
    expectWithLogs(workspace.logs.some((line) => line.includes("br list --json")), workspace).toBe(true);
    expectWithLogs(workspace.logs.some((line) => /code=[1-9]/.test(line)), workspace).toBe(true);
  });
});
