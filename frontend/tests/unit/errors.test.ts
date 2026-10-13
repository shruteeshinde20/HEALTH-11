import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, describeError, toApiError } from "../../src/lib/shared/errors.ts";

test("backend errors keep their code, message and field details", () => {
  const body = { error: { code: "VALIDATION_ERROR", message: "Invalid input",
                          details: [{ field: "body.email", message: "Required" }, { bad: 1 }] } };
  const error = toApiError(422, body);
  assert.equal(error.status, 422);
  assert.equal(error.code, "VALIDATION_ERROR");
  assert.equal(error.message, "Invalid input");
  assert.deepEqual(error.details, [{ field: "body.email", message: "Required" }]);
});

test("unknown bodies never leak raw server output", () => {
  assert.equal(toApiError(502, "<html>Bad gateway</html>").message,
               "Something went wrong on the server. Please try again.");
  assert.equal(toApiError(403, null).message, "You do not have permission to do this.");
  assert.equal(toApiError(400, { detail: "x" }).code, "REQUEST_FAILED");
});

test("rate limits say when to try again", () => {
  const error = toApiError(429, { error: { code: "RATE_LIMITED", message: "Too many attempts." } }, "125");
  assert.equal(error.retryAfterSeconds, 125);
  assert.equal(describeError(error), "Too many attempts. Try again in about 3 minutes.");
  assert.equal(toApiError(429, null, "abc").retryAfterSeconds, null);
  assert.equal(describeError(new TypeError("fetch failed")),
               "Something went wrong. Please check your connection and try again.");
  assert.ok(error instanceof ApiError);
});
