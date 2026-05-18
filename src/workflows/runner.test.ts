import { describe, it, expect, beforeEach } from "vitest";
import { createInitialState } from "../types.js";
import type { OrchestratorState } from "../types.js";
import {
  _resetPlanningWorkflowRegistryForTesting,
  registerPlanningWorkflowAdapter,
} from "./registry.js";
import type { PlanningWorkflowAdapter } from "./native.js";
import { NATIVE_ADAPTER_ID } from "./native.js";
import {
  checkPlanningToolOrdering,
  stageToPlanningPhase,
} from "./runner.js";
import type { WorkflowStage } from "./types.js";

beforeEach(() => {
  _resetPlanningWorkflowRegistryForTesting();
});

/** Build a state with a planning-workflow at the given stage. */
function stateAt(stage: WorkflowStage, adapterId = NATIVE_ADAPTER_ID): OrchestratorState {
  const state = createInitialState();
  state.planningWorkflow = {
    schemaVersion: 1,
    adapterId,
    stage,
    generationMode: adapterId === "superpowers" ? "superpowers" : "native",
    goalFingerprint: "abc123",
  };
  return state;
}

/** A throwaway non-native adapter so we can exercise the runner guardrails. */
function registerSuperpowersStub(): PlanningWorkflowAdapter {
  const adapter: PlanningWorkflowAdapter = {
    id: "superpowers",
    mode: "superpowers",
    supportedStages: new Set<WorkflowStage>([
      "idle",
      "brainstorming",
      "spec",
      "awaiting_spec_approval",
      "plan",
      "awaiting_plan_approval",
      "handoff",
    ]),
    createInitialState: () => ({
      schemaVersion: 1,
      adapterId: "superpowers",
      stage: "idle",
      generationMode: "superpowers",
      goalFingerprint: "",
    }),
    stageToPhase: (stage) => {
      switch (stage) {
        case "brainstorming":
        case "spec":
        case "plan":
          return "planning";
        case "awaiting_spec_approval":
        case "awaiting_plan_approval":
          return "awaiting_plan_approval";
        default:
          return null;
      }
    },
  };
  registerPlanningWorkflowAdapter(adapter);
  return adapter;
}

describe("runner — stageToPlanningPhase", () => {
  it("returns null when state has no planningWorkflow (legacy session)", () => {
    expect(stageToPlanningPhase(createInitialState())).toBeNull();
  });

  it("returns 'planning' for native stage='plan'", () => {
    expect(stageToPlanningPhase(stateAt("plan"))).toBe("planning");
  });

  it("returns 'awaiting_plan_approval' for native stage='awaiting_plan_approval'", () => {
    expect(stageToPlanningPhase(stateAt("awaiting_plan_approval"))).toBe("awaiting_plan_approval");
  });

  it("returns null for idle/handoff stages even when planningWorkflow is set", () => {
    expect(stageToPlanningPhase(stateAt("idle"))).toBeNull();
    expect(stageToPlanningPhase(stateAt("handoff"))).toBeNull();
  });

  it("only ever returns planning|awaiting_plan_approval (acceptance criterion)", () => {
    registerSuperpowersStub();
    const stages: WorkflowStage[] = [
      "idle",
      "brainstorming",
      "spec",
      "awaiting_spec_approval",
      "plan",
      "awaiting_plan_approval",
      "handoff",
    ];
    for (const s of stages) {
      const out = stageToPlanningPhase(stateAt(s, "superpowers"));
      expect([null, "planning", "awaiting_plan_approval"]).toContain(out);
    }
  });
});

describe("runner — checkPlanningToolOrdering (native adapter parity)", () => {
  it("never rejects when planningWorkflow is absent (legacy sessions are permissive)", () => {
    const state = createInitialState();
    expect(checkPlanningToolOrdering("flywheel_plan", state)).toBeNull();
    expect(checkPlanningToolOrdering("flywheel_approve_beads", state)).toBeNull();
  });

  it("native adapter never rejects, regardless of stage (existing tools own native ordering)", () => {
    for (const stage of [
      "idle",
      "plan",
      "awaiting_plan_approval",
      "handoff",
    ] as WorkflowStage[]) {
      expect(checkPlanningToolOrdering("flywheel_plan", stateAt(stage))).toBeNull();
      expect(checkPlanningToolOrdering("flywheel_approve_beads", stateAt(stage))).toBeNull();
    }
  });
});

