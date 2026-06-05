import { describe, it, expect } from "vitest";
import {
  assessAcceptanceCriteriaEvidence,
  assessVerificationEvidence,
  extractAcceptanceCriteria,
  extractVerificationCommands,
  formatAcceptanceCriteriaEvidenceMatrix,
  parseSuggestions,
  pickAlternativeBeadReviewModel,
} from "./bead-review.js";
import type { VerificationContract } from "./types.js";

describe("parseSuggestions", () => {
  it("parses numbered list", () => {
    const input = `1. Fix bead A dependency on bead B
2. Split bead C into two smaller beads
3. Add error handling to bead D`;
    const result = parseSuggestions(input);
    expect(result).toEqual([
      "Fix bead A dependency on bead B",
      "Split bead C into two smaller beads",
      "Add error handling to bead D",
    ]);
  });

  it("parses bullet list", () => {
    const input = `- Bead A should depend on bead B
* Bead C is too vague
• Missing acceptance criteria on bead D`;
    const result = parseSuggestions(input);
    expect(result).toEqual([
      "Bead A should depend on bead B",
      "Bead C is too vague",
      "Missing acceptance criteria on bead D",
    ]);
  });

  it("parses mixed format (numbered + bullets)", () => {
    const input = `1. First suggestion about bead A
- Second suggestion about bead B
2. Third suggestion about bead C`;
    const result = parseSuggestions(input);
    expect(result).toEqual([
      "First suggestion about bead A",
      "Second suggestion about bead B",
      "Third suggestion about bead C",
    ]);
  });

  it("falls back to paragraphs for prose-only output", () => {
    const input = `The beads look generally well-structured. However, bead A could benefit from clearer acceptance criteria.

Bead C and bead D seem to overlap in scope. Consider merging them.

Overall the dependency graph is correct.`;
    const result = parseSuggestions(input);
    expect(result).toHaveLength(3);
    expect(result[0]).toContain("bead A");
    expect(result[1]).toContain("merging");
  });

  it("returns empty array for empty output", () => {
    expect(parseSuggestions("")).toEqual([]);
    expect(parseSuggestions("   ")).toEqual([]);
  });

  it("handles continuation lines in numbered lists", () => {
    const input = `1. This is a long suggestion that
   continues on the next line
2. This is another suggestion`;
    const result = parseSuggestions(input);
    expect(result).toEqual([
      "This is a long suggestion that continues on the next line",
      "This is another suggestion",
    ]);
  });

  it("handles markdown headers as section delimiters", () => {
    // Ensure test coverage for bead pi-r47: validation against verification contracts
    const input = `## Gaps
- Missing error handling in bead A
## Dependencies
- Bead B should depend on bead C`;
    const result = parseSuggestions(input);
    expect(result).toEqual([
      "Missing error handling in bead A",
      "Bead B should depend on bead C",
    ]);
  });
});

describe("pickAlternativeBeadReviewModel", () => {
  it("uses an alternative Google model routed through OpenRouter", () => {
    expect(pickAlternativeBeadReviewModel()).toBe("openrouter/google/gemini-2.5-pro");
  });
});

