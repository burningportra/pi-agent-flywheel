import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  readBeads,
  readyBeads,
  getBeadById,
  beadDeps,
  extractArtifacts,
  extractVerificationContract,
  updateBeadStatus,
  updateBeadDescription,
  validateBeads,
  validateVerificationContract,
  normalizeBeadMutationPlan,
  validateBeadMutationPlan,
  executeBeadMutationPlan,
  getBeadsSummary,
  detectBv,
  bvInsights,
  bvNext,
  bvPlan,
  resetBvCache,
  qualityCheckBeads,
} from "./beads.js";
import type { Bead } from "./types.js";

function makePi(impl: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  return { exec: vi.fn(impl) } as unknown as ExtensionAPI;
}

const CWD = "/fake/cwd";

const VALID_VERIFICATION_SECTION = `### Verification:
- Commands/checks: run npm test -- src/beads.test.ts and npm run build.
- Success looks like: tests pass, TypeScript compiles, and commands exit 0.
- Manual proof fallback: if automation cannot cover the work, capture logs and inspect the changed code manually.`;

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: "bead-1",
    title: "Test bead",
    description: "",
    status: "open",
    priority: 1,
    type: "task",
    labels: [],
    ...overrides,
  };
}

// ─── Structured bead mutation plans ─────────────────────────

function makeMutationBead(overrides: Record<string, unknown> = {}) {
  return {
    localId: "base",
    title: "Base bead",
    description: `Implement the base bead.

Acceptance criteria:
- [ ] Add the implementation.
- [ ] Add tests.

${VALID_VERIFICATION_SECTION}
### Files:
- src/beads.ts`,
    priority: 1,
    type: "task",
    files: ["src/beads.ts"],
    verification: {
      commandsChecks: "run npm test -- src/beads.test.ts",
      successLooksLike: "tests pass and TypeScript compiles",
      manualProofFallback: "inspect src/beads.ts if commands cannot run",
    },
    ...overrides,
  };
}

