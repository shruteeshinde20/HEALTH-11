import { test } from "node:test";
import assert from "node:assert/strict";

import { passwordProblem } from "../../src/lib/shared/password.ts";

test("passwords follow the API's rules", () => {
  assert.equal(passwordProblem("StrongPassword!234"), null);
  assert.equal(passwordProblem("Short!1a"), "Use at least 12 characters.");
  assert.equal(passwordProblem("NOLOWERCASE!123"), "Add a lowercase letter.");
  assert.equal(passwordProblem("nouppercase!123"), "Add an uppercase letter.");
  assert.equal(passwordProblem("NoDigitsHere!!"), "Add a digit.");
  assert.equal(passwordProblem("NoSpecial12345"), "Add a special character, such as ! or #.");
  assert.match(passwordProblem("Aa1!" + "é".repeat(35)) ?? "", /at most 72/);   // 74 bytes
  assert.equal(passwordProblem("Ää1!ääääääää"), null);                         // letters beyond ASCII count
});
