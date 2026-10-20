// One organization's journey through HEALTH-11, in a real browser against the
// real website, API and database (PROJECT.md: "Every button works end-to-end:
// UI, API, database, UI"). The steps build on each other, so they run in order.
//
// The floor is PROJECT.md's Test case. With a fire blocking C1 the expected
// routes are WardA,C2,S2,E2 (47 m, walking) and ICU,C2,R2,E2 (50 m,
// stretcher): a mean walk of 48.5 m, everyone out after 100 s.

import { readFileSync } from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { FRONTEND_DIR, WEB_URL } from "./support";

const ADMIN = { organization: "E2E Hospital Group", name: "E2E Admin", email: "admin@e2e.test", password: "E2e-Admin-Pass-2026!" };
const STAFF = { name: "E2E Staff", email: "staff@e2e.test", password: "E2e-Staff-Pass-2026!" };
const FLOOR_FILE = path.join(FRONTEND_DIR, "e2e", "fixtures", "test-case-floor.csv");

const PATIENTS_CSV = "patient_code,mobility,criticality,test_data,hospital,building,floor_number,place\r\n"
  + "P-1,ambulatory,3,true,E2E Hospital,Main Block,0,WardA\r\n"
  + "P-2,stretcher,4,true,E2E Hospital,Main Block,0,ICU\r\n";
const STAFF_CSV = "staff_code,full_name,role,test_data,hospital,building,floor_number,place\r\n"
  + "S-1,Test Nurse,nurse,true,,,,\r\n";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let organizationId = "";
const securityProblems: string[] = [];

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: WEB_URL, timezoneId: "UTC", locale: "en-GB" });
}

/** Collect Content-Security-Policy violations and script errors on every page. */
function watch(p: Page) {
  p.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|execute|apply|connect|frame)/i.test(text)) securityProblems.push(text);
  });
  p.on("pageerror", (error) => securityProblems.push(`Script error: ${error.message}`));
}

async function login(p: Page, email: string, password: string) {
  await p.goto("/login");
  await p.getByLabel("Organization ID").fill(organizationId);
  await p.getByLabel("Email").fill(email);
  await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Log in" }).click();
}

async function download(p: Page, click: () => Promise<void>) {
  const [file] = await Promise.all([p.waitForEvent("download"), click()]);
  return { name: file.suggestedFilename(), body: readFileSync(await file.path()) };
}

test.beforeAll(async ({ browser }) => {
  context = await newContext(browser);
  page = await context.newPage();
  watch(page);
});

test.afterAll(async () => {
  await context.close();
});

test("sign-up creates the organization and its first Administrator", async () => {
  await page.goto("/register");
  await page.getByLabel("Organization name").fill(ADMIN.organization);
  await page.getByLabel("Your name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page.getByLabel("Repeat password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Your organization is ready" })).toBeVisible();
  organizationId = (await page.locator('[aria-label="Organization ID"]').innerText()).trim();
  expect(organizationId).not.toBe("");

  await page.goto("/dashboard");
  await expect(page.getByText(`${ADMIN.name} · Administrator`)).toBeVisible();
});

test("logging out ends the session; a wrong password is refused; the right one works", async () => {
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);

  await login(page, ADMIN.email, "Not-The-Password-1!");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await login(page, ADMIN.email, ADMIN.password);
  await expect(page).toHaveURL(/\/dashboard/);
});

test("the keyboard reaches 'Skip to content' first", async () => {
  await page.goto("/dashboard");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
});

