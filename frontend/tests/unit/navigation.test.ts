import { test } from "node:test";
import assert from "node:assert/strict";
import { HOME_PATH, PUBLIC_PATHS, safeNextPath } from "../../src/lib/shared/navigation.ts";

test("after login, only paths on this site are followed", () => {
  assert.equal(safeNextPath("/reports?run=3"), "/reports?run=3");
  for (const unsafe of [null, "", "https://evil.example", "//evil.example", "/\\evil.example",
                        "javascript:alert(1)", "/login", "/login?next=/x", "/register", "/a\nb"]) {
    assert.equal(safeNextPath(unsafe), HOME_PATH, String(unsafe));
  }
});

test("the pages anyone may open without logging in", () => {
  assert.deepEqual([...PUBLIC_PATHS].sort(), ["/", "/forgot-password", "/login", "/register"]);
});
