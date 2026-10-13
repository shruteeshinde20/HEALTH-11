import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_PAGES, visiblePages } from "../../src/lib/shared/pages.ts";

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
