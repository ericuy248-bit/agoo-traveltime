/**
 * Agoo Corridor — Automated Travel-Time Logger (v3, directional + E-W)
 * -----------------------------------------------------------------------
 * Changes in this version:
 *   1. NORTH-SOUTH HIGHWAY IS NOW SPLIT BY DIRECTION. A single Directions
 *      API call is one-directional (origin -> destination), so the old
 *      3-segment list only ever measured one direction per block. Each
 *      highway block is now two segments: *_SB (I-high to I-low) and
 *      *_NB (I-low to I-high) — important because the NB bus stop between
 *      I1-I2 can make NB and SB congestion genuinely different.
 *   2. EAST-WEST CROSS-STREET SEGMENTS ADDED (one pair of flanking points
 *      per intersection: Verceles/I1, Grotto-Tabora/I2, Cases-Asprer/I3,
 *      Calvary/I4). These have NO reliable "expected distance" yet, so
 *      they are marked has_expected:false and are exempt from the
 *      distance pass/fail check (informational only).
 *   3. NOTE ON DATA QUALITY: Google's live-traffic layer depends on GPS
 *      probe density from navigation users. A national highway usually
 *      has enough; a short residential cross street often does not. If
 *      an E-W segment's duration_traffic_s keeps coming back identical
 *      to duration_typical_s (TTI stuck at 1.000), that is very likely
 *      Google reporting "no live data," not "no congestion" — flagged
 *      automatically in the low_traffic_data column below.
 *
 *   4. UPSTREAM/DOWNSTREAM BOUNDARY POINTS ADDED: N0 (~150 m north of I1)
 *      and S0 (~150 m south of I4), each as a directional pair against
 *      their neighbouring intersection (N0_I1_SB/I1_N0_NB, I4_S0_SB/
 *      S0_I4_NB). These sit outside any intersection's direct influence,
 *      so they give a "free-flow" reference speed for the corridor ends
 *      and double as boundary-condition inputs for the LWR/SUMO models.
 *
 *   5. RECORDING WINDOWS NOW SUPPORT MINUTE PRECISION AND MULTIPLE RANGES.
 *      The old ACTIVE_HOURS_PH only understood whole hours (e.g. 6 to 18).
 *      TIME_WINDOWS_PH now takes exact "HH:MM" start/end pairs — e.g.
 *      06:30 to 08:00 — and you can list more than one window (the other
 *      two field-protocol peaks are included, commented out, ready to
 *      enable). Only rounds falling inside a listed window are logged.
 *
 * Requires Node 18+ (built-in fetch). No extra packages.
 */

const fs = require("fs");
const path = require("path");

// ---------- CONFIG ----------
const API_KEY = process.env.GOOGLE_MAPS_API_KEY || "PASTE_YOUR_API_KEY_HERE";
const INTERVAL_MIN = 15;
const PH_UTC_OFFSET_HOURS = 8;                    // Philippines has no DST; always UTC+8

// Recording windows, in Philippine local time, "HH:MM" 24-hour, minute
// precision (not just whole hours) — start is inclusive, end is exclusive,
// so "06:30".."08:00" samples 06:30, 06:45, 07:00, 07:15, 07:30, 07:45
// (six 15-minute bins) and stops before 08:00. Add more objects to this
// array for additional peak windows, e.g. the 11:00-13:00 and 16:30-17:30
// windows from the field protocol — each is independent and can have its
// own start/end.
const TIME_WINDOWS_PH = [
  { start: "06:30", end: "08:00" },
  // { start: "11:00", end: "13:00" },
  // { start: "16:30", end: "17:30" },
];
const OUT_DIR = path.join(__dirname, "traveltime_logs");
const DAILY_CALL_CAP = 400;
const DISTANCE_TOLERANCE = 0.30;                  // allow +/-30% vs expected block length