describe("runner — checkPlanningToolOrdering (non-native adapter guardrails)", () => {
  beforeEach(() => {
    registerSuperpowersStub();
  });

  it("rejects flywheel_plan during awaiting_spec_approval and recommends flywheel_approve_beads", () => {
    const rej = checkPlanningToolOrdering(
      "flywheel_plan",
      stateAt("awaiting_spec_approval", "superpowers"),
    );
    expect(rej).not.toBeNull();
    expect(rej!.code).toBe("OUT_OF_ORDER_TOOL_CALL");
    expect(rej!.toolName).toBe("flywheel_plan");
    expect(rej!.stage).toBe("awaiting_spec_approval");
    expect(rej!.recommendedTool).toBe("flywheel_approve_beads");
    expect(rej!.message).toMatch(/approve.*spec/i);
  });

  it("rejects flywheel_plan during brainstorming and spec generation", () => {
    expect(
      checkPlanningToolOrdering("flywheel_plan", stateAt("brainstorming", "superpowers"))?.code,
    ).toBe("OUT_OF_ORDER_TOOL_CALL");
    expect(
      checkPlanningToolOrdering("flywheel_plan", stateAt("spec", "superpowers"))?.code,
    ).toBe("OUT_OF_ORDER_TOOL_CALL");
  });

  it("allows flywheel_plan at plan/awaiting_plan_approval/idle/handoff for non-native adapter", () => {
    expect(checkPlanningToolOrdering("flywheel_plan", stateAt("plan", "superpowers"))).toBeNull();
    expect(checkPlanningToolOrdering("flywheel_plan", stateAt("awaiting_plan_approval", "superpowers"))).toBeNull();
    expect(checkPlanningToolOrdering("flywheel_plan", stateAt("idle", "superpowers"))).toBeNull();
    expect(checkPlanningToolOrdering("flywheel_plan", stateAt("handoff", "superpowers"))).toBeNull();
  });

  it("rejects flywheel_approve_beads while plan generation is in flight", () => {
    const rej = checkPlanningToolOrdering(
      "flywheel_approve_beads",
      stateAt("plan", "superpowers"),
    );
    expect(rej).not.toBeNull();
    expect(rej!.code).toBe("OUT_OF_ORDER_TOOL_CALL");
    expect(rej!.toolName).toBe("flywheel_approve_beads");
    expect(rej!.stage).toBe("plan");
    expect(rej!.message).toMatch(/implementation plan/i);
  });

  it("rejects flywheel_approve_beads while spec generation is in flight", () => {
    const rej = checkPlanningToolOrdering(
      "flywheel_approve_beads",
      stateAt("spec", "superpowers"),
    );
    expect(rej?.code).toBe("OUT_OF_ORDER_TOOL_CALL");
    expect(rej?.message).toMatch(/spec/i);
  });

  it("rejects flywheel_approve_beads while brainstorming is in flight", () => {
    const rej = checkPlanningToolOrdering(
      "flywheel_approve_beads",
      stateAt("brainstorming", "superpowers"),
    );
    expect(rej?.code).toBe("OUT_OF_ORDER_TOOL_CALL");
  });

  it("allows flywheel_approve_beads at awaiting_spec_approval and awaiting_plan_approval", () => {
    expect(
      checkPlanningToolOrdering("flywheel_approve_beads", stateAt("awaiting_spec_approval", "superpowers")),
    ).toBeNull();
    expect(
      checkPlanningToolOrdering("flywheel_approve_beads", stateAt("awaiting_plan_approval", "superpowers")),
    ).toBeNull();
  });

  it("rejections carry both the offending toolName and current stage (machine-readable)", () => {
    const rej = checkPlanningToolOrdering(
      "flywheel_plan",
      stateAt("spec", "superpowers"),
    );
    expect(rej).toMatchObject({
      code: "OUT_OF_ORDER_TOOL_CALL",
      toolName: "flywheel_plan",
      stage: "spec",
    });
  });
});

describe("runner — single-model and multi-model native paths are unchanged", () => {
  // Sanity check that the native adapter's behavior is permissive regardless of
  // which planning mode the user picks at the tool layer (single vs multi).
  it("flywheel_plan with no planningWorkflow stays permissive (legacy path)", () => {
    const state = createInitialState();
    expect(checkPlanningToolOrdering("flywheel_plan", state)).toBeNull();
  });

  it("flywheel_plan with native adapter at stage='plan' stays permissive", () => {
    expect(checkPlanningToolOrdering("flywheel_plan", stateAt("plan"))).toBeNull();
  });

  it("flywheel_approve_beads with native adapter at stage='awaiting_plan_approval' stays permissive", () => {
    expect(
      checkPlanningToolOrdering("flywheel_approve_beads", stateAt("awaiting_plan_approval")),
    ).toBeNull();
  });
});