describe("normalizeBeadMutationPlan", () => {
  it("normalizes staged bead creations and dependency edges without shell commands", () => {
    const result = normalizeBeadMutationPlan({
      metadata: { source: "test" },
      beads: [{
        ref: "add-contract",
        title: "Add mutation contract",
        description: "Create a typed bead mutation contract.",
        priority: 1,
        type: "task",
        files: ["src/types.ts", "src/beads.ts"],
        verification: {
          commandsChecks: "run npm test -- src/beads.test.ts",
          successLooksLike: "tests pass and TypeScript compiles",
          manualProofFallback: "inspect src/types.ts and src/beads.ts if commands cannot run",
        },
        metadata: { owner: "planner" },
      }],
      dependencies: [{ from: "wire-approval", to: "add-contract", type: "parent-child" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected normalization to pass");
    expect(result.plan.beads[0]).toMatchObject({
      localId: "add-contract",
      title: "Add mutation contract",
      priority: 1,
      files: ["src/types.ts", "src/beads.ts"],
    });
    expect(result.plan.dependencies[0]).toEqual({ from: "wire-approval", to: "add-contract", type: "parent-child" });
    expect(result.plan.metadata).toEqual({ source: "test" });
  });

  it("reports field-level diagnostics for incomplete bead creations", () => {
    const result = normalizeBeadMutationPlan({
      beads: [{
        ref: "incomplete",
        title: "Incomplete bead",
        priority: 2,
        files: [],
        verification: { commandsChecks: "run npm test" },
      }],
      dependencies: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected normalization to fail");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "beads[0].description", beadRef: "incomplete" }),
      expect.objectContaining({ path: "beads[0].files", beadRef: "incomplete" }),
      expect.objectContaining({ path: "beads[0].verification.successLooksLike", beadRef: "incomplete" }),
      expect.objectContaining({ path: "beads[0].verification.manualProofFallback", beadRef: "incomplete" }),
    ]));
  });

  it("reports dependency diagnostics with exact edge indexes", () => {
    const result = normalizeBeadMutationPlan({
      beads: [{
        localId: "base",
        title: "Base bead",
        description: "Create the base work.",
        priority: 1,
        files: ["src/types.ts"],
        verification: {
          commandsChecks: "run npm test",
          successLooksLike: "tests pass",
          manualProofFallback: "inspect src/types.ts",
        },
      }],
      dependencies: [{ from: "child", type: "surprising" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected normalization to fail");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "dependencies[0].to", dependencyIndex: 0 }),
      expect.objectContaining({ code: "invalid-dependency-type", path: "dependencies[0].type", dependencyIndex: 0 }),
    ]));
  });
});

describe("validateBeadMutationPlan", () => {
  it("accepts a complete staged plan without invoking br", () => {
    const result = validateBeadMutationPlan({
      beads: [makeMutationBead(), makeMutationBead({ localId: "child", title: "Child bead" })],
      dependencies: [{ from: "child", to: "base", type: "blocks" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected validation to pass");
    expect(result.plan.dependencies[0]).toMatchObject({ from: "child", to: "base", type: "blocks" });
  });

  it("rejects unresolved template artifacts and missing Verification/Files sections", () => {
    const result = validateBeadMutationPlan({
      beads: [makeMutationBead({
        localId: "bad-template",
        description: `Please [Use template: add-tests]
Details can see template for the rest.

Acceptance criteria:
- [ ] Cover {{featureName}}`,
      })],
      dependencies: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation to fail");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "beads[0].description", beadRef: "bad-template", message: expect.stringContaining("missing required ### Files") }),
      expect.objectContaining({ path: "beads[0].description", beadRef: "bad-template", message: expect.stringContaining("missing required ### Verification") }),
      expect.objectContaining({ path: "beads[0].description", beadRef: "bad-template", message: expect.stringContaining("raw template marker") }),
      expect.objectContaining({ path: "beads[0].description", beadRef: "bad-template", message: expect.stringContaining("template shorthand") }),
      expect.objectContaining({ path: "beads[0].description", beadRef: "bad-template", message: expect.stringContaining("unresolved template placeholder") }),
    ]));
  });

  it("rejects descriptions with incomplete verification sections", () => {
    const result = validateBeadMutationPlan({
      beads: [makeMutationBead({
        localId: "weak-verification",
        description: `Implement the weak verification bead.

Acceptance criteria:
- [ ] Add behavior.
- [ ] Add coverage.

### Verification:
- Commands/checks: run npm test -- src/beads.test.ts

### Files:
- src/beads.ts`,
      })],
      dependencies: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation to fail");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ beadRef: "weak-verification", message: expect.stringContaining("success expectations") }),
      expect.objectContaining({ beadRef: "weak-verification", message: expect.stringContaining("manual proof guidance") }),
    ]));
  });

  it("rejects invalid dependency types before semantic validation", () => {
    const result = validateBeadMutationPlan({
      beads: [makeMutationBead()],
      dependencies: [{ from: "base", to: "base", type: "surprising" }],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid-dependency-type", path: "dependencies[0].type", dependencyIndex: 0 }),
    ]));
  });

  it("rejects duplicate, self, missing-endpoint, and cyclic dependencies", () => {
    const result = validateBeadMutationPlan({
      beads: [
        makeMutationBead({ localId: "a", title: "A" }),
        makeMutationBead({ localId: "b", title: "B" }),
        makeMutationBead({ localId: "a", title: "Duplicate A" }),
      ],
      dependencies: [
        { from: "a", to: "b", type: "blocks" },
        { from: "b", to: "a", type: "blocks" },
        { from: "a", to: "b", type: "related" },
        { from: "a", to: "a", type: "blocks" },
        { from: "missing", to: "a", type: "blocks" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation to fail");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "beads[2].localId", message: expect.stringContaining("duplicate staged bead") }),
      expect.objectContaining({ path: "dependencies[2]", message: expect.stringContaining("duplicate dependency edge") }),
      expect.objectContaining({ path: "dependencies[3]", message: expect.stringContaining("cannot point to itself") }),
      expect.objectContaining({ path: "dependencies[4].from", message: expect.stringContaining("unknown bead missing") }),
      expect.objectContaining({ path: "dependencies", message: expect.stringContaining("dependency cycle detected") }),
    ]));
  });

  it("rejects staged dependencies that duplicate or cycle with existing graph edges", () => {
    const result = validateBeadMutationPlan({
      beads: [makeMutationBead({ localId: "new-c", title: "New C" })],
      dependencies: [
        { from: "existing-a", to: "existing-b", type: "blocks" },
        { from: "existing-b", to: "new-c", type: "blocks" },
        { from: "new-c", to: "existing-a", type: "blocks" },
      ],
    }, {
      existingBeads: [{ id: "existing-a" }, { id: "existing-b" }],
      existingDependencies: [{ from: "existing-a", to: "existing-b", type: "blocks" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation to fail");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "dependencies[0]", message: expect.stringContaining("duplicate dependency edge already exists") }),
      expect.objectContaining({ path: "dependencies", message: expect.stringContaining("dependency cycle detected") }),
    ]));
  });

  it("rejects staged local IDs that collide with existing beads", () => {
    const result = validateBeadMutationPlan({
      beads: [makeMutationBead({ localId: "pi-existing" })],
      dependencies: [],
    }, { existingBeads: [{ id: "pi-existing" }] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation to fail");
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "beads[0].localId", message: expect.stringContaining("collides with existing bead") }),
    ]));
  });
});

describe("executeBeadMutationPlan", () => {
  it("validates before invoking any mutation command", async () => {
    const runner = { run: vi.fn(async () => ({ ok: true, stdout: "" })) };
    const result = await executeBeadMutationPlan({
      beads: [makeMutationBead({ localId: "bad", description: "Missing required sections" })],
      dependencies: [],
    }, { runner });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("validation-failed");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("creates beads before dependencies and reports provenance", async () => {
    const calls: string[][] = [];
    const runner = {
      run: vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === "create" && args[1] === "Base bead") return { ok: true, stdout: "✓ Created bead pi-base: Base bead" };
        if (args[0] === "create" && args[1] === "Child bead") return { ok: true, stdout: "✓ Created pi-child: Child bead" };
        return { ok: true, stdout: "✓ Added dependency: pi-child -> pi-base (blocks)" };
      }),
    };

    const result = await executeBeadMutationPlan({
      beads: [makeMutationBead(), makeMutationBead({ localId: "child", title: "Child bead" })],
      dependencies: [{ from: "child", to: "base", type: "blocks" }],
    }, { runner });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected execution to pass");
    expect(calls.map((args) => args[0])).toEqual(["create", "create", "dep"]);
    expect(calls[2]).toEqual(["dep", "add", "pi-child", "pi-base", "--type", "blocks"]);
    expect(result.createdBeads).toEqual([
      { localId: "base", beadId: "pi-base", title: "Base bead" },
      { localId: "child", beadId: "pi-child", title: "Child bead" },
    ]);
    expect(result.dependencyEdges).toEqual([{ from: "pi-child", to: "pi-base", type: "blocks" }]);
    expect(result.commands).toHaveLength(3);
  });

  it("returns partial-failure diagnostics when an injected command fails", async () => {
    const runner = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "create") return { ok: true, stdout: `✓ Created ${args[1] === "Base bead" ? "pi-base" : "pi-child"}: ${args[1]}` };
        return { ok: false, stdout: "", stderr: "dependency failed" };
      }),
    };

    const result = await executeBeadMutationPlan({
      beads: [makeMutationBead(), makeMutationBead({ localId: "child", title: "Child bead" })],
      dependencies: [{ from: "child", to: "base", type: "blocks" }],
    }, { runner });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected execution to fail");
    expect(result.status).toBe("partial-failure");
    expect(result.createdBeads).toHaveLength(2);
    expect(result.dependencyEdges).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ message: "dependency failed" })]);
  });
});

