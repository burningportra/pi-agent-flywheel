import { describe, expect, it } from "vitest";
import {
  extractVerificationContract,
  validateVerificationContract,
} from "./beads.js";
import {
  assessVerificationEvidence,
  extractVerificationCommands,
} from "./bead-review.js";
import type { Bead } from "./types.js";

function beadWithDescription(description: string): Bead {
  return {
    id: "verify-docs",
    title: "Document verification contracts",
    description,
    status: "open",
    priority: 1,
    type: "task",
    labels: [],
  };
}

const realisticBeadDescription = `Add documentation and regression coverage for verification contracts.

Why this bead exists:
- Fresh agents need exact proof requirements before implementation starts.
- Review should compare evidence against the requested checks, not generic claims.

Acceptance criteria:
- [ ] Document good and bad verification examples.
- [ ] Add regression coverage for validation and review evidence.

### Verification:
- Commands/checks: run npm test -- src/verification-contracts.integration.test.ts and npm run build.
- Success looks like: the focused integration test passes, TypeScript compiles, and both commands exit 0.
- Manual proof fallback: if commands cannot run, capture the exact blocker and manually inspect README examples plus validator/review assertions.

### Files:
- README.md
- src/verification-contracts.integration.test.ts`;

describe("verification contracts end to end", () => {
  it("accepts a realistic planned bead and validates matching review evidence", () => {
    const bead = beadWithDescription(realisticBeadDescription);

    expect(validateVerificationContract(bead)).toEqual([]);

    const contract = extractVerificationContract(bead.description);
    expect(contract).not.toBeNull();
    expect(contract!.body).toContain("Commands/checks");
    expect(contract!.body).not.toContain("### Files");

    expect(extractVerificationCommands(contract!)).toEqual([
      "npm test -- src/verification-contracts.integration.test.ts",
      "npm run build",
    ]);

    const evidence = assessVerificationEvidence(
      contract!,
      `Verified:
- npm test -- src/verification-contracts.integration.test.ts passed.
- npm run build passed.`
    );

    expect(evidence.ok).toBe(true);
    expect(evidence.missingCommands).toEqual([]);
  });

  it("rejects a bead whose verification contract omits manual proof guidance", () => {
    const bead = beadWithDescription(`Implement the feature.

### Verification:
- Commands/checks: run npm test -- src/verification-contracts.integration.test.ts.
- Success looks like: the focused test passes.

### Files:
- src/verification-contracts.integration.test.ts`);

    expect(validateVerificationContract(bead)).toEqual([
      expect.objectContaining({
        beadId: "verify-docs",
        requirement: "manual-proof",
        reason: expect.stringContaining("manual proof guidance"),
      }),
    ]);
  });

  it("rejects generic review evidence for a contract with exact commands", () => {
    const contract = extractVerificationContract(realisticBeadDescription)!;

    const evidence = assessVerificationEvidence(contract, "All tests passed. Looks good.");

    expect(evidence.ok).toBe(false);
    expect(evidence.issues.join("\n")).toContain("generic evidence is insufficient");
    expect(evidence.missingCommands).toEqual([
      "npm test -- src/verification-contracts.integration.test.ts",
      "npm run build",
    ]);
  });
});
