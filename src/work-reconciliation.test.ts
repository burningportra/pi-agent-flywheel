import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, it } from "vitest";
import {
  buildWorkReconciliationReport,
  formatWorkReconciliationReport,
  readPiTodoFiles,
} from "./work-reconciliation.js";
import type { Bead } from "./types.js";

function bead(overrides: Partial<Bead> & Pick<Bead, "id" | "title" | "status">): Bead {
  return {
    description: "desc",
    priority: 2,
    type: "task",
    labels: [],
    ...overrides,
  };
}

describe("buildWorkReconciliationReport", () => {
  it("summarizes active, ready, blocked, unproven, assigned, and next work", () => {
    const beads = [
      bead({ id: "pi-active", title: "Active", status: "in_progress", updated_at: "2026-05-30T00:00:00Z" }),
      bead({ id: "pi-ready", title: "Ready", status: "open" }),
      bead({ id: "pi-blocked", title: "Blocked", status: "open" }),
      bead({ id: "pi-closed", title: "Closed", status: "closed" }),
      bead({ id: "pi-deferred", title: "Deferred", status: "deferred" }),
    ];
    const report = buildWorkReconciliationReport({
      beads,
      readyBeads: [beads[1]],
      state: { currentBeadId: "pi-ready", beadResults: {} },
      stage: { phase: "implementing", label: "Implementing", nextAction: "Call `agent_flywheel_review` to pick up the next bead." },
      now: new Date("2026-05-31T00:00:00Z"),
    });

    expect(report.stage?.label).toBe("Implementing");
    expect(report.activeWork.map((entry) => entry.id)).toEqual(["pi-active"]);
    expect(report.readyWork.map((entry) => entry.id)).toEqual(["pi-ready"]);
    expect(report.blockedWork.map((entry) => entry.id)).toEqual(["pi-blocked", "pi-deferred"]);
    expect(report.closedButUnproven.map((entry) => entry.id)).toEqual(["pi-closed"]);
    expect(report.staleOrSuperseded.map((entry) => entry.id)).toContain("pi-active");
    expect(report.assignedToOtherSession.map((entry) => entry.id)).toEqual(["pi-active"]);
    expect(report.nextRecommended?.id).toBe("pi-ready");
  });

  it("does not mark closed beads as unproven when state has success evidence", () => {
    const report = buildWorkReconciliationReport({
      beads: [bead({ id: "pi-done", title: "Done", status: "closed" })],
      state: { beadResults: { "pi-done": { beadId: "pi-done", status: "success", summary: "Verified" } } },
    });

    expect(report.closedButUnproven).toEqual([]);
  });

  it("detects explicit and duplicate superseded work using newer beads and todos", () => {
    const oldBead = bead({
      id: "pi-old",
      title: "Add audit log",
      status: "open",
      description: "Superseded by pi-new",
      updated_at: "2026-05-30T00:00:00Z",
    });
    const duplicate = bead({
      id: "pi-dup",
      title: "Improve status",
      status: "open",
      updated_at: "2026-05-30T00:00:00Z",
    });
    const newer = bead({
      id: "pi-new",
      title: "Improve status",
      status: "open",
      updated_at: "2026-05-31T00:00:00Z",
    });
    const report = buildWorkReconciliationReport({
      beads: [oldBead, duplicate, newer],
      todos: [{ id: "todo-1", title: "Add audit log", status: "open", source: ".pi/todos.json", updated_at: "2026-05-31T01:00:00Z" }],
    });

    expect(report.staleOrSuperseded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "pi-old", reason: "superseded by pi-new" }),
        expect.objectContaining({ id: "pi-dup", reason: "similar newer item pi-new" }),
      ])
    );
  });

  it("formats a concise ledger", () => {
    const report = buildWorkReconciliationReport({
      beads: [bead({ id: "pi-ready", title: "Ready", status: "open" })],
      readyBeads: [bead({ id: "pi-ready", title: "Ready", status: "open" })],
    });
    const formatted = formatWorkReconciliationReport(report);

    expect(formatted).toContain("## Active Work Ledger");
    expect(formatted).toContain("Next recommended: pi-ready: Ready");
    expect(formatted).toContain("### Ready work");
  });
});

describe("readPiTodoFiles", () => {
  it("reads json and markdown pi todo files when available", () => {
    const cwd = mkdtempSync(join(tmpdir(), "flywheel-todos-"));
    try {
      mkdirSync(join(cwd, ".pi", "todos"), { recursive: true });
      writeFileSync(join(cwd, ".pi", "todos.json"), JSON.stringify({ todos: [{ id: "todo-json", title: "JSON todo", status: "done" }] }));
      writeFileSync(join(cwd, ".pi", "todos", "local.md"), "- [ ] Markdown todo\n- [x] Done markdown\n");

      const todos = readPiTodoFiles(cwd);

      expect(todos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "todo-json", title: "JSON todo", status: "closed" }),
          expect.objectContaining({ title: "Markdown todo", status: "open" }),
          expect.objectContaining({ title: "Done markdown", status: "closed" }),
        ])
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