// ─── readBeads ───────────────────────────────────────────────

describe("readBeads", () => {
  it("parses br list --json output", async () => {
    const beads = [makeBead({ id: "b1" }), makeBead({ id: "b2" })];
    const pi = makePi(async () => ({
      code: 0,
      stdout: JSON.stringify({ issues: beads }),
      stderr: "",
    }));

    const result = await readBeads(pi, CWD);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("b1");
  });

  it("returns [] on failure", async () => {
    const pi = makePi(async () => { throw new Error("br not found"); });
    const result = await readBeads(pi, CWD);
    expect(result).toEqual([]);
  });
});

// ─── readyBeads ──────────────────────────────────────────────

describe("readyBeads", () => {
  it("parses br ready --json output", async () => {
    const beads = [makeBead({ id: "ready-1" })];
    const pi = makePi(async () => ({
      code: 0,
      stdout: JSON.stringify({ issues: beads }),
      stderr: "",
    }));

    const result = await readyBeads(pi, CWD);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ready-1");
  });

  it("returns [] on empty output", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "", stderr: "" }));
    const result = await readyBeads(pi, CWD);
    expect(result).toEqual([]);
  });
});

// ─── getBeadById ─────────────────────────────────────────────

describe("getBeadById", () => {
  it("returns bead from br show --json", async () => {
    const bead = makeBead({ id: "abc" });
    const pi = makePi(async () => ({
      code: 0,
      stdout: JSON.stringify(bead),
      stderr: "",
    }));

    const result = await getBeadById(pi, CWD, "abc");
    expect(result?.id).toBe("abc");
  });

  it("normalizes br show --json one-element array output", async () => {
    const bead = makeBead({ id: "abc", title: "Array-shaped bead" });
    const pi = makePi(async () => ({
      code: 0,
      stdout: JSON.stringify([bead]),
      stderr: "",
    }));

    const result = await getBeadById(pi, CWD, "abc");
    expect(result).toMatchObject({ id: "abc", title: "Array-shaped bead" });
  });

  it("returns null on an empty br show --json array", async () => {
    const pi = makePi(async () => ({
      code: 0,
      stdout: JSON.stringify([]),
      stderr: "",
    }));

    const result = await getBeadById(pi, CWD, "missing");
    expect(result).toBeNull();
  });

  it("returns null on failure", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    const result = await getBeadById(pi, CWD, "nope");
    expect(result).toBeNull();
  });
});

// ─── beadDeps ────────────────────────────────────────────────

describe("beadDeps", () => {
  it("parses dep list output", async () => {
    const pi = makePi(async () => ({
      code: 0,
      stdout: "dep-1\ndep-2\n",
      stderr: "",
    }));

    const result = await beadDeps(pi, CWD, "bead-x");
    expect(result).toEqual(["dep-1", "dep-2"]);
  });

  it("returns [] on failure", async () => {
    const pi = makePi(async () => { throw new Error("fail"); });
    const result = await beadDeps(pi, CWD, "bead-x");
    expect(result).toEqual([]);
  });
});

// ─── extractArtifacts ────────────────────────────────────────

