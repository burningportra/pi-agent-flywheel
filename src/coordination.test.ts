import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  selectStrategy,
  selectMode,
  detectCoordinationBackend,
  resetDetection,
  detectUbs,
  resetUbsCache,
  decideImplementationLaunchSafety,
  detectInteractiveSubagentToolSurface,
  findFileScopeConflicts,
} from "./coordination.js";

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

// ─── Implementation launch safety ──────────────────────────

describe("implementation launch safety", () => {
  const availableAgentMail = {
    status: "available" as const,
    reservationsAvailable: true,
    evidence: ["health_check: exit=0"],
    repairGuidance: [],
  };

  it("allows parallel single-branch only when Agent Mail reservations are available, scopes are disjoint, and supervision is controllable", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-a", files: ["src/a.ts"] },
        { id: "pi-b", files: ["src/b.ts"] },
      ],
      agentMailPreflight: availableAgentMail,
      worktreeAvailable: false,
      visibleNtmAvailable: true,
    });

    expect(decision.mode).toBe("single-branch-parallel");
    expect(decision.parallel).toBe(true);
    expect(decision.explanation).toContain("Agent Mail reservations are available and file scopes are disjoint");
  });

  it("downgrades overlapping file scopes away from same-checkout parallel launch and names conflicting bead/file pairs", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-ko73", files: ["src/tools/shared.ts", "src/tools/triage.ts"] },
        { id: "pi-jp4p", files: ["src/tools/shared.ts", "src/tools/status.ts"] },
      ],
      agentMailPreflight: availableAgentMail,
      worktreeAvailable: false,
      visibleNtmAvailable: true,
    });

    expect(decision.mode).toBe("sequential");
    expect(decision.parallel).toBe(false);
    expect(decision.conflicts).toEqual([{ file: "src/tools/shared.ts", beadIds: ["pi-ko73", "pi-jp4p"] }]);
    expect(decision.explanation).toContain("src/tools/shared.ts (pi-ko73 ↔ pi-jp4p)");
  });

  it("chooses worktree isolation for overlapping scopes when worktrees are available", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-a", files: ["src/shared.ts"] },
        { id: "pi-b", files: ["src/shared.ts"] },
      ],
      agentMailPreflight: availableAgentMail,
      worktreeAvailable: true,
      visibleNtmAvailable: true,
    });

    expect(decision.mode).toBe("worktree-parallel");
    expect(decision.parallel).toBe(true);
    expect(decision.explanation).toContain("worktree isolation");
  });

  it("downgrades same-checkout parallel launch when Agent Mail is unavailable even for disjoint scopes", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-a", files: ["src/a.ts"] },
        { id: "pi-b", files: ["src/b.ts"] },
      ],
      agentMailPreflight: {
        status: "unauthorized",
        reservationsAvailable: false,
        evidence: ['health_check: exit=0 stdout={"detail":"Unauthorized"}'],
        repairGuidance: ["Do not retry endlessly on 401/Unauthorized"],
      },
      worktreeAvailable: false,
      visibleNtmAvailable: true,
    });

    expect(decision.mode).toBe("sequential");
    expect(decision.agentMailStatus).toBe("unauthorized");
    expect(decision.explanation).toContain("Agent Mail preflight: unauthorized");
    expect(decision.explanation).toContain("Do not retry endlessly");
  });

  it("treats missing file scopes as unsafe for same-checkout parallel launch", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-a", files: [] },
        { id: "pi-b", files: ["src/b.ts"] },
      ],
      agentMailPreflight: availableAgentMail,
      worktreeAvailable: false,
      visibleNtmAvailable: true,
    });

    expect(decision.mode).toBe("sequential");
    expect(decision.missingFileScopeBeadIds).toEqual(["pi-a"]);
    expect(decision.explanation).toContain("Missing file scopes: pi-a");
  });

  it("allows explicit worktree mode to launch parallel workers without Agent Mail reservations", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "worktree",
      readyBeads: [
        { id: "pi-a", files: ["src/shared.ts"] },
        { id: "pi-b", files: ["src/shared.ts"] },
      ],
      worktreeAvailable: true,
      visibleNtmAvailable: true,
    });

    expect(decision.mode).toBe("worktree-parallel");
    expect(decision.agentMailStatus).toBe("not_required");
  });

  it("downgrades multi-agent same-checkout launch when no interactive or visible supervision surface is available", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-a", files: ["src/a.ts"] },
        { id: "pi-b", files: ["src/b.ts"] },
      ],
      agentMailPreflight: availableAgentMail,
      worktreeAvailable: false,
      visibleNtmAvailable: false,
      interactiveSubagentsAvailable: false,
    });

    expect(decision.mode).toBe("sequential");
    expect(decision.explanation).toContain("no visible/interactive multi-agent supervision surface detected");
  });

  it("keeps healthy provider preflight green for same-checkout parallel launch", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-a", files: ["src/a.ts"] },
        { id: "pi-b", files: ["src/b.ts"] },
      ],
      agentMailPreflight: availableAgentMail,
      worktreeAvailable: false,
      visibleNtmAvailable: true,
      providerPreflight: {
        status: "available",
        launchableCount: 1,
        requiredUnavailable: false,
        selectedCheckIds: ["impl:ntm"],
        downgradeReasons: [],
        repairGuidance: [],
        results: [{
          status: "available",
          launchable: true,
          evidence: ["ntm --help", "exit=0"],
          repairGuidance: [],
          check: { id: "impl:ntm", label: "NTM visible panes", surface: "ntm", required: true },
        }],
      },
    });

    expect(decision.mode).toBe("single-branch-parallel");
    expect(decision.providerStatus).toBe("available");
  });

  it("downgrades unauthorized required provider preflight before multi-worker handoff", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-a", files: ["src/a.ts"] },
        { id: "pi-b", files: ["src/b.ts"] },
      ],
      agentMailPreflight: availableAgentMail,
      worktreeAvailable: false,
      visibleNtmAvailable: true,
      providerPreflight: {
        status: "unauthorized",
        launchableCount: 0,
        requiredUnavailable: true,
        selectedCheckIds: [],
        downgradeReasons: ["Required Claude Code is unauthorized"],
        repairGuidance: ["Do not retry endlessly on 401/403/Unauthorized evidence"],
        results: [{
          status: "unauthorized",
          launchable: false,
          evidence: ["cc --help", "stderr: permission_error"],
          repairGuidance: ["Do not retry endlessly on 401/403/Unauthorized evidence"],
          check: { id: "impl:cc", label: "Claude Code", surface: "claude-code", required: true },
        }],
      },
    });

    expect(decision.mode).toBe("sequential");
    expect(decision.parallel).toBe(false);
    expect(decision.explanation).toContain("Provider preflight: unauthorized");
    expect(decision.explanation).toContain("permission_error");
    expect(decision.explanation).toContain("Do not retry endlessly");
  });

  it("routes around an optional unavailable provider when another provider is launchable", () => {
    const decision = decideImplementationLaunchSafety({
      requestedMode: "single-branch",
      readyBeads: [
        { id: "pi-a", files: ["src/a.ts"] },
        { id: "pi-b", files: ["src/b.ts"] },
      ],
      agentMailPreflight: availableAgentMail,
      worktreeAvailable: false,
      visibleNtmAvailable: true,
      providerPreflight: {
        status: "available",
        launchableCount: 1,
        requiredUnavailable: false,
        selectedCheckIds: ["impl:codex"],
        downgradeReasons: ["Optional Cursor agent is unavailable"],
        repairGuidance: ["Verify installation and PATH"],
        results: [
          {
            status: "unavailable",
            launchable: false,
            evidence: ["cursor --help", "exit=127"],
            repairGuidance: ["Verify installation and PATH"],
            check: { id: "impl:cursor", label: "Cursor agent", surface: "cursor-agent", required: false },
          },
          {
            status: "available",
            launchable: true,
            evidence: ["codex --help", "exit=0"],
            repairGuidance: [],
            check: { id: "impl:codex", label: "Codex", surface: "codex", required: false },
          },
        ],
      },
    });

    expect(decision.mode).toBe("single-branch-parallel");
    expect(decision.downgradeReasons).toContain("Optional Cursor agent is unavailable");
  });

  it("detects pi-interactive-subagents style tool surfaces", () => {
    expect(detectInteractiveSubagentToolSurface(["subagent", "subagent_interrupt", "subagent_resume", "caller_ping"])).toBe(true);
    expect(detectInteractiveSubagentToolSurface(["subagent"])).toBe(false);
  });

  it("finds exact file conflicts only once per bead even when files repeat", () => {
    expect(findFileScopeConflicts([
      { id: "pi-a", files: ["src/shared.ts", "src/shared.ts"] },
      { id: "pi-b", files: ["src/shared.ts"] },
    ])).toEqual([{ file: "src/shared.ts", beadIds: ["pi-a", "pi-b"] }]);
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
