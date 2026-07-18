import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

// Load repo-root .env.test into process.env so the live-test credentials never
// need exporting by hand (no dotenv dependency). Real environment variables
// win over file values, so shell/CI overrides keep working.
const envFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.env.test",
);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.APP_URL ?? "https://delivery-scheduler.example.com",
    extraHTTPHeaders: {
      "Content-Type": "application/json",
    },
    trace: "retain-on-failure",
  },
});
