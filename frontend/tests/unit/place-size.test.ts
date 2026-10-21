import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSize, readSize } from "../../src/lib/shared/place-size.ts";

test("both empty means no size", () => {
  assert.deepEqual(readSize(" ", ""), { ok: true, width_m: null, length_m: null });
});

test("two sizes in metres", () => {
  assert.deepEqual(readSize("20", " 12.5 "), { ok: true, width_m: 20, length_m: 12.5 });
  assert.deepEqual(readSize("0.5", "1000"), { ok: true, width_m: 0.5, length_m: 1000 });
});

test("one without the other is refused", () => {
  const onlyWidth = readSize("20", "");
  assert.equal(!onlyWidth.ok && onlyWidth.field, "length");
  const onlyLength = readSize("", "12");
  assert.equal(!onlyLength.ok && onlyLength.field, "width");
});

test("zero, negative, too big and text are refused", () => {
  for (const [w, l, field] of [["0", "5", "width"], ["5", "-1", "length"], ["1001", "5", "width"],
                               ["abc", "5", "width"], ["5", "Infinity", "length"]] as const) {
    const result = readSize(w, l);
    assert.equal(result.ok, false, `${w} x ${l}`);
    assert.equal(!result.ok && result.field, field);
  }
});

test("a size is shown as width × length", () => {
  assert.equal(formatSize({ width_m: 20, length_m: 12.5 }), "20 × 12.5 m");
  assert.equal(formatSize({ width_m: null, length_m: null }), null);
});
