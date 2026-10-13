import { test } from "node:test";
import assert from "node:assert/strict";
import { apiAll } from "../../src/lib/client/api.ts";

test("every page of a list is loaded, 200 at a time, until the total is reached", async () => {
  const total = 450;
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input), "http://site.test");
    seen.push(url.pathname + url.search);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ id: offset + i }));
    return new Response(JSON.stringify({ items, total, limit, offset }), { status: 200 });
  }) as typeof fetch;
  try {
    const items = await apiAll<{ id: number }>("/floors", { building_id: 3 });
    assert.equal(items.length, 450);
    assert.equal(items[449]?.id, 449);
    assert.deepEqual(seen, [
      "/api/backend/floors?building_id=3&limit=200&offset=0",
      "/api/backend/floors?building_id=3&limit=200&offset=200",
      "/api/backend/floors?building_id=3&limit=200&offset=400",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
