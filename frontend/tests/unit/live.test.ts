import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clock, closeReason, exitLoadRows, floorView, mapFloors, parseStreamMessage, spread,
} from "../../src/lib/shared/live.ts";

const frame = {
  t: 3, total: 2, evacuated: 1, active: 1, needs_assistance: 0, reached_by_hazard: 0,
  blocked_nodes: [4], congested_edges: [7], exit_load: { "9": 1 }, done: false,
  positions: [{ id: "staff-1", x: 1.5, y: 0, floor_id: 2, mobility: "ambulatory", status: "active" }],
};

test("stream frames, pause replies and errors are told apart", () => {
  const parsed = parseStreamMessage(JSON.stringify(frame));
  assert.equal(parsed.kind, "frame");
  if (parsed.kind === "frame") {
    assert.equal(parsed.frame.t, 3);
    assert.deepEqual(parsed.frame.blocked_nodes, [4]);
    assert.deepEqual(parsed.frame.exit_load, { "9": 1 });
    assert.equal(parsed.frame.positions[0]?.id, "staff-1");
  }
  assert.deepEqual(parseStreamMessage('{"status":"paused","t":12}'), { kind: "status", paused: true, t: 12 });
  assert.deepEqual(parseStreamMessage('{"status":"running","t":12}'), { kind: "status", paused: false, t: 12 });
  assert.deepEqual(parseStreamMessage('{"error":{"code":"UNAUTHORIZED","message":"Invalid or expired token"}}'),
                   { kind: "error", message: "Invalid or expired token" });
});

test("unexpected stream data is ignored, never trusted", () => {
  for (const raw of ["not json", "null", "[]", '{"t":"1"}', '{"status":"paused"}', '{"error":"x"}']) {
    assert.equal(parseStreamMessage(raw).kind, "unknown", raw);
  }
  // Bad positions and non-numbers in lists are dropped, the rest of the frame is kept.
  const messy = { ...frame, blocked_nodes: [4, "x"], positions: [{ id: 1, x: "1", y: 0, floor_id: 2 }, { id: 5, x: 1, y: 2, floor_id: 2 }],
                  exit_load: { "9": 1, "10": "two" } };
  const parsed = parseStreamMessage(JSON.stringify(messy));
  assert.equal(parsed.kind, "frame");
  if (parsed.kind === "frame") {
    assert.deepEqual(parsed.frame.blocked_nodes, [4]);
    assert.deepEqual(parsed.frame.positions.map((p) => p.id), ["5"]);
    assert.deepEqual(parsed.frame.exit_load, { "9": 1 });
  }
});

test("closing the stream is explained in words", () => {
  assert.equal(closeReason(1000, true), null);
  assert.equal(closeReason(1006, true), null);             // finished before the close
  assert.match(closeReason(4401, false) ?? "", /sign-in/);
  assert.match(closeReason(4404, false) ?? "", /no longer exists/);
  assert.match(closeReason(1006, false) ?? "", /lost/);
});

test("floors and the drawing area come from the run's own map", () => {
  const map = { building_id: 1, edges: [], nodes: [
    { id: 1, name: "A", type: "ward", x: 0, y: 0, floor_id: 5, is_blocked: false },
    { id: 2, name: "B", type: "exit", x: 100, y: 50, floor_id: 3, is_blocked: false },
    { id: 3, name: "C", type: "stair", x: 10, y: 10, floor_id: 5, is_blocked: false },
  ] };
  assert.deepEqual(mapFloors(map), [3, 5]);
  const view = floorView([{ x: 0, y: 0 }, { x: 100, y: 50 }]);
  assert.equal(view.unit, 2);
  assert.deepEqual([view.x, view.y, view.width, view.height], [-8, -8, 116, 66]);
  assert.equal(floorView([{ x: 5, y: 5 }]).width > 0, true);   // one place still gets an area
  assert.equal(floorView([]).width, 100);
});

test("people at the same place are spread out, the same way every frame", () => {
  const a = spread("staff-1", 2);
  assert.deepEqual(spread("staff-1", 2), a);
  assert.notDeepEqual(spread("staff-2", 2), a);
  const distance = Math.hypot(a.dx, a.dy);
  assert.ok(distance >= 1.2 - 1e-9 && distance <= 3.0 + 1e-9);
});

test("clock and exit loads", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(65.4), "1:05");
  assert.equal(clock(3600), "60:00");
  const names = new Map([[9, "Exit 1"], [10, "Exit 2"]]);
  assert.deepEqual(exitLoadRows({ "9": 2, "10": 5, "11": 2 }, names),
                   [{ name: "Exit 2", people: 5 }, { name: "Exit 1", people: 2 }, { name: "Exit 11", people: 2 }]);
});
