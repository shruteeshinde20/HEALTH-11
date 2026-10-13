import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backendPath, clientIp, isSameOrigin, isUnsafeMethod, publicWsBase, streamUrl,
} from "../../src/lib/server/request-core.ts";

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
                         ["auth"], ["simulations", "4", "stream-token"], ["..", "health"], ["floors", "a%2Fb"], ["floors", ""], [], ["a b"]]) {
    assert.equal(backendPath(blocked), null, JSON.stringify(blocked));
  }
});

test("live streams use the public WebSocket address of the backend", () => {
  assert.equal(publicWsBase("http://127.0.0.1:8000", undefined), "ws://127.0.0.1:8000");
  assert.equal(publicWsBase("https://api.example.org/", ""), "wss://api.example.org");
  assert.equal(publicWsBase("http://backend:8000", " wss://evac.example.org/ "), "wss://evac.example.org");
  assert.equal(publicWsBase("http://backend:8000", "https://evac.example.org"), null);
  assert.equal(publicWsBase("http://backend:8000", "not a url"), null);
});

test("a stream address is built only for a real run id and an offered speed", () => {
  assert.equal(streamUrl("ws://127.0.0.1:8000", 12, "a.b+c/=", 10),
               "ws://127.0.0.1:8000/api/v1/ws/simulations/12?token=a.b%2Bc%2F%3D&speed=10");
  for (const [runId, speed] of [[0, 10], [-1, 10], [1.5, 10], ["3", 10], [3, 7], [3, "10"], [3, 0]] as const) {
    assert.equal(streamUrl("ws://x", runId, "t", speed), null, JSON.stringify([runId, speed]));
  }
});
