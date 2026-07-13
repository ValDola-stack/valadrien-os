import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Use a dedicated port so e2e tests always start their own server in local_trusted mode,
// even when the dev server is running on :3100 in authenticated mode.
const PORT = Number(process.env.VALADRIEN_OS_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const VALADRIEN_OS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "valadrien-os-e2e-home-"));
const VALADRIEN_OS_CONFIG = path.join(VALADRIEN_OS_HOME, "instances", "playwright-e2e", "config.json");
const VALADRIEN_OS_AGENT_JWT_SECRET = process.env.VALADRIEN_OS_AGENT_JWT_SECRET ?? "playwright-e2e-agent-jwt-secret";
const PLAYWRIGHT_CHANNEL = process.env.VALADRIEN_OS_PLAYWRIGHT_CHANNEL;

process.env.VALADRIEN_OS_HOME = VALADRIEN_OS_HOME;
process.env.VALADRIEN_OS_CONFIG = VALADRIEN_OS_CONFIG;
process.env.VALADRIEN_OS_AGENT_JWT_SECRET = VALADRIEN_OS_AGENT_JWT_SECRET;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // These suites target dedicated multi-user configurations/ports and are
  // intentionally not part of the default local_trusted e2e run.
  testIgnore: ["multi-user.spec.ts", "multi-user-authenticated.spec.ts"],
  timeout: 60_000,
  retries: 0,
  // All specs share one throwaway server, and several toggle instance-level
  // state (the `enableConferenceRoomChat` experimental flag) that changes
  // which UI variant renders. Run files serially so a flag flip in one spec
  // can't change the wizard/thread under another spec mid-flight.
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
  // The webServer directive bootstraps a throwaway instance and then starts it.
  // `onboard --yes --run` works in a non-interactive temp VALADRIEN_OS_HOME.
  webServer: {
    command: `pnpm valadrien-os onboard --yes --run`,
    url: `${BASE_URL}/api/health`,
    // Always boot a dedicated throwaway instance for e2e so browser tests
    // never attach to the developer's active ValadrienOs home/server.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      VALADRIEN_OS_HOME,
      VALADRIEN_OS_CONFIG,
      VALADRIEN_OS_AGENT_JWT_SECRET,
      VALADRIEN_OS_INSTANCE_ID: "playwright-e2e",
      VALADRIEN_OS_BIND: "loopback",
      VALADRIEN_OS_DEPLOYMENT_MODE: "local_trusted",
      VALADRIEN_OS_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