// EDIT ALL COORDINATES with real lat,lng (right-click the point in Google
// Maps, copy the lat,lng shown at the top of the context menu).
//
// Highway (N-S) blocks — each now split into two directional segments.
// has_expected:true means the distance_check column will flag mismatches.
const HIGHWAY_SEGMENTS = [
  { id: "N0_I1_SB", label: "N0 (~150m N of I1) -> I1 southbound (upstream approach)",
    origin: "16.32717385727822,120.36629557772648",
    destination: "16.325846,120.366633",
    expected_m: 150, has_expected: true },
  { id: "I1_N0_NB", label: "I1 -> N0 (~150m N of I1) northbound (upstream approach)",
    origin: "16.325846,120.366633",
    destination: "16.32717385727822,120.36629557772648",
    expected_m: 150, has_expected: true },

  { id: "I1_I2_SB", label: "I1->I2 southbound (Verceles to Grotto/Tabora)",
    origin: "16.325846,120.366633",
    destination: "16.323141,120.367084",
    expected_m: 310, has_expected: true },
  { id: "I2_I1_NB", label: "I2->I1 northbound (Grotto/Tabora to Verceles)",
    origin: "16.323141,120.367084",
    destination: "16.325846,120.366633",
    expected_m: 310, has_expected: true },

  { id: "I2_I3_SB", label: "I2->I3 southbound (Grotto/Tabora to Cases/Asprer)",
    origin: "16.323141,120.367084",
    destination: "16.321961,120.367344",
    expected_m: 136, has_expected: true },
  { id: "I3_I2_NB", label: "I3->I2 northbound (Cases/Asprer to Grotto/Tabora)",
    origin: "16.321961,120.367344",
    destination: "16.323141,120.367084",
    expected_m: 136, has_expected: true },

  { id: "I3_I4_SB", label: "I3->I4 southbound (Cases/Asprer to Calvary)",
    origin: "16.321961,120.367344",
    destination: "16.320234,120.367705",
    expected_m: 200, has_expected: true },
  { id: "I4_I3_NB", label: "I4->I3 northbound (Calvary to Cases/Asprer)",
    origin: "16.320234,120.367705",
    destination: "16.321961,120.367344",
    expected_m: 200, has_expected: true },

  { id: "I4_S0_SB", label: "I4 -> S0 (~150m S of I4) southbound (downstream approach)",
    origin: "16.320234,120.367705",
    destination: "16.318892764628448,120.36792339760221",
    expected_m: 150, has_expected: true },
  { id: "S0_I4_NB", label: "S0 (~150m S of I4) -> I4 northbound (downstream approach)",
    origin: "16.318892764628448,120.36792339760221",
    destination: "16.320234,120.367705",
    expected_m: 150, has_expected: true },
];

// East-West cross-street segments — one pair of flanking points per
// intersection, roughly 100-150 m either side of the highway crossing.
// No fixed expected distance yet: measure once you've picked the points,
// then you may fill expected_m in and flip has_expected to true.
const EASTWEST_SEGMENTS = [
  { id: "I1_EW", label: "Verceles St. crossing at I1 (west to east)",
    origin: "16.325606172334584,120.36524287899847",
    destination: "16.326097159196078,120.36800871652888",
    expected_m: null, has_expected: false },
  { id: "I2_EW", label: "Grotto Rd./G. Tabora Rd. crossing at I2 (west to east)",
    origin: "16.32283378947204,120.36569648947528",
    destination: "16.323453430346508,120.36845286040885",
    expected_m: null, has_expected: false },
  { id: "I3_EW", label: "Cases Blvd./T. Asprer St. crossing at I3 (west to east)",
    origin: "16.321570481392243,120.36600291832497",
    destination: "16.322326933481772,120.3687111660094",
    expected_m: null, has_expected: false },
  { id: "I4_EW", label: "Calvary Rd. crossing at I4 (west to east)",
    origin: "16.31992513087929,120.36633827584097",
    destination: "16.320548400803762,120.36906968663082",
    expected_m: null, has_expected: false },
];

const SEGMENTS = [...HIGHWAY_SEGMENTS, ...EASTWEST_SEGMENTS];
// ---------- END CONFIG ----------

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let callsToday = 0;
let lastDayPH = phDateStr();

