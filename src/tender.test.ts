import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const tenderSource = readFileSync(join(__dirname, "tender.ts"), "utf8");

describe("SwarmTender cadence checklist", () => {
  it("preserves the existing six cadence items", () => {
    for (const item of [
      "Check bead progress",
      "Handle compactions",
      "Run a review round",
      "Manage rate limits",
      "Periodic commit",
      "Handle surprises",
    ]) {
      expect(tenderSource).toContain(item);
    }
  });

  it("includes proof card, score matrix, convergence check, and repeated-nudge escalation", () => {
    expect(tenderSource).toContain("Operator Proof Card");
    expect(tenderSource).toContain("Evidence:");
    expect(tenderSource).toContain("Card matched:");
    expect(tenderSource).toContain("Expected state change:");
    expect(tenderSource).toContain("Recovery:");
    expect(tenderSource).toContain("| Evidence | Impact | Reversibility | BlastRadius | Score |");
    expect(tenderSource).toContain("Score >= 2.0");
    expect(tenderSource).toContain("convergence triple-check");
    expect(tenderSource).toContain("ready queue empty AND no in-flight work AND no expected upstream signals");
    expect(tenderSource).toContain("escalate to smart-restart, not another nudge");
  });
});
