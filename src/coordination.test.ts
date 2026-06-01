import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { selectStrategy, selectMode, detectCoordinationBackend, resetDetection, detectUbs, resetUbsCache } from "./coordination.js";

// ─── Mock fs ────────────────────────────────────────────────

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { existsSync } from "fs";
const mockExistsSync = existsSync as unknown as ReturnType<typeof vi.fn>;

// ─── selectStrategy ─────────────────────────────────────────

describe("selectStrategy", () => {
  it("returns beads+agentmail when both beads and agentMail are true", () => {
    expect(selectStrategy({ beads: true, agentMail: true })).toBe("beads+agentmail");
  });

  it("returns worktrees when nothing is available", () => {
    expect(selectStrategy({ beads: false, agentMail: false })).toBe("worktrees");
  });

  it("returns worktrees when only beads is available (not enough without agentMail)", () => {
    expect(selectStrategy({ beads: true, agentMail: false })).toBe("worktrees");
  });

  it("returns worktrees when only agentMail is available (not enough without beads)", () => {
    expect(selectStrategy({ beads: false, agentMail: true })).toBe("worktrees");
  });
});

// ─── selectMode ─────────────────────────────────────────────

describe("selectMode", () => {
  it("returns single-branch when agentMail is available", () => {
    expect(selectMode({ beads: false, agentMail: true })).toBe("single-branch");
  });

  it("returns worktree when agentMail is unavailable", () => {
    expect(selectMode({ beads: true, agentMail: false })).toBe("worktree");
  });
});

// ─── detectCoordinationBackend ──────────────────────────────

describe("detectCoordinationBackend", () => {
  let mockPi: { exec: ReturnType<typeof vi.fn> } & ExtensionAPI;

  beforeEach(() => {
    resetDetection();
    mockPi = { exec: vi.fn() } as unknown as { exec: ReturnType<typeof vi.fn> } & ExtensionAPI;
    mockExistsSync.mockReset();
  });

  it("returns beads and agentMail availability without probing unsupported CR tools", async () => {
    mockExistsSync.mockReturnValue(true);
    mockPi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "br" && args[0] === "--help") return { code: 0, stdout: "br help", stderr: "" };
      if (cmd === "curl") return { code: 0, stdout: '{"status":"ok"}', stderr: "" };
      if (cmd === "legacy-cr") throw new Error("unsupported CR tools should not be probed");
      return { code: 1, stdout: "", stderr: "" };
    });

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(true);
    expect(result.agentMail).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["agentMail", "beads", "preCommitGuardInstalled"]);
    expect(mockPi.exec.mock.calls.some(([cmd]) => cmd === "legacy-cr")).toBe(false);
  });

  it("returns all false when no supported tools are available", async () => {
    mockExistsSync.mockReturnValue(false);
    mockPi.exec.mockImplementation(async () => {
      throw new Error("command not found");
    });

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(false);
    expect(result.agentMail).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["agentMail", "beads", "preCommitGuardInstalled"]);
  });

  it("returns partial availability: br yes, agent-mail no", async () => {
    mockPi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "br" && args[0] === "--help") return { code: 0, stdout: "br help", stderr: "" };
      if (cmd === "curl") return { code: 1, stdout: "", stderr: "" }; // unreachable
      if (cmd === "uv") return { code: 1, stdout: "", stderr: "" }; // not installed, degrade cleanly
      if (cmd === "legacy-cr") throw new Error("unsupported CR tools should not be probed");
      return { code: 1, stdout: "", stderr: "" };
    });

    mockExistsSync.mockImplementation((p: string) => p.endsWith(".beads"));

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(true);
    expect(result.agentMail).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["agentMail", "beads", "preCommitGuardInstalled"]);
    expect(mockPi.exec.mock.calls.some(([cmd]) => cmd === "legacy-cr")).toBe(false);
  });

  it("returns beads false when .beads/ directory is missing", async () => {
    mockPi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "br" && args[0] === "--help") return { code: 0, stdout: "br help", stderr: "" };
      if (cmd === "curl") return { code: 0, stdout: '{"status":"ok"}', stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });

    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith(".beads")) return false; // not initialized
      return false;
    });

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(false);
    expect(result.agentMail).toBe(true);
  });

  it("returns agentMail false when probes fail or startup cannot launch", async () => {
    mockPi.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "br" && args[0] === "--help") return { code: 0, stdout: "br help", stderr: "" };
      if (cmd === "curl") throw new Error("connection refused");
      if (cmd === "uv") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "bash") throw new Error("spawn failed");
      return { code: 1, stdout: "", stderr: "" };
    });

    mockExistsSync.mockImplementation((p: string) => p.endsWith(".beads"));

    const result = await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(result.beads).toBe(true);
    expect(result.agentMail).toBe(false);
  });

  it("caches the result on second call", async () => {
    mockExistsSync.mockReturnValue(false);
    mockPi.exec.mockRejectedValue(new Error("not found"));

    await detectCoordinationBackend(mockPi, "/fake/cwd");
    const callCount = mockPi.exec.mock.calls.length;

    // Second call should use cache
    await detectCoordinationBackend(mockPi, "/fake/cwd");
    expect(mockPi.exec.mock.calls.length).toBe(callCount);
  });
});

// ─── detectUbs ──────────────────────────────────────────────

describe("detectUbs", () => {
  let mockPi: { exec: ReturnType<typeof vi.fn> } & ExtensionAPI;

  beforeEach(() => {
    resetUbsCache();
    mockPi = { exec: vi.fn() } as unknown as { exec: ReturnType<typeof vi.fn> } & ExtensionAPI;
  });

  it("returns true when ubs --help succeeds", async () => {
    mockPi.exec.mockResolvedValue({ code: 0, stdout: "ubs help", stderr: "" });
    expect(await detectUbs(mockPi, "/fake/cwd")).toBe(true);
  });

  it("returns false when ubs --help fails", async () => {
    mockPi.exec.mockRejectedValue(new Error("command not found"));
    expect(await detectUbs(mockPi, "/fake/cwd")).toBe(false);
  });
});