describe("verification evidence assessment", () => {
  const contract: VerificationContract = {
    body: `- Commands/checks: run npm test -- src/bead-review.test.ts and npm run build.
- Success looks like: the focused tests pass and TypeScript compiles.
- Manual proof fallback: if commands cannot run, capture the exact blocker and manually inspect the review prompt.`,
    startLine: 1,
    endLine: 4,
  };

  it("extracts concrete command/checks from a verification contract", () => {
    expect(extractVerificationCommands(contract)).toEqual([
      "npm test -- src/bead-review.test.ts",
      "npm run build",
    ]);
  });

  it("accepts evidence keyed to every named command/check", () => {
    const result = assessVerificationEvidence(
      contract,
      `Verified:
- npm test -- src/bead-review.test.ts passed.
- npm run build passed.`
    );

    expect(result.ok).toBe(true);
    expect(result.missingCommands).toEqual([]);
  });

  it("rejects generic passing claims when the contract names specific commands", () => {
    const result = assessVerificationEvidence(contract, "All tests passed. Looks good.");

    expect(result.ok).toBe(false);
    expect(result.issues.join("\n")).toContain("generic evidence is insufficient");
    expect(result.missingCommands).toEqual([
      "npm test -- src/bead-review.test.ts",
      "npm run build",
    ]);
  });

  it("rejects partial evidence that omits one required command/check", () => {
    const result = assessVerificationEvidence(contract, "npm test -- src/bead-review.test.ts passed.");

    expect(result.ok).toBe(false);
    expect(result.missingCommands).toEqual(["npm run build"]);
  });

  it("allows a justified manual proof fallback when automation is blocked", () => {
    const result = assessVerificationEvidence(
      contract,
      "Manual proof fallback used: npm is unavailable in this environment, so commands could not run. I manually inspected the review prompt output and captured the exact blocker."
    );

    expect(result.ok).toBe(true);
    expect(result.manualFallbackUsed).toBe(true);
  });

  it("does not treat optional/fallback commands as required checks", () => {
    const optionalContract: VerificationContract = {
      body: `- Commands/checks: run npm test -- src/bead-review.test.ts; optional: npm run lint if available; fallback: npm run build if test runner is unavailable.
- Success looks like: required tests pass.
- Manual proof fallback: if commands cannot run, capture blockers and inspect manually.`,
      startLine: 1,
      endLine: 3,
    };

    const result = assessVerificationEvidence(optionalContract, "npm test -- src/bead-review.test.ts passed.");

    expect(result.ok).toBe(true);
    expect(result.requiredCommands).toEqual(["npm test -- src/bead-review.test.ts"]);
  });

  it("does not treat manual fallback example commands as required checks", () => {
    const fallbackContract: VerificationContract = {
      body: `- Commands/checks: run npm test -- src/bead-review.test.ts.
- Success looks like: tests pass.
- Manual proof fallback: if commands cannot run, run npm run build if possible, then inspect manually.`,
      startLine: 1,
      endLine: 3,
    };

    expect(extractVerificationCommands(fallbackContract)).toEqual(["npm test -- src/bead-review.test.ts"]);
  });

  it("accepts Branch A layout verification without requiring the mutually exclusive Branch B cargo command", () => {
    const branchContract: VerificationContract = {
      body: `- Commands/checks: run cd dashboard-ui && npm run typecheck; cd dashboard-ui && npm run build; cd dashboard-ui && npm run test:unit -- src-menubar/__tests__/menubar-shell-smoke.test.tsx; Branch A: bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml; Branch B: bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets; br dep cycles.
- Success looks like: both branches run typecheck/build and only the layout-specific cargo command differs.
- Manual proof fallback: if commands cannot run, capture blockers and inspect manually.`,
      startLine: 1,
      endLine: 3,
    };

    const result = assessVerificationEvidence(branchContract, `
Branch A selected and documented.
cd dashboard-ui && npm run typecheck exit 0
cd dashboard-ui && npm run build exit 0; produced dist/menubar.html and dist/index.html
cd dashboard-ui && npm run test:unit -- src-menubar/__tests__/menubar-shell-smoke.test.tsx exit 0
bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml exit 0
Branch A required file exists: dashboard-ui/src-tauri/Cargo.toml
br dep cycles reports no cycles
Running Branch B command correctly fails: bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets error: package ID specification 'menubar-app' did not match any packages
`);

    expect(result.ok).toBe(true);
    expect(result.requiredCommands).not.toContain("bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets");
    expect(result.missingCommands).toEqual([]);
  });

  it("accepts Branch B layout verification without requiring the mutually exclusive Branch A cargo command", () => {
    const branchContract: VerificationContract = {
      body: `- Commands/checks: run cd dashboard-ui && npm run typecheck; Branch A: bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml; Branch B: bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets; br dep cycles.
- Success looks like: selected layout cargo check passes.
- Manual proof fallback: if commands cannot run, capture blockers and inspect manually.`,
      startLine: 1,
      endLine: 3,
    };

    const result = assessVerificationEvidence(branchContract, `
Branch B selected and documented.
cd dashboard-ui && npm run typecheck exit 0
bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets exit 0
br dep cycles reports no cycles
`);

    expect(result.ok).toBe(true);
    expect(result.requiredCommands).not.toContain("bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml");
    expect(result.missingCommands).toEqual([]);
  });

  it("keeps selected Branch A layout checks strict", () => {
    const branchContract: VerificationContract = {
      body: `- Commands/checks: run Branch A: bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml; Branch B: bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets.
- Success looks like: selected layout cargo check passes.
- Manual proof fallback: if commands cannot run, capture blockers and inspect manually.`,
      startLine: 1,
      endLine: 3,
    };

    const result = assessVerificationEvidence(branchContract, `Branch A selected and documented. dashboard-ui/src-tauri/Cargo.toml exists, but cargo check was not run.`);

    expect(result.ok).toBe(false);
    expect(result.missingCommands).toContain("bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml");
  });

  it("accepts markdown-backticked menubar verification contract evidence", () => {
    const menubarContract: VerificationContract = {
      body: `Commands/checks (both branches must run typecheck + build; only the layout-specific cargo command differs):
  - \`cd dashboard-ui && npm run typecheck\` — must exit 0; the menubar entry is included in tsconfig but does not break the browser dashboard typecheck.
  - \`cd dashboard-ui && npm run build\` — must exit 0 and produce a separate build output for the menubar entry (the existing browser dashboard build output must remain present and unchanged in shape).
  - \`cd dashboard-ui && npm run test:unit -- src-menubar/__tests__/menubar-shell-smoke.test.tsx\` — must exit 0 and prove the dedicated menubar entry mounts the placeholder app without live gateway credentials or mutation affordances; native tray/popover journey beyond mount can remain companion-covered by \`topstepx-n3srz\`.
  - Branch A (default \`dashboard-ui/src-tauri/\` layout):
    - \`bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml\` — must exit 0.
    - \`test -f dashboard-ui/src-tauri/Cargo.toml && test -f dashboard-ui/src-tauri/build.rs && test -f dashboard-ui/src-tauri/tauri.conf.json && test -f dashboard-ui/src-tauri/capabilities/default.json && test -f dashboard-ui/src-tauri/src/main.rs && test -f dashboard-ui/src-tauri/README.md\` — must succeed.
  - Branch B (workspace crate, e.g. \`crates/menubar-app/\`):
    - \`bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets\` — must exit 0.
    - The module-local note must record the exact reason the workspace crate split was required.
  - Tauri 2 API proof recorded: \`grep -nE "tauri[- ]?(plugin)?[- ]?(tray|positioner|window-state)" dashboard-ui/src-tauri/Cargo.toml 2>/dev/null || grep -nE "tauri[- ]?plugin" crates/menubar-app/Cargo.toml 2>/dev/null\` — must show the exact plugin/feature names that match the chosen layout, and the README/note must cite the Tauri 2 docs URL or version used.
  - Read-only boundary holds at scaffold time: \`grep -nE "place_order|flatten|kill_switch|cancel_order|set_size|update_param|submit_order" dashboard-ui/src-tauri/src dashboard-ui/src-menubar 2>/dev/null\` — must return no matches.
  - Dual-entry isolation: \`grep -nE "src-menubar|menubar\\.html" dashboard-ui/index.html dashboard-ui/menubar.html dashboard-ui/vite.config.* 2>/dev/null\` — the menubar entry must be wired through a separate Vite input/HTML or a separate Vite config so the browser dashboard entry is not modified.
  - \`br dep cycles\` — must report "No dependency cycles detected.".
- Success looks like: typecheck, build, and the lightweight menubar-entry smoke test all pass with both entries coexisting.
- Manual proof fallback: if Tauri dependencies or macOS build tools cannot run on this machine, capture the exact command and error, then inspect manually.`,
      startLine: 1,
      endLine: 20,
    };

    expect(extractVerificationCommands(menubarContract)).toEqual([
      "cd dashboard-ui && npm run typecheck",
      "cd dashboard-ui && npm run build",
      "cd dashboard-ui && npm run test:unit -- src-menubar/__tests__/menubar-shell-smoke.test.tsx",
      "bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml",
      "test -f dashboard-ui/src-tauri/Cargo.toml && test -f dashboard-ui/src-tauri/build.rs && test -f dashboard-ui/src-tauri/tauri.conf.json && test -f dashboard-ui/src-tauri/capabilities/default.json && test -f dashboard-ui/src-tauri/src/main.rs && test -f dashboard-ui/src-tauri/README.md",
      "bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets",
      "grep -nE \"tauri[- ]?(plugin)?[- ]?(tray|positioner|window-state)\" dashboard-ui/src-tauri/Cargo.toml 2>/dev/null || grep -nE \"tauri[- ]?plugin\" crates/menubar-app/Cargo.toml 2>/dev/null",
      "grep -nE \"place_order|flatten|kill_switch|cancel_order|set_size|update_param|submit_order\" dashboard-ui/src-tauri/src dashboard-ui/src-menubar 2>/dev/null",
      "grep -nE \"src-menubar|menubar\\.html\" dashboard-ui/index.html dashboard-ui/menubar.html dashboard-ui/vite.config.* 2>/dev/null",
      "br dep cycles",
    ]);

    const result = assessVerificationEvidence(menubarContract, `
Branch A selected and documented.
cd dashboard-ui && npm run typecheck — PASS, exit 0.
cd dashboard-ui && npm run build — PASS, exit 0; output included dist/menubar.html and dist/index.html.
cd dashboard-ui && npm run test:unit -- src-menubar/__tests__/menubar-shell-smoke.test.tsx — PASS, exit 0; 1 test passed.
bash scripts/build-mutex.sh cargo check --manifest-path dashboard-ui/src-tauri/Cargo.toml — PASS, exit 0.
test -f dashboard-ui/src-tauri/Cargo.toml && test -f dashboard-ui/src-tauri/build.rs && test -f dashboard-ui/src-tauri/tauri.conf.json && test -f dashboard-ui/src-tauri/capabilities/default.json && test -f dashboard-ui/src-tauri/src/main.rs && test -f dashboard-ui/src-tauri/README.md — PASS, exit 0.
grep -nE "tauri[- ]?(plugin)?[- ]?(tray|positioner|window-state)" dashboard-ui/src-tauri/Cargo.toml 2>/dev/null || grep -nE "tauri[- ]?plugin" crates/menubar-app/Cargo.toml 2>/dev/null — PASS, output showed tauri-plugin-positioner and tauri-plugin-window-state.
grep -nE "place_order|flatten|kill_switch|cancel_order|set_size|update_param|submit_order" dashboard-ui/src-tauri/src dashboard-ui/src-menubar 2>/dev/null — PASS; no mutation-token matches were emitted.
grep -nE "src-menubar|menubar\\.html" dashboard-ui/index.html dashboard-ui/menubar.html dashboard-ui/vite.config.* 2>/dev/null — PASS, exit 0.
br dep cycles — PASS, exit 0; No dependency cycles detected.
Branch B command is not applicable because Branch A was selected and documented.
`);

    expect(result.ok).toBe(true);
    expect(result.requiredCommands).not.toContain("bash scripts/build-mutex.sh cargo check -p menubar-app --all-targets");
    expect(result.missingCommands).toEqual([]);
  });
});