describe("extractArtifacts", () => {
  it("extracts paths from bullet lines", () => {
    const bead = makeBead({
      description: "Some text\n- src/foo.ts\n- src/bar.ts\nMore text",
    });
    expect(extractArtifacts(bead)).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("extracts from ### Files: section", () => {
    const bead = makeBead({
      description: "Intro\n### Files:\n  src/a.ts\n  lib/b.ts\n\nDone",
    });
    const result = extractArtifacts(bead);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("lib/b.ts");
  });

  it("returns [] for empty description", () => {
    expect(extractArtifacts(makeBead())).toEqual([]);
  });
});

// ─── Verification contracts ──────────────────────────────────

describe("extractVerificationContract", () => {
  it("extracts only the ### Verification section before ### Files", () => {
    const description = `Intro
${VALID_VERIFICATION_SECTION}
### Files:
- src/beads.ts`;

    const contract = extractVerificationContract(description);
    expect(contract).not.toBeNull();
    expect(contract!.body).toContain("Commands/checks");
    expect(contract!.body).not.toContain("### Files");
    expect(contract!.body).not.toContain("src/beads.ts");
  });

  it("returns null when the heading is absent", () => {
    expect(extractVerificationContract("Intro\n### Files:\n- src/beads.ts")).toBeNull();
  });
});

describe("validateVerificationContract", () => {
  it("accepts a complete verification contract", () => {
    const issues = validateVerificationContract(makeBead({ description: VALID_VERIFICATION_SECTION }));
    expect(issues).toEqual([]);
  });

  it("reports a clear missing-section error", () => {
    const issues = validateVerificationContract(makeBead({ id: "verify-1", description: "No verification here." }));
    expect(issues).toEqual([
      expect.objectContaining({
        beadId: "verify-1",
        issueType: "missing-section",
        reason: expect.stringContaining("missing required ### Verification: section"),
      }),
    ]);
  });

  it("reports missing commands/checks guidance", () => {
    const issues = validateVerificationContract(makeBead({
      id: "verify-2",
      description: `### Verification:
- Success looks like: the review passes.
- Manual proof fallback: if automation cannot cover it, inspect the code manually.`,
    }));
    expect(issues).toEqual([
      expect.objectContaining({
        requirement: "commands-checks",
        reason: expect.stringContaining("missing commands/checks"),
      }),
    ]);
  });

  it("reports missing success expectations", () => {
    const issues = validateVerificationContract(makeBead({
      id: "verify-3",
      description: `### Verification:
- Commands/checks: run npm test -- src/beads.test.ts.
- Manual proof fallback: if automation cannot cover it, inspect the code manually.`,
    }));
    expect(issues).toEqual([
      expect.objectContaining({
        requirement: "success-expectations",
        reason: expect.stringContaining("missing success expectations"),
      }),
    ]);
  });

  it("reports missing manual proof guidance", () => {
    const issues = validateVerificationContract(makeBead({
      id: "verify-4",
      description: `### Verification:
- Commands/checks: run npm test -- src/beads.test.ts.
- Success looks like: the tests pass and the command exits 0.`,
    }));
    expect(issues).toEqual([
      expect.objectContaining({
        requirement: "manual-proof",
        reason: expect.stringContaining("missing manual proof guidance"),
      }),
    ]);
  });
});

// ─── updateBeadStatus ────────────────────────────────────────

describe("updateBeadStatus", () => {
  it("calls br update with correct args", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "", stderr: "" }));
    await updateBeadStatus(pi, CWD, "bead-123", "in_progress");
    expect((pi as any).exec.mock.calls[0]).toEqual([
      "br", ["update", "bead-123", "--status", "in_progress"], expect.any(Object),
    ]);
  });

  it("handles failure gracefully", async () => {
    const pi = makePi(async () => { throw new Error("br failed"); });
    await expect(updateBeadStatus(pi, CWD, "bead-789", "closed")).resolves.toBeUndefined();
  });
});

// ─── validateBeads ───────────────────────────────────────────

describe("updateBeadDescription", () => {
  it("updates bead descriptions through br update", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "", stderr: "" }));

    const ok = await updateBeadDescription(pi, CWD, "pi-1h8u", "New description");

    expect(ok).toBe(true);
    expect((pi.exec as any).mock.calls[0]).toEqual([
      "br",
      ["update", "pi-1h8u", "--description", "New description"],
      { timeout: 10000, cwd: CWD },
    ]);
  });

  it("returns false when br update fails", async () => {
    const pi = makePi(async () => ({ code: 1, stdout: "", stderr: "nope" }));

    const ok = await updateBeadDescription(pi, CWD, "pi-1h8u", "New description");

    expect(ok).toBe(false);
  });
});

describe("validateBeads", () => {
  it("returns ok=true when no cycles", async () => {
    const pi = makePi(async () => ({
      code: 0,
      stdout: "All dependency checks passed.",
      stderr: "",
    }));
    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(true);
    expect(result.cycles).toBe(false);
  });

  it("does not treat successful br dep cycles output as a cycle", async () => {
    const pi = makePi(async () => ({
      code: 0,
      stdout: "✓ No dependency cycles detected.",
      stderr: "",
    }));
    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(true);
    expect(result.cycles).toBe(false);
  });

  it("detects cycles", async () => {
    const pi = makePi(async () => ({
      code: 1,
      stdout: "Detected cycle: a → b → a",
      stderr: "",
    }));
    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(false);
    expect(result.cycles).toBe(true);
  });
});

