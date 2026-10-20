// Shared settings for the end-to-end tests (Playwright).
//
// The tests start their own backend, website and fake AI on separate ports, and
// use their own database, health11_e2e, which is emptied and rebuilt at the
// start of every run. The development database and the pytest database
// (health11_test) are never touched: anything but /health11_e2e is refused.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = path.resolve(FRONTEND_DIR, "..");

export const PORTS = {
  web: Number(process.env.E2E_WEB_PORT ?? 3100),
  api: Number(process.env.E2E_API_PORT ?? 8100),
  ai: Number(process.env.E2E_AI_PORT ?? 11500),
  smtp: Number(process.env.E2E_SMTP_PORT ?? 11525),
  mail: Number(process.env.E2E_MAIL_PORT ?? 11526),   // the fake mail server's inbox (HTTP)
};
// localhost (not 127.0.0.1): browsers keep Secure cookies on http://localhost.
export const WEB_URL = `http://localhost:${PORTS.web}`;
export const API_URL = `http://127.0.0.1:${PORTS.api}`;
export const AI_URL = `http://127.0.0.1:${PORTS.ai}`;
export const MAIL_URL = `http://127.0.0.1:${PORTS.mail}`;

const E2E_DATABASE = "health11_e2e";

/** E2E_DATABASE_URL, or TEST_DATABASE_URL from .env.test with the database
 *  name changed to health11_e2e. The address itself is never printed. */
export function e2eDatabaseUrl(): string {
  let url = process.env.E2E_DATABASE_URL?.trim();
  if (!url) {
    const file = path.join(REPO_DIR, ".env.test");
    const line = existsSync(file)
      ? readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).find((l) => /^\s*TEST_DATABASE_URL\s*=/.test(l))
      : undefined;
    const testUrl = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (testUrl?.endsWith("/health11_test")) url = `${testUrl.slice(0, -"health11_test".length)}${E2E_DATABASE}`;
  }
  if (!url) {
    throw new Error("Set E2E_DATABASE_URL, or TEST_DATABASE_URL (…/health11_test) in .env.test, for the end-to-end tests.");
  }
  if (!url.endsWith(`/${E2E_DATABASE}`)) {
    throw new Error(`Refusing to run: the end-to-end database must be /${E2E_DATABASE} (it is emptied on every run).`);
  }
  return url;
}

/** The project's Python: E2E_PYTHON, else the .venv next to the project, else "python". */
export function python(): string {
  if (process.env.E2E_PYTHON) return process.env.E2E_PYTHON;
  const venv = process.platform === "win32"
    ? path.join(REPO_DIR, ".venv", "Scripts", "python.exe")
    : path.join(REPO_DIR, ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python";
}

/** process.env plus `extra`, as the plain string map web servers expect. */
export function environment(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  return { ...base, ...extra };
}
