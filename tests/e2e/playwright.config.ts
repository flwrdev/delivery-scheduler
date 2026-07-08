import { defineConfig } from "@playwright/test";

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
