// HEALTH-11 prototype: reading files people import. Everything is checked;
// nothing in a file is trusted.

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// RFC 4180 style CSV: quoted fields, doubled quotes, CRLF or LF.
export function parseCsv(textIn) {
  const text = String(textIn ?? "").replace(/^﻿/, "");
  if (text.length > MAX_FILE_BYTES) throw new Error("The file is larger than 2 MB");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("The file has a quote (\") that is never closed");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const cleaned = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!cleaned.length) throw new Error("The file is empty");
  const header = cleaned[0].map((h) => h.trim().toLowerCase());
  return cleaned.slice(1).map((r, n) => {
    const o = { _line: n + 2 };
    header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

function need(rows, columns, what) {
  if (!rows.length) throw new Error(`${what}: the file has a header but no rows`);
  for (const c of columns) if (!(c in rows[0])) throw new Error(`${what}: column "${c}" is missing`);
}

const numberOr = (v, fallback) => (v === "" || v === undefined ? fallback : Number(v));

// HEALTH-11 floor export (record_type,name,type,x,y,...,from_node,to_node,distance,width,...)
export function floorFromHealth11Csv(text, floorNumber = 0) {
  const rows = parseCsv(text);
  need(rows, ["record_type"], "Floor plan");
  const places = [];
  const paths = [];
  for (const r of rows) {
    const kind = r.record_type.toLowerCase();
    if (kind === "node") {
      places.push({ id: r.name, type: r.type, x: Number(r.x), y: Number(r.y), floor: floorNumber,
        w: numberOr(r.width_m, 4), l: numberOr(r.length_m, 4), evacLift: r.is_evacuation_lift || "false", blocked: r.is_blocked || "false" });
    } else if (kind === "edge") {
      paths.push({ a: r.from_node, b: r.to_node, length: Number(r.distance), width: numberOr(r.width, 1.2),
        wheelchair: r.wheelchair_accessible || "true", stretcher: r.stretcher_accessible || "true", blocked: r.is_blocked || "false" });
    } else throw new Error(`Floor plan line ${r._line}: record_type must be node or edge`);
  }
  return { places, paths };
}

// HEALTH-11 patients export (patient_code,mobility,criticality,...,place)
export function patientsFromCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["patient_code", "mobility", "place"], "Patients");
  return rows.map((r) => ({ code: r.patient_code, mobility: r.mobility, criticality: numberOr(r.criticality, 1), place: r.place }));
}

export function staffFromCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["staff_code", "place"], "Staff");
  return rows.map((r) => ({ code: r.staff_code, role: r.role || "staff", place: r.place }));
}

// Sensors and cameras: id,kind,place[,count]; kind = smoke|heat|gas|camera
export function devicesFromCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["id", "kind", "place"], "Devices");
  const sensors = [];
  const cameras = [];
  for (const r of rows) {
    if (r.kind.toLowerCase() === "camera") cameras.push({ id: r.id, place: r.place, count: numberOr(r.count, 0) });
    else sensors.push({ id: r.id, kind: r.kind, place: r.place });
  }
  return { sensors, cameras };
}

// Camera people counts: camera,count[,time]. The latest count per camera wins.
export function cameraCountsFromCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["camera", "count"], "Camera counts");
  const latest = {};
  for (const r of rows) {
    // time may be seconds or a date-time such as 2026-10-24T09:05:00
    const t = r.time === "" || r.time === undefined ? 0 : Number.isFinite(Number(r.time)) ? Number(r.time) : Date.parse(r.time);
    if (!Number.isFinite(t)) throw new Error(`Camera counts line ${r._line}: time "${r.time}" is not a number or a date-time`);
    const count = Number(r.count);
    if (!Number.isInteger(count) || count < 0 || count > 2000) throw new Error(`Camera counts line ${r._line}: count must be a whole number from 0 to 2000`);
    if (!latest[r.camera] || latest[r.camera].t <= t) latest[r.camera] = { t, count };
  }
  return Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v.count]));
}

// Fire-model export: place,hazard,arrival_s[,severity]. One hazard per hazard type.
export function hazardsFromFireModelCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["place", "hazard", "arrival_s"], "Fire model");
  const byType = new Map();
  for (const r of rows) {
    const type = r.hazard.toLowerCase();
    const t = Number(r.arrival_s);
    if (!Number.isFinite(t) || t < 0) throw new Error(`Fire model line ${r._line}: arrival_s must be 0 or more`);
    if (!byType.has(type)) byType.set(type, { name: `${type} (imported fire model)`, type, severity: numberOr(r.severity, 4), arrivals: [] });
    byType.get(type).arrivals.push({ place: r.place, arrival_s: t });
  }
  return [...byType.values()];
}

// Drill record: code,kind,exit,exit_time_s
export function drillFromCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["exit", "exit_time_s"], "Drill record");
  return rows.map((r) => {
    const t = Number(r.exit_time_s);
    if (!Number.isFinite(t) || t < 0) throw new Error(`Drill record line ${r._line}: exit_time_s must be 0 or more`);
    return { code: r.code || `row ${r._line}`, kind: r.kind || "", exit: r.exit, exit_time_s: t };
  });
}

// The prototype's own building file (JSON).
export function buildingFromJson(text) {
  if (String(text).length > MAX_FILE_BYTES) throw new Error("The file is larger than 2 MB");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The JSON file must hold one building object");
  return data;
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Cells starting with = + - @ could run as formulas in a spreadsheet.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
