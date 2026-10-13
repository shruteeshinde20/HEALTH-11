import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCsp, newNonce, wsOrigin } from "../../src/lib/server/csp.ts";

const parts = (csp: string) => new Map(csp.split("; ").map((d) => {
  const [name, ...values] = d.split(" ");
  return [name, values.join(" ")] as const;
}));

test("production pages only run scripts with this response's nonce", () => {
  const csp = parts(buildCsp({ nonce: "abc", development: false, secure: true, streamOrigin: "wss://evac.example.org" }));
  assert.equal(csp.get("script-src"), "'self' 'nonce-abc' 'strict-dynamic'");
  assert.equal(csp.get("style-src"), "'self' 'nonce-abc'");
  assert.equal(csp.get("connect-src"), "'self' wss://evac.example.org");
  assert.equal(csp.get("frame-ancestors"), "'none'");
  assert.equal(csp.get("object-src"), "'none'");
  assert.ok(csp.has("upgrade-insecure-requests"));
  assert.ok(!buildCsp({ nonce: "abc", development: false, secure: true, streamOrigin: null }).includes("unsafe-eval"));
});

test("development allows what Next.js needs, and no https upgrade on http://localhost", () => {
  const csp = parts(buildCsp({ nonce: "n", development: true, secure: false, streamOrigin: "ws://127.0.0.1:8000" }));
  assert.match(csp.get("script-src") ?? "", /'unsafe-eval'/);
  assert.equal(csp.get("style-src"), "'self' 'unsafe-inline'");
  assert.equal(csp.get("connect-src"), "'self' ws://127.0.0.1:8000");
  assert.ok(!csp.has("upgrade-insecure-requests"));
});

test("nonces are random and the stream origin is taken from a ws URL only", () => {
  assert.notEqual(newNonce(), newNonce());
  assert.match(newNonce(), /^[A-Za-z0-9+/=]{20,}$/);
  assert.equal(wsOrigin("ws://127.0.0.1:8000"), "ws://127.0.0.1:8000");
  assert.equal(wsOrigin("wss://evac.example.org/"), "wss://evac.example.org");
  assert.equal(wsOrigin("https://evac.example.org"), null);
  assert.equal(wsOrigin("not a url"), null);
  assert.equal(wsOrigin(null), null);
});