// ─── getBeadsSummary ─────────────────────────────────────────

describe("getBeadsSummary", () => {
  it("summarizes bead statuses", () => {
    const beads = [
      makeBead({ status: "closed" }),
      makeBead({ status: "in_progress" }),
      makeBead({ status: "open" }),
      makeBead({ status: "open" }),
    ];
    const summary = getBeadsSummary(beads);
    expect(summary).toContain("1 closed");
    expect(summary).toContain("1 in-progress");
    expect(summary).toContain("2 open");
  });

  it("returns 'no beads tracked' for empty array", () => {
    expect(getBeadsSummary([])).toBe("no beads tracked");
  });
});

// ─── detectBv ────────────────────────────────────────────────

describe("detectBv", () => {
  beforeEach(() => resetBvCache());

  it("returns true when bv is found", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" }));
    expect(await detectBv(pi)).toBe(true);
  });

  it("returns false when bv is not found", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    expect(await detectBv(pi)).toBe(false);
  });

  it("caches the result", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" }));
    await detectBv(pi);
    await detectBv(pi);
    expect((pi as any).exec).toHaveBeenCalledTimes(1);
  });
});

// ─── bvInsights ──────────────────────────────────────────────

describe("bvInsights", () => {
  beforeEach(() => resetBvCache());

  it("parses bv --robot-insights output", async () => {
    const insightsData = {
      Bottlenecks: [{ ID: "bead-x", Value: 8.5 }],
      Cycles: null,
      Orphans: [],
      Articulation: ["bead-y"],
      Slack: [{ ID: "bead-z", Value: 2 }],
    };
    // Mock: which bv → found, bv --robot-insights → JSON
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        return { code: 0, stdout: JSON.stringify(insightsData), stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await bvInsights(pi, CWD);
    expect(result).not.toBeNull();
    expect(result!.Bottlenecks).toHaveLength(1);
    expect(result!.Bottlenecks[0].ID).toBe("bead-x");
    expect(result!.Articulation).toEqual(["bead-y"]);
  });

  it("returns null when bv is unavailable", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    expect(await bvInsights(pi, CWD)).toBeNull();
  });
});

// ─── bvNext ──────────────────────────────────────────────────

describe("bvNext", () => {
  beforeEach(() => resetBvCache());

  it("returns the highest-priority next bead", async () => {
    const pickData = {
      id: "bead-abc",
      title: "Do the thing",
      score: 0.85,
      reasons: ["high unblock potential"],
      unblocks: ["bead-def"],
    };
    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        return { code: 0, stdout: JSON.stringify(pickData), stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await bvNext(pi, CWD);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("bead-abc");
    expect(result!.score).toBe(0.85);
    expect(result!.unblocks).toEqual(["bead-def"]);
  });

  it("returns null when no actionable items", async () => {
    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    expect(await bvNext(pi, CWD)).toBeNull();
  });

  it("returns null when bv unavailable", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    expect(await bvNext(pi, CWD)).toBeNull();
  });
});

// ─── bvPlan ──────────────────────────────────────────────────