function phNow() {
  const utcMs = Date.now();
  return new Date(utcMs + PH_UTC_OFFSET_HOURS * 3600 * 1000);
}
function phDateStr() { return phNow().toISOString().slice(0, 10); }
function phMinutesOfDay() {
  const d = phNow();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function hhmmToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function phTimeLabel() {
  const d = phNow();
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} PHT`;
}

function resetDailyCounterIfNeeded() {
  const today = phDateStr();
  if (today !== lastDayPH) { lastDayPH = today; callsToday = 0; }
}
function withinActiveHours() {
  const nowMin = phMinutesOfDay();
  return TIME_WINDOWS_PH.some(w => nowMin >= hhmmToMin(w.start) && nowMin < hhmmToMin(w.end));
}
function activeWindowsLabel() {
  return TIME_WINDOWS_PH.map(w => `${w.start}-${w.end}`).join(", ");
}
function csvPath(segId) {
  return path.join(OUT_DIR, `traveltime_${segId}_${phDateStr()}.csv`);
}
function ensureHeader(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file,
      "timestamp_utc,timestamp_ph,segment_id,label,axis,duration_typical_s,duration_traffic_s,tti,distance_m,expected_distance_m,distance_check,speed_kmh,low_traffic_data\n");
  }
}

function axisOf(seg) {
  return HIGHWAY_SEGMENTS.includes(seg) ? "NS_highway" : "EW_cross";
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
    return null;
  }

  const leg = data.routes[0].legs[0];
  const durationTypical = leg.duration.value;
  const durationTraffic = (leg.duration_in_traffic || leg.duration).value;
  const distance = leg.distance.value;
  const tti = (durationTraffic / durationTypical).toFixed(3);
  const speedKmh = (distance / durationTraffic * 3.6).toFixed(1);
  const lowTrafficData = (durationTraffic === durationTypical) ? "POSSIBLE" : "";

  let distanceCheck = "N/A";
  if (seg.has_expected) {
    const lowBound = seg.expected_m * (1 - DISTANCE_TOLERANCE);
    const highBound = seg.expected_m * (1 + DISTANCE_TOLERANCE);
    distanceCheck = (distance >= lowBound && distance <= highBound) ? "OK" : "CHECK_COORDINATES";
  }

  const axis = axisOf(seg);
  const ph = phTimeLabel();
  const utc = new Date().toISOString();
  const expectedStr = seg.has_expected ? seg.expected_m : "";

  const file = csvPath(seg.id);
  ensureHeader(file);
  fs.appendFileSync(file,
    `${utc},${ph},${seg.id},"${seg.label}",${axis},${durationTypical},${durationTraffic},${tti},${distance},${expectedStr},${distanceCheck},${speedKmh},${lowTrafficData}\n`);

  const flag = distanceCheck === "CHECK_COORDINATES" ? " *** CHECK_COORDINATES ***" : "";
  const ltd = lowTrafficData ? " [possible low live-traffic data]" : "";
  console.log(`[${ph}] ${seg.id} (${axis}): dist=${distance}m${seg.has_expected ? ` (expected ~${seg.expected_m}m)` : ""}${flag}  TTI=${tti} speed=${speedKmh}km/h${ltd}`);
  return { seg, distanceCheck };
}

async function pollAll() {
  resetDailyCounterIfNeeded();
  if (callsToday + SEGMENTS.length > DAILY_CALL_CAP) {
    console.warn("Daily call cap reached — skipping this round to stay in the free tier.");
    return;
  }
  if (!withinActiveHours()) {
    console.log(`Outside recording window(s) [${activeWindowsLabel()}] (PH time is ${phTimeLabel()}) — skipping.`);
    return;
  }
  for (const seg of SEGMENTS) {
    try { await fetchOne(seg); callsToday++; }
    catch (e) { console.error(`[${seg.id}] request failed:`, e.message); }
  }
}

async function verifyAll() {
  console.log("=== VERIFY MODE: checking all segments, ignoring active-hours/day-cap filters ===");
  console.log(`Current Philippine time: ${phTimeLabel()}\n`);
  let allOk = true;
  for (const seg of SEGMENTS) {
    if (seg.origin.startsWith("REPLACE_WITH") || seg.destination.startsWith("REPLACE_WITH")) {
      console.error(`[${seg.id}] SKIPPED — placeholder coordinates still in this segment. Edit the script first.`);
      allOk = false;
      continue;
    }
    const result = await fetchOne(seg);
    if (!result) { allOk = false; continue; }
    if (result.seg.has_expected && result.distanceCheck !== "OK") allOk = false;
  }
  console.log("\n=== RESULT: " + (allOk ? "ALL CHECKABLE SEGMENTS PASSED — safe to trust the schedule." : "ONE OR MORE SEGMENTS FAILED OR ARE UNCONFIGURED — fix before relying on scheduled runs.") + " ===");
  console.log("(East-West segments with no expected distance are informational only and always print N/A.)");
}

const verify = process.argv.includes("--verify");
const once = process.argv.includes("--once");

if (API_KEY === "PASTE_YOUR_API_KEY_HERE") {
  console.error("Set GOOGLE_MAPS_API_KEY (env var) or edit API_KEY in this file before running.");
  process.exit(1);
}

if (verify) {
  verifyAll();
} else if (once) {
  pollAll();
} else {
  console.log(`Polling every ${INTERVAL_MIN} min inside window(s) [${activeWindowsLabel()}] PH time, daily cap ${DAILY_CALL_CAP} calls, ${SEGMENTS.length} segments/round.`);
  pollAll();
  setInterval(pollAll, INTERVAL_MIN * 60 * 1000);
}

