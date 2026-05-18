import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetPlanningWorkflowRegistryForTesting,
  getPlanningWorkflowAdapter,
  getPlanningWorkflowAdapterById,
  listPlanningWorkflowAdapterIds,
  registerPlanningWorkflowAdapter,
} from "./registry.js";
import { NATIVE_ADAPTER_ID, nativePlanningAdapter, type PlanningWorkflowAdapter } from "./native.js";
import type { OrchestratorState } from "../types.js";
import { createInitialState } from "../types.js";

beforeEach(() => {
  _resetPlanningWorkflowRegistryForTesting();
});

describe("planning-workflow registry", () => {
  it("defaults to native when state has no planningWorkflow", () => {
    const state = createInitialState();
    expect(getPlanningWorkflowAdapter(state)).toBe(nativePlanningAdapter);
  });

  it("defaults to native when adapterId is the literal 'native'", () => {
    const state: OrchestratorState = createInitialState();
    state.planningWorkflow = {
      schemaVersion: 1,
      adapterId: NATIVE_ADAPTER_ID,
      stage: "plan",
      generationMode: "native",
      goalFingerprint: "deadbeef",
    };
    expect(getPlanningWorkflowAdapter(state).id).toBe(NATIVE_ADAPTER_ID);
  });

  it("falls back to native when adapterId is unknown (graceful degrade for removed plugins)", () => {
    const state: OrchestratorState = createInitialState();
    state.planningWorkflow = {
      schemaVersion: 1,
      adapterId: "deleted-plugin",
      stage: "plan",
      generationMode: "native",
      goalFingerprint: "deadbeef",
    };
    expect(getPlanningWorkflowAdapter(state)).toBe(nativePlanningAdapter);
  });

  it("returns a registered custom adapter by id", () => {
    const fakeAdapter: PlanningWorkflowAdapter = {
      id: "fake",
      mode: "superpowers",
      supportedStages: new Set(["plan", "awaiting_plan_approval"]),
      createInitialState: () => ({
        schemaVersion: 1,
        adapterId: "fake",
        stage: "idle",
        generationMode: "superpowers",
        goalFingerprint: "",
      }),
      stageToPhase: () => null,
    };
    registerPlanningWorkflowAdapter(fakeAdapter);
    expect(getPlanningWorkflowAdapterById("fake")).toBe(fakeAdapter);
  });

  it("re-registering the same id replaces the previous adapter (idempotent)", () => {
    const v1: PlanningWorkflowAdapter = {
      id: "twin",
      mode: "native",
      supportedStages: new Set(["idle"]),
      createInitialState: () => nativePlanningAdapter.createInitialState(),
      stageToPhase: () => null,
    };
    const v2: PlanningWorkflowAdapter = { ...v1 };
    registerPlanningWorkflowAdapter(v1);
    registerPlanningWorkflowAdapter(v2);
    expect(getPlanningWorkflowAdapterById("twin")).toBe(v2);
  });

  it("listPlanningWorkflowAdapterIds includes native by default", () => {
    expect(listPlanningWorkflowAdapterIds()).toContain(NATIVE_ADAPTER_ID);
  });

  it("getPlanningWorkflowAdapterById('native') === nativePlanningAdapter", () => {
    expect(getPlanningWorkflowAdapterById(NATIVE_ADAPTER_ID)).toBe(nativePlanningAdapter);
  });

  it("getPlanningWorkflowAdapterById(undefined) falls back to native", () => {
    expect(getPlanningWorkflowAdapterById(undefined)).toBe(nativePlanningAdapter);
  });
});
