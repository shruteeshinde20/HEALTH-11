// Reading files people import. Everything is checked; nothing in a file is trusted.

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// RFC 4180 style CSV: quoted fields, doubled quotes, CRLF or LF, optional BOM.
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
  if (quoted) throw new Error('The file has a quote (") that is never closed');
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

// Drill record: code,kind,mobility,exit,exit_time_s (code, kind and mobility optional).
export function drillFromCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["exit", "exit_time_s"], "Drill record");
  if (rows.length > 20000) throw new Error("Drill record: more than 20000 rows");
  return rows.map((r) => {
    const t = Number(r.exit_time_s);
    if (r.exit_time_s === "" || !Number.isFinite(t) || t < 0 || t > 86400) throw new Error(`Drill record line ${r._line}: exit_time_s must be a number of seconds from 0 to 86400`);
    if (!r.exit) throw new Error(`Drill record line ${r._line}: exit is missing`);
    return { code: (r.code || `row ${r._line}`).slice(0, 40), kind: (r.kind || "").slice(0, 20), mobility: (r.mobility || "").slice(0, 20), exit: r.exit.slice(0, 80), exit_time_s: t };
  });
}

// Camera people counts: camera,count[,time]. The latest count per camera wins.
export function cameraCountsFromCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["camera", "count"], "Camera counts");
  const latest = {};
  for (const r of rows) {
    const t = r.time === "" || r.time === undefined ? 0 : Number.isFinite(Number(r.time)) ? Number(r.time) : Date.parse(r.time);
    if (!Number.isFinite(t)) throw new Error(`Camera counts line ${r._line}: time "${r.time}" is not a number or a date-time`);
    const count = Number(r.count);
    if (r.count === "" || !Number.isInteger(count) || count < 0 || count > 2000) throw new Error(`Camera counts line ${r._line}: count must be a whole number from 0 to 2000`);
    if (!latest[r.camera] || latest[r.camera].t <= t) latest[r.camera] = { t, count };
  }
  return Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v.count]));
}

// Recorded sensor readings: sensor,t,value (t in seconds from the start).
export function readingsFromCsv(text) {
  const rows = parseCsv(text);
  need(rows, ["sensor", "t", "value"], "Sensor readings");
  if (rows.length > 200000) throw new Error("Sensor readings: more than 200000 rows");
  return rows.map((r) => {
    const t = Number(r.t);
    const v = Number(r.value);
    if (r.t === "" || !Number.isFinite(t) || t < 0) throw new Error(`Sensor readings line ${r._line}: t must be 0 or more seconds`);
    if (r.value === "" || !Number.isFinite(v)) throw new Error(`Sensor readings line ${r._line}: value must be a number`);
    if (!r.sensor) throw new Error(`Sensor readings line ${r._line}: sensor is missing`);
    return { sensor: r.sensor.slice(0, 40), t, value: v };
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
