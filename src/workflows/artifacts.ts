/**
 * Artifact-naming and fingerprinting helpers for planning workflows.
 *
 * Two invariants this module guards:
 *
 *  1. Final implementation plans MUST keep using `plans/<slug>.md` so the
 *     saved-plan discovery in `commands.ts` still finds them. Spec artifacts
 *     belong to a separate adapter step and must live OUTSIDE `plans/` so
 *     they are not mistaken for final plans.
 *
 *  2. The planning-workflow fingerprint must be deterministic across runs
 *     — same goal + constraints + adapter + brainstorm/spec inputs must
 *     produce the same string, regardless of constraint order or whitespace
 *     noise. This is what `[[pi-3ujg]]` and `[[pi-23yx]]` will use to
 *     detect drift between approval and bead generation.
 */

import { createHash } from "crypto";
import type { PlanningWorkflowFingerprintInput } from "./types.js";

/** Slug used for both spec and plan paths — kept stable across helpers. */
export function slugifyWorkflowGoal(goal: string, fallback = "workflow"): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || fallback
  );
}

/**
 * Artifact name for a Superpowers-style spec document.
 *
 * Returned path is relative to the session artifact root. It deliberately
 * does NOT start with `plans/` so saved-plan discovery (which walks
 * `<artifact-root>/plans/*.md`) will skip it. The implementation plan
 * generated later still uses `plans/<slug>.md`, keeping the bead-generation
 * contract unchanged.
 */
export function specArtifactName(goal: string): string {
  return `superpowers/specs/${slugifyWorkflowGoal(goal, "spec")}.md`;
}

/**
 * Final implementation-plan artifact name.
 *
 * Mirrors `singleModelPlanArtifactName` in `tools/plan.ts` and is exposed
 * here so workflow adapters can reference both spec and plan paths from one
 * module without taking a hard dependency on the legacy plan tool.
 */
export function finalPlanArtifactName(goal: string): string {
  return `plans/${slugifyWorkflowGoal(goal, "plan")}.md`;
}

function normalizeConstraints(constraints?: string[]): string[] {
  if (!constraints) return [];
  return constraints
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .sort();
}

/**
 * Compute a stable planning-workflow fingerprint.
 *
 * Determinism rules:
 *  - constraints are trimmed, blanks dropped, and sorted lexicographically
 *  - all string inputs are normalized to NFC then concatenated with a
 *    delimiter the user cannot type literally
 *  - missing optional inputs become the empty string (NOT the word
 *    "undefined") so absence vs. an empty value remain distinguishable
 *
 * The output is a hex SHA-256 digest. We do not truncate — drift checks
 * compare full strings, and the 64-char cost is negligible.
 */
export function computePlanningWorkflowFingerprint(
  input: PlanningWorkflowFingerprintInput,
): string {
  const goal = (input.goal ?? "").normalize("NFC");
  const adapterId = (input.adapterId ?? "").normalize("NFC");
  const constraints = normalizeConstraints(input.constraints)
    .map((c) => c.normalize("NFC"))
    .join("");
  const brainstorm = (input.brainstormDecisionArtifact ?? "").normalize("NFC");
  const spec = (input.specArtifact ?? "").normalize("NFC");

  const payload = [
    `goal:${goal}`,
    `adapter:${adapterId}`,
    `constraints:${constraints}`,
    `brainstorm:${brainstorm}`,
    `spec:${spec}`,
  ].join("");

  return createHash("sha256").update(payload, "utf8").digest("hex");
}
