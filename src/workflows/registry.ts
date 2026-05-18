/**
 * Planning-workflow adapter registry.
 *
 * Holds the set of {@link PlanningWorkflowAdapter} implementations the
 * flywheel knows about and resolves an adapter for the current session.
 *
 * Resolution rules:
 *   1. If `state.planningWorkflow` is absent, return the native adapter.
 *   2. If the persisted `adapterId` matches a registered adapter, return it.
 *   3. Unknown adapter ids fall back to native — a session whose adapter was
 *      removed (e.g. removed plugin) still loads instead of crashing.
 *
 * This keeps the runner and tool code free of `if (adapterId === "...")`
 * branches: they look up an adapter and ask it for behavior.
 */

import type { OrchestratorState } from "../types.js";
import type { PlanningWorkflowAdapter } from "./native.js";
import { NATIVE_ADAPTER_ID, nativePlanningAdapter } from "./native.js";

const adapters = new Map<string, PlanningWorkflowAdapter>();
adapters.set(NATIVE_ADAPTER_ID, nativePlanningAdapter);

/**
 * Register a planning-workflow adapter. Idempotent — re-registering an
 * adapter under the same id overwrites the previous entry (intentionally
 * permissive so plugin reloads in tests do not error).
 */
export function registerPlanningWorkflowAdapter(adapter: PlanningWorkflowAdapter): void {
  adapters.set(adapter.id, adapter);
}

/**
 * Resolve an adapter by id. Unknown / missing ids fall back to native.
 *
 * Callers should generally prefer {@link getPlanningWorkflowAdapter} which
 * accepts the orchestrator state directly.
 */
export function getPlanningWorkflowAdapterById(id: string | undefined): PlanningWorkflowAdapter {
  if (id && adapters.has(id)) {
    return adapters.get(id)!;
  }
  return nativePlanningAdapter;
}

/**
 * Resolve the adapter for the given orchestrator state.
 *
 * - No `planningWorkflow` field → native.
 * - `adapterId === "native"` → native.
 * - Anything else → registered adapter, or native fallback.
 */
export function getPlanningWorkflowAdapter(
  state: Pick<OrchestratorState, "planningWorkflow">,
): PlanningWorkflowAdapter {
  const id = state.planningWorkflow?.adapterId;
  return getPlanningWorkflowAdapterById(id);
}

/** List registered adapter ids. Stable order is not guaranteed. */
export function listPlanningWorkflowAdapterIds(): string[] {
  return Array.from(adapters.keys());
}

/**
 * Test-only reset. Drops every adapter except the built-in native one so
 * test cases that register experimental adapters cannot leak across files.
 */
export function _resetPlanningWorkflowRegistryForTesting(): void {
  adapters.clear();
  adapters.set(NATIVE_ADAPTER_ID, nativePlanningAdapter);
}
