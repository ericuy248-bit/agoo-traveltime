/**
 * Agoo Corridor — Automated Travel-Time Logger
 * -----------------------------------------------
 * Queries the Google Directions API for each corridor block on a timer,
 * and appends a timestamped row (current travel time, typical/free-flow
 * travel time, and the Travel Time Index) to a CSV file per block.
 *
 * Requires Node 18+ (uses the built-in fetch). No extra packages needed.
 *
 * Usage:
 *   1. Put your API key in GOOGLE_MAPS_API_KEY below (or as an env var).
 *   2. Edit SEGMENTS with the real lat/lng of each intersection.
 *   3. Run once to test:      node collect_traveltimes.js --once
 *   4. Run continuously:      node collect_traveltimes.js
 *      (polls every INTERVAL_MIN minutes, only inside ACTIVE_HOURS)
 */

const fs = require("fs");
const path = require("path");

// ---------- CONFIG ----------
const API_KEY = process.env.GOOGLE_MAPS_API_KEY || "PASTE_YOUR_API_KEY_HERE";
const INTERVAL_MIN = 15;                 // how often to sample
const ACTIVE_HOURS = { start: 6, end: 18 }; // only poll 06:00–18:00 field time
const OUT_DIR = path.join(__dirname, "traveltime_logs");
const DAILY_CALL_CAP = 400;              // hard safety cap; script stops logging past this

// Replace these with the real coordinates of I1–I4 (from Google Maps: right-click a
// point on the map -> the lat,lng shown at the top of the context menu).
const SEGMENTS = [
  {
    id: "I1_I2",
    label: "I1 (Verceles) to I2 (Grotto/Tabora)",
    origin: "16.325846,120.366633",
    destination: "16.323141,120.367084"
  },
  {
    id: "I2_I3",
    label: "I2 (Grotto/Tabora) to I3 (Cases/Asprer)",
    origin: "16.323141,120.367084",
    destination: "16.321961,120.367344"
  },
  {
    id: "I3_I4",
    label: "I3 (Cases/Asprer) to I4 (Calvary)",
    origin: "16.321961,120.367344",
    destination: "16.320234,120.367705"
  },
];
// ---------- END CONFIG ----------

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let callsToday = 0;
let lastDay = new Date().toISOString().slice(0, 10);

function resetDailyCounterIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastDay) { lastDay = today; callsToday = 0; }
}

function withinActiveHours() {
  const h = new Date().getHours();
  return h >= ACTIVE_HOURS.start && h < ACTIVE_HOURS.end;
}

function csvPath(segId) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(OUT_DIR, `traveltime_${segId}_${day}.csv`);
}

function ensureHeader(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file,
      "timestamp,segment_id,label,duration_typical_s,duration_traffic_s,tti,distance_m\n");
  }
}

async function fetchOne(seg) {
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", seg.origin);
  url.searchParams.set("destination", seg.destination);
  url.searchParams.set("departure_time", "now");
  url.searchParams.set("traffic_model", "best_guess");
  url.searchParams.set("key", API_KEY);

  const res = await fetch(url.toString());
  const data = await res.json();

  if (data.status !== "OK") {
    console.error(`[${seg.id}] API error: ${data.status} ${data.error_message || ""}`);
    return;
  }

  const leg = data.routes[0].legs[0];
  const durationTypical = leg.duration.value;                 // seconds, free-flow-ish
  const durationTraffic = (leg.duration_in_traffic || leg.duration).value; // seconds, current
  const distance = leg.distance.value;                        // metres
  const tti = (durationTraffic / durationTypical).toFixed(3);
  const ts = new Date().toISOString();

  const file = csvPath(seg.id);
  ensureHeader(file);
  fs.appendFileSync(file,
    `${ts},${seg.id},"${seg.label}",${durationTypical},${durationTraffic},${tti},${distance}\n`);

  console.log(`[${ts}] ${seg.id}: typical=${durationTypical}s traffic=${durationTraffic}s TTI=${tti}`);
}

async function pollAll() {
  resetDailyCounterIfNeeded();
  if (callsToday + SEGMENTS.length > DAILY_CALL_CAP) {
    console.warn("Daily call cap reached — skipping this round to stay in the free tier.");
    return;
  }
  if (!withinActiveHours()) {
    console.log("Outside active hours — skipping.");
    return;
  }
  for (const seg of SEGMENTS) {
    try { await fetchOne(seg); callsToday++; }
    catch (e) { console.error(`[${seg.id}] request failed:`, e.message); }
  }
}

const once = process.argv.includes("--once");
if (API_KEY === "PASTE_YOUR_API_KEY_HERE") {
  console.error("Set GOOGLE_MAPS_API_KEY (env var) or edit API_KEY in this file before running.");
  process.exit(1);
}

if (once) {
  pollAll();
} else {
  console.log(`Polling every ${INTERVAL_MIN} min, active hours ${ACTIVE_HOURS.start}:00-${ACTIVE_HOURS.end}:00, daily cap ${DAILY_CALL_CAP} calls.`);
  pollAll();
  setInterval(pollAll, INTERVAL_MIN * 60 * 1000);
}
