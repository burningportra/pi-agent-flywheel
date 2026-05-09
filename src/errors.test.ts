import { describe, it, expect } from "vitest";
import { FlywheelError, isFlywheelError } from "./errors.js";
import { ERROR_CATEGORIES } from "./tools/capabilities.js";

describe("R-006: FlywheelError class", () => {
  it("constructs with code only and pulls message from ERROR_CATEGORIES", () => {
    const err = new FlywheelError("NO_GOAL");
    expect(err.code).toBe("NO_GOAL");
    expect(err.message).toContain("NO_GOAL");
    expect(err.message).toContain("flywheel_select"); // via fix_command
    expect(err.suggestion).toBe(ERROR_CATEGORIES.NO_GOAL.fix_command);
  });

  it("accepts custom message + suggestion", () => {
    const err = new FlywheelError("PLAN_SYNTH_FAILED", "All planners died.", { suggestion: "flywheel_plan({mode:'single_model'})" });
    expect(err.code).toBe("PLAN_SYNTH_FAILED");
    expect(err.message).toContain("All planners died");
    expect(err.suggestion).toContain("single_model");
  });

  it("toJSON returns a flat structured payload", () => {
    const err = new FlywheelError("BEAD_NOT_FOUND", "no bead xyz", { safe_alternative: "br list" });
    const json = err.toJSON();
    expect(json.flywheel_error).toBe(true);
    expect(json.code).toBe("BEAD_NOT_FOUND");
    expect(json.safe_alternative).toBe("br list");
  });

  it("isFlywheelError discriminates from plain Error", () => {
    expect(isFlywheelError(new FlywheelError("NO_GOAL"))).toBe(true);
    expect(isFlywheelError(new Error("plain"))).toBe(false);
    expect(isFlywheelError({ code: "NO_GOAL" })).toBe(false);
  });

  it("every code in ERROR_CATEGORIES is a constructible FlywheelError", () => {
    for (const code of Object.keys(ERROR_CATEGORIES)) {
      const err = new FlywheelError(code as any);
      expect(err.code).toBe(code);
      expect(err.suggestion.length).toBeGreaterThan(0);
    }
  });
});
