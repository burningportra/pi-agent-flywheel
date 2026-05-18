import { describe, it, expect } from "vitest";
import {
  NATIVE_ADAPTER_ID,
  nativePlanningAdapter,
} from "./native.js";
import { computePlanningWorkflowFingerprint } from "./artifacts.js";

describe("native planning-workflow adapter", () => {
  it("has the canonical id and native generation mode", () => {
    expect(nativePlanningAdapter.id).toBe(NATIVE_ADAPTER_ID);
    expect(nativePlanningAdapter.mode).toBe("native");
  });

  it("supports only the native subset of stages", () => {
    const supported = nativePlanningAdapter.supportedStages;
    expect(supported.has("idle")).toBe(true);
    expect(supported.has("plan")).toBe(true);
    expect(supported.has("awaiting_plan_approval")).toBe(true);
    expect(supported.has("handoff")).toBe(true);
    // Superpowers-only stages MUST NOT be advertised by the native adapter.
    expect(supported.has("spec")).toBe(false);
    expect(supported.has("awaiting_spec_approval")).toBe(false);
    expect(supported.has("brainstorming")).toBe(false);
  });

  it("maps plan and awaiting_plan_approval to the matching OrchestratorPhase values", () => {
    expect(nativePlanningAdapter.stageToPhase("plan")).toBe("planning");
    expect(nativePlanningAdapter.stageToPhase("awaiting_plan_approval")).toBe("awaiting_plan_approval");
  });

  it("returns null for stages that should not pin a top-level phase", () => {
    expect(nativePlanningAdapter.stageToPhase("idle")).toBeNull();
    expect(nativePlanningAdapter.stageToPhase("handoff")).toBeNull();
    expect(nativePlanningAdapter.stageToPhase("spec")).toBeNull();
    expect(nativePlanningAdapter.stageToPhase("awaiting_spec_approval")).toBeNull();
    expect(nativePlanningAdapter.stageToPhase("brainstorming")).toBeNull();
  });

  it("createInitialState returns an idle, schema-versioned native state", () => {
    const state = nativePlanningAdapter.createInitialState();
    expect(state.schemaVersion).toBe(1);
    expect(state.adapterId).toBe(NATIVE_ADAPTER_ID);
    expect(state.generationMode).toBe("native");
    expect(state.stage).toBe("idle");
    expect(state.goalFingerprint).toBe("");
    // No spec or brainstorm artifacts on a fresh native state.
    expect(state.specArtifact).toBeUndefined();
    expect(state.brainstormDecisionArtifact).toBeUndefined();
  });

  it("native parity — initial state plus computed fingerprint is fully populated", () => {
    const state = nativePlanningAdapter.createInitialState();
    state.goalFingerprint = computePlanningWorkflowFingerprint({
      goal: "Improve flywheel logging",
      adapterId: state.adapterId,
      constraints: ["preserve existing CLI flags"],
    });
    expect(state.goalFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(state.adapterId).toBe("native");
  });
});
