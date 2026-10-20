import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLocation, readLocation } from "../../src/lib/shared/location.ts";

test("both empty means no position", () => {
  assert.deepEqual(readLocation("", "  "), { ok: true, latitude: null, longitude: null });
});

test("two numbers in decimal degrees", () => {
  assert.deepEqual(readLocation(" 18.5204 ", "73.8567"), { ok: true, latitude: 18.5204, longitude: 73.8567 });
  assert.deepEqual(readLocation("-33.8688", "-151.2093"), { ok: true, latitude: -33.8688, longitude: -151.2093 });
  assert.deepEqual(readLocation("90", "-180"), { ok: true, latitude: 90, longitude: -180 });
});

test("a pair pasted from a map app into the first box is split", () => {
  assert.deepEqual(readLocation("18.5204, 73.8567", ""), { ok: true, latitude: 18.5204, longitude: 73.8567 });
});

test("one without the other is refused", () => {
  const onlyLat = readLocation("18.5", "");
  assert.equal(onlyLat.ok, false);
  assert.equal(!onlyLat.ok && onlyLat.field, "longitude");
  const onlyLon = readLocation("", "73.8");
  assert.equal(!onlyLon.ok && onlyLon.field, "latitude");
});

test("out of range, text and comma decimals are refused", () => {
  for (const [lat, lon, field] of [
    ["90.1", "0", "latitude"], ["-91", "0", "latitude"], ["0", "180.01", "longitude"],
    ["north", "0", "latitude"], ["0", "1e3", "longitude"], ["18,5", "73.8", "latitude"],
    ["Infinity", "0", "latitude"],
  ] as const) {
    const result = readLocation(lat, lon);
    assert.equal(result.ok, false, `${lat}, ${lon}`);
    assert.equal(!result.ok && result.field, field, `${lat}, ${lon}`);
  }
});

test("positions are shown with N/S and E/W", () => {
  assert.equal(formatLocation(18.5204, 73.8567), "18.52040° N, 73.85670° E");
  assert.equal(formatLocation(-33.8688, -151.2093), "33.86880° S, 151.20930° W");
  assert.equal(formatLocation(null, null), "");
});
