import { describe, it, expect } from "vitest";
import { assessVerificationEvidence, extractVerificationCommands, parseSuggestions } from "./bead-review.js";
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
});
