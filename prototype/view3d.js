// HEALTH-11 prototype: 3D view of the building (three.js r185, served with the page).
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { rectOf, doorsOf, bounds } from "./layout.js";

export const LEVEL = 9; // metres between drawn floors (spread apart so every floor can be seen)
const WALL_H = 2.4;
const DOOR_W = 1.2;

export const COLOURS = {
  ground: 0xf8fafc,
  slab: 0xe2e8f0,
  room: 0xd6e9f8,
  corridor: 0xeef2f6,
  vertical: 0xfce9b2,
  exit: 0xbfe8d0,
  blocked: 0xf9c5c5,
  outline: 0x94a3b8,
  wall: 0xffffff,
  ink: 0x1e3a5f,
  fire: 0xdc2626,
  fireGlow: 0xea580c,
  smoke: 0x64748b,
  hazmat: 0xea580c,
  sensor: 0x94a3b8,
  sensorOn: 0xdc2626,
  camera: 0x1e3a5f,
  people: { staff: 0x1e3a5f, visitor: 0x64748b, ambulatory: 0x2563eb, wheelchair: 0x7c3aed, stretcher: 0xc2410c, ventilator: 0xbe185d },
};

function floorColour(type) {
  if (type === "corridor") return COLOURS.corridor;
  if (type === "stair" || type === "ramp" || type === "lift") return COLOURS.vertical;
  if (type === "exit" || type === "assembly") return COLOURS.exit;
  return COLOURS.room;
}

function labelSprite(text, { colour = "#1E3A5F", size = 1, weight = 600 } = {}) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const px = 44;
  ctx.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  c.width = w;
  c.height = px + 24;
  ctx.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  const r = 14;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, c.height, r);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 14, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true });
  const s = new THREE.Sprite(mat);
  const h = 1.5 * size;
  s.scale.set((h * w) / c.height, h, 1);
  s.renderOrder = 10;
  return s;
}

