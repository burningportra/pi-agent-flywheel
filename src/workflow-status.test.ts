import { describe, expect, it } from "vitest";
import {
  buildWorkflowStatus,
  WORKFLOW_STATUS_CONTRACT_VERSION,
  type WorkflowStatusOutput,
} from "./workflow-status.js";
import type { Bead, OrchestratorState } from "./types.js";
import { createInitialState } from "./types.js";

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return { ...createInitialState(), ...overrides };
}

function makeBead(id: string, status: Bead["status"], overrides: Partial<Bead> = {}): Bead {
  return {
    id,
    title: `Bead ${id}`,
    description: "desc",
    status,
    priority: 0,
    type: "task",
    labels: [],
    updated_at: `2026-06-01T00:00:0${id.length}Z`,
    ...overrides,
  };
}

describe("buildWorkflowStatus", () => {
  it("exports the contract version and required JSON-ready fields for idle/no beads", () => {
    const status = buildWorkflowStatus(makeState(), []);

    expect(WORKFLOW_STATUS_CONTRACT_VERSION).toBe(1);
    expect(status).toMatchObject<Partial<WorkflowStatusOutput>>({
      contract_version: 1,
      phase: "idle",
      selected_goal: null,
      approval_state: "not_started",
      next_action: "Run /agent-flywheel to start.",
      confidence: "low",
    });
    expect(status.resume_prompt).toContain("agent_flywheel_profile");
    expect(status.inferred_from).toEqual(["no persistent signals found"]);
    expect("compaction" in status).toBe(false);
    expect(status.beads).toEqual({
      total: 0,
      open: 0,
      in_progress: 0,
      closed: 0,
      deferred: 0,
      pending: [],
      current: [],
    });
    expect(JSON.stringify(status)).toContain("contract_version");
  });

  it("projects latest compaction context with generated guidance when state has compaction data", () => {
    const status = buildWorkflowStatus(
      makeState({
        phase: "implementing",
        compaction: {
          latest: {
            eventName: "session_compact",
            reason: "threshold",
            rawReason: "auto",
            willRetry: true,
            timestamp: "2026-07-09T12:00:00.000Z",
            workflow: {
              phase: "implementing",
              goal: "Add compaction status",
              selectedBeadId: "pi-65o2",
            },
          },
          recent: [
            {
              eventName: "session_compact",
              reason: "threshold",
              rawReason: "auto",
              willRetry: true,
              timestamp: "2026-07-09T12:00:00.000Z",
            },
            {
              eventName: "session_before_compact",
              reason: "manual",
              timestamp: "2026-07-09T11:55:00.000Z",
            },
          ],
        },
      }),
      [makeBead("pi-65o2", "in_progress")]
    );

    expect(status.compaction?.latest).toMatchObject({
      event_name: "session_compact",
      reason: "threshold",
      raw_reason: "auto",
      will_retry: true,
      observed_at: "2026-07-09T12:00:00.000Z",
      workflow: {
        phase: "implementing",
        goal: "Add compaction status",
        selectedBeadId: "pi-65o2",
      },
      guidance: {
        reason: "threshold",
        title: "Automatic threshold compaction",
        duplicate_side_effect_risk: true,
      },
    });
    expect(status.compaction?.latest.guidance.warnings.join("\n")).toContain("avoid duplicate side effects");
    expect(status.compaction?.latest.guidance.next_steps.join("\n")).toContain("bead status");
    expect(status.compaction?.recent?.map((entry) => entry.reason)).toEqual(["threshold", "manual"]);
  });

  it("reuses session detection to infer implementing from open beads when persisted phase is idle", () => {
    const status = buildWorkflowStatus(
      makeState({ phase: "idle", selectedGoal: "Add machine-readable status" }),
      [makeBead("pi-a", "open"), makeBead("pi-b", "closed")]
    );

    expect(status.phase).toBe("implementing");
    expect(status.approval_state).toBe("approved");
    expect(status.selected_goal).toBe("Add machine-readable status");
    expect(status.confidence).toBe("medium");
    expect(status.inferred_from.some((signal) => signal.includes("open bead"))).toBe(true);
    expect(status.beads.pending.map((bead) => bead.id)).toEqual(["pi-a"]);
    expect(status.beads.current).toEqual([]);
    expect(status.beads.closed).toBe(1);
  });

  it("keeps the full selected goal in the status contract", () => {
    const selectedGoal = "## Goal\nShip workflow status\n\n## Notes\nKeep the full persisted goal.";
    const status = buildWorkflowStatus(makeState({ phase: "planning", selectedGoal }), []);

    expect(status.selected_goal).toBe(selectedGoal);
    expect(status.resume_prompt).toContain("Ship workflow status");
  });

  it("reports in-progress beads as current and excludes them from pending", () => {
    const status = buildWorkflowStatus(
      makeState({ phase: "idle" }),
      [makeBead("pi-current", "in_progress"), makeBead("pi-next", "open")]
    );

    expect(status.phase).toBe("implementing");
    expect(status.beads.current.map((bead) => bead.id)).toEqual(["pi-current"]);
    expect(status.beads.pending.map((bead) => bead.id)).toEqual(["pi-next"]);
    expect(status.resume_prompt).toContain("pi-current");
  });

  it("honors state.currentBeadId even before the live bead status changes to in_progress", () => {
    const status = buildWorkflowStatus(
      makeState({ phase: "implementing", currentBeadId: "pi-a", activeBeadIds: ["pi-b", "pi-a"] }),
      [makeBead("pi-a", "open"), makeBead("pi-b", "open")]
    );

    expect(status.confidence).toBe("high");
    expect(status.beads.current.map((bead) => bead.id)).toEqual(["pi-a"]);
    expect(status.beads.pending.map((bead) => bead.id)).toEqual(["pi-b"]);
  });

  it("surfaces an unknown current bead when state references one missing from live beads", () => {
    const status = buildWorkflowStatus(makeState({ phase: "implementing", currentBeadId: "pi-missing" }), []);

    expect(status.beads.current).toEqual([
      {
        id: "pi-missing",
        title: null,
        status: "unknown",
        priority: null,
        type: null,
        updated_at: null,
      },
    ]);
  });

  it("does not report a closed stale currentBeadId as current", () => {
    const status = buildWorkflowStatus(
      makeState({ phase: "implementing", currentBeadId: "pi-done" }),
      [makeBead("pi-done", "closed"), makeBead("pi-next", "open")]
    );

    expect(status.beads.current).toEqual([]);
    expect(status.beads.pending.map((bead) => bead.id)).toEqual(["pi-next"]);
  });

  it("represents awaiting plan approval without beads", () => {
    const status = buildWorkflowStatus(
      makeState({ phase: "awaiting_plan_approval", selectedGoal: "Improve status", planDocument: "artifacts/plan.md" }),
      []
    );

    expect(status.phase).toBe("awaiting_plan_approval");
    expect(status.approval_state).toBe("awaiting_plan_approval");
    expect(status.next_action).toContain("agent_flywheel_approve_beads");
    expect(status.resume_prompt).toContain("artifacts/plan.md");
  });

  it("represents awaiting bead approval with open beads", () => {
    const status = buildWorkflowStatus(
      makeState({ phase: "awaiting_bead_approval", selectedGoal: "Improve status" }),
      [makeBead("pi-a", "open"), makeBead("pi-b", "open")]
    );

    expect(status.phase).toBe("awaiting_bead_approval");
    expect(status.approval_state).toBe("awaiting_bead_approval");
    expect(status.beads.pending.map((bead) => bead.id)).toEqual(["pi-a", "pi-b"]);
    expect(status.next_action).toContain("agent_flywheel_approve_beads");
  });

  it("uses planning phase and selected goal while planning is active", () => {
    const status = buildWorkflowStatus(makeState({ phase: "planning", selectedGoal: "Add status contract" }), []);

    expect(status.phase).toBe("planning");
    expect(status.approval_state).toBe("planning");
    expect(status.selected_goal).toBe("Add status contract");
    expect(status.next_action).toContain("agent_flywheel_plan");
  });

  it("represents complete state when all live beads are closed", () => {
    const status = buildWorkflowStatus(
      makeState({ phase: "idle" }),
      [makeBead("pi-a", "closed"), makeBead("pi-b", "closed")]
    );

    expect(status.phase).toBe("complete");
    expect(status.approval_state).toBe("complete");
    expect(status.beads.closed).toBe(2);
    expect(status.beads.pending).toEqual([]);
    expect(status.beads.current).toEqual([]);
    expect(status.next_action).toContain("start a new session");
  });

  it("does not mutate orchestrator state or live beads", () => {
    const state = makeState({
      phase: "implementing",
      currentBeadId: "pi-current",
      activeBeadIds: ["pi-current", "pi-next"],
    });
    const beads = [makeBead("pi-next", "open"), makeBead("pi-current", "in_progress")];
    const stateBefore = JSON.stringify(state);
    const beadsBefore = JSON.stringify(beads);

    buildWorkflowStatus(state, beads);

    expect(JSON.stringify(state)).toBe(stateBefore);
    expect(JSON.stringify(beads)).toBe(beadsBefore);
  });
});
