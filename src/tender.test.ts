import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { selectStalledBeads, antiSlopDue } from "./tender.js";

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

describe("selectStalledBeads", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const hour = 60 * 60 * 1000;

  it("reopens only in_progress beads that are older than the threshold", () => {
    const beads = [
      { id: "pi-old", status: "in_progress", updated_at: "2026-08-22T10:00:00Z" },
      { id: "pi-fresh", status: "in_progress", updated_at: "2026-08-22T11:55:00Z" },
      { id: "pi-open", status: "open", updated_at: "2026-08-22T01:00:00Z" },
      { id: "pi-closed", status: "closed", updated_at: "2026-08-22T01:00:00Z" },
    ];
    expect(selectStalledBeads(beads, now, hour)).toEqual(["pi-old"]);
  });

  it("handles numeric (epoch ms) updated_at", () => {
    const old = now - 2 * hour;
    const beads = [{ id: "pi-x", status: "in_progress", updated_at: old }];
    expect(selectStalledBeads(beads, now, hour)).toEqual(["pi-x"]);
  });

  it("ignores malformed updated_at and returns nothing for empty input", () => {
    expect(selectStalledBeads([], now, hour)).toEqual([]);
    expect(selectStalledBeads([{ id: "pi-bad", status: "in_progress", updated_at: "nonsense" }], now, hour)).toEqual([]);
  });

  it("returns nothing when all in_progress beads are recent", () => {
    const beads = [{ id: "pi-now", status: "in_progress", updated_at: "2026-08-22T11:59:00Z" }];
    expect(selectStalledBeads(beads, now, hour)).toEqual([]);
  });
});

describe("antiSlopDue", () => {
  it("is not due until a baseline commit count is established", () => {
    expect(antiSlopDue(10, 0, 6)).toEqual({ due: false, since: 0 });
  });

  it("fires once the cadence is reached", () => {
    expect(antiSlopDue(12, 6, 6)).toEqual({ due: true, since: 6 });
  });

  it("is not due before the cadence", () => {
    expect(antiSlopDue(8, 6, 6)).toEqual({ due: false, since: 2 });
  });

  // Regression: the SwarmTender state machine must establish a baseline on its first
  // observation (lastCount=0) and only then fire on subsequent crossings. Without
  // establishing the baseline, lastCount stays 0 forever and onAntiSlopDue never fires.
  it("establishes a baseline on first run, then fires on the next crossing", () => {
    let lastCount = 0;
    const fired: number[] = [];
    // simulate two auto-tick observations: count at first run, then +6 later
    const observe = (count: number) => {
      const { due, since } = antiSlopDue(count, lastCount, 6);
      if (due) {
        lastCount = count;
        fired.push(since);
      } else if (lastCount === 0) {
        lastCount = count; // baseline established on first observation
      }
    };
    observe(30); // first run: baseline = 30, no fire
    expect(fired).toEqual([]);
    observe(36); // +6: due
    expect(fired).toEqual([6]);
  });
});