describe("acceptance criteria evidence assessment", () => {
  const description = `Implement the feature.

Acceptance criteria:
- [ ] Add the GET /api/users endpoint with request validation.
- [ ] Preserve existing authentication behavior.
- [ ] Add tests for the happy path and invalid input.`;

  it("extracts checkbox acceptance criteria from bead descriptions", () => {
    expect(extractAcceptanceCriteria(description)).toEqual([
      "Add the GET /api/users endpoint with request validation.",
      "Preserve existing authentication behavior.",
      "Add tests for the happy path and invalid input.",
    ]);
  });

  it("marks each explicitly evidenced criterion as proven", () => {
    const result = assessAcceptanceCriteriaEvidence(description, [
      "Implemented GET /api/users endpoint with request validation.",
      "Preserved existing authentication behavior by leaving the auth middleware path unchanged.",
      "Added tests for the happy path and invalid input.",
    ].join("\n"));

    expect(result.ok).toBe(true);
    expect(result.criteria.map((criterion) => criterion.status)).toEqual(["proven", "proven", "proven"]);
  });

  it("rejects generic completion claims when criteria are named", () => {
    const result = assessAcceptanceCriteriaEvidence(description, "Implemented. All tests passed. Looks good.");

    expect(result.ok).toBe(false);
    expect(result.criteria.map((criterion) => criterion.status)).toEqual(["unproven", "unproven", "unproven"]);
    expect(result.issues.join("\n")).toContain("generic completion evidence is insufficient");
  });

  it("allows documented manual fallback evidence as blocked rather than unproven", () => {
    const result = assessAcceptanceCriteriaEvidence(
      description,
      "Manual proof fallback used: npm is unavailable, so the test command could not run. I manually inspected the endpoint, auth behavior, and test file."
    );

    expect(result.ok).toBe(true);
    expect(result.criteria.map((criterion) => criterion.status)).toEqual(["blocked", "blocked", "blocked"]);
  });

  it("does not mark every criterion not-applicable when only an alternate branch is not applicable", () => {
    const menubarDescription = `Implement menubar shell.

Acceptance criteria:
- [ ] Verify the exact Tauri 2 tray/status-bar/popover/window APIs before coding against them, and preserve the proof in code comments or the module-local note.
- [ ] Keep package/workspace changes minimal and explain why they were necessary.
- [ ] Confirm the scaffold exposes no order placement, flatten, kill-switch, sizing, or strategy-parameter mutation affordances.`;

    const result = assessAcceptanceCriteriaEvidence(menubarDescription, `
Verified Tauri 2 tray/status-bar/popover/window APIs in the module-local note.
Kept package/workspace changes minimal by choosing Branch A dashboard-ui/src-tauri; no workspace crate split was necessary.
Confirmed the scaffold exposes no order placement, flatten, kill-switch, sizing, or strategy-parameter mutation affordances.
Branch B command is not applicable because Branch A was selected.
`);

    expect(result.ok).toBe(true);
    expect(result.criteria.map((criterion) => criterion.status)).toEqual(["proven", "proven", "proven"]);
  });

  it("formats a per-criterion proof matrix", () => {
    const result = assessAcceptanceCriteriaEvidence(description, "Implemented GET /api/users endpoint with request validation.");
    const matrix = formatAcceptanceCriteriaEvidenceMatrix(result);

    expect(matrix).toContain("proven: Add the GET /api/users endpoint");
    expect(matrix).toContain("unproven: Preserve existing authentication behavior");
  });
});