test("Facility Manager: hospital, building and floor, then the Test case floor file", async () => {
  await page.goto("/facilities");
  await page.getByRole("button", { name: "Add hospital" }).click();
  let dialog = page.getByRole("dialog", { name: "Add hospital" });
  await dialog.getByLabel("Hospital name").fill("E2E Hospital");
  await dialog.getByLabel("Time zone").selectOption("UTC");
  await dialog.getByRole("button", { name: "Add hospital" }).click();
  await expect(dialog).toBeHidden();

  // The new hospital opens by itself, showing its buildings and floors.
  await expect(page.getByRole("heading", { name: "E2E Hospital", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Add building" }).click();
  dialog = page.getByRole("dialog", { name: "Add building" });
  await dialog.getByLabel("Building name").fill("Main Block");
  await dialog.getByRole("button", { name: "Add building" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Add floor" }).click();
  dialog = page.getByRole("dialog", { name: "Add floor" });
  await dialog.getByLabel("Floor name").fill("Ground");
  await dialog.getByLabel("Floor number").fill("0");
  await dialog.getByRole("button", { name: "Add floor" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Import", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Import a floor file" });
  await dialog.getByLabel("Floor file").setInputFiles(FLOOR_FILE);
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByText("Imported 10 places and 12 paths.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
});

test("Graph Builder shows the imported places", async () => {
  await page.getByRole("link", { name: "Open map" }).click();
  const plan = page.getByRole("region", { name: "Floor plan of Ground" });
  for (const place of ["ICU", "WardA", "C1", "C2", "E1", "E2"]) {
    await expect(plan.getByText(place, { exact: true })).toBeVisible();
  }
});

test("Patients & Staff: a CSV file is checked first, then saved; Export gives it back", async () => {
  await page.goto("/people");
  await page.getByRole("button", { name: "Import CSV" }).click();
  let dialog = page.getByRole("dialog", { name: "Import patients from CSV" });
  await dialog.getByLabel("CSV file").setInputFiles({ name: "patients.csv", mimeType: "text/csv", buffer: Buffer.from(PATIENTS_CSV) });
  await dialog.getByRole("button", { name: "Check file" }).click();
  await expect(dialog.getByText("The file lists 2 people: 2 to add, 0 to change, 0 to remove, 0 unchanged.")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect(dialog.getByText("Saved: 2 added, 0 changed, 0 removed, 0 unchanged.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(page.getByRole("heading", { name: "Patients (2)" })).toBeVisible();

  await page.getByRole("button", { name: "Staff", exact: true }).click();
  await page.getByRole("button", { name: "Import CSV" }).click();
  dialog = page.getByRole("dialog", { name: "Import staff from CSV" });
  await dialog.getByLabel("CSV file").setInputFiles({ name: "staff.csv", mimeType: "text/csv", buffer: Buffer.from(STAFF_CSV) });
  await dialog.getByRole("button", { name: "Check file" }).click();
  await expect(dialog.getByText("1 to add")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect(dialog.getByText(/^Saved: 1 added/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(page.getByRole("heading", { name: "Staff (1)" })).toBeVisible();

  const exported = await download(page, () => page.getByRole("link", { name: "Export CSV" }).click());
  expect(exported.name).toBe("staff.csv");
  expect(exported.body.toString("utf8")).toBe(STAFF_CSV);
});

test("Scenario Builder: a fire at C1 is saved", async () => {
  await page.goto("/scenarios");
  await page.getByRole("button", { name: "New scenario" }).click();
  await page.getByLabel("Scenario name").fill("Fire at C1");
  // A new scenario starts with one hazard (a serious fire that does not spread); only its place is chosen.
  await expect(page.getByRole("group", { name: "Hazard 1" })).toBeVisible();
  await page.getByLabel("Place", { exact: true }).selectOption({ label: "C1 (corridor)" });
  await page.getByRole("button", { name: "Save scenario" }).click();
  await expect(page.getByText("The scenario is saved.")).toBeVisible();
});

test("Algorithm Comparison: three charts and the Test case values", async () => {
  await page.goto("/compare");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  for (const chart of ["Evacuation time (s), everyone out only", "Mean walk (m)", "Mean risk exposure"]) {
    await expect(page.getByRole("figure", { name: chart })).toBeVisible();
  }
  const walk = page.getByRole("figure", { name: "Mean walk (m)" });
  await expect(walk.locator(".recharts-bar-rectangle")).toHaveCount(4);    // one bar per algorithm
  await expect(walk.locator('[tabindex="0"]')).toHaveCount(0);
  for (const algorithm of ["Dijkstra", "A*"]) {
    const row = page.getByRole("row").filter({ has: page.getByText(algorithm, { exact: true }) });
    await expect(row).toContainText("48.5");     // (47 m + 50 m) / 2, PROJECT.md Test case with C1 blocked
    await expect(row).toContainText("1m 40s");   // everyone out after 100 s
  }
});

test("Run and watch: the run plays live to the end", async () => {
  const astar = page.getByRole("row").filter({ has: page.getByText("A*", { exact: true }) });
  await astar.getByRole("button", { name: "Run and watch" }).click();
  await expect(page).toHaveURL(/\/live\?run=\d+/);
  await page.getByLabel("Speed").selectOption("60");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Finished at/ })).toBeVisible({ timeout: 60_000 });
});

test("Reports & History: details with the timeline chart, and a real PDF", async () => {
  await page.goto("/reports");
  await page.getByRole("button", { name: "Details" }).first().click();
  const timeline = page.getByRole("figure", { name: "People over time" });
  await expect(timeline).toBeVisible();
  await expect(timeline.locator(".recharts-line-curve")).toHaveCount(2);   // "Reached an exit" and "Still moving"
  await expect(timeline.locator('[tabindex="0"]')).toHaveCount(0);       // nothing focusable inside the hidden drawing

  const pdf = await download(page, () => page.getByRole("link", { name: "PDF" }).first().click());
  expect(pdf.name).toMatch(/\.pdf$/);
  expect(pdf.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
});

test("AI Assistant: drafts a scenario from text and explains a run (test AI, nothing leaves the PC)", async () => {
  await page.goto("/assistant");
  await page.getByLabel("What is happening?").fill("Fire in WardA, severity 4");
  await page.getByRole("button", { name: "Draft scenario" }).click();
  await expect(page.getByRole("table", { name: "Drafted hazards" })).toContainText("WardA");

  await page.getByRole("button", { name: "Explain this run" }).click();
  await expect(page.getByText("This is a simulation result for planning and training.")).toBeVisible();
});

test("Admin adds a Staff User, who sees only the pages of that role", async ({ browser }) => {
  await page.goto("/admin");
  await page.getByRole("button", { name: "Add user" }).click();
  const dialog = page.getByRole("dialog", { name: "Add user" });
  await dialog.getByLabel("Full name").fill(STAFF.name);
  await dialog.getByLabel("Email").fill(STAFF.email);
  await dialog.getByLabel("Role").selectOption("Staff User");
  await dialog.getByLabel("First password").fill(STAFF.password);
  await dialog.getByRole("button", { name: "Add user" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("table", { name: "Users" })).toContainText(STAFF.email);

  const staffContext = await newContext(browser);
  const staff = await staffContext.newPage();
  watch(staff);
  await login(staff, STAFF.email, STAFF.password);
  await expect(staff).toHaveURL(/\/dashboard/);
  await expect(staff.getByRole("navigation", { name: "Pages" }).getByRole("link")).toHaveText(
    ["Dashboard", "Live Simulation", "Patients & Staff", "Reports & History", "Settings / Profile"]);

  await staff.goto("/facilities");
  await expect(staff.getByRole("heading", { name: "Not available" })).toBeVisible();
  await staff.goto("/people");
  await expect(staff.getByRole("heading", { name: "Patients (2)" })).toBeVisible();
  await expect(staff.getByRole("link", { name: "Export CSV" })).toBeVisible();
  await expect(staff.getByRole("button", { name: "Import CSV" })).toHaveCount(0);
  await staffContext.close();
});

test("Settings: an Administrator changes their own name", async () => {
  await page.goto("/settings");
  await page.getByLabel("Full name").fill("E2E Administrator");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("E2E Administrator · Administrator")).toBeVisible();
});

test("every page passes the automatic accessibility check (WCAG 2.1 A and AA)", async ({ browser }) => {
  const signedIn = ["/dashboard", "/facilities", "/graph", "/scenarios", "/live", "/compare", "/people",
                    "/assistant", "/reports", "/admin", "/settings", "/onboarding"];
  const problems: string[] = [];
  const check = async (p: Page, address: string) => {
    await p.goto(address);
    await p.waitForLoadState("networkidle");
    const result = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    for (const v of result.violations.filter((v) => v.impact === "serious" || v.impact === "critical")) {
      problems.push(`${address}: ${v.id} (${v.impact}) ${v.help}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
    }
  };
  for (const address of signedIn) await check(page, address);

  const visitorContext = await newContext(browser);
  const visitor = await visitorContext.newPage();
  watch(visitor);
  for (const address of ["/", "/login", "/register"]) await check(visitor, address);
  await visitorContext.close();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("no page broke the Content-Security-Policy or threw a script error", async () => {
  expect(securityProblems, securityProblems.join("\n")).toEqual([]);
});
