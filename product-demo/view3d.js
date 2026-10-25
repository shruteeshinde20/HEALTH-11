// Realistic 3D view of the building (three.js r185, served with the page).
// Everything is built from simple shapes in code: rooms with walls, doors and
// windows, furniture, human figures that walk, beds and wheelchairs pushed by
// staff, soft smoke, fire, the site outside and an automatic camera tour.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { rectOf, doorsOf, bounds, edgePolyline, furnitureFor, isOuterSide } from "./layout.js";

const WALL_H = 3.0;
const SILL = 0.9;
const HEAD = 2.3;
const DOOR_W = 1.2;

// ---------------------------------------------------------------- textures
function canvasTexture(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 4;
  return t;
}
function tiles(base, line, n = 4) {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(0,0,0,${Math.random() * 0.025})`;
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    g.strokeStyle = line;
    g.lineWidth = 2;
    for (let k = 0; k <= n; k++) {
      g.beginPath();
      g.moveTo((k * w) / n, 0);
      g.lineTo((k * w) / n, h);
      g.moveTo(0, (k * h) / n);
      g.lineTo(w, (k * h) / n);
      g.stroke();
    }
  });
}
function grass() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = "#8DAF6B";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const v = Math.random();
      g.fillStyle = v < 0.5 ? "rgba(90,130,60,0.35)" : "rgba(170,200,120,0.3)";
      g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 3);
    }
  }, [40, 40]);
}
function asphalt() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = "#6B7075";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3000; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? "255,255,255" : "0,0,0"},${Math.random() * 0.08})`;
      g.fillRect(Math.random() * w, Math.random() * h, 1, 1);
    }
  }, [12, 2]);
}
function softDot(inner, outer) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function textSprite(text, { colour = "#14231C", bg = "rgba(255,255,255,0.88)", size = 1, weight = 600 } = {}) {
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  const px = 44;
  g.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = w;
  c.height = px + 22;
  g.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(0, 0, w, c.height, 12);
  g.fill();
  g.fillStyle = colour;
  g.textBaseline = "middle";
  g.fillText(text, 14, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  const h = 1.3 * size;
  s.scale.set((h * w) / c.height, h, 1);
  s.renderOrder = 10;
  return s;
}

// ---------------------------------------------------------------- colours
export const SKIN = [0x8d5524, 0xa0673e, 0xc68642, 0xb07a52, 0x7a4a2a, 0xd29b6c];
const CLOTHES = [0x7f8c8d, 0x8e44ad, 0xc0392b, 0x2c3e50, 0xd35400, 0x16a085, 0x6d4c41, 0x34495e, 0xb7950b, 0x1f618d];
export const ROLE_COLOUR = { nurse: 0x2e8b9a, doctor: 0xf4f6f6, porter: 0x5d6d7e, staff: 0x2e8b9a, patient: 0x9cc9e8, rescue: 0xd4a017 };

function floorMaterial(n, mats) {
  if (n.type === "corridor") return mats.corridor;
  if (n.type === "stair" || n.type === "lift") return mats.core;
  if (n.type === "exit") return mats.exit;
  if (n.refuge) return mats.refuge;
  if (n.type === "icu" || n.type === "ward") return mats.ward;
  return mats.room;
}

export function createView3D(container, model, { siteName = "" } = {}) {
  const b = bounds(model);
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.y0 + b.y1) / 2;
  const floors = model.floors;
  const lowest = floors[0];
  let exploded = true;
  let level = 7.5; // drawn metres between floors (exploded); 4.2 when not
  const fy = (f) => (f - lowest) * level;
  const W = (x, y, f) => new THREE.Vector3(x - cx, fy(f), y - cz);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-label", "3D view of the building");
  renderer.domElement.setAttribute("role", "img");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfe3f2);
  scene.fog = new THREE.Fog(0xcfe3f2, 260, 620);
  const span = Math.max(b.x1 - b.x0, b.y1 - b.y0);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.3, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 4;
  controls.maxDistance = 420;

  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x8a8f7a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.3);
  sun.position.set(-60, 120, 70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, far: 400 });
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  const mats = {
    corridor: new THREE.MeshStandardMaterial({ map: tiles("#DCE3DE", "#C9D2CC", 6), roughness: 0.55 }),
    ward: new THREE.MeshStandardMaterial({ map: tiles("#E4ECF2", "#D0DAE2", 5), roughness: 0.6 }),
    room: new THREE.MeshStandardMaterial({ map: tiles("#EEEAE4", "#DCD6CE", 5), roughness: 0.65 }),
    refuge: new THREE.MeshStandardMaterial({ map: tiles("#DCEFE3", "#C4E0CE", 5), roughness: 0.6 }),
    core: new THREE.MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.8 }),
    exit: new THREE.MeshStandardMaterial({ color: 0x9fd3b0, roughness: 0.7 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xf7f7f4, roughness: 0.85 }),
    outer: new THREE.MeshStandardMaterial({ color: 0xe9e2d6, roughness: 0.8 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9fc6de, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35, depthWrite: false }),
    slab: new THREE.MeshStandardMaterial({ color: 0xbfc5c2, roughness: 0.9 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x9aa3a8, roughness: 0.4, metalness: 0.5 }),
    mattress: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
    sheet: new THREE.MeshStandardMaterial({ color: 0xbfd8ee, roughness: 0.95 }),
    wood: new THREE.MeshStandardMaterial({ color: 0xb08a64, roughness: 0.7 }),
    chair: new THREE.MeshStandardMaterial({ color: 0x3f6f8f, roughness: 0.6 }),
    machine: new THREE.MeshStandardMaterial({ color: 0xdfe4e6, roughness: 0.45, metalness: 0.2 }),
    screen: new THREE.MeshStandardMaterial({ color: 0x0f2a33, emissive: 0x1f8a70, emissiveIntensity: 0.6 }),
    shelf: new THREE.MeshStandardMaterial({ color: 0xc7ccd0, roughness: 0.6, metalness: 0.3 }),
  };

  // ------------------------------------------------------------ site
  const site = new THREE.Group();
  scene.add(site);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshStandardMaterial({ map: grass(), roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.36;
  ground.receiveShadow = true;
  site.add(ground);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(260, 14), new THREE.MeshStandardMaterial({ map: asphalt(), roughness: 0.95 }));
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, -0.33, b.y1 - cz + 16);
  road.receiveShadow = true;
  site.add(road);
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(260, 0.25), new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }));
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(0, -0.32, b.y1 - cz + 16);
  site.add(lane);
  const plaza = new THREE.Mesh(new THREE.PlaneGeometry(b.x1 - b.x0 + 16, 8), new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.9 }));
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(0, -0.34, b.y1 - cz + 5);
  plaza.receiveShadow = true;
  site.add(plaza);
  // trees
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0x6b4f35 }), 80);
  const crown = new THREE.InstancedMesh(new THREE.SphereGeometry(1.8, 10, 8), new THREE.MeshStandardMaterial({ color: 0x4f7f3a, roughness: 0.9 }), 80);
  const m4 = new THREE.Matrix4();
  const q0 = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const colour = new THREE.Color();
  let t = 0;
  const rnd = (() => {
    let a = 7;
    return () => ((a = (a * 16807) % 2147483647) / 2147483647);
  })();
  for (let k = 0; k < 80; k++) {
    const sideK = k % 4;
    let x;
    let z;
    if (sideK === 0) [x, z] = [-80 + rnd() * 160, b.y0 - cz - 10 - rnd() * 30];
    else if (sideK === 1) [x, z] = [b.x0 - cx - 12 - rnd() * 30, -40 + rnd() * 80];
    else if (sideK === 2) [x, z] = [b.x1 - cx + 12 + rnd() * 30, -40 + rnd() * 80];
    else [x, z] = [-90 + rnd() * 180, b.y1 - cz + 28 + rnd() * 25];
    const s = 0.8 + rnd() * 0.7;
    m4.compose(new THREE.Vector3(x, 0.85 * s - 0.36, z), q0, new THREE.Vector3(s, s, s));
    trunk.setMatrixAt(t, m4);
    m4.compose(new THREE.Vector3(x, 2.9 * s - 0.36, z), q0, new THREE.Vector3(s, s * 1.15, s));
    crown.setMatrixAt(t, m4);
    crown.setColorAt(t, colour.setHex([0x4f7f3a, 0x5d8c3f, 0x41702f][k % 3]));
    t++;
  }
  trunk.castShadow = crown.castShadow = true;
  site.add(trunk, crown);
  // entrance canopy, sign and ambulance
  const main = model.nodes.find((n) => n.id === "Main Entrance") ?? model.nodes.find((n) => n.type === "exit");
  if (main) {
    const p = W(main.x, main.y, main.floor);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(10, 0.3, 5), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }));
    canopy.position.set(p.x, 3.4, p.z + 1.5);
    canopy.castShadow = true;
    site.add(canopy);
    for (const dx of [-4.6, 4.6]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.4, 8), mats.frame);
      post.position.set(p.x + dx, 1.5, p.z + 3.6);
      site.add(post);
    }
    if (siteName) {
      const board = textSprite(siteName.toUpperCase(), { colour: "#ffffff", bg: "rgba(11,92,140,0.95)", size: 1.6, weight: 700 });
      board.position.set(p.x, 4.7, p.z + 2.2);
      site.add(board);
    }
  }
  const amb = model.nodes.find((n) => n.id === "Ambulance Bay");
  if (amb) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 5), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
    body.position.y = 1.3;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.22, 0.3, 5.02), new THREE.MeshStandardMaterial({ color: 0xc0392b }));
    stripe.position.y = 1.2;
    const light = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 0.3), new THREE.MeshStandardMaterial({ color: 0x2e86de, emissive: 0x2e86de, emissiveIntensity: 1 }));
    light.position.set(0, 2.5, 1.8);
    g.add(body, stripe, light);
    for (const [wx, wz] of [[-1.1, -1.6], [1.1, -1.6], [-1.1, 1.6], [1.1, 1.6]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 14), new THREE.MeshStandardMaterial({ color: 0x222222 }));
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, 0.4, wz);
      g.add(wheel);
    }
    const p = W(amb.x, amb.y, amb.floor);
    g.position.set(p.x + 4, -0.36, p.z - 5);
    g.traverse((o) => (o.castShadow = true));
    site.add(g);
  }

  // ------------------------------------------------------------ building (rebuilt when spacing changes)
  const building = new THREE.Group();
  scene.add(building);
  const floorGroups = new Map();
  const furnitureByFloor = new Map();
  let wallSegsCache = null;

  function buildBuilding() {
    for (const c of [...building.children]) {
      building.remove(c);
      c.traverse?.((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }
    floorGroups.clear();
    furnitureByFloor.clear();
    for (const f of floors) {
      const g = new THREE.Group();
      g.userData.floor = f;
      building.add(g);
      floorGroups.set(f, g);
    }
    // slabs
    for (const f of floors) {
      const ns = model.nodes.filter((n) => n.floor === f && n.type !== "exit");
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
      const slab = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 0.6, 0.35, y1 - y0 + 0.6), mats.slab);
      const p = W((x0 + x1) / 2, (y0 + y1) / 2, f);
      slab.position.set(p.x, p.y - 0.18, p.z);
      slab.receiveShadow = true;
      slab.castShadow = true;
      floorGroups.get(f).add(slab);
      const tag = textSprite(f === 0 ? "Ground floor" : `Floor ${f}`, { size: 1.4, weight: 700 });
      tag.position.copy(W(x0 - 3, y1 + 1, f));
      tag.position.y += 1.2;
      tag.userData.label = true;
      floorGroups.get(f).add(tag);
    }
    // room floors
    for (const n of model.nodes) {
      const g = floorGroups.get(n.floor);
      const mat = floorMaterial(n, mats);
      const geo = new THREE.BoxGeometry(n.w - 0.05, 0.05, n.l - 0.05);
      const mesh = new THREE.Mesh(geo, mat);
      if (mat.map) {
        // texture repeats per metre
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * n.w / 2.4, uv.getY(i) * n.l / 2.4);
      }
      const p = W(n.x, n.y, n.floor);
      mesh.position.set(p.x, p.y + 0.025, p.z);
      mesh.receiveShadow = true;
      mesh.userData.node = n.i;
      g.add(mesh);
    }
    // walls with door gaps and windows on the outside
    const doors = model.nodes.map(() => []);
    for (const e of model.edges) {
      if (e.virtual || e.kind !== "flat") continue;
      const d = doorsOf(model, e);
      if (d.length === 2) {
        doors[e.u].push([d[0], e.width]);
        doors[e.v].push([d[1], e.width]);
      }
    }
    const solid = [];
    const windows = [];
    const done = new Set();
    for (const n of model.nodes) {
      if (n.type === "exit") continue;
      const r = rectOf(n);
      const sides = [
        { axis: "x", fixed: r.y0, lo: r.x0, hi: r.x1 },
        { axis: "x", fixed: r.y1, lo: r.x0, hi: r.x1 },
        { axis: "y", fixed: r.x0, lo: r.y0, hi: r.y1 },
        { axis: "y", fixed: r.x1, lo: r.y0, hi: r.y1 },
      ];
      for (const s of sides) {
        const key = `${n.floor}:${s.axis}:${s.fixed.toFixed(2)}:${s.lo.toFixed(2)}:${s.hi.toFixed(2)}`;
        if (done.has(key)) continue;
        done.add(key);
        const gaps = doors[n.i]
          .filter(([d]) => Math.abs((s.axis === "x" ? d[1] : d[0]) - s.fixed) < 0.05)
          .map(([d, w]) => [(s.axis === "x" ? d[0] : d[1]), Math.min(Math.max(w, DOOR_W), 2.4)])
          .sort((p, q) => p[0] - q[0]);
        let start = s.lo;
        const pieces = [];
        for (const [gpos, gw] of gaps) {
          if (gpos - gw / 2 > start) pieces.push([start, gpos - gw / 2]);
          start = Math.max(start, gpos + gw / 2);
        }
        if (s.hi > start) pieces.push([start, s.hi]);
        const outer = n.type !== "corridor" && n.type !== "stair" && n.type !== "lift" && isOuterSide(model, n, s.axis, s.fixed, (s.lo + s.hi) / 2);
        for (const [p0, p1] of pieces) {
          if (p1 - p0 < 0.05) continue;
          (outer ? windows : solid).push({ n, axis: s.axis, fixed: s.fixed, p0, p1 });
        }
      }
    }
    wallSegsCache = { solid, windows };
    const addBox = (list, mat, y0, y1, thick) => {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, Math.max(1, list.length));
      im.castShadow = mat !== mats.glass;
      im.receiveShadow = true;
      list.forEach((w, i) => {
        const len = w.p1 - w.p0;
        const mid = (w.p0 + w.p1) / 2;
        const p = w.axis === "x" ? W(mid, w.fixed, w.n.floor) : W(w.fixed, mid, w.n.floor);
        const size = w.axis === "x" ? new THREE.Vector3(len, y1 - y0, thick) : new THREE.Vector3(thick, y1 - y0, len);
        m4.compose(new THREE.Vector3(p.x, p.y + (y0 + y1) / 2, p.z), q0, size);
        im.setMatrixAt(i, m4);
      });
      im.count = list.length;
      im.userData.walls = list;
      im.userData.y = [y0, y1, thick];
      building.add(im);
      return im;
    };
    addBox(solid, mats.wall, 0, WALL_H, 0.14);
    addBox(windows, mats.outer, 0, SILL, 0.24);
    addBox(windows, mats.glass, SILL, HEAD, 0.06);
    addBox(windows, mats.outer, HEAD, WALL_H, 0.24);
    // stairs: steps
    const stepMat = new THREE.MeshStandardMaterial({ color: 0xcfc8b6, roughness: 0.8 });
    for (const e of model.edges) {
      if (e.kind !== "stair") continue;
      const lo = model.nodes[e.u].floor < model.nodes[e.v].floor ? model.nodes[e.u] : model.nodes[e.v];
      const steps = 14;
      const rise = Math.min(level, 4.2) / steps;
      const run = (lo.l - 0.6) / steps;
      for (let k = 0; k < steps; k++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(lo.w * 0.42, rise * (k + 1), run), stepMat);
        const p = W(lo.x - lo.w * 0.22, lo.y - lo.l / 2 + 0.3 + run * (k + 0.5), lo.floor);
        s.position.set(p.x, p.y + (rise * (k + 1)) / 2, p.z);
        s.castShadow = s.receiveShadow = true;
        floorGroups.get(lo.floor).add(s);
      }
    }
    // lift cars
    for (const n of model.nodes) {
      if (n.type !== "lift") continue;
      const door = new THREE.Mesh(new THREE.BoxGeometry(n.w * 0.7, 2.2, 0.08), new THREE.MeshStandardMaterial({ color: 0xb8c2c8, metalness: 0.7, roughness: 0.25 }));
      const p = W(n.x, n.y + n.l / 2 - 0.15, n.floor);
      door.position.set(p.x, p.y + 1.1, p.z);
      floorGroups.get(n.floor).add(door);
    }
    // furniture
    const kinds = {};
    for (const n of model.nodes) for (const it of furnitureFor(model, n)) (kinds[it.kind] ??= []).push({ ...it, floor: n.floor });
    const place = (list, geo, mat, yOff, scaleFn, rotY = (it) => it.rot) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      im.castShadow = true;
      im.receiveShadow = true;
      list.forEach((it, i) => {
        const p = W(it.x, it.y, it.floor);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY(it));
        m4.compose(new THREE.Vector3(p.x, p.y + yOff, p.z), q, scaleFn(it));
        im.setMatrixAt(i, m4);
      });
      im.count = list.length;
      im.userData.items = list;
      building.add(im);
    };
    const bedsStatic = (kinds.bed ?? []);
    place(bedsStatic, new THREE.BoxGeometry(1, 0.12, 1), mats.frame, 0.45, (it) => new THREE.Vector3(it.w, 1, it.l));
    place(bedsStatic, new THREE.BoxGeometry(1, 0.18, 1), mats.mattress, 0.6, (it) => new THREE.Vector3(it.w * 0.92, 1, it.l * 0.95));
    place(bedsStatic, new THREE.BoxGeometry(1, 0.5, 0.06), mats.frame, 0.75, (it) => new THREE.Vector3(it.w, 1, 1), (it) => it.rot);
    const legs = [];
    for (const it of bedsStatic) for (const [a, c] of [[-0.4, -0.9], [0.4, -0.9], [-0.4, 0.9], [0.4, 0.9]]) legs.push({ ...it, x: it.x + (it.rot ? c : a) * (it.rot ? 1 : it.w), y: it.y + (it.rot ? a * it.w : c) });
    place(legs, new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), mats.frame, 0.22, () => one);
    place(kinds.incubator ?? [], new THREE.BoxGeometry(1, 0.45, 1), mats.glass, 1.05, (it) => new THREE.Vector3(it.w, 1, it.l));
    place(kinds.incubator ?? [], new THREE.BoxGeometry(1, 0.8, 1), mats.machine, 0.4, (it) => new THREE.Vector3(it.w * 0.8, 1, it.l * 0.8));
    place(kinds.monitor ?? [], new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), mats.frame, 0.75, () => one);
    place(kinds.monitor ?? [], new THREE.BoxGeometry(0.42, 0.32, 0.06), mats.screen, 1.5, () => one, () => 0.3);
    place(kinds.otTable ?? [], new THREE.BoxGeometry(1, 0.9, 1), mats.machine, 0.45, (it) => new THREE.Vector3(it.w, 1, it.l), (it) => it.rot);
    place(kinds.otLamp ?? [], new THREE.CylinderGeometry(0.55, 0.35, 0.18, 18), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff7d6, emissiveIntensity: 0.8 }), 2.55, () => one);
    place(kinds.scanner ?? [], new THREE.TorusGeometry(0.85, 0.32, 14, 28), mats.machine, 1.15, () => one, (it) => it.rot);
    place(kinds.machine ?? [], new THREE.BoxGeometry(1, 1.2, 1), mats.machine, 0.6, (it) => new THREE.Vector3(it.w, 1, it.l), (it) => it.rot);
    place(kinds.shelf ?? [], new THREE.BoxGeometry(1, 2.0, 1), mats.shelf, 1.0, (it) => new THREE.Vector3(it.w, 1, it.l), (it) => it.rot);
    place(kinds.counter ?? [], new THREE.BoxGeometry(1, 1.05, 1), mats.wood, 0.52, (it) => new THREE.Vector3(it.w, 1, it.l), (it) => it.rot);
    place(kinds.table ?? [], new THREE.BoxGeometry(1, 0.06, 1), mats.wood, 0.75, (it) => new THREE.Vector3(it.w, 1, it.l), (it) => it.rot);
    place(kinds.table ?? [], new THREE.CylinderGeometry(0.06, 0.06, 0.72, 6), mats.frame, 0.36, () => one);
    place(kinds.chair ?? [], new THREE.BoxGeometry(0.46, 0.06, 0.46), mats.chair, 0.46, () => one);
    place(kinds.chair ?? [], new THREE.BoxGeometry(0.46, 0.5, 0.06), mats.chair, 0.72, () => one, () => 0);
    // labels
    for (const n of model.nodes) {
      if (n.type === "corridor" || n.type === "stair" || n.type === "lift") continue;
      const isExit = n.type === "exit";
      const s = textSprite(isExit ? `EXIT · ${n.id}` : n.id, { colour: isExit ? "#0B6B3A" : "#1E3A5F", size: isExit ? 0.95 : 0.75 });
      const p = W(n.x, n.y, n.floor);
      s.position.set(p.x, p.y + WALL_H + 0.7, p.z);
      s.userData.label = true;
      s.userData.floor = n.floor;
      floorGroups.get(n.floor).add(s);
    }
    // exit signs above junctions
    signMeshes.clear();
    const signGeo = new THREE.BoxGeometry(0.9, 0.32, 0.08);
    for (const n of model.nodes) {
      if (!n.sign) continue;
      const m = new THREE.Mesh(signGeo, new THREE.MeshStandardMaterial({ color: 0x0b7a4b, emissive: 0x0b7a4b, emissiveIntensity: 0.9 }));
      const p = W(n.x, n.y, n.floor);
      m.position.set(p.x, p.y + WALL_H - 0.35, p.z);
      floorGroups.get(n.floor).add(m);
      signMeshes.set(n.i, m);
    }
    // sensors on the ceiling
    sensorMeshes.clear();
    const sensorGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.06, 16);
    model.sensors.forEach((s, k) => {
      const n = model.nodes[s.node];
      const m = new THREE.Mesh(sensorGeo, new THREE.MeshStandardMaterial({ color: 0xf2f2f2, emissive: 0x000000 }));
      const p = W(n.x + ((k % 3) - 1) * 0.9, n.y - n.l / 4, n.floor);
      m.position.set(p.x, p.y + WALL_H - 0.05, p.z);
      floorGroups.get(n.floor).add(m);
      sensorMeshes.set(s.id, m);
    });
    applyVisibility();
  }

  const signMeshes = new Map();
  const sensorMeshes = new Map();

  // ------------------------------------------------------------ people
  const MAX = Math.max(64, model.people.length + model.cameras.reduce((s, c) => s + c.count, 0) + 400) * 3;
  const mk = (geo, mat) => {
    const im = new THREE.InstancedMesh(geo, mat, MAX);
    im.castShadow = true;
    im.count = 0;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(im);
    return im;
  };
  const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  const skinMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  const torso = mk(new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), bodyMat);
  const head = mk(new THREE.SphereGeometry(0.12, 14, 10), skinMat);
  const leg = mk(new THREE.CapsuleGeometry(0.07, 0.62, 3, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }));
  const arm = mk(new THREE.CapsuleGeometry(0.05, 0.46, 3, 6), new THREE.MeshStandardMaterial({ roughness: 0.7 }));
  const helmet = mk(new THREE.SphereGeometry(0.15, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.4 }));
  const bedFrame = mk(new THREE.BoxGeometry(0.95, 0.12, 2.0), mats.frame);
  const bedMat = mk(new THREE.BoxGeometry(0.88, 0.18, 1.9), mats.mattress);
  const bedSheet = mk(new THREE.BoxGeometry(0.9, 0.1, 1.2), mats.sheet);
  const chairSeat = mk(new THREE.BoxGeometry(0.55, 0.08, 0.5), new THREE.MeshStandardMaterial({ color: 0x2c3e50 }));
  const wheel = mk(new THREE.TorusGeometry(0.3, 0.03, 6, 18), new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6 }));
  const ring = mk(new THREE.TorusGeometry(0.55, 0.05, 6, 24), new THREE.MeshBasicMaterial({ color: 0xc2410c }));
  const parts = [torso, head, leg, arm, helmet, bedFrame, bedMat, bedSheet, chairSeat, wheel, ring];
  const heading = new Map();
  const phase = new Map();
  const lastPos = new Map();
  const up = new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3(1, 0, 0);
  const qH = new THREE.Quaternion();
  const qTmp = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  const sc = new THREE.Vector3();
  let counts = {};

  function put(im, key, pos, quat, scale = one, hex = null) {
    const i = counts[key]++;
    m4.compose(pos, quat, scale);
    im.setMatrixAt(i, m4);
    if (hex !== null) im.setColorAt(i, colour.setHex(hex));
  }

  // One standing or walking person at world position w, facing quaternion q.
  function figure(w, q, clothes, skin, swing, opts = {}) {
    const local = (x, y, z) => v3.set(x, y, z).applyQuaternion(q).add(w).clone();
    // legs (swing around the hip)
    for (const sgn of [-1, 1]) {
      const a = swing * sgn * 0.55;
      qTmp.setFromAxisAngle(xAxis, a).premultiply(q);
      const hip = local(sgn * 0.1, 0.86, 0);
      const offs = new THREE.Vector3(0, -0.4, 0).applyQuaternion(qTmp);
      put(leg, "leg", hip.add(offs), qTmp, one, opts.trousers ?? 0x2f3640);
    }
    put(torso, "torso", local(0, 1.18, 0), q, one, clothes);
    for (const sgn of [-1, 1]) {
      const a = opts.pushing ? -1.1 : -swing * sgn * 0.5;
      qTmp.setFromAxisAngle(xAxis, a).premultiply(q);
      const sh = local(sgn * 0.26, 1.42, 0);
      const offs = new THREE.Vector3(0, -0.3, 0).applyQuaternion(qTmp);
      put(arm, "arm", sh.add(offs), qTmp, one, clothes);
    }
    put(head, "head", local(0, 1.66, 0), q, one, skin);
    if (opts.helmet) put(helmet, "helmet", local(0, 1.72, 0), q, one);
  }

  function lying(w, q, skin, gown = ROLE_COLOUR.patient) {
    // bed with a patient lying on it
    put(bedFrame, "bedFrame", v3.set(0, 0.48, 0).applyQuaternion(q).add(w).clone(), q);
    put(bedMat, "bedMat", v3.set(0, 0.63, 0).applyQuaternion(q).add(w).clone(), q);
    const qLie = new THREE.Quaternion().setFromAxisAngle(xAxis, Math.PI / 2).premultiply(q);
    put(torso, "torso", v3.set(0, 0.85, 0.05).applyQuaternion(q).add(w).clone(), qLie, one, gown);
    put(head, "head", v3.set(0, 0.84, -0.72).applyQuaternion(q).add(w).clone(), q, one, skin);
    put(bedSheet, "bedSheet", v3.set(0, 0.79, 0.35).applyQuaternion(q).add(w).clone(), q);
  }

  function seated(w, q, skin) {
    put(chairSeat, "chairSeat", v3.set(0, 0.5, 0).applyQuaternion(q).add(w).clone(), q);
    const qW = new THREE.Quaternion().setFromAxisAngle(up, Math.PI / 2).premultiply(q);
    for (const sgn of [-1, 1]) put(wheel, "wheel", v3.set(sgn * 0.3, 0.32, 0.05).applyQuaternion(q).add(w).clone(), qW);
    put(torso, "torso", v3.set(0, 0.95, -0.05).applyQuaternion(q).add(w).clone(), q, one, ROLE_COLOUR.patient);
    put(head, "head", v3.set(0, 1.42, -0.05).applyQuaternion(q).add(w).clone(), q, one, skin);
    const qLeg = new THREE.Quaternion().setFromAxisAngle(xAxis, Math.PI / 2).premultiply(q);
    for (const sgn of [-1, 1]) put(leg, "leg", v3.set(sgn * 0.1, 0.55, 0.32).applyQuaternion(q).add(w).clone(), qLeg, sc.set(1, 0.6, 1), 0x9cc9e8);
  }

  function clothesOf(s) {
    if (s.kind === "rescue") return ROLE_COLOUR.rescue;
    if (s.kind === "staff") return ROLE_COLOUR[s.role] ?? ROLE_COLOUR.staff;
    if (s.kind === "patient") return ROLE_COLOUR.patient;
    return CLOTHES[s.id % CLOTHES.length];
  }

  function setPeople(positions, people, dt = 0.016) {
    counts = Object.fromEntries(["torso", "head", "leg", "arm", "helmet", "bedFrame", "bedMat", "bedSheet", "chairSeat", "wheel", "ring"].map((k) => [k, 0]));
    for (const s of people) {
      const pos = positions.get(s.id);
      if (!pos || !visibleFloor(Math.round(pos[2]))) continue;
      const w = new THREE.Vector3(pos[0] - cx, (pos[2] - lowest) * level, pos[1] - cz);
      const prev = lastPos.get(s.id);
      let hd = heading.get(s.id) ?? (s.id * 1.7) % (Math.PI * 2);
      let moving = false;
      if (prev) {
        const dx = w.x - prev.x;
        const dz = w.z - prev.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.004) {
          hd = Math.atan2(dx, dz);
          moving = true;
          phase.set(s.id, (phase.get(s.id) ?? 0) + d * 3.2);
        }
      }
      lastPos.set(s.id, w.clone());
      heading.set(s.id, hd);
      const skin = SKIN[s.id % SKIN.length];
      const pose = pos[3];
      const ph = phase.get(s.id) ?? 0;
      const swing = moving ? Math.sin(ph) : 0;
      if (pose === "bed") {
        qH.setFromAxisAngle(up, (pos[4] ?? 0));
        lying(w, qH, skin);
      } else if (s.kind === "patient" && (s.mobility === "stretcher" || s.mobility === "ventilator")) {
        qH.setFromAxisAngle(up, hd);
        lying(w, qH, skin);
        for (let k = 0; k < (s.helpers || 0); k++) {
          const front = k === 0 ? 1.25 : -1.25;
          const qs = qH.clone();
          figure(v3.set(0.0, 0, front).applyQuaternion(qH).add(w).clone(), qs, ROLE_COLOUR.nurse, SKIN[(s.id + k + 1) % SKIN.length], swing, { pushing: true });
        }
      } else if (s.kind === "patient" && s.mobility === "wheelchair") {
        qH.setFromAxisAngle(up, hd);
        seated(w, qH, skin);
        if (s.helpers) figure(v3.set(0, 0, -0.75).applyQuaternion(qH).add(w).clone(), qH.clone(), ROLE_COLOUR.nurse, SKIN[(s.id + 2) % SKIN.length], swing, { pushing: true });
      } else if (s.kind === "rescue") {
        qH.setFromAxisAngle(up, hd);
        const team = 1 + (s.helpers ?? 1);
        for (let k = 0; k < team; k++) {
          const off = v3.set((k - (team - 1) / 2) * 0.75, 0, 0).applyQuaternion(qH).add(w).clone();
          figure(off, qH.clone(), ROLE_COLOUR.rescue, SKIN[(s.id + k) % SKIN.length], swing, { helmet: true, trousers: 0x8a6d1d });
        }
        if (s.carrying) lying(v3.set(0, 0, 1.4).applyQuaternion(qH).add(w).clone(), qH.clone(), SKIN[(s.id + 3) % SKIN.length]);
      } else {
        qH.setFromAxisAngle(up, hd);
        figure(w, qH, clothesOf(s), skin, swing);
      }
      if (s.state === "incapacitated" || s.state === "shelter" || s.state === "needsHelp") {
        const col = s.state === "incapacitated" ? 0xb91c1c : s.state === "needsHelp" ? 0xd97706 : 0xc2410c;
        const qr = new THREE.Quaternion().setFromAxisAngle(xAxis, Math.PI / 2);
        put(ring, "ring", w.clone().add(v3.set(0, 0.06, 0)), qr, one, col);
      }
    }
    const map = { torso, head, leg, arm, helmet, bedFrame, bedMat, bedSheet, chairSeat, wheel, ring };
    for (const [k, im] of Object.entries(map)) {
      im.count = counts[k];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    void dt;
  }

  // ------------------------------------------------------------ smoke and fire
  const smokeTex = softDot("rgba(255,255,255,0.95)", "rgba(255,255,255,0)");
  const fireTex = softDot("rgba(255,240,200,1)", "rgba(255,120,20,0)");
  const smokeBuckets = [0.12, 0.2, 0.3, 0.42].map((op) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(3 * 6000), 3));
    geo.setDrawRange(0, 0);
    const m = new THREE.PointsMaterial({ map: smokeTex, color: 0x5d6168, size: 3.2, transparent: true, opacity: op, depthWrite: false, sizeAttenuation: true });
    const pts = new THREE.Points(geo, m);
    pts.frustumCulled = false;
    pts.renderOrder = 6;
    scene.add(pts);
    return { pts, seeds: [] };
  });
  const fireGeo = new THREE.BufferGeometry();
  fireGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(3 * 3000), 3));
  fireGeo.setDrawRange(0, 0);
  const firePts = new THREE.Points(fireGeo, new THREE.PointsMaterial({ map: fireTex, color: 0xffb060, size: 0.55, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
  // flame tongues: tall cones that flicker
  const flameIM = new THREE.InstancedMesh(new THREE.ConeGeometry(0.35, 1.6, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xd9360b, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), 900);
  const flameCore = new THREE.InstancedMesh(new THREE.ConeGeometry(0.18, 1.0, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xf2a10f, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), 900);
  flameIM.count = flameCore.count = 0;
  flameIM.frustumCulled = flameCore.frustumCulled = false;
  scene.add(flameIM, flameCore);
  let flameSeeds = [];
  firePts.frustumCulled = false;
  firePts.renderOrder = 7;
  scene.add(firePts);
  let fireSeeds = [];
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.45, depthWrite: false });
  const glowGroup = new THREE.Group();
  scene.add(glowGroup);
  const fireLights = [];
  let hazardKey = "";

  function setHazards(hazard) {
    const key = hazard.map((h) => `${h.n}:${h.fire ? "f" : Math.round(h.smoke * 8)}`).join(",") + "|" + floorFilter + level;
    if (key === hazardKey) return;
    hazardKey = key;
    for (const bkt of smokeBuckets) bkt.seeds = [];
    fireSeeds = [];
    flameSeeds = [];
    for (const c of [...glowGroup.children]) glowGroup.remove(c);
    for (const l of fireLights) scene.remove(l);
    fireLights.length = 0;
    let fires = 0;
    for (const h of hazard) {
      const n = model.nodes[h.n];
      if (!visibleFloor(n.floor) || n.type === "exit") continue;
      const base = (n.floor - lowest) * level;
      const lvl = Math.min(1, h.smoke);
      if (lvl > 0.03) {
        const bkt = smokeBuckets[Math.min(3, Math.floor(lvl * 4))];
        const count = Math.min(120, Math.round((n.w * n.l) / 5 * (0.4 + lvl)));
        const layer = WALL_H * (0.25 + 0.7 * lvl);
        for (let k = 0; k < count; k++) {
          bkt.seeds.push({ x: n.x - cx + (Math.random() - 0.5) * (n.w - 0.6), z: n.y - cz + (Math.random() - 0.5) * (n.l - 0.6), y: base + WALL_H - Math.random() * layer, p: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.4 });
        }
      }
      if (h.fire) {
        fires++;
        const count = Math.min(160, Math.round(n.w * n.l * 0.8));
        for (let k = 0; k < count; k++) fireSeeds.push({ x: n.x - cx + (Math.random() - 0.5) * (n.w - 1), z: n.y - cz + (Math.random() - 0.5) * (n.l - 1), y: base + 0.2, h: Math.random(), p: Math.random() * 6.28 });
        const tongues = Math.min(40, Math.round(n.w * n.l * 0.22));
        for (let k = 0; k < tongues && flameSeeds.length < 900; k++) flameSeeds.push({ x: n.x - cx + (Math.random() - 0.5) * (n.w - 1.2), z: n.y - cz + (Math.random() - 0.5) * (n.l - 1.2), y: base, s: 0.6 + Math.random() * 0.9, p: Math.random() * 6.28 });
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(n.w - 0.3, n.l - 0.3), glowMat);
        glow.rotation.x = -Math.PI / 2;
        glow.position.set(n.x - cx, base + 0.08, n.y - cz);
        glowGroup.add(glow);
        if (fires <= 6) {
          const l = new THREE.PointLight(0xff6a2b, 40, 22, 2);
          l.position.set(n.x - cx, base + 1.8, n.y - cz);
          scene.add(l);
          fireLights.push(l);
        }
      }
    }
  }

  function animateHazards(time) {
    for (const bkt of smokeBuckets) {
      const arr = bkt.pts.geometry.attributes.position.array;
      const n = Math.min(bkt.seeds.length, 6000);
      for (let i = 0; i < n; i++) {
        const s = bkt.seeds[i];
        arr[i * 3] = s.x + Math.sin(time * s.sp + s.p) * 0.6;
        arr[i * 3 + 1] = s.y + Math.sin(time * s.sp * 0.7 + s.p * 2) * 0.15;
        arr[i * 3 + 2] = s.z + Math.cos(time * s.sp * 0.8 + s.p) * 0.6;
      }
      bkt.pts.geometry.setDrawRange(0, n);
      bkt.pts.geometry.attributes.position.needsUpdate = true;
    }
    const arr = fireGeo.attributes.position.array;
    const n = Math.min(fireSeeds.length, 3000);
    for (let i = 0; i < n; i++) {
      const s = fireSeeds[i];
      const life = (time * 0.9 + s.h) % 1;
      arr[i * 3] = s.x + Math.sin(time * 3 + s.p) * 0.15;
      arr[i * 3 + 1] = s.y + life * 2.4;
      arr[i * 3 + 2] = s.z + Math.cos(time * 2.6 + s.p) * 0.15;
    }
    fireGeo.setDrawRange(0, n);
    fireGeo.attributes.position.needsUpdate = true;
    firePts.material.size = 0.5 + 0.12 * Math.sin(time * 12);
    const nf = flameSeeds.length;
    for (let i = 0; i < nf; i++) {
      const f = flameSeeds[i];
      const h = f.s * (0.75 + 0.35 * Math.sin(time * 9 + f.p) + 0.15 * Math.sin(time * 23 + f.p * 3));
      m4.compose(new THREE.Vector3(f.x + Math.sin(time * 4 + f.p) * 0.06, f.y + 0.8 * h, f.z), q0, new THREE.Vector3(1, h, 1));
      flameIM.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(f.x, f.y + 0.5 * h, f.z), q0, new THREE.Vector3(1, h, 1));
      flameCore.setMatrixAt(i, m4);
    }
    flameIM.count = flameCore.count = nf;
    flameIM.instanceMatrix.needsUpdate = flameCore.instanceMatrix.needsUpdate = true;
    for (const l of fireLights) l.intensity = 34 + 12 * Math.sin(time * 13 + l.position.z);
  }

  // ------------------------------------------------------------ routes, predicted spread, signs, sensors
  const routeGroup = new THREE.Group();
  scene.add(routeGroup);
  const routeMat = new THREE.LineBasicMaterial({ color: 0x0b7a4b, transparent: true, opacity: 0.85 });
  const teamMat = new THREE.LineDashedMaterial({ color: 0xc2410c, dashSize: 0.8, gapSize: 0.5 });
  const predMat = new THREE.LineDashedMaterial({ color: 0xd9480f, dashSize: 0.6, gapSize: 0.4 });
  const lines = model.edges.map((e) => edgePolyline(model, e));
  let routeKey = "";
  function routePoints(nodes) {
    const pts = [];
    for (let k = 0; k + 1 < nodes.length; k++) {
      const a = nodes[k];
      const c = nodes[k + 1];
      const ei = model.adj[a].find((x) => (model.edges[x].u === a && model.edges[x].v === c) || (model.edges[x].v === a && model.edges[x].u === c));
      const seg = ei === undefined ? [[model.nodes[a].x, model.nodes[a].y, model.nodes[a].floor], [model.nodes[c].x, model.nodes[c].y, model.nodes[c].floor]] : model.edges[ei].u === a ? lines[ei] : [...lines[ei]].reverse();
      for (const pt of seg) {
        if (!visibleFloor(Math.floor(pt[2] + 1e-6))) continue;
        pts.push(new THREE.Vector3(pt[0] - cx, (pt[2] - lowest) * level + 0.18, pt[1] - cz));
      }
    }
    return pts;
  }
  function setOverlays(snap, layers) {
    const key = (layers.routes ? snap.routes.map((r) => r.nodes.join("-")).join("|") + "#" + snap.teams.map((tt) => tt.route.join("-")).join("|") : "") + (layers.predicted ? "P" + snap.predicted.map((q) => q.n).join(",") : "") + floorFilter + level;
    if (key !== routeKey) {
      routeKey = key;
      for (const c of [...routeGroup.children]) {
        routeGroup.remove(c);
        c.geometry.dispose();
      }
      if (layers.routes) {
        for (const r of snap.routes) {
          const pts = routePoints(r.nodes);
          if (pts.length > 1) routeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), routeMat));
        }
        for (const tt of snap.teams) {
          const pts = routePoints(tt.route);
          if (pts.length < 2) continue;
          const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), teamMat);
          l.computeLineDistances();
          routeGroup.add(l);
        }
      }
      if (layers.predicted) {
        const burning = new Set(snap.hazard.map((h) => h.n));
        for (const qq of snap.predicted) {
          if (burning.has(qq.n)) continue;
          const n = model.nodes[qq.n];
          if (!visibleFloor(n.floor)) continue;
          const r = rectOf(n);
          const y = (n.floor - lowest) * level + 0.1;
          const pts = [[r.x0 + 0.3, r.y0 + 0.3], [r.x1 - 0.3, r.y0 + 0.3], [r.x1 - 0.3, r.y1 - 0.3], [r.x0 + 0.3, r.y1 - 0.3], [r.x0 + 0.3, r.y0 + 0.3]].map(([x, z]) => new THREE.Vector3(x - cx, y, z - cz));
          const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), predMat);
          l.computeLineDistances();
          routeGroup.add(l);
        }
      }
    }
    for (const s of snap.signs) {
      const m = signMeshes.get(s.n);
      if (!m) continue;
      m.visible = layers.signs !== false && visibleFloor(model.nodes[s.n].floor);
      const hex = s.failed ? 0x8a9590 : s.next < 0 ? 0xc2410c : 0x0b7a4b;
      m.material.color.setHex(hex);
      m.material.emissive.setHex(s.failed ? 0x000000 : hex);
      if (s.next >= 0) {
        const a = model.nodes[s.n];
        const c = model.nodes[s.next];
        m.rotation.y = a.floor === c.floor ? -Math.atan2(c.y - a.y, c.x - a.x) : 0;
      }
    }
    for (const s of snap.sensors) {
      const m = sensorMeshes.get(s.id);
      if (!m) continue;
      m.visible = layers.sensors !== false;
      const on = s.detected && s.status === "ok";
      m.material.color.setHex(s.status !== "ok" ? 0x777777 : on ? 0xc2410c : 0xf2f2f2);
      m.material.emissive.setHex(on ? 0xc2410c : 0x000000);
    }
  }

  // ------------------------------------------------------------ visibility, camera
  let floorFilter = null;
  let showLabels = false;
  let showOuter = true;
  const visibleFloor = (f) => floorFilter === null || f <= floorFilter;
  function applyVisibility() {
    for (const [f, g] of floorGroups) {
      g.visible = visibleFloor(f);
      for (const c of g.children) if (c.userData.label) c.visible = showLabels && (c.userData.floor === undefined || true);
    }
    // instanced walls and furniture: hide by scaling instances of hidden floors
    for (const im of building.children) {
      if (!im.isInstancedMesh) continue;
      const list = im.userData.walls ?? im.userData.items;
      if (!list) continue;
      if (im.userData.walls) {
        const [y0, y1, thick] = im.userData.y;
        const outerMesh = im.material === mats.outer || im.material === mats.glass;
        list.forEach((w, i) => {
          const len = w.p1 - w.p0;
          const mid = (w.p0 + w.p1) / 2;
          const p = w.axis === "x" ? W(mid, w.fixed, w.n.floor) : W(w.fixed, mid, w.n.floor);
          const vis = visibleFloor(w.n.floor) && (!outerMesh || showOuter || true);
          const hideOuter = outerMesh && !showOuter;
          const size = !vis ? new THREE.Vector3(1e-4, 1e-4, 1e-4) : w.axis === "x" ? new THREE.Vector3(len, hideOuter ? 0.05 : y1 - y0, thick) : new THREE.Vector3(thick, hideOuter ? 0.05 : y1 - y0, len);
          m4.compose(new THREE.Vector3(p.x, p.y + (hideOuter ? y0 : (y0 + y1) / 2), p.z), q0, size);
          im.setMatrixAt(i, m4);
        });
      } else {
        const tmp = new THREE.Matrix4();
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        list.forEach((it, i) => {
          if (it._m === undefined) {
            im.getMatrixAt(i, tmp);
            it._m = tmp.clone();
          }
          if (visibleFloor(it.floor)) im.setMatrixAt(i, it._m);
          else {
            it._m.decompose(pos, quat, scl);
            m4.compose(pos, quat, new THREE.Vector3(1e-4, 1e-4, 1e-4));
            im.setMatrixAt(i, m4);
          }
        });
      }
      im.instanceMatrix.needsUpdate = true;
    }
    hazardKey = "";
    routeKey = "";
  }

  function frameAll() {
    const top = floorFilter === null ? floors[floors.length - 1] : floorFilter;
    const midY = floorFilter === null ? fy(top) / 2 : fy(floorFilter);
    const aspect = Math.max(0.5, camera.aspect || 1);
    const half = Math.max(b.x1 - b.x0, (b.y1 - b.y0) * 1.3) / 2;
    const dist = half / Math.tan((camera.fov * Math.PI) / 360) / Math.min(1, aspect) + fy(top) * 0.5;
    const dir = new THREE.Vector3(-0.35, 0.62, 0.9).normalize();
    controls.target.set(0, midY, 0);
    camera.position.copy(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, midY, 0));
    camera.updateProjectionMatrix();
  }

  // Camera tour: a loop of views; stops when the user grabs the view.
  let tour = null;
  function tourStops() {
    const stops = [];
    const topY = fy(floors[floors.length - 1]);
    stops.push({ pos: [-110, topY + 70, 120], target: [0, topY / 2, 0] });
    stops.push({ pos: [0, 20, b.y1 - cz + 60], target: [0, 6, b.y1 - cz] });
    const f = tour?.focusFloor ?? floors[Math.floor(floors.length / 2)];
    const yy = fy(f);
    stops.push({ pos: [-55, yy + 26, 30], target: [-15, yy, 0] });
    stops.push({ pos: [15, yy + 14, 22], target: [10, yy + 1, 0] });
    stops.push({ pos: [60, yy + 30, -30], target: [20, yy, 0] });
    stops.push({ pos: [110, topY + 60, -90], target: [0, topY / 2, 0] });
    return stops;
  }
  function startTour(focusFloor = null) {
    tour = { t: 0, stop: 0, focusFloor };
    tour.stops = tourStops();
    tour.from = { pos: camera.position.clone(), target: controls.target.clone() };
  }
  function stopTour() {
    tour = null;
  }
  controls.addEventListener("start", () => stopTour());
  function stepTour(dt) {
    if (!tour) return;
    tour.t += dt / 5;
    const s = tour.stops[tour.stop];
    const e = (x) => x * x * (3 - 2 * x);
    const k = e(Math.min(1, tour.t));
    camera.position.lerpVectors(tour.from.pos, new THREE.Vector3(...s.pos), k);
    controls.target.lerpVectors(tour.from.target, new THREE.Vector3(...s.target), k);
    if (tour.t >= 1.25) {
      tour.from = { pos: camera.position.clone(), target: controls.target.clone() };
      tour.stop = (tour.stop + 1) % tour.stops.length;
      tour.t = 0;
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
      frameAll();
    }
  }
  let framed = false;
  buildBuilding();
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let running = true;
  let onFrame = null;
  let last = performance.now();
  const started = last;
  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (onFrame) onFrame(dt);
    animateHazards((now - started) / 1000);
    stepTour(dt);
    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);

  return {
    update({ positions, snapshot, layers }) {
      setHazards(layers.hazard === false ? [] : snapshot.hazard);
      setOverlays(snapshot, layers);
      setPeople(positions, snapshot.people);
    },
    setFloor(f) {
      floorFilter = f;
      applyVisibility();
      frameAll();
    },
    setExploded(on) {
      exploded = on;
      level = on ? 7.5 : 4.2;
      lastPos.clear();
      buildBuilding();
      frameAll();
    },
    setLabels(on) {
      showLabels = on;
      applyVisibility();
    },
    setOuter(on) {
      showOuter = on;
      applyVisibility();
    },
    startTour,
    stopTour,
    lookAt(pos, target) {
      stopTour();
      camera.position.set(...pos);
      controls.target.set(...target);
      controls.update();
    },
    // Fly close to one place (used when you click a room or follow the fire).
    focusPlace(n) {
      const node = model.nodes[n];
      if (!node) return;
      stopTour();
      const p = W(node.x, node.y, node.floor);
      camera.position.set(p.x - 10, p.y + 12, p.z + 14);
      controls.target.set(p.x, p.y + 1, p.z);
      controls.update();
    },
    touring: () => tour !== null,
    resetCamera: frameAll,
    onFrame(fn) {
      onFrame = fn;
    },
    dispose() {
      running = false;
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
    canvas: renderer.domElement,
    get exploded() {
      return exploded;
    },
  };
}
