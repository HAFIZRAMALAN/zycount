// The app (docs/) served on localhost:8767, talking to a local Supabase
// started by `supabase start`. SUPA_URL / SUPA_ANON come from `supabase status`.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.APP_URL || "http://localhost:8767",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1360, height: 900 },
  },
});
