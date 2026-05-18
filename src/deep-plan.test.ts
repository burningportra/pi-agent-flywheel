import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { runDeepPlanAgents } from "./deep-plan.js";

function makePiExecMock() {
  let taskFileFromPrompt = "";
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === "ntm" && args[0] === "spawn") {
      const promptArg = args[args.indexOf("--prompt") + 1] ?? "";
      taskFileFromPrompt = promptArg.match(/at (\/[^,]+), follow/)?.[1] ?? "";
      return { code: 0, stdout: "spawned", stderr: "" };
    }

    if (cmd === "ntm" && args[0]?.startsWith("--robot-wait=")) {
      const task = readFileSync(taskFileFromPrompt, "utf8");
      const outputFile = task.match(/FINAL_ANSWER_PATH=(.+)/)?.[1]?.trim();
      if (outputFile) writeFileSync(outputFile, "proposal from ntm cc", "utf8");
      return { code: 0, stdout: "idle", stderr: "" };
    }

    if (cmd === "pi") {
      return { code: 0, stdout: "proposal from pi", stderr: "" };
    }

    return { code: 0, stdout: "", stderr: "" };
  });
  return { exec } as any;
}

describe("runDeepPlanAgents provider routing", () => {
  it("routes Anthropic planners through managed NTM cc panes", async () => {
    const pi = makePiExecMock();

    const results = await runDeepPlanAgents(pi, "/tmp/pi-agent-flywheel", [{
      name: "research-investigate",
      model: "anthropic/claude-opus-4-6",
      task: "Investigate this repo",
    }]);

    expect(results[0].plan).toBe("proposal from ntm cc");
    expect(results[0].exitCode).toBe(0);
    expect(pi.exec).not.toHaveBeenCalledWith("pi", expect.anything(), expect.anything());

    const spawnCall = pi.exec.mock.calls.find(([cmd, args]: [string, string[]]) => cmd === "ntm" && args[0] === "spawn");
    expect(spawnCall).toBeDefined();
    expect(spawnCall![1]).toContain("--no-user");
    expect(spawnCall![1]).toContain("--cc=1:opus");

    const promptArg = spawnCall![1][spawnCall![1].indexOf("--prompt") + 1];
    const taskFile = promptArg.match(/at (\/[^,]+), follow/)?.[1];
    expect(taskFile).toBeTruthy();
    expect(existsSync(taskFile!)).toBe(true);
    expect(readFileSync(taskFile!, "utf8")).toContain("FINAL_ANSWER_PATH=");
  });

  it("keeps non-Anthropic planners on pi print mode", async () => {
    const pi = makePiExecMock();

    const results = await runDeepPlanAgents(pi, "/tmp/pi-agent-flywheel", [{
      name: "research-deepen",
      model: "openai-codex/gpt-5.4",
      task: "Deepen this proposal",
    }]);

    expect(results[0].plan).toBe("proposal from pi");
    expect(pi.exec).toHaveBeenCalledWith("pi", expect.arrayContaining(["--print", "--model", "openai-codex/gpt-5.4"]), expect.anything());
    expect(pi.exec).not.toHaveBeenCalledWith("ntm", expect.arrayContaining(["spawn"]), expect.anything());
  });
});

describe("runDeepPlanAgents — approved spec ingestion", () => {
  it("injects an Approved Spec preamble into every agent task when options.approvedSpec is set", async () => {
    const pi = makePiExecMock();
    const approvedSpec =
      "## Spec\n- desired behavior: keep request rate below 5 rps\n- non-goal: change telemetry";

    await runDeepPlanAgents(
      pi,
      "/tmp/pi-agent-flywheel",
      [
        { name: "correctness", model: "openai-codex/gpt-5.4", task: "Plan correctness pass" },
        { name: "robustness", model: "openai-codex/gpt-5.4", task: "Plan robustness pass" },
      ],
      undefined,
      { approvedSpec },
    );

    const taskFiles = pi.exec.mock.calls
      .filter(([cmd, args]: [string, string[]]) => cmd === "pi" && args.some((a) => a.startsWith("@")))
      .map(([, args]: [string, string[]]) => args.find((a) => a.startsWith("@"))!.slice(1));

    expect(taskFiles.length).toBe(2);
    for (const taskFile of taskFiles) {
      const body = readFileSync(taskFile, "utf8");
      expect(body).toContain("## Approved Spec");
      expect(body).toContain("desired behavior: keep request rate below 5 rps");
      expect(body).toContain("non-goal: change telemetry");
    }
  });

  it("is a no-op when options.approvedSpec is omitted (native parity)", async () => {
    const pi = makePiExecMock();

    await runDeepPlanAgents(
      pi,
      "/tmp/pi-agent-flywheel",
      [{ name: "correctness", model: "openai-codex/gpt-5.4", task: "Plan correctness pass" }],
    );

    const taskCall = pi.exec.mock.calls.find(
      ([cmd, args]: [string, string[]]) => cmd === "pi" && args.some((a) => a.startsWith("@")),
    );
    const taskFile = taskCall![1].find((a: string) => a.startsWith("@"))!.slice(1);
    const body = readFileSync(taskFile, "utf8");
    expect(body).not.toContain("## Approved Spec");
  });

  it("does NOT double-inject when the planner prompt already contains an Approved Spec section", async () => {
    const pi = makePiExecMock();
    const approvedSpec = "- contract X must hold";
    const taskWithSpec =
      "Plan correctness pass\n\n## Approved Spec\n- contract X must hold (already embedded)";

    await runDeepPlanAgents(
      pi,
      "/tmp/pi-agent-flywheel",
      [{ name: "correctness", model: "openai-codex/gpt-5.4", task: taskWithSpec }],
      undefined,
      { approvedSpec },
    );

    const taskCall = pi.exec.mock.calls.find(
      ([cmd, args]: [string, string[]]) => cmd === "pi" && args.some((a) => a.startsWith("@")),
    );
    const taskFile = taskCall![1].find((a: string) => a.startsWith("@"))!.slice(1);
    const body = readFileSync(taskFile, "utf8");
    // Exactly one "## Approved Spec" header — runner did not duplicate.
    expect(body.match(/## Approved Spec/g)?.length).toBe(1);
    expect(body).toContain("already embedded");
  });
});
