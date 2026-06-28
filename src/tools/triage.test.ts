import { describe, it, expect } from "vitest";
import { buildTriage, TRIAGE_CONTRACT_VERSION, TRIAGE_TTL_SECONDS } from "./triage.js";
import { createInitialState } from "../types.js";

const makeOC = (overrides: any = {}): any => ({
  state: { ...createInitialState(), ...overrides },
});

describe("R-004: flywheel_triage mega-command", () => {
  it("returns contract_version 1.0", () => {
    const t = buildTriage(makeOC());
    expect(t.contract_version).toBe(TRIAGE_CONTRACT_VERSION);
  });

  it("ttl_seconds is 60", () => {
    const t = buildTriage(makeOC());
    expect(t.ttl_seconds).toBe(TRIAGE_TTL_SECONDS);
  });

  it("idle state recommends flywheel_profile as the next step", () => {
    const t = buildTriage(makeOC());
    expect(t.recommendations[0].command).toBe("flywheel_profile");
    expect(t.recommendations[0].priority).toBe("high");
  });

  it("recommendations[*].command always references a flywheel_* canonical name", () => {
    const t = buildTriage(makeOC());
    for (const r of t.recommendations) {
      expect(r.command).toMatch(/^flywheel_/);
    }
  });

  it("all recommendation commands use canonical names (no legacy prefix)", () => {
    const profileSet = makeOC({ phase: "discovering", repoProfile: { name: "x", languages: [], frameworks: [], keyFiles: {}, hasGit: true, todos: [], recentCommits: [], entrypoints: [], structure: "", hasTests: false, hasDocs: false, hasCI: false } });
    const t = buildTriage(profileSet);
    const commands = t.recommendations.map((r) => r.command);
    for (const c of commands) {
      expect(c, `command ${c}`).not.toMatch(/^orch_|^agent_flywheel_/);
    }
  });

  it("copy_paste_workflow starts with recovery status and includes capabilities + robot_docs + doctor", () => {
    const t = buildTriage(makeOC());
    const joined = t.copy_paste_workflow.join("\n");
    expect(t.copy_paste_workflow[0]).toContain("flywheel_status");
    expect(joined).toContain("flywheel_capabilities");
    expect(joined).toContain("flywheel_robot_docs");
    expect(joined).toContain("flywheel_doctor");
  });

  it("quick_ref.next_canonical_tool advances through the status phase order", () => {
    expect(buildTriage(makeOC({ phase: "idle" })).quick_ref.next_canonical_tool).toBe("flywheel_profile");
    expect(buildTriage(makeOC({ phase: "profiling" })).quick_ref.next_canonical_tool).toBe("flywheel_profile");
    expect(buildTriage(makeOC({ phase: "discovering" })).quick_ref.next_canonical_tool).toBe("flywheel_discover");
    expect(buildTriage(makeOC({ phase: "awaiting_selection" })).quick_ref.next_canonical_tool).toBe("flywheel_select");
    expect(buildTriage(makeOC({ phase: "researching" })).quick_ref.next_canonical_tool).toBe("flywheel_research");
    expect(buildTriage(makeOC({ phase: "awaiting_bead_approval" })).quick_ref.next_canonical_tool).toBe("flywheel_approve_beads");
    expect(buildTriage(makeOC({ phase: "reviewing" })).quick_ref.next_canonical_tool).toBe("flywheel_review");
    expect(buildTriage(makeOC({ phase: "complete" })).quick_ref.next_canonical_tool).toBe("flywheel_profile");
  });

  it("researching state recommends flywheel_research rather than repo profiling", () => {
    const t = buildTriage(makeOC({
      phase: "researching",
      researchState: {
        url: "https://github.com/obra/superpowers",
        externalName: "superpowers",
        artifactName: "research/superpowers-proposal.md",
        phasesCompleted: [],
      },
    }));

    expect(t.quick_ref.next_canonical_tool).toBe("flywheel_research");
    expect(t.quick_ref.blocking_error).toBe(null);
    expect(t.recommendations[0].command).toBe("flywheel_research");
    expect(t.recommendations[0].why).toContain("https://github.com/obra/superpowers");
  });

  it("blocking_error fires NO_PROFILE in idle state with no profile loaded", () => {
    const t = buildTriage(makeOC());
    expect(t.quick_ref.blocking_error).toContain("NO_PROFILE");
  });

  it("surfaces provider preflight as read-only not_checked launch-time guidance", () => {
    const t = buildTriage(makeOC());
    expect(t.health.provider_preflight.status).toBe("not_checked");
    expect(t.health.provider_preflight.reason).toContain("read-only");
    expect(t.health.provider_preflight.launch_time_check).toContain("launches run bounded provider/model preflight");
    expect(t.health.provider_preflight.repair_guidance.join("\n")).toContain("OAuth 403");
  });
});
