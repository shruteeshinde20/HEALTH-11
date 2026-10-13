import { test } from "node:test";
import assert from "node:assert/strict";
import { backendPath, clientIp, isSameOrigin, isUnsafeMethod } from "../../src/lib/server/request-core.ts";

test("only same-site pages may change data", () => {
  assert.equal(isSameOrigin({ origin: "https://evac.example.org", host: "evac.example.org", secFetchSite: "same-origin" }), true);
  assert.equal(isSameOrigin({ origin: "http://localhost:3000", host: "localhost:3000", secFetchSite: null }), true);
  assert.equal(isSameOrigin({ origin: "https://evil.example", host: "evac.example.org", secFetchSite: null }), false);
  assert.equal(isSameOrigin({ origin: "https://evac.example.org", host: "evac.example.org", secFetchSite: "cross-site" }), false);
  assert.equal(isSameOrigin({ origin: null, host: "evac.example.org", secFetchSite: null }), false);
  assert.equal(isSameOrigin({ origin: "not a url", host: "evac.example.org", secFetchSite: null }), false);
  assert.equal(isUnsafeMethod("post") && isUnsafeMethod("DELETE") && !isUnsafeMethod("GET"), true);
});

test("the visitor's IP is used only behind a trusted proxy, right-most entry", () => {
  assert.equal(clientIp("1.2.3.4", false), null);
  assert.equal(clientIp(null, true), null);
  assert.equal(clientIp("6.6.6.6, 203.0.113.9", true), "203.0.113.9");   // forged first entry ignored
  assert.equal(clientIp("2001:db8::1", true), "2001:db8::1");
  assert.equal(clientIp("1.2.3.4, <script>", true), null);
});

test("token endpoints and odd paths are never passed to the backend", () => {
  assert.equal(backendPath(["floors", "12", "route"]), "/floors/12/route");
  assert.equal(backendPath(["auth", "me"]), "/auth/me");
  for (const blocked of [["auth", "login"], ["auth", "refresh"], ["auth", "logout"], ["auth", "register-organization"],
                         ["auth"], ["..", "health"], ["floors", "a%2Fb"], ["floors", ""], [], ["a b"]]) {
    assert.equal(backendPath(blocked), null, JSON.stringify(blocked));
  }
});
