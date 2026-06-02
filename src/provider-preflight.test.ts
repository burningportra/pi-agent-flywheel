import { describe, expect, it, vi } from "vitest";
import {
  classifyProviderAuthEvidence,
  decideReviewWorkerLaunchSafety,
  formatReviewWorkerLaunchSafety,
  isProviderLaunchable,
  preflightWorkerProviders,
  providerPreflightRepairGuidance,
  type ProviderPreflightCheck,
  type ProviderPreflightResult,
  type ProviderPreflightStatus,
  type ProviderPreflightSummary,
} from "./provider-preflight.js";

describe("provider preflight classifier", () => {
  it("exports the core provider preflight shapes", () => {
    const check: ProviderPreflightCheck = {
      id: "reviewer:claude",
      label: "Claude reviewer",
      provider: "anthropic",
      model: "claude-sonnet",
      surface: "subagent",
      required: true,
    };
    const result: ProviderPreflightResult = {
      status: "available",
      check,
      launchable: true,
      evidence: ["dry-run: exit=0"],
      repairGuidance: [],
    };
    const summary: ProviderPreflightSummary = {
      status: "available",
      launchableCount: 1,
      requiredUnavailable: false,
      results: [result],
      selectedCheckIds: [check.id],
      downgradeReasons: [],
      repairGuidance: [],
    };

    expect(summary.results[0].check.surface).toBe("subagent");
    expect(summary.selectedCheckIds).toEqual(["reviewer:claude"]);
  });

  it("classifies the observed OAuth 403 permission_error as unauthorized", () => {
    const status = classifyProviderAuthEvidence({
      code: 403,
      stdout: JSON.stringify({
        type: "error",
        error: {
          type: "permission_error",
          message: "OAuth authentication is currently not allowed for this organization.",
        },
      }),
      stderr: "",
    });

    expect(status).toBe("unauthorized");
  });

  it("classifies 401 Unauthorized text as unauthorized", () => {
    expect(classifyProviderAuthEvidence({ code: 0, stdout: '{"detail":"Unauthorized"}', stderr: "" })).toBe("unauthorized");
    expect(classifyProviderAuthEvidence({ code: 401, stdout: "", stderr: "" })).toBe("unauthorized");
  });

  it("classifies rate-limit and quota evidence as rate_limited", () => {
    const cases = [
      { code: 429, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "rate limit exceeded" },
      { code: 402, stdout: "", stderr: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" },
      { code: 1, stdout: "quota exceeded", stderr: "" },
    ];

    for (const evidence of cases) {
      expect(classifyProviderAuthEvidence(evidence), JSON.stringify(evidence)).toBe("rate_limited");
    }
  });

  it("classifies missing-command evidence as unavailable", () => {
    const status = classifyProviderAuthEvidence({
      code: null,
      stdout: "",
      stderr: "",
      error: new Error("spawn cc ENOENT"),
    });

    expect(status).toBe("unavailable");
    expect(classifyProviderAuthEvidence({ code: 127, stdout: "", stderr: "command not found: ntm" })).toBe("unavailable");
    expect(classifyProviderAuthEvidence({ code: 127, stdout: "", stderr: "" })).toBe("unavailable");
  });

  it("classifies provider configuration gaps as misconfigured", () => {
    expect(classifyProviderAuthEvidence({ code: 1, stdout: "", stderr: "Missing API key for provider" })).toBe("misconfigured");
    expect(classifyProviderAuthEvidence({ code: 1, stdout: "model not configured", stderr: "" })).toBe("misconfigured");
  });

  it("returns unknown_failure for nonzero evidence with no recognized shape", () => {
    expect(classifyProviderAuthEvidence({ code: 2, stdout: "", stderr: "unexpected provider failure" })).toBe("unknown_failure");
  });

  it("returns not_checked when no probe evidence is available", () => {
    expect(classifyProviderAuthEvidence({})).toBe("not_checked");
    expect(classifyProviderAuthEvidence({ code: null, stdout: "", stderr: "" })).toBe("not_checked");
  });

  it("returns available for clean zero-exit evidence", () => {
    expect(classifyProviderAuthEvidence({ code: 0, stdout: "provider ready", stderr: "" })).toBe("available");
    expect(isProviderLaunchable("available")).toBe(true);
    expect(isProviderLaunchable("unauthorized")).toBe(false);
  });

  it("provides bounded repair guidance for every degraded status", () => {
    const statuses: ProviderPreflightStatus[] = [
      "unauthorized",
      "unavailable",
      "rate_limited",
      "misconfigured",
      "unknown_failure",
      "not_checked",
    ];

    for (const status of statuses) {
      expect(providerPreflightRepairGuidance(status), status).not.toEqual([]);
    }
  });

  it("tells agents not to retry endlessly on unauthorized provider failures", () => {
    const guidance = providerPreflightRepairGuidance("unauthorized").join("\n");

    expect(guidance).toContain("Do not retry endlessly");
    expect(guidance).toContain("repair auth or switch");
  });
});

describe("decideReviewWorkerLaunchSafety", () => {
  const checks: ProviderPreflightCheck[] = [
    { id: "fresh-eyes", label: "Fresh eyes", surface: "subagent", required: false },
    { id: "polish", label: "Polish", surface: "subagent", required: false },
  ];

  function summary(results: ProviderPreflightResult[]): ProviderPreflightSummary {
    return {
      status: results.some((result) => result.launchable) ? "available" : results[0]?.status ?? "not_checked",
      launchableCount: results.filter((result) => result.launchable).length,
      requiredUnavailable: false,
      results,
      selectedCheckIds: results.filter((result) => result.launchable).map((result) => result.check.id),
      downgradeReasons: results.filter((result) => !result.launchable).map((result) => `${result.check.label} ${result.status}`),
      repairGuidance: results.flatMap((result) => result.repairGuidance),
    };
  }

  it("allows all healthy review workers", () => {
    const safety = decideReviewWorkerLaunchSafety(checks, summary(checks.map((check) => ({
      status: "available",
      check,
      launchable: true,
      evidence: ["exit=0"],
      repairGuidance: [],
    }))));

    expect(safety.canProceed).toBe(true);
    expect(safety.launchableReviewerIds).toEqual(["fresh-eyes", "polish"]);
    expect(safety.degradedReviewerIds).toEqual([]);
  });

  it("allows partial review worker availability with explicit degraded output", () => {
    const safety = decideReviewWorkerLaunchSafety(checks, summary([
      { status: "available", check: checks[0], launchable: true, evidence: ["exit=0"], repairGuidance: [] },
      { status: "unavailable", check: checks[1], launchable: false, evidence: ["command not found"], repairGuidance: ["install tool"] },
    ]));

    expect(safety.canProceed).toBe(true);
    expect(safety.launchableReviewerIds).toEqual(["fresh-eyes"]);
    expect(safety.degradedReviewerIds).toEqual(["polish"]);
    expect(formatReviewWorkerLaunchSafety(safety)).toContain("degraded review capacity");
    expect(formatReviewWorkerLaunchSafety(safety)).toContain("Skipped reviewers");
  });

  it("blocks fake successful peer review when zero reviewers are launchable", () => {
    const safety = decideReviewWorkerLaunchSafety(checks, summary(checks.map((check) => ({
      status: "unauthorized",
      check,
      launchable: false,
      evidence: ["status 403 OAuth authentication is currently not allowed"],
      repairGuidance: providerPreflightRepairGuidance("unauthorized"),
    }))));

    expect(safety.canProceed).toBe(false);
    expect(safety.launchableReviewerIds).toEqual([]);
    expect(safety.degradedReviewerIds).toEqual(["fresh-eyes", "polish"]);
    expect(formatReviewWorkerLaunchSafety(safety)).toContain("zero launchable review workers");
    expect(formatReviewWorkerLaunchSafety(safety)).toContain("Do not retry endlessly");
  });
});

describe("preflightWorkerProviders", () => {
  const cwd = "/repo";

  it("summarizes an available safe probe", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "cc available", stderr: "" });
    const summary = await preflightWorkerProviders({
      cwd,
      exec,
      checks: [{ id: "impl:cc", label: "Claude Code", surface: "claude-code", required: true, probe: { command: "cc", args: ["--help"] } }],
    });

    expect(exec).toHaveBeenCalledWith("cc", ["--help"], { cwd, timeout: 2500 });
    expect(summary.status).toBe("available");
    expect(summary.launchableCount).toBe(1);
    expect(summary.requiredUnavailable).toBe(false);
    expect(summary.selectedCheckIds).toEqual(["impl:cc"]);
    expect(summary.results[0].evidence).toContain("cc --help");
  });

  it("marks required unauthorized checks unavailable without retrying", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 403, stdout: "", stderr: "permission_error: OAuth authentication is currently not allowed" });
    const summary = await preflightWorkerProviders({
      cwd,
      exec,
      timeoutMs: 1000,
      checks: [{ id: "review:claude", label: "Claude reviewer", surface: "subagent", required: true, probe: { command: "pi", args: ["--print", "ping"] } }],
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe("unauthorized");
    expect(summary.requiredUnavailable).toBe(true);
    expect(summary.launchableCount).toBe(0);
    expect(summary.repairGuidance.join("\n")).toContain("Do not retry endlessly");
  });

  it("classifies missing command probes as unavailable", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("spawn ntm ENOENT"));
    const summary = await preflightWorkerProviders({
      cwd,
      exec,
      checks: [{ id: "impl:ntm", label: "NTM", surface: "ntm", required: true, probe: { command: "ntm", args: ["--help"] } }],
    });

    expect(summary.results[0].status).toBe("unavailable");
    expect(summary.requiredUnavailable).toBe(true);
  });

  it("keeps optional unavailable checks from blocking when another provider is launchable", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ code: 127, stdout: "", stderr: "command not found: agent" })
      .mockResolvedValueOnce({ code: 0, stdout: "codex help", stderr: "" });
    const summary = await preflightWorkerProviders({
      cwd,
      exec,
      checks: [
        { id: "impl:cursor", label: "Cursor Agent CLI", surface: "cursor-agent", required: false, probe: { command: "agent", args: ["--help"] } },
        { id: "impl:codex", label: "Codex", surface: "codex", required: false, probe: { command: "codex", args: ["--help"] } },
      ],
    });

    expect(summary.status).toBe("available");
    expect(summary.requiredUnavailable).toBe(false);
    expect(summary.launchableCount).toBe(1);
    expect(summary.selectedCheckIds).toEqual(["impl:codex"]);
    expect(summary.downgradeReasons).toContain("Optional Cursor Agent CLI is unavailable");
  });

  it("returns not_checked when no safe probe exists", async () => {
    const exec = vi.fn();
    const summary = await preflightWorkerProviders({
      cwd,
      exec,
      checks: [{ id: "impl:unknown", label: "Unknown worker", surface: "unknown", required: false }],
    });

    expect(exec).not.toHaveBeenCalled();
    expect(summary.status).toBe("not_checked");
    expect(summary.results[0].status).toBe("not_checked");
    expect(summary.results[0].launchable).toBe(false);
    expect(summary.results[0].evidence.join("\n")).toContain("no safe bounded probe");
  });
});
