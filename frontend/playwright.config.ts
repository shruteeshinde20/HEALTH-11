// End-to-end tests (PROJECT.md build step 16): a real browser uses the real
// website, API and PostgreSQL. Run with `npm run e2e` after `npm run build`.
// See e2e/support.ts for the separate database, ports and fake AI.

import { defineConfig, devices } from "@playwright/test";

import { AI_URL, API_URL, MAIL_URL, PORTS, REPO_DIR, WEB_URL, e2eDatabaseUrl, environment, python } from "./e2e/support";

const databaseUrl = e2eDatabaseUrl();     // refuses anything but /health11_e2e
const py = `"${python()}"`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: WEB_URL,
    timezoneId: "UTC",
    locale: "en-GB",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Stand-in for the AI service: no real AI and no internet during tests.
      command: "node e2e/fake-ai.mjs",
      url: `${AI_URL}/`,
      reuseExistingServer: false,
      env: environment({ E2E_AI_PORT: String(PORTS.ai) }),
    },
    {
      // Stand-in mail server for "Forgot password?" codes: no real e-mail is sent.
      command: "node e2e/fake-smtp.mjs",
      url: `${MAIL_URL}/`,
      reuseExistingServer: false,
      env: environment({ E2E_SMTP_PORT: String(PORTS.smtp), E2E_MAIL_PORT: String(PORTS.mail) }),
    },
    {
      // Empty the e2e database, build it again with the migrations, start the API.
      command: `${py} -m alembic downgrade base && ${py} -m alembic upgrade head && `
        + `${py} -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port ${PORTS.api}`,
      cwd: REPO_DIR,
      url: `${API_URL}/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      env: environment({
        DATABASE_URL: databaseUrl,
        ENVIRONMENT: "development",
        AI_PROVIDER: "ollama",
        OLLAMA_URL: AI_URL,
        OLLAMA_MODEL: "e2e-fake-model",
        CORS_ORIGINS: WEB_URL,
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(PORTS.smtp),
        SMTP_SECURITY: "none",
        SMTP_FROM: "health11@e2e.test",
        SMTP_USERNAME: "",
        SMTP_PASSWORD: "",
      }),
    },
    {
      // The production build (npm run build first).
      command: `npx next start --port ${PORTS.web}`,
      url: `${WEB_URL}/login`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: environment({ BACKEND_URL: API_URL, BACKEND_PUBLIC_WS_URL: `ws://127.0.0.1:${PORTS.api}` }),
    },
  ],
});
