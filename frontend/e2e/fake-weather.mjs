// A stand-in for Open-Meteo during end-to-end tests, so no internet is used.
// The backend runs with OPEN_METEO_URL pointed here; every forecast request
// gets the same current weather. Listens on 127.0.0.1 only.

import http from "node:http";

const port = Number(process.env.E2E_WEATHER_PORT ?? 11528);

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = url.pathname === "/v1/forecast" ? {
    latitude: Number(url.searchParams.get("latitude")), longitude: Number(url.searchParams.get("longitude")),
    utc_offset_seconds: 19800, timezone: "Asia/Kolkata",
    current: { time: "2026-10-21T14:15", interval: 900, temperature_2m: 28.4, relative_humidity_2m: 61,
               wind_speed_10m: 12.6, wind_direction_10m: 315, wind_gusts_10m: 22.3 },
  } : { status: "ok" };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}).listen(port, "127.0.0.1");