export function createView3D(container, model) {
  const b = bounds(model);
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.y0 + b.y1) / 2;
  const floors = model.floors;
  const lowest = floors[0];
  const toWorld = (x, y, floor) => new THREE.Vector3(x - cx, (floor - lowest) * LEVEL, y - cz);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-label", "3D view of the building");
  renderer.domElement.setAttribute("role", "img");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9eff5);

  const span = Math.max(b.x1 - b.x0, b.y1 - b.y0);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 1500);
  const controls = new OrbitControls(camera, renderer.domElement);
  // Frame the whole building (or the chosen floor) from above and to the south-west.
  const home = () => {
    const top = floorFilter === null ? floors[floors.length - 1] : floorFilter;
    const midY = floorFilter === null ? ((floors.length - 1) * LEVEL) / 2 : (floorFilter - lowest) * LEVEL;
    const aspect = Math.max(0.5, camera.aspect || 1);
    const half = (Math.max(b.x1 - b.x0, (b.y1 - b.y0) * 1.4) / 2) * 0.82;
    const dist = half / Math.tan((camera.fov * Math.PI) / 360) / Math.min(1, aspect) + (top - lowest) * LEVEL * 0.6;
    const dir = new THREE.Vector3(-0.28, 0.78, 0.86).normalize();
    controls.target.set(0, midY, 0);
    camera.position.copy(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, midY, 0));
    camera.updateProjectionMatrix();
  };
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 8;
  controls.maxDistance = 400;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x94a3b8, 1.25));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(-40, 90, 50);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -span;
  sc.right = span;
  sc.top = span;
  sc.bottom = -span;
  sc.far = 300;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // Ground and site
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 6, span * 6), new THREE.MeshStandardMaterial({ color: 0xdfe7ee, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.31;
  ground.receiveShadow = true;
  scene.add(ground);

  let floorFilter = null;
  const floorGroups = new Map();
  for (const f of floors) {
    const g = new THREE.Group();
    g.userData.floor = f;
    scene.add(g);
    floorGroups.set(f, g);
  }

  // Floor slabs (under the places of each floor)
  for (const f of floors) {
    const ns = model.nodes.filter((n) => n.floor === f && n.type !== "assembly");
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const n of ns) {
      const r = rectOf(n);
      x0 = Math.min(x0, r.x0);
      x1 = Math.max(x1, r.x1);
      y0 = Math.min(y0, r.y0);
      y1 = Math.max(y1, r.y1);
    }
    const slab = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 2, 0.3, y1 - y0 + 2), new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.9, transparent: true, opacity: 0.7 }));
    slab.position.copy(toWorld((x0 + x1) / 2, (y0 + y1) / 2, f));
    slab.position.y -= 0.16;
    slab.receiveShadow = true;
    slab.castShadow = true;
    floorGroups.get(f).add(slab);
    const tag = labelSprite(f === 0 ? "Ground floor" : `Floor ${f}`, { size: 1.6, weight: 700 });
    tag.position.copy(toWorld(x0 - 1, y1 + 2, f));
    tag.position.y += 0.6;
    floorGroups.get(f).add(tag);
  }

  // Place floors (one instanced mesh, coloured per place)
  const tileGeo = new THREE.BoxGeometry(1, 0.06, 1);
  const tileMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
  const tiles = new THREE.InstancedMesh(tileGeo, tileMat, model.nodes.length);
  tiles.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  const colour = new THREE.Color();
  model.nodes.forEach((n, i) => {
    const p = toWorld(n.x, n.y, n.floor);
    m4.compose(new THREE.Vector3(p.x, p.y + 0.03, p.z), new THREE.Quaternion(), new THREE.Vector3(n.w - 0.08, 1, n.l - 0.08));
    tiles.setMatrixAt(i, m4);
    tiles.setColorAt(i, colour.setHex(n.blocked ? COLOURS.blocked : floorColour(n.type)));
  });
  scene.add(tiles);

  // Walls with door gaps
  const doors = model.nodes.map(() => []);
  for (const e of model.edges) {
    if (e.virtual || e.kind !== "flat") continue;
    const d = doorsOf(model, e);
    if (d.length === 2) {
      doors[e.u].push(d[0]);
      doors[e.v].push(d[1]);
    }
  }
  const wallSegs = [];
  const outlinePts = [];
  for (const n of model.nodes) {
    if (n.type === "exit" || n.type === "assembly") continue;
    const r = rectOf(n);
    const sides = [
      { a: [r.x0, r.y0], b: [r.x1, r.y0], axis: "x", fixed: r.y0 },
      { a: [r.x0, r.y1], b: [r.x1, r.y1], axis: "x", fixed: r.y1 },
      { a: [r.x0, r.y0], b: [r.x0, r.y1], axis: "y", fixed: r.x0 },
      { a: [r.x1, r.y0], b: [r.x1, r.y1], axis: "y", fixed: r.x1 },
    ];
    for (const s of sides) {
      const lo = s.axis === "x" ? s.a[0] : s.a[1];
      const hi = s.axis === "x" ? s.b[0] : s.b[1];
      const gaps = doors[n.i]
        .filter((d) => Math.abs((s.axis === "x" ? d[1] : d[0]) - s.fixed) < 0.05)
        .map((d) => (s.axis === "x" ? d[0] : d[1]))
        .sort((p, q) => p - q);
      let start = lo;
      const pieces = [];
      for (const g of gaps) {
        if (g - DOOR_W / 2 > start) pieces.push([start, g - DOOR_W / 2]);
        start = Math.max(start, g + DOOR_W / 2);
      }
      if (hi > start) pieces.push([start, hi]);
      for (const [p0, p1] of pieces) {
        if (p1 - p0 < 0.05) continue;
        wallSegs.push({ n, axis: s.axis, fixed: s.fixed, p0, p1 });
      }
    }
    const y = (n.floor - lowest) * LEVEL + WALL_H;
    outlinePts.push(
      [r.x0, y, r.y0], [r.x1, y, r.y0], [r.x1, y, r.y0], [r.x1, y, r.y1],
      [r.x1, y, r.y1], [r.x0, y, r.y1], [r.x0, y, r.y1], [r.x0, y, r.y0],
    );
  }
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5, transparent: true, opacity: 0.78 });
  const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wallMat, Math.max(1, wallSegs.length));
  walls.castShadow = true;
  walls.receiveShadow = true;
  const wallFloor = [];
  wallSegs.forEach((w, i) => {
    const len = w.p1 - w.p0;
    const mid = (w.p0 + w.p1) / 2;
    const p = w.axis === "x" ? toWorld(mid, w.fixed, w.n.floor) : toWorld(w.fixed, mid, w.n.floor);
    const size = w.axis === "x" ? new THREE.Vector3(len, WALL_H, 0.14) : new THREE.Vector3(0.14, WALL_H, len);
    m4.compose(new THREE.Vector3(p.x, p.y + WALL_H / 2, p.z), new THREE.Quaternion(), size);
    walls.setMatrixAt(i, m4);
    wallFloor.push(w.n.floor);
  });
  walls.count = wallSegs.length;
  scene.add(walls);
  const outline = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(outlinePts.map(([x, y, z]) => new THREE.Vector3(x - cx, y, z - cz))),
    new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.9 }),
  );
  scene.add(outline);

  // Stairs: steps rising to the floor above inside each stair place with a link upward
  const stepMat = new THREE.MeshStandardMaterial({ color: 0xf3d98a, roughness: 0.7 });
  for (const e of model.edges) {
    if (e.kind !== "stair") continue;
    const lo = model.nodes[e.u].floor < model.nodes[e.v].floor ? model.nodes[e.u] : model.nodes[e.v];
    const hi = lo === model.nodes[e.u] ? model.nodes[e.v] : model.nodes[e.u];
    const steps = 12;
    const rise = ((hi.floor - lo.floor) * LEVEL) / steps;
    const run = (lo.l - 0.4) / steps;
    const g = floorGroups.get(lo.floor);
    for (let k = 0; k < steps; k++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(lo.w * 0.45, rise * (k + 1), run), stepMat);
      const p = toWorld(lo.x - lo.w * 0.22, lo.y - lo.l / 2 + 0.2 + run * (k + 0.5), lo.floor);
      s.position.set(p.x, p.y + (rise * (k + 1)) / 2, p.z);
      s.castShadow = true;
      s.receiveShadow = true;
      g.add(s);
    }
  }

  // Lift shafts
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0xfce9b2, transparent: true, opacity: 0.28, roughness: 0.3 });
  const shaftDone = new Set();
  for (const n of model.nodes) {
    if (n.type !== "lift" || shaftDone.has(`${n.x},${n.y}`)) continue;
    shaftDone.add(`${n.x},${n.y}`);
    const same = model.nodes.filter((m) => m.type === "lift" && m.x === n.x && m.y === n.y);
    const f0 = Math.min(...same.map((m) => m.floor));
    const f1 = Math.max(...same.map((m) => m.floor));
    const h = (f1 - f0) * LEVEL + WALL_H;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(n.w * 0.8, h, n.l * 0.8), shaftMat);
    const p = toWorld(n.x, n.y, f0);
    shaft.position.set(p.x, p.y + h / 2, p.z);
    scene.add(shaft);
  }

  // Labels
  const labels = new THREE.Group();
  for (const n of model.nodes) {
    if (n.type === "corridor" || (n.type === "stair" && n.w < 3) || n.type === "lift") continue;
    const isExit = n.type === "exit";
    const s = labelSprite(isExit ? `EXIT · ${n.id}` : n.id, { colour: isExit ? "#166534" : "#1E3A5F", size: isExit ? 1.1 : 0.9 });
    const p = toWorld(n.x, n.y, n.floor);
    s.position.set(p.x, p.y + WALL_H + 0.9, p.z);
    s.userData.floor = n.floor;
    labels.add(s);
  }
  scene.add(labels);

  // Sensors (ceiling discs) and cameras
  const sensorMeshes = new Map();
  const sensorGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.12, 20);
  model.sensors.forEach((s, k) => {
    const n = model.nodes[s.node];
    const mat = new THREE.MeshStandardMaterial({ color: COLOURS.sensor, emissive: 0x000000 });
    const m = new THREE.Mesh(sensorGeo, mat);
    const off = ((k % 3) - 1) * 0.9;
    const p = toWorld(n.x + off, n.y - n.l / 2 + 0.8, n.floor);
    m.position.set(p.x, p.y + WALL_H - 0.1, p.z);
    m.userData.floor = n.floor;
    sensorMeshes.set(s.id, m);
    scene.add(m);
  });
  const camGeo = new THREE.BoxGeometry(0.5, 0.3, 0.3);
  for (const c of model.cameras) {
    const n = model.nodes[c.node];
    const m = new THREE.Mesh(camGeo, new THREE.MeshStandardMaterial({ color: COLOURS.camera }));
    const p = toWorld(n.x + n.w / 2 - 0.5, n.y - n.l / 2 + 0.4, n.floor);
    m.position.set(p.x, p.y + WALL_H - 0.3, p.z);
    m.userData.floor = n.floor;
    scene.add(m);
  }

  // Hazards: one volume per place, shown when the hazard has reached it
  const hazardGroup = new THREE.Group();
  scene.add(hazardGroup);
  const fireMat = new THREE.MeshStandardMaterial({ color: COLOURS.fire, emissive: COLOURS.fireGlow, emissiveIntensity: 1.2, transparent: true, opacity: 0.5, depthWrite: false });
  const smokeMat = new THREE.MeshStandardMaterial({ color: COLOURS.smoke, transparent: true, opacity: 0.32, depthWrite: false, roughness: 1 });
  const thickSmokeMat = new THREE.MeshStandardMaterial({ color: 0x475569, transparent: true, opacity: 0.5, depthWrite: false, roughness: 1 });
  const hazmatMat = new THREE.MeshStandardMaterial({ color: COLOURS.hazmat, transparent: true, opacity: 0.35, depthWrite: false });
  const hazardBox = new THREE.BoxGeometry(1, 1, 1);
  const flameGeo = new THREE.ConeGeometry(0.32, 1.3, 9);
  const flameMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xea580c, emissiveIntensity: 1.6, transparent: true, opacity: 0.9, depthWrite: false });
  const flameCoreMat = new THREE.MeshStandardMaterial({ color: 0xfde68a, emissive: 0xf59e0b, emissiveIntensity: 1.8, transparent: true, opacity: 0.95, depthWrite: false });
  const hazardMeshes = new Map();
  const fireLights = [];

  // People: body + head, plus beds and wheelchairs for assisted groups
  const maxPeople = Math.max(1, model.people.length + model.cameras.reduce((s, c) => s + c.count, 0) + 2000);
  const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.55 });
  const bodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.22, 0.85, 4, 10), bodyMat, maxPeople);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 14, 10), new THREE.MeshStandardMaterial({ color: 0xf1d3b8, roughness: 0.7 }), maxPeople);
  const beds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.95, 0.55, 2.0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }), maxPeople);
  const chairs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 0.55, 0.75), new THREE.MeshStandardMaterial({ color: 0x7c3aed, roughness: 0.6 }), maxPeople);
  for (const im of [bodies, heads, beds, chairs]) {
    im.castShadow = true;
    im.count = 0;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(im);
  }
  const markers = new THREE.InstancedMesh(new THREE.TorusGeometry(0.55, 0.06, 6, 24), new THREE.MeshBasicMaterial({ color: 0xdc2626 }), maxPeople);
  markers.count = 0;
  scene.add(markers);

  let showLabels = true;
  let hazardKey = "";
  let last = { positions: new Map(), people: [], heading: new Map() };

  const visibleFloor = (f) => floorFilter === null || f <= floorFilter;

  function applyFilter() {
    for (const [f, g] of floorGroups) g.visible = visibleFloor(f);
    tiles.count = model.nodes.length;
    model.nodes.forEach((n, i) => {
      const p = toWorld(n.x, n.y, n.floor);
      const s = visibleFloor(n.floor) ? new THREE.Vector3(n.w - 0.08, 1, n.l - 0.08) : new THREE.Vector3(0.0001, 0.0001, 0.0001);
      m4.compose(new THREE.Vector3(p.x, p.y + 0.03, p.z), new THREE.Quaternion(), s);
      tiles.setMatrixAt(i, m4);
    });
    tiles.instanceMatrix.needsUpdate = true;
    wallSegs.forEach((w, i) => {
      const len = w.p1 - w.p0;
      const mid = (w.p0 + w.p1) / 2;
      const p = w.axis === "x" ? toWorld(mid, w.fixed, w.n.floor) : toWorld(w.fixed, mid, w.n.floor);
      const vis = visibleFloor(wallFloor[i]);
      const size = vis ? (w.axis === "x" ? new THREE.Vector3(len, WALL_H, 0.14) : new THREE.Vector3(0.14, WALL_H, len)) : new THREE.Vector3(0.0001, 0.0001, 0.0001);
      m4.compose(new THREE.Vector3(p.x, p.y + WALL_H / 2, p.z), new THREE.Quaternion(), size);
      walls.setMatrixAt(i, m4);
    });
    walls.instanceMatrix.needsUpdate = true;
    const pts = [];
    for (const n of model.nodes) {
      if (n.type === "exit" || n.type === "assembly" || !visibleFloor(n.floor)) continue;
      const r = rectOf(n);
      const y = (n.floor - lowest) * LEVEL + WALL_H;
      pts.push([r.x0, y, r.y0], [r.x1, y, r.y0], [r.x1, y, r.y0], [r.x1, y, r.y1], [r.x1, y, r.y1], [r.x0, y, r.y1], [r.x0, y, r.y1], [r.x0, y, r.y0]);
    }
    outline.geometry.dispose();
    outline.geometry = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y, z]) => new THREE.Vector3(x - cx, y, z - cz)));
    for (const s of labels.children) s.visible = showLabels && visibleFloor(s.userData.floor);
    for (const m of sensorMeshes.values()) m.visible = visibleFloor(m.userData.floor);
    scene.traverse((o) => {
      if (o.isMesh && o.userData.floor !== undefined && o.parent === scene) o.visible = visibleFloor(o.userData.floor);
    });
    hazardKey = "";
  }

  function setHazards(hazardState, model2 = model) {
    const key = JSON.stringify(hazardState.map((h) => [h.type, h.severity, h.places.length]));
    if (key === hazardKey) return;
    hazardKey = key;
    for (const m of hazardMeshes.values()) hazardGroup.remove(m);
    hazardMeshes.clear();
    for (const l of fireLights) scene.remove(l);
    fireLights.length = 0;
    const fireAt = new Set();
    for (const h of hazardState) {
      for (const n of h.places) {
        const node = model2.nodes[n];
        if (!visibleFloor(node.floor)) continue;
        const k = `${h.type}:${n}`;
        if (hazardMeshes.has(k)) continue;
        let mat = smokeMat;
        let height = WALL_H * 0.9;
        let y0 = 0.05;
        if (h.type === "fire") {
          mat = fireMat;
          height = 1.1;
          fireAt.add(n);
        } else if (h.type === "smoke") {
          mat = h.severity >= 4 ? thickSmokeMat : smokeMat;
          height = h.severity >= 4 ? WALL_H * 0.95 : WALL_H * 0.45;
          y0 = WALL_H - height;
        } else if (h.type === "hazmat") {
          mat = hazmatMat;
          height = 0.35;
        } else {
          mat = thickSmokeMat;
          height = 0.6;
        }
        const m = new THREE.Mesh(hazardBox, mat);
        const p = toWorld(node.x, node.y, node.floor);
        m.scale.set(node.w - 0.3, height, node.l - 0.3);
        m.position.set(p.x, p.y + y0 + height / 2, p.z);
        m.userData.type = h.type;
        m.renderOrder = 5;
        hazardGroup.add(m);
        hazardMeshes.set(k, m);
        if (h.type === "fire") {
          // Flames scattered over the burning place (fixed pattern per place).
          const count = Math.max(2, Math.min(7, Math.round((node.w * node.l) / 12)));
          for (let f = 0; f < count; f++) {
            const a = (f * 2.399 + n) % (Math.PI * 2);
            const r = 0.35 * Math.sqrt((f + 0.5) / count);
            const fx = node.x + Math.cos(a) * r * (node.w - 0.8);
            const fy = node.y + Math.sin(a) * r * (node.l - 0.8);
            const fp = toWorld(fx, fy, node.floor);
            const flame = new THREE.Mesh(flameGeo, f % 3 === 0 ? flameCoreMat : flameMat);
            flame.position.set(fp.x, fp.y + 0.7, fp.z);
            flame.userData.type = "flame";
            flame.userData.phase = f * 1.7 + n;
            flame.renderOrder = 6;
            hazardGroup.add(flame);
            hazardMeshes.set(`${k}:flame${f}`, flame);
          }
        }
      }
    }
    // A few warm lights where fire is (kept small for speed)
    for (const n of [...fireAt].slice(0, 6)) {
      const node = model2.nodes[n];
      const l = new THREE.PointLight(0xff6a2b, 30, 18, 2);
      const p = toWorld(node.x, node.y, node.floor);
      l.position.set(p.x, p.y + 1.6, p.z);
      scene.add(l);
      fireLights.push(l);
    }
  }

  function setSensors(fired) {
    for (const [id, m] of sensorMeshes) {
      const on = fired.has(id);
      m.material.color.setHex(on ? COLOURS.sensorOn : COLOURS.sensor);
      m.material.emissive.setHex(on ? 0x991b1b : 0x000000);
    }
  }

  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  // positions: id -> [x, y, floor]; people: snapshot list (kind, mobility, helpers, state)
  function setPeople(positions, people, prev) {
    let nb = 0;
    let nBed = 0;
    let nChair = 0;
    let nMark = 0;
    for (const s of people) {
      const pos = positions.get(s.id);
      if (!pos || !visibleFloor(Math.round(pos[2]))) continue;
      const before = prev?.get(s.id) ?? pos;
      const dx = pos[0] - before[0];
      const dz = pos[1] - before[1];
      let heading = last.heading.get(s.id) ?? 0;
      if (Math.hypot(dx, dz) > 0.02) heading = Math.atan2(dx, dz);
      last.heading.set(s.id, heading);
      q.setFromAxisAngle(up, heading);
      const w = toWorld(pos[0], pos[1], pos[2]);
      const group = s.mobility !== "ambulatory" && s.kind === "patient";
      const colourHex = s.kind === "staff" ? COLOURS.people.staff : s.kind === "visitor" ? COLOURS.people.visitor : COLOURS.people[s.mobility];
      if (group && (s.mobility === "stretcher" || s.mobility === "ventilator")) {
        m4.compose(new THREE.Vector3(w.x, w.y + 0.3, w.z), q, new THREE.Vector3(1, 1, 1));
        beds.setMatrixAt(nBed, m4);
        beds.setColorAt(nBed, colour.setHex(colourHex).lerp(new THREE.Color(0xffffff), 0.55));
        nBed++;
        // staff around the bed
        for (let k = 0; k < s.helpers; k++) {
          const side = k % 2 === 0 ? 1 : -1;
          const off = new THREE.Vector3(side * 0.75, 0, (k < 2 ? 0.6 : -0.6)).applyQuaternion(q);
          m4.compose(new THREE.Vector3(w.x + off.x, w.y + 0.65, w.z + off.z), q, new THREE.Vector3(1, 1, 1));
          bodies.setMatrixAt(nb, m4);
          bodies.setColorAt(nb, colour.setHex(COLOURS.people.staff));
          m4.compose(new THREE.Vector3(w.x + off.x, w.y + 1.42, w.z + off.z), q, new THREE.Vector3(1, 1, 1));
          heads.setMatrixAt(nb, m4);
          nb++;
        }
      } else if (group && s.mobility === "wheelchair") {
        m4.compose(new THREE.Vector3(w.x, w.y + 0.28, w.z), q, new THREE.Vector3(1, 1, 1));
        chairs.setMatrixAt(nChair, m4);
        nChair++;
        m4.compose(new THREE.Vector3(w.x, w.y + 0.85, w.z), q, new THREE.Vector3(0.9, 0.6, 0.9));
        bodies.setMatrixAt(nb, m4);
        bodies.setColorAt(nb, colour.setHex(colourHex));
        m4.compose(new THREE.Vector3(w.x, w.y + 1.3, w.z), q, new THREE.Vector3(1, 1, 1));
        heads.setMatrixAt(nb, m4);
        nb++;
        for (let k = 0; k < s.helpers; k++) {
          const off = new THREE.Vector3(0, 0, -0.75 - k * 0.5).applyQuaternion(q);
          m4.compose(new THREE.Vector3(w.x + off.x, w.y + 0.65, w.z + off.z), q, new THREE.Vector3(1, 1, 1));
          bodies.setMatrixAt(nb, m4);
          bodies.setColorAt(nb, colour.setHex(COLOURS.people.staff));
          m4.compose(new THREE.Vector3(w.x + off.x, w.y + 1.42, w.z + off.z), q, new THREE.Vector3(1, 1, 1));
          heads.setMatrixAt(nb, m4);
          nb++;
        }
      } else {
        m4.compose(new THREE.Vector3(w.x, w.y + 0.65, w.z), q, new THREE.Vector3(1, 1, 1));
        bodies.setMatrixAt(nb, m4);
        bodies.setColorAt(nb, colour.setHex(colourHex));
        m4.compose(new THREE.Vector3(w.x, w.y + 1.42, w.z), q, new THREE.Vector3(1, 1, 1));
        heads.setMatrixAt(nb, m4);
        nb++;
      }
      if (s.state === "reached" || s.state === "stuck_wait" || s.state === "needsHelp") {
        const red = s.state === "reached";
        m4.compose(new THREE.Vector3(w.x, w.y + 0.08, w.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), new THREE.Vector3(1, 1, 1));
        markers.setMatrixAt(nMark, m4);
        markers.setColorAt(nMark, colour.setHex(red ? 0xdc2626 : s.state === "needsHelp" ? 0xea580c : 0x7c3aed));
        nMark++;
      }
    }
    bodies.count = nb;
    heads.count = nb;
    beds.count = nBed;
    chairs.count = nChair;
    markers.count = nMark;
    for (const im of [bodies, heads, beds, chairs, markers]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  function resize() {
    const w = container.clientWidth || 600;
    const h = container.clientHeight || 400;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!framed) {
      framed = true;
      home();
    }
  }
  let framed = false;
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let running = true;
  let onFrame = null;
  const started = performance.now();
  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    const t = (performance.now() - started) / 1000;
    if (onFrame) onFrame();
    for (const m of hazardGroup.children) {
      if (m.userData.type === "fire") m.material.emissiveIntensity = 1 + 0.35 * Math.sin(t * 9 + m.position.x);
      if (m.userData.type === "flame") {
        const s = 0.8 + 0.25 * Math.sin(t * 11 + m.userData.phase) + 0.1 * Math.sin(t * 23 + m.userData.phase * 2);
        m.scale.set(1, s, 1);
        m.position.y = Math.floor(m.position.y / LEVEL + 0.01) * LEVEL + 0.65 * s;
      }
    }
    for (const l of fireLights) l.intensity = 26 + 8 * Math.sin(t * 13 + l.position.z);
    controls.update();
    renderer.render(scene, camera);
  }
  loop();

  return {
    setFloor(f) {
      floorFilter = f;
      applyFilter();
      home();
    },
    setLabels(on) {
      showLabels = on;
      applyFilter();
    },
    setHazards,
    setSensors,
    setPeople,
    onFrame(fn) {
      onFrame = fn;
    },
    resetCamera() {
      home();
      controls.target.set(0, ((floors.length - 1) * LEVEL) / 2, 0);
    },
    dispose() {
      running = false;
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
    canvas: renderer.domElement,
  };
}
