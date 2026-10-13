import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_PAGES, canOpen, pageFor, visiblePages } from "../../src/lib/shared/pages.ts";

test("the navigation lists only built pages, and Admin only for Administrators", () => {
  assert.equal(APP_PAGES.length, 11);   // 13 pages minus Landing and Login / Register
  assert.ok(visiblePages("Staff User").every((page) => page.ready));
  const admin = APP_PAGES.find((page) => page.href === "/admin")!;
  assert.equal(admin.ready, true);
  assert.ok(visiblePages("Administrator").some((page) => page.href === "/admin"));
  assert.ok(!visiblePages("Emergency Commander").some((page) => page.href === "/admin"));
  assert.ok(!visiblePages("Staff User").some((page) => page.href === "/admin"));
  assert.ok(!visiblePages(null).some((page) => page.href === "/admin"));
  // Algorithm Comparison runs simulations, so Staff Users do not see it.
  assert.ok(!visiblePages("Staff User").some((page) => page.href === "/compare"));
  assert.ok(visiblePages("Emergency Commander").some((page) => page.href === "/compare"));
  // Every page is built now.
  assert.ok(APP_PAGES.every((page) => page.ready));
});

test("each role sees the pages PROJECT.md gives it", () => {
  const hrefs = (role: Parameters<typeof visiblePages>[0]) => visiblePages(role).map((p) => p.href);
  assert.deepEqual(hrefs("Staff User"), ["/dashboard", "/live", "/people", "/reports", "/settings"]);
  assert.deepEqual(hrefs("Emergency Commander"), APP_PAGES.filter((p) => p.href !== "/admin").map((p) => p.href));
  assert.deepEqual(hrefs("Administrator"), APP_PAGES.map((p) => p.href));
});

test("pages opened by address follow the same rules", () => {
  assert.equal(canOpen("/graph", "Staff User"), false);
  assert.equal(canOpen("/scenarios", "Staff User"), false);
  assert.equal(canOpen("/onboarding", "Staff User"), false);
  assert.equal(canOpen("/admin", "Emergency Commander"), false);
  assert.equal(canOpen("/live", "Staff User"), true);
  assert.equal(canOpen("/graph", "Emergency Commander"), true);
  assert.equal(canOpen("/settings", "Staff User"), true);
  assert.equal(canOpen("/graphs-and-more", "Staff User"), true);   // not a page of ours: Next.js answers 404
  assert.equal(pageFor("/scenarios", "Staff User"), null);
  assert.equal(pageFor("/scenarios", "Emergency Commander")?.href, "/scenarios");
});
