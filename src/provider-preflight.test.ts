import { describe, expect, it } from "vitest";
import {
  classifyProviderAuthEvidence,
  isProviderLaunchable,
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
