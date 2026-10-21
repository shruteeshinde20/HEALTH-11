import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alongRoute, arrange, bounds, labelBox, labelSize, placeLabels, standingArea, passages, personSpots, placeBoxes, pointKey, scaleBarMetres, shownHazard,
  unitsPerMetre, wallPoint, wallSide, type PlanPath, type PlanPlace,
} from "../../src/lib/shared/floor-plan.ts";

const place = (id: number, type: string, x: number, y: number, size?: [number, number]): PlanPlace => ({
  id, name: `P${id}`, type, x, y, is_blocked: false,
  width_m: size ? size[0] : null, length_m: size ? size[1] : null,
});
const path = (id: number, a: number, b: number, distance: number, width = 2): PlanPath => ({
  id, from_node_id: a, to_node_id: b, distance, width, is_blocked: false,
});

test("a plan in metres is drawn at 1 unit per metre", () => {
  const places = [place(1, "corridor", 0, 0), place(2, "ward", 0, 8), place(3, "exit", 24, 0)];
  assert.equal(unitsPerMetre(places, [path(1, 1, 2, 8), path(2, 1, 3, 24)]), 1);
});

test("a plan drawn in pixels is measured from its paths (the typical ratio)", () => {
  const places = [place(1, "corridor", 0, 0), place(2, "corridor", 120, 0), place(3, "ward", 0, 50), place(4, "exit", 240, 0)];
  // 120 px for 24 m, 50 px for 10 m, 120 px for 24 m: 5 px per metre each.
  assert.equal(unitsPerMetre(places, [path(1, 1, 2, 24), path(2, 1, 3, 10), path(3, 2, 4, 24)]), 5);
});

test("no usable path means the scale is unknown", () => {
  assert.equal(unitsPerMetre([place(1, "ward", 0, 0), place(2, "exit", 0, 0)], [path(1, 1, 2, 5)]), null);
  assert.equal(unitsPerMetre([place(1, "ward", 0, 0), place(2, "exit", 5, 0)], [path(1, 1, 2, 0)]), null);
});

test("places with a size are drawn at that size", () => {
  const boxes = placeBoxes([place(1, "ward", 24, 22, [20, 12]), place(2, "corridor", 24, 30, [14, 3])], 1);
  assert.deepEqual(boxes.get(1), { cx: 24, cy: 22, w: 20, h: 12 });
  assert.deepEqual(placeBoxes([place(1, "ward", 0, 0, [20, 12])], 5).get(1), { cx: 0, cy: 0, w: 100, h: 60 });
});

test("places without a size get one from their type, never covering a close neighbour", () => {
  const far = placeBoxes([place(1, "ward", 0, 0), place(2, "exit", 100, 0)], 1);
  assert.deepEqual(far.get(1), { cx: 0, cy: 0, w: 16, h: 10 });           // ward default 16 x 10 m
  const close = placeBoxes([place(1, "ward", 0, 0), place(2, "room", 5, 0)], 1).get(1)!;
  assert.ok(close.w <= 4 + 1e-9 && Math.abs(close.w / close.h - 1.6) < 1e-9);   // 80% of 5 m, same shape
});

test("doors sit where the path leaves each room; touching rooms need no passage", () => {
  const box = { cx: 0, cy: 0, w: 10, h: 4 };
  assert.deepEqual(wallPoint(box, { x: 0, y: 20 }), { x: 0, y: 2 });
  assert.deepEqual(wallPoint(box, { x: -20, y: 0 }), { x: -5, y: 0 });
  assert.equal(wallSide(box, { x: 0, y: 2 }), "bottom");
  assert.equal(wallSide(box, { x: -5, y: 0 }), "left");

  const boxes = placeBoxes([place(1, "ward", 0, 0, [10, 4]), place(2, "corridor", 0, 10, [20, 2]),
                            place(3, "room", 0, -3, [4, 2])], 1);
  const [apart, touching] = passages([path(1, 1, 2, 10, 1.5), path(2, 1, 3, 3)], boxes, 1);
  assert.deepEqual([apart!.from, apart!.to, apart!.width], [{ x: 0, y: 2 }, { x: 0, y: 9 }, 1.5]);
  assert.deepEqual(touching!.from, touching!.to);
});

test("a room beside a corridor gets a straight door, not a slanted one", () => {
  // Corridor 34 m long at y = 30; a 6 x 6 m room below it, off to one side of the corridor's centre.
  const boxes = placeBoxes([place(1, "corridor", 48, 30, [34, 3]), place(2, "room", 42, 38, [6, 6])], 1);
  const [door] = passages([path(1, 1, 2, 10)], boxes, 1);
  assert.deepEqual([door!.doorA, door!.doorB], [{ x: 42, y: 31.5 }, { x: 42, y: 35 }]);
  assert.deepEqual(door!.route, [{ x: 48, y: 30 }, { x: 42, y: 31.5 }, { x: 42, y: 35 }, { x: 42, y: 38 }]);
  // Side by side: a horizontal door at the same height.
  const side = placeBoxes([place(1, "corridor", 0, 0, [10, 3]), place(2, "stair", 9, 0, [4, 4])], 1);
  const [stair] = passages([path(1, 1, 2, 9)], side, 1);
  assert.deepEqual([stair!.doorA, stair!.doorB], [{ x: 5, y: 0 }, { x: 7, y: 0 }]);
});

