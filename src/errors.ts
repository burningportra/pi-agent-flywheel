/**
 * R-006: structured error class for pi-agent-flywheel.
 *
 * Every error emitted by an MCP tool should carry:
 *   - a stable code (NO_GOAL, NO_PROFILE, etc.) — listed in capabilities.error_categories
 *   - a human-readable message
 *   - a `suggestion` field naming the EXACT canonical tool to call next (post-R-001)
 *   - an optional `safe_alternative` for destructive paths (e.g. "/flywheel-stop" instead of git reset)
 *
 * Agents that JSON-parse the error get the structured payload via FlywheelError.toJSON().
 * Plain consumers get a useful one-liner via .message.
 */

import { ERROR_CATEGORIES } from "./tools/capabilities.js";

export type FlywheelErrorCode =
  | "NO_GOAL"
  | "NO_PROFILE"
  | "NO_IDEAS"
  | "NO_PLAN"
  | "PLAN_SYNTH_FAILED"
  | "BEAD_NOT_FOUND"
  | "OUT_OF_ORDER_TOOL_CALL"
  | "INVALID_INPUT"
  | "INTERNAL";

export interface FlywheelErrorPayload {
  flywheel_error: true;
  code: FlywheelErrorCode;
  message: string;
  suggestion: string;
  safe_alternative: string | null;
}

export class FlywheelError extends Error {
  readonly code: FlywheelErrorCode;
  readonly suggestion: string;
  readonly safe_alternative: string | null;

  constructor(code: FlywheelErrorCode, message?: string, opts?: { suggestion?: string; safe_alternative?: string | null }) {
    const cat = ERROR_CATEGORIES[code as keyof typeof ERROR_CATEGORIES];
    const finalMessage = message ?? cat?.message_template ?? code;
    const suggestion = opts?.suggestion ?? cat?.fix_command ?? "flywheel_capabilities";
    super(`[${code}] ${finalMessage} (suggestion: ${suggestion})`);
    this.name = "FlywheelError";
    this.code = code;
    this.suggestion = suggestion;
    this.safe_alternative = opts?.safe_alternative ?? null;
  }

  toJSON(): FlywheelErrorPayload {
    return {
      flywheel_error: true,
      code: this.code,
      message: this.message,
      suggestion: this.suggestion,
      safe_alternative: this.safe_alternative,
    };
  }
}

export function isFlywheelError(err: unknown): err is FlywheelError {
  return err instanceof FlywheelError;
}