describe("bvPlan", () => {
  beforeEach(() => resetBvCache());

  it("returns raw output from bv --robot-plan", async () => {
    const planOutput = '{"order":["bead-1","bead-2"],"reasoning":"bead-1 unblocks bead-2"}';
    const pi = {
      exec: vi.fn(async (cmd: string, args?: string[]) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        if (args?.[0] === "--robot-plan") return { code: 0, stdout: planOutput + "\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await bvPlan(pi, CWD);
    expect(result).toBe(planOutput);
  });

  it("returns null when bv unavailable", async () => {
    const pi = makePi(async () => { throw new Error("not found"); });
    expect(await bvPlan(pi, CWD)).toBeNull();
  });

  it("returns null on empty output", async () => {
    const pi = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        return { code: 0, stdout: "  \n", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    expect(await bvPlan(pi, CWD)).toBeNull();
  });
});

// ─── validateBeads with bv ───────────────────────────────────

describe("validateBeads with bv insights", () => {
  beforeEach(() => resetBvCache());

  it("uses bv insights for validation when available", async () => {
    const insightsData = {
      Bottlenecks: [{ ID: "bead-hot", Value: 10.2 }],
      Cycles: null,
      Orphans: [],
      Articulation: ["bead-critical"],
      Slack: [],
    };
    // readBeads must return open beads matching the IDs in bv insights,
    // otherwise the open-bead filter will drop them.
    const openBeads = [
      { id: "bead-hot", title: "Hot", description: `A bottleneck bead with enough content to pass checks.\n${VALID_VERIFICATION_SECTION}\n### Files:\n- src/hot.ts\n- [ ] criterion`, status: "open", priority: 2, type: "task", labels: [] },
      { id: "bead-critical", title: "Critical", description: `An articulation point bead with enough content.\n${VALID_VERIFICATION_SECTION}\n### Files:\n- src/critical.ts\n- [ ] criterion`, status: "open", priority: 2, type: "task", labels: [] },
    ];
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        if (cmd === "bv") return { code: 0, stdout: JSON.stringify(insightsData), stderr: "" };
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify(openBeads), stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(true);
    expect(result.cycles).toBe(false);
    expect(result.warnings).toContain("bead bead-hot is a bottleneck (betweenness=10.2) — consider splitting");
    expect(result.warnings).toContain("bead bead-critical is a single point of failure in the dep graph");
  });

  it("detects cycles from bv insights", async () => {
    const insightsData = {
      Bottlenecks: [],
      Cycles: [["a", "b", "a"]],
      Orphans: ["orphan-1"],
      Articulation: [],
      Slack: [],
    };
    // readBeads must return open beads matching cycle and orphan IDs
    const openBeads = [
      { id: "a", title: "A", description: "Bead A", status: "open", priority: 2, type: "task", labels: [] },
      { id: "b", title: "B", description: "Bead B", status: "open", priority: 2, type: "task", labels: [] },
      { id: "orphan-1", title: "Orphan", description: "Orphan bead", status: "open", priority: 2, type: "task", labels: [] },
    ];
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") return { code: 0, stdout: "/usr/local/bin/bv\n", stderr: "" };
        if (cmd === "bv") return { code: 0, stdout: JSON.stringify(insightsData), stderr: "" };
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify(openBeads), stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(false);
    expect(result.cycles).toBe(true);
    expect(result.orphaned).toEqual(["orphan-1"]);
  });

  it("falls back to manual detection when bv unavailable", async () => {
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        // br dep cycles
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") {
          return { code: 0, stdout: "All dependency checks passed.", stderr: "" };
        }
        // br list --json
        return { code: 0, stdout: JSON.stringify([]), stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await validateBeads(pi, CWD);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

// ─── qualityCheckBeads ───────────────────────────────────────

describe("qualityCheckBeads", () => {
  beforeEach(() => resetBvCache());

  const validDescription = `This bead implements the widget feature with proper error handling and tests.

## What to implement
Add a new widget component that handles user input validation and displays results.

### Files: src/widget.ts, src/widget.test.ts

## Acceptance criteria
- [ ] Widget renders correctly
- [ ] Input validation works
- [ ] Tests pass`;

  it("passes for a well-formed bead", async () => {
    const beads = [makeBead({ id: "good-1", description: validDescription })];
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found"); // no bv
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify(beads), stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") return { code: 0, stdout: "OK", stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await qualityCheckBeads(pi, CWD);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.summary.score).toBe(100);
    expect(result.summary.failedChecks).toBe(0);
    expect(result.summary.totalChecks).toBeGreaterThan(0);
  });

  it("fails for empty description", async () => {
    const beads = [makeBead({ id: "empty-1", description: "" })];
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify(beads), stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") return { code: 0, stdout: "OK", stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await qualityCheckBeads(pi, CWD);
    expect(result.passed).toBe(false);
    const checks = result.failures.map((f) => f.check);
    expect(checks).toContain("has-substance");
    expect(checks).toContain("has-file-scope");
    expect(checks).toContain("has-acceptance-criteria");
    expect(checks).toContain("not-oversimplified");
  });

  it("fails for missing files section", async () => {
    const desc = "A".repeat(100) + "\n" + "word ".repeat(50) + "\n- [ ] criterion";
    const beads = [makeBead({ id: "nofiles-1", description: desc })];
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify(beads), stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") return { code: 0, stdout: "OK", stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await qualityCheckBeads(pi, CWD);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.check === "has-file-scope")).toBe(true);
  });

  it("fails for missing acceptance criteria", async () => {
    const desc = "A".repeat(100) + "\n" + "word ".repeat(50) + "\n### Files: src/foo.ts";
    const beads = [makeBead({ id: "nocrit-1", description: desc })];
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify(beads), stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") return { code: 0, stdout: "OK", stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await qualityCheckBeads(pi, CWD);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.check === "has-acceptance-criteria")).toBe(true);
    expect(result.summary.score).toBeLessThan(100);
    expect(result.summary.failuresByCheck["has-acceptance-criteria"]).toBe(1);
  });
});

// ─── file-overlap detection ──────────────────────────────────

describe("qualityCheckBeads file-overlap", () => {
  beforeEach(() => resetBvCache());

  const makeValidDesc = (...files: string[]) =>
    `This bead implements a feature with proper error handling and thorough testing throughout.

## What to implement
Add a new component that handles user input validation and displays results properly.

### Files:
${files.map((f) => `- ${f}`).join("\n")}

## Acceptance criteria
- [ ] Component works correctly
- [ ] Tests pass`;

  function makeOverlapPi(allBeads: Bead[], readyBeads: Bead[]) {
    return {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify(allBeads), stderr: "" };
        if (cmd === "br" && args[0] === "ready") return { code: 0, stdout: JSON.stringify(readyBeads), stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") return { code: 0, stdout: "OK", stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "list") return { code: 0, stdout: "", stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;
  }

  it("no failure for disjoint files", async () => {
    const b1 = makeBead({ id: "a1", description: makeValidDesc("src/foo.ts") });
    const b2 = makeBead({ id: "a2", description: makeValidDesc("src/bar.ts") });
    const pi = makeOverlapPi([b1, b2], [b1, b2]);

    const result = await qualityCheckBeads(pi, CWD);
    expect(result.failures.some((f) => f.check === "file-overlap")).toBe(false);
  });

  it("fails for two ready beads sharing a file", async () => {
    const b1 = makeBead({ id: "a1", description: makeValidDesc("src/shared.ts") });
    const b2 = makeBead({ id: "a2", description: makeValidDesc("src/shared.ts") });
    const pi = makeOverlapPi([b1, b2], [b1, b2]);

    const result = await qualityCheckBeads(pi, CWD);
    expect(result.passed).toBe(false);
    const overlap = result.failures.filter((f) => f.check === "file-overlap");
    expect(overlap.length).toBe(1);
    expect(overlap[0].reason).toContain("a1");
    expect(overlap[0].reason).toContain("a2");
    expect(overlap[0].reason).toContain("src/shared.ts");
    expect(result.summary.failuresByCheck["file-overlap"]).toBe(1);
  });

  it("no failure when beads with deps share files (not both ready)", async () => {
    const b1 = makeBead({ id: "a1", description: makeValidDesc("src/shared.ts") });
    const b2 = makeBead({ id: "a2", description: makeValidDesc("src/shared.ts") });
    // Only b1 is ready (b2 depends on b1)
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify([b1, b2]), stderr: "" };
        if (cmd === "br" && args[0] === "ready") return { code: 0, stdout: JSON.stringify([b1]), stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") return { code: 0, stdout: "OK", stderr: "" };
        if (cmd === "br" && args[0] === "dep" && args[1] === "list") {
          if (args[2] === "a2") return { code: 0, stdout: "a1", stderr: "" };
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await qualityCheckBeads(pi, CWD);
    expect(result.failures.some((f) => f.check === "file-overlap")).toBe(false);
  });
});

// ─── validateBeads shallowBeads ──────────────────────────────

describe("validateBeads shallowBeads", () => {
  beforeEach(() => resetBvCache());

  it("returns shallowBeads for empty descriptions", async () => {
    const beads = [makeBead({ id: "shallow-1", description: "short" })];
    const pi = {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") return { code: 0, stdout: "OK", stderr: "" };
        if (cmd === "br" && args[0] === "list") return { code: 0, stdout: JSON.stringify(beads), stderr: "" };
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;

    const result = await validateBeads(pi, CWD);
    expect(result.shallowBeads).toHaveLength(1);
    expect(result.shallowBeads[0].id).toBe("shallow-1");
    expect(result.shallowBeads[0].reason).toContain("too short");
  });
});

describe("validateBeads verification contracts", () => {
  beforeEach(() => resetBvCache());

  function makeValidationPi(beads: Bead[]) {
    return {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") {
          return { code: 0, stdout: "OK", stderr: "" };
        }
        if (cmd === "br" && args[0] === "list") {
          return { code: 0, stdout: JSON.stringify(beads), stderr: "" };
        }
        if (cmd === "br" && args[0] === "dep" && args[1] === "list") {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;
  }

  it("surfaces missing verification sections in validateBeads", async () => {
    const bead = makeBead({
      id: "missing-verify",
      description: "This bead has files and acceptance criteria but no verification section.\n\n### Files:\n- src/beads.ts\n\n- [ ] update code\n- [ ] add tests",
    });

    const result = await validateBeads(makeValidationPi([bead]), CWD);
    expect(result.ok).toBe(false);
    expect(result.verificationIssues).toEqual([
      expect.objectContaining({
        beadId: "missing-verify",
        issueType: "missing-section",
        reason: expect.stringContaining("missing required ### Verification: section"),
      }),
    ]);
  });

  it("surfaces component-specific verification requirement failures", async () => {
    const bead = makeBead({
      id: "weak-verify",
      description: `This bead has an incomplete verification section.

### Verification:
- Review the changes.

### Files:
- src/beads.ts

- [ ] update code
- [ ] add tests`,
    });

    const result = await validateBeads(makeValidationPi([bead]), CWD);
    expect(result.ok).toBe(false);
    expect(result.verificationIssues.map((issue) => issue.requirement)).toEqual([
      "commands-checks",
      "success-expectations",
      "manual-proof",
    ]);
    expect(result.verificationIssues.map((issue) => issue.reason)).toEqual([
      expect.stringContaining("missing commands/checks"),
      expect.stringContaining("missing success expectations"),
      expect.stringContaining("missing manual proof guidance"),
    ]);
  });
});

describe("validateBeads template hygiene", () => {
  beforeEach(() => resetBvCache());

  function makeValidationPi(beads: Bead[]) {
    return {
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "which") throw new Error("not found");
        if (cmd === "br" && args[0] === "dep" && args[1] === "cycles") {
          return { code: 0, stdout: "OK", stderr: "" };
        }
        if (cmd === "br" && args[0] === "list") {
          return { code: 0, stdout: JSON.stringify(beads), stderr: "" };
        }
        if (cmd === "br" && args[0] === "dep" && args[1] === "list") {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "[]", stderr: "" };
      }),
    } as unknown as ExtensionAPI;
  }

  it("flags raw template markers and shorthand in open beads", async () => {
    const beads = [
      makeBead({
        id: "tmpl-1",
        description: `This bead still needs expansion.\n[Use template: add-api-endpoint]\nsee template for the rest\n### Files:\n- src/api/users.ts\n- src/api/users.test.ts\n- [ ] one\n- [ ] two`,
      }),
    ];

    const result = await validateBeads(makeValidationPi(beads), CWD);
    expect(result.ok).toBe(false);
    expect(result.templateIssues.some((issue) => issue.issueType === "raw-template-marker")).toBe(true);
    expect(result.templateIssues.some((issue) => issue.issueType === "template-shorthand")).toBe(true);
  });

  it("flags unresolved placeholder syntax", async () => {
    const beads = [
      makeBead({
        id: "tmpl-2",
        description: `Implement endpoint for {{endpointPath}} with schema in <SCHEMA_NAME>.\n### Files:\n- src/api/users.ts\n- src/api/users.test.ts\n- [ ] one\n- [ ] two`,
      }),
    ];

    const result = await validateBeads(makeValidationPi(beads), CWD);
    expect(result.templateIssues.filter((issue) => issue.issueType === "unresolved-placeholder")).toHaveLength(2);
    expect(result.templateIssues.every((issue) => issue.beadId === "tmpl-2")).toBe(true);
  });

  it("does not flag generic type syntax as unresolved placeholders", async () => {
    const beads = [
      makeBead({
        id: "tmpl-typed",
        description: `Document that this helper returns Promise<Result<T>> and integrates with <ErrorBoundary> in docs.\n\n${VALID_VERIFICATION_SECTION}\n\n### Files:\n- src/parser.ts\n- src/parser.test.ts\n\n- [ ] explain the typing\n- [ ] keep tests passing`,
      }),
    ];

    const result = await validateBeads(makeValidationPi(beads), CWD);
    expect(result.templateIssues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("does not flag legitimate mentions of template in prose", async () => {
    const beads = [
      makeBead({
        id: "tmpl-3",
        description: `This bead follows the singleton template pattern used in the parser and documents why that pattern matters for maintainability.\n\n${VALID_VERIFICATION_SECTION}\n\n### Files:\n- src/parser.ts\n- src/parser.test.ts\n\n- [ ] explain the pattern\n- [ ] keep tests passing`,
      }),
    ];

    const result = await validateBeads(makeValidationPi(beads), CWD);
    expect(result.templateIssues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("ignores closed beads with template markers", async () => {
    const beads = [
      makeBead({
        id: "tmpl-4",
        status: "closed",
        description: `[Use template: add-tests]\nsee template\n{{featureName}}`,
      }),
    ];

    const result = await validateBeads(makeValidationPi(beads), CWD);
    expect(result.templateIssues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("adds a missing-structure issue when template artifacts remain without concrete bead sections", async () => {
    const beads = [
      makeBead({
        id: "tmpl-5",
        description: `Use template: add-api-endpoint\n{{endpointPath}}`,
      }),
    ];

    const result = await validateBeads(makeValidationPi(beads), CWD);
    expect(result.templateIssues.some((issue) => issue.issueType === "template-missing-structure")).toBe(true);
  });

  it("surfaces template hygiene failures through qualityCheckBeads", async () => {
    const beads = [
      makeBead({
        id: "tmpl-6",
        description: `This bead needs follow-up.\n[Use template: add-api-endpoint]\n### Files:\n- src/api/users.ts\n- src/api/users.test.ts\n\n- [ ] one\n- [ ] two\n\n${"word ".repeat(60)}`,
      }),
    ];
    const pi = makeValidationPi(beads);

    const result = await qualityCheckBeads(pi, CWD);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.check === "template-hygiene")).toBe(true);
  });
});

describe("auditPlanToBeads", () => {
  it("flags uncovered plan sections with no bead matches", async () => {
    const { auditPlanToBeads } = await import("./beads.js");
    const plan = `# Feature Plan

## API Contract
Add route handlers and request validation.

## Rollout Safety
Add migration rollback and feature flag coverage.`;
    const beads = [
      makeBead({ id: "b1", title: "Implement API contract", description: "Add route handlers and request validation in src/api.ts" }),
    ];

    const audit = auditPlanToBeads(plan, beads);
    expect(audit.uncoveredSections.map((section) => section.heading)).toContain("Rollout Safety");
    expect(audit.sections.find((section) => section.heading === "API Contract")?.matches[0]?.beadId).toBe("b1");
  });

  it("flags weak mappings when overlap is too thin", async () => {
    const { auditPlanToBeads } = await import("./beads.js");
    const plan = `## Testing Strategy
Cover retries, backoff, and timeout behavior.`;
    const beads = [
      makeBead({ id: "b2", title: "Add timeout smoke test", description: "Write a basic smoke test in src/tests.ts" }),
    ];

    const audit = auditPlanToBeads(plan, beads);
    expect(audit.weakMappings.map((section) => section.heading)).toContain("Testing Strategy");
  });
});
