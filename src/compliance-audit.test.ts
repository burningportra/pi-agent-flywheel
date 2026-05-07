import { describe, expect, it } from "vitest";
import {
  buildComplianceAuditPrompt,
  clampAuditParallelism,
  clampAuditThreshold,
  formatComplianceAuditSummary,
  normalizeSampleSize,
  recommendComplianceAuditTier,
  suggestComplianceAuditMode,
  type ComplianceAuditPlan,
} from "./compliance-audit.js";

const basePlan = {
  cwd: "/repo",
  auditDir: "/repo/beads_compliance_audit",
  auditDirExists: false,
  mode: "standard",
  tier: "pair",
  threshold: 700,
  remediationPolicy: "completion-debt",
  parallelism: 3,
  totalCount: 42,
  closedCount: 40,
  testExecutionOk: true,
} satisfies Omit<ComplianceAuditPlan, "prompt" | "summary">;

describe("compliance audit tiering", () => {
  it("maps closed-bead counts to the documented tiers", () => {
    expect(recommendComplianceAuditTier(0)).toMatchObject({ tier: "solo", recommendedParallelism: 1 });
    expect(recommendComplianceAuditTier(20)).toMatchObject({ tier: "pair", recommendedParallelism: 3 });
    expect(recommendComplianceAuditTier(151)).toMatchObject({ tier: "squad", recommendedParallelism: 5 });
    expect(recommendComplianceAuditTier(501)).toMatchObject({ tier: "battalion", recommendedParallelism: 7 });
    expect(recommendComplianceAuditTier(1001)).toMatchObject({ tier: "swarm", recommendedParallelism: 9 });
    expect(recommendComplianceAuditTier(1501)).toMatchObject({ tier: "mega-swarm", recommendedParallelism: 10, recommendedMode: "sample" });
  });

  it("hard-caps parallelism at 10", () => {
    expect(clampAuditParallelism(99, 3)).toBe(10);
    expect(clampAuditParallelism(0, 3)).toBe(1);
    expect(clampAuditParallelism(undefined, 7)).toBe(7);
  });
});

describe("compliance audit mode selection", () => {
  it("prefers explicit and single-bead modes", () => {
    expect(suggestComplianceAuditMode({ closedCount: 100, auditDirExists: true, explicitMode: "triage" })).toBe("triage");
    expect(suggestComplianceAuditMode({ closedCount: 100, auditDirExists: false, beadId: "br-1" })).toBe("single-bead");
  });

  it("selects re-verification, sample, onboarding, or standard by context", () => {
    expect(suggestComplianceAuditMode({ closedCount: 10, auditDirExists: true })).toBe("re-verification");
    expect(suggestComplianceAuditMode({ closedCount: 1501, auditDirExists: false })).toBe("sample");
    expect(suggestComplianceAuditMode({ closedCount: 51, auditDirExists: false })).toBe("onboarding");
    expect(suggestComplianceAuditMode({ closedCount: 50, auditDirExists: false })).toBe("standard");
  });
});

describe("compliance audit option normalization", () => {
  it("clamps threshold to the 0-1000 scoring range", () => {
    expect(clampAuditThreshold(-10)).toBe(0);
    expect(clampAuditThreshold(1001)).toBe(1000);
    expect(clampAuditThreshold(699.6)).toBe(700);
    expect(clampAuditThreshold(undefined)).toBe(700);
  });

  it("normalizes sample size only in sample mode", () => {
    expect(normalizeSampleSize(undefined, 2000, "sample")).toBe(50);
    expect(normalizeSampleSize(0, 2000, "sample")).toBe(1);
    expect(normalizeSampleSize(99, 2000, "sample")).toBe(50);
    expect(normalizeSampleSize(25, 2000, "standard")).toBeUndefined();
  });
});

describe("compliance audit prompt", () => {
  it("includes the verification kernel, phase loop, cap, and artifact directory", () => {
    const prompt = buildComplianceAuditPrompt(basePlan);
    expect(prompt).toContain("A bead status is a claim, not a fact");
    expect(prompt).toContain("br doctor --json");
    expect(prompt).toContain("hard cap 10");
    expect(prompt).toContain("beads_compliance_audit");
    expect(prompt).toContain("10-phase loop");
    expect(prompt).toContain("ANTI-THEATER");
    expect(prompt).toContain("Flag closed beads below 700");
  });

  it("formats a concise preflight summary", () => {
    const summary = formatComplianceAuditSummary(basePlan);
    expect(summary).toContain("mode: standard");
    expect(summary).toContain("threshold: 700");
    expect(summary).toContain("test execution: confirmed");
  });
});
