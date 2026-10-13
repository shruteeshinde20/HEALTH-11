import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_PAGES, visiblePages } from "../../src/lib/shared/pages.ts";

test("the navigation lists only built pages, and Admin only for Administrators", () => {
  assert.equal(APP_PAGES.length, 11);   // 13 pages minus Landing and Login / Register
  assert.ok(visiblePages("Staff User").every((page) => page.ready));
  const admin = APP_PAGES.find((page) => page.href === "/admin")!;
  admin.ready = true;
  try {
    assert.ok(visiblePages("Administrator").some((page) => page.href === "/admin"));
    assert.ok(!visiblePages("Emergency Commander").some((page) => page.href === "/admin"));
    assert.ok(!visiblePages(null).some((page) => page.href === "/admin"));
  } finally {
    admin.ready = false;
  }
});