test("a share of the way along a route", () => {
  const route = [{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 6, y: 4 }];      // 4 m then 6 m
  assert.deepEqual(alongRoute(route, 0), { x: 0, y: 0 });
  assert.deepEqual(alongRoute(route, 0.2), { x: 0, y: 2 });
  assert.deepEqual(alongRoute(route, 0.7), { x: 3, y: 4 });
  assert.deepEqual(alongRoute(route, 1), { x: 6, y: 4 });
});

test("the drawing's bounds and a round scale bar", () => {
  assert.deepEqual(bounds([{ cx: 0, cy: 0, w: 10, h: 4 }, { cx: 20, cy: 10, w: 2, h: 2 }], 1),
                   { x: -6, y: -3, width: 28, height: 15 });
  assert.equal(bounds([]), null);
  assert.equal(scaleBarMetres(100, 1), 20);      // 100 m wide drawing: a 20 m bar
  assert.equal(scaleBarMetres(500, 5), 20);      // same drawing in pixels at 5 px per metre
  assert.equal(scaleBarMetres(30, 1), 5);
});

test("people at a place stand in rows inside its room, the same way every frame", () => {
  const spots = arrange(6, { cx: 0, cy: 0, w: 20, h: 12 }, 1);
  assert.equal(spots.length, 6);
  assert.equal(new Set(spots.map((p) => `${p.x},${p.y}`)).size, 6);                  // nobody on top of another
  assert.ok(spots.every((p) => Math.abs(p.x) <= 10 && Math.abs(p.y) <= 6));          // all inside the room
  assert.deepEqual(arrange(1, { cx: 5, cy: 5, w: 4, h: 4 }, 1), [{ x: 5, y: 5 }]);

  const room = { cx: 50, cy: 20, w: 20, h: 10 };
  const at = new Map([[pointKey({ x: 50, y: 20 }), room]]);
  const people = ["patient-10", "patient-2", "staff-1"].map((id) => ({ id, x: 50, y: 20 }));
  const first = personSpots(people, at, [], 1);
  const again = personSpots([...people].reverse(), at, [], 1);
  assert.deepEqual([...first.entries()].sort(), [...again.entries()].sort());       // order of arrival does not matter
  assert.equal(new Set([...first.values()].map((p) => `${p.x},${p.y}`)).size, 3);
});

test("people on their way walk through the doors, not through walls", () => {
  const boxes = placeBoxes([place(1, "corridor", 48, 30, [34, 3]), place(2, "room", 42, 38, [6, 6])], 1);
  const ways = passages([path(7, 1, 2, 10)], boxes, 1);
  // The stream puts someone halfway along the straight line from (48, 30) to (42, 38).
  const spot = personSpots([{ id: "staff-1", x: 45, y: 34 }], new Map(), ways, 1).get("staff-1")!;
  assert.deepEqual(spot, alongRoute(ways[0]!.route, 0.5));
  assert.ok(Math.abs(spot.x - 42) < 1e-9);          // halfway along the drawn route is in the doorway's line
  // Someone not on any path is drawn where the stream says.
  assert.deepEqual(personSpots([{ id: "p", x: 0, y: 0 }], new Map(), ways, 1).get("p"), { x: 0, y: 0 });
});

test("fire is shown before chemicals, structure and smoke", () => {
  assert.equal(shownHazard(["smoke", "fire"]), "fire");
  assert.equal(shownHazard(["smoke", "hazmat"]), "hazmat");
  assert.equal(shownHazard(["smoke"]), "smoke");
  assert.equal(shownHazard([]), null);
});

test("labels shrink to fit their room", () => {
  const big = labelSize("ICU", { cx: 0, cy: 0, w: 12, h: 12 }, 2, 0.6);
  const long = labelSize("Operating Theatre", { cx: 0, cy: 0, w: 12, h: 12 }, 2, 0.6);
  assert.equal(big, 2);
  assert.ok(long < big && long >= 0.6);
});

test("names go at the top of rooms, people stand below them; exit names go outside the building", () => {
  const places = [place(1, "ward", 24, 22, [20, 12]), place(2, "room", 42, 38, [2, 2]),
                  place(3, "exit", 84, 30, [2, 3]), place(4, "exit", 10, 38, [2, 3])];
  places[0]!.name = "Ward 1A";
  places[1]!.name = "Nurses Station 1";
  places[2]!.name = "East Exit";
  const boxes = placeBoxes(places, 1);
  const footprint = { x: 8, y: 14, width: 78, height: 32 };
  const labels = placeLabels(places, boxes, footprint, 1, 0.8);

  const ward = labels.get(1)!;
  assert.ok(ward.inside && ward.anchor === "middle" && ward.y < 22 && ward.y > 16);   // near the top, inside
  const area = standingArea(boxes.get(1)!, ward);
  assert.ok(area.cy > 22 && area.h < 12 && area.cy - area.h / 2 >= 16 + ward.band - 1e-9);

  const small = labels.get(2)!;                     // too long for a 2 m room: below it
  assert.ok(!small.inside && small.y > 39);
  assert.deepEqual(standingArea(boxes.get(2)!, small), boxes.get(2));

  const east = labels.get(3)!;                      // on the right wall: to the right, outside
  assert.equal(east.anchor, "start");
  assert.ok(east.x > footprint.x + footprint.width);
  const west = labels.get(4)!;                      // on the left wall: to the left, outside
  assert.equal(west.anchor, "end");
  assert.ok(west.x < footprint.x);
  const area4 = labelBox("Main Entrance Exit", west);
  assert.ok(area4.x + area4.w <= west.x + 1e-9 && area4.w > 0);
});
