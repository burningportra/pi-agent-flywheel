#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const logDir = process.env.STARTUP_CEREMONY_E2E_LOG_DIR || resolve("tmp/startup-ceremony-e2e");
mkdirSync(logDir, { recursive: true });

const runner = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  runner,
  ["vitest", "run", "src/startup-ceremony.e2e.test.ts", "--reporter=verbose"],
  {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: "inherit",
    env: {
      ...process.env,
      STARTUP_CEREMONY_E2E_LOG_DIR: logDir,
    },
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

console.log(`\nStartup ceremony E2E artifacts: ${logDir}`);
process.exit(result.status ?? 1);
