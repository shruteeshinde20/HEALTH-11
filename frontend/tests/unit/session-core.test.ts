import { test } from "node:test";
import assert from "node:assert/strict";
import { cookieNames, cookieOptions, createRefresher, secondsUntilExpiry, sessionCookieAges,
         type RefreshResult, type TokenResponse } from "../../src/lib/server/session-core.ts";

function jwt(exp: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ exp })}.signature`;
}

const user = { id: 1, organization_id: 1, email: "a@b.org", full_name: "A", role: "Administrator" as const, is_active: true };
const pair = (n: number): TokenResponse => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`,
                                              token_type: "bearer", expires_in: 1800, user });

test("cookies are httpOnly, SameSite=Strict, and __Host- prefixed when secure", () => {
  assert.deepEqual(cookieNames(true), { access: "__Host-h11_access", refresh: "__Host-h11_refresh" });
  assert.deepEqual(cookieNames(false), { access: "h11_access", refresh: "h11_refresh" });
  assert.deepEqual(cookieOptions(1800.7, true), { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 1800 });
  assert.equal(cookieOptions(-5, false).maxAge, 0);
});

test("cookie lifetimes follow the tokens", () => {
  const now = 1_000_000_000_000;
  assert.equal(secondsUntilExpiry(jwt(now / 1000 + 600), now), 600);
  assert.equal(secondsUntilExpiry("garbage", now), null);
  assert.equal(secondsUntilExpiry(jwt(now / 1000 - 5), now), 0);
  assert.deepEqual(sessionCookieAges({ access_token: "x", refresh_token: jwt(now / 1000 + 86400), expires_in: 1800 }, now),
                   { access: 1800, refresh: 86400 });
});

test("simultaneous requests share one renewal (refresh tokens work only once)", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const refresh = createRefresher(async (token): Promise<RefreshResult> => {
    calls += 1;
    await gate;
    return token === "refresh-1" ? { ok: true, tokens: pair(2) } : { ok: false, status: 401, body: null };
  });
  const waiting = [refresh("refresh-1", null), refresh("refresh-1", null), refresh("refresh-1", null)];
  release();
  const results = await Promise.all(waiting);
  assert.equal(calls, 1);
  for (const result of results) assert.deepEqual(result, { ok: true, tokens: pair(2) });
});

test("a late request with the old token gets the same new tokens, only within the grace period", async () => {
  let clock = 0;
  let calls = 0;
  const refresh = createRefresher(async (): Promise<RefreshResult> => {
    calls += 1;
    return calls === 1 ? { ok: true, tokens: pair(2) } : { ok: false, status: 401, body: null };
  }, { graceMs: 30_000, now: () => clock });
  assert.equal((await refresh("refresh-1", null)).ok, true);
  clock = 10_000;
  assert.deepEqual(await refresh("refresh-1", null), { ok: true, tokens: pair(2) });   // still in grace
  assert.equal(calls, 1);
  clock = 40_001;
  assert.equal((await refresh("refresh-1", null)).ok, false);                           // grace over: backend decides
  assert.equal(calls, 2);
});

test("each renewal receives its caller's context", async () => {
  const seen: string[] = [];
  const refresh = createRefresher<string>(async (_token, context): Promise<RefreshResult> => {
    seen.push(context);
    return { ok: false, status: 401, body: null };
  });
  await refresh("refresh-a", "request-1");
  await refresh("refresh-b", "request-2");
  assert.deepEqual(seen, ["request-1", "request-2"]);
});

test("failed renewals are not remembered", async () => {
  let calls = 0;
  const refresh = createRefresher(async (): Promise<RefreshResult> => {
    calls += 1;
    return { ok: false, status: 503, body: null };
  });
  await refresh("refresh-9", null);
  await refresh("refresh-9", null);
  assert.equal(calls, 2);
});
