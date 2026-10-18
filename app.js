// Hoboken street cleaning map. Curb schedules and holidays come from data/
// (built by scripts/build_data.py); temporary no-parking signs are fetched
// live from the city's sign map API, falling back to the last snapshot.

const SIGNS_API = "https://api-hpuvp.hobokennj.gov/api/v1";
const TZ = "America/New_York";
const COLORS = { now: "#dc2626", later: "#f59e0b", clear: "#16a34a", none: "#9ca3af" };
const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const REASONS = { MOVING: "Moving", CONSTRUCTION: "Construction", EVENT: "Event", DELIVERY: "Delivery", FILMSHOOT: "Film shoot" };

// mode "moment": one date and time. mode "trip": the car sits from trip.from
// to trip.to (each {date, minutes}) and we look for any cleaning in between.
const state = { mode: "moment", date: null, minutes: 0, live: true, showSigns: true, trip: null };
let curbs = null;            // FeatureCollection sent to the map (id, side, status only)
const curbProps = new Map(); // id -> full properties (rules, block, source)
const curbCoords = new Map(); // id -> [lon, lat][]
const holidays = new Map();  // "YYYY-MM-DD" -> name
let signs = [];
let map, popup;

// ---------------------------------------------------------------- time math
// Dates are plain "YYYY-MM-DD" strings and times are minutes after midnight,
// both in Hoboken time, so nothing depends on the viewer's time zone.

function hobokenNow() {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date())) p[type] = value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}
const utc = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (iso, n) => { const t = utc(iso); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const isoDow = (iso) => utc(iso).getUTCDay() || 7; // 1 = Monday ... 7 = Sunday
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

function fmtTime(min, withMeridiem = true) {
  const h24 = Math.floor(min / 60) % 24, m = min % 60;
  const h = h24 % 12 || 12;
  const t = m ? `${h}:${String(m).padStart(2, "0")}` : `${h}`;
  return withMeridiem ? `${t} ${h24 < 12 ? "am" : "pm"}` : t;
}
function fmtRange(start, end) {
  const a = typeof start === "number" ? start : toMin(start);
  const b = typeof end === "number" ? end : toMin(end);
  return (a < 720) === (b < 720) ? `${fmtTime(a, false)}–${fmtTime(b)}` : `${fmtTime(a)}–${fmtTime(b)}`;
}
const fmtDate = (iso, opts = { weekday: "short", month: "short", day: "numeric" }) =>
  new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(utc(iso));
function fmtDays(days) {
  const run = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  return run ? `${DAY[days[0] - 1]}–${DAY[days[days.length - 1] - 1]}` : days.map((d) => DAY[d - 1]).join(", ");
}
const fmtRule = (r) => `${fmtDays(r.days)} ${fmtRange(r.start, r.end)}`;

// ------------------------------------------------------------ street rules

function statusFor(rules, date, minutes) {
  if (!rules.length) return "none";
  if (holidays.has(date)) return "clear";
  const dow = isoDow(date);
  let later = false;
  for (const r of rules) {
    if (!r.days.includes(dow)) continue;
    const s = toMin(r.start), e = toMin(r.end);
    if (minutes >= s && minutes < e) return "now";
    if (s > minutes) later = true;
  }
  return later ? "later" : "clear";
}

// The next cleaning window at or after (date, minutes), skipping holidays.
function nextCleaning(rules, date, minutes) {
  for (let off = 0; off < 21; off++) {
    const d = addDays(date, off);
    if (holidays.has(d)) continue;
    const dow = isoDow(d);
    const wins = rules
      .filter((r) => r.days.includes(dow))
      .map((r) => ({ s: toMin(r.start), e: toMin(r.end) }))
      .filter((w) => off > 0 || w.e > minutes)
      .sort((a, b) => a.s - b.s);
    if (wins.length) return { date: d, off, ...wins[0] };
  }
  return null;
}

// --------------------------------------------------------------- trip mode

const MAX_TRIP_DAYS = 62;
const tripValid = (t) => t.from.date < t.to.date || (t.from.date === t.to.date && t.from.minutes < t.to.minutes);
const fmtWhen = (dt) => `${fmtDate(dt.date)}, ${fmtTime(dt.minutes)}`;

// Each day of the trip (or of [first, last] within it) with the minutes the car is parked: [lo, hi).
function* tripDays(t, first = t.from.date, last = t.to.date) {
  for (let d = first, n = 0; d <= last && n < MAX_TRIP_DAYS; d = addDays(d, 1), n++) {
    yield { date: d, lo: d === t.from.date ? t.from.minutes : 0, hi: d === t.to.date ? t.to.minutes : 1440 };
  }
}

// The first cleaning window that falls while the car is parked, or null.
function firstCleaningDuring(rules, t, { ignoreHolidays = false } = {}) {
  for (const { date, lo, hi } of tripDays(t)) {
    if (!ignoreHolidays && holidays.has(date)) continue;
    const dow = isoDow(date);
    const hit = rules
      .filter((r) => r.days.includes(dow))
      .map((r) => ({ s: toMin(r.start), e: toMin(r.end) }))
      .filter((w) => w.e > lo && w.s < hi)
      .sort((a, b) => a.s - b.s)[0];
    if (hit) return { date, ...hit };
  }
  return null;
}

function tripStatus(rules, t) {
  if (!rules.length) return "none";
  return firstCleaningDuring(rules, t) ? "now" : "clear";
}

// Weekday city holidays inside the trip (the ones that skip a cleaning).
const tripHolidays = (t) => [...tripDays(t)].filter((d) => holidays.has(d.date) && isoDow(d.date) <= 5).map((d) => d.date);

// ------------------------------------------------------------------- signs

const usDate = (s) => { const [m, d, y] = s.split("/"); return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`; };

function prepSign(s) {
  const start = toMin(s.start_time.slice(0, 5)), end = toMin(s.end_time.slice(0, 5));
  return {
    id: s.id, address: prettyAddress(s.address), reason: REASONS[s.reason] || titleCase(s.reason || "Reserved"),
    from: usDate(s.start_date), to: usDate(s.stop_date), start, end, allDay: end <= start,
    lon: +s.longitude, lat: +s.latitude,
  };
}
const signOnDate = (s, date) => s.from <= date && date <= s.to;
const signActiveAt = (s, minutes) => s.allDay || (minutes >= s.start && minutes < s.end);
// First day a sign's no-parking hours overlap the trip, or null.
function signDuringTrip(s, t) {
  const first = s.from > t.from.date ? s.from : t.from.date;
  const last = s.to < t.to.date ? s.to : t.to.date;
  for (const { date, lo, hi } of tripDays(t, first, last)) {
    const ws = s.allDay ? 0 : s.start, we = s.allDay ? 1440 : s.end;
    if (we > lo && ws < hi) return date;
  }
  return null;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/(\d)(St|Nd|Rd|Th)\b/g, (m, d, x) => d + x.toLowerCase());
}
function prettyAddress(a) {
  const m = /^0*(\d+)-0*(\d+)\s+(.*)$/.exec((a || "").trim());
  if (!m) return titleCase(a || "");
  const num = m[1] === m[2] ? m[1] : `${m[1]}–${m[2]}`;
  return `${num} ${titleCase(m[3])}`;
}

async function loadSigns() {
  const note = document.getElementById("signs-source");
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const pages = await Promise.all(["parking", "parking/future"].map((p) =>
      fetch(`${SIGNS_API}/${p}`, { signal: ctl.signal }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })));
    clearTimeout(timer);
    const byId = new Map();
    for (const page of pages) for (const s of page.data) byId.set(s.id, s);
    signs = [...byId.values()].map(prepSign);
    note.textContent = "Loaded live just now.";
  } catch (err) {
    try {
      const snap = await fetch("data/tnp_snapshot.json").then((r) => r.json());
      signs = snap.signs.map(prepSign);
      note.textContent = `The live feed didn't respond, so these are from a snapshot taken ${new Date(snap.fetched_at).toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" })}.`;
    } catch (_) {
      signs = [];
      note.textContent = "Couldn't load signs.";
    }
  }
  render();
}

// ------------------------------------------------------------------- popups

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STATUS_TEXT = { now: "Cleaning now", later: "Cleaning later this day", clear: "No more cleaning this day", none: "No schedule listed" };

function relDay(off) {
  return off === 0 ? "today" : off === 1 ? "tomorrow" : `in ${off} days`;
}

const TRIP_STATUS_TEXT = { now: "Cleaning while you're away", clear: "Clear the whole time", none: "No schedule listed" };

function tripRows(p) {
  const t = state.trip;
  if (!tripValid(t)) return `<div class="row">Pick a return time after you park.</div>`;
  const hit = firstCleaningDuring(p.rules, t);
  if (hit) {
    return `<div class="row"><b>First cleaning:</b> ${fmtDate(hit.date)}, ${fmtRange(hit.s, hit.e)}. Move the car before ${fmtTime(hit.s)}.</div>`;
  }
  const saved = firstCleaningDuring(p.rules, t, { ignoreHolidays: true });
  let html = `<div class="row">No cleaning from ${fmtWhen(t.from)} to ${fmtWhen(t.to)}.</div>`;
  if (saved) html += `<div class="row">${esc(holidays.get(saved.date))} (${fmtDate(saved.date)}) skips this curb's cleaning: no street cleaning on city holidays.</div>`;
  return html;
}

function curbPopup(p) {
  const trip = state.mode === "trip";
  const status = trip ? (tripValid(state.trip) ? tripStatus(p.rules, state.trip) : "none") : statusFor(p.rules, state.date, state.minutes);
  const side = p.side_name ? `${p.side_name} side` : "";
  const block = [p.from, p.to].filter((x) => x && x !== "end").join(" → ") || "";
  let html = `<div class="pop"><span class="tag ${status}">${(trip ? TRIP_STATUS_TEXT : STATUS_TEXT)[status]}</span>
    <h3>${esc(p.street)}${side ? " · " + side : ""}</h3>${block ? `<p class="block">${esc(block)}</p>` : ""}`;
  if (p.rules.length && trip) {
    html += `<div class="row"><b>Street cleaning:</b> ${p.rules.map(fmtRule).join("; ")}</div>` + tripRows(p);
  } else if (p.rules.length) {
    html += `<div class="row"><b>Street cleaning:</b> ${p.rules.map(fmtRule).join("; ")}</div>`;
    const hol = holidays.get(state.date);
    if (hol) html += `<div class="row">No cleaning on ${fmtDate(state.date)}: ${esc(hol)}.</div>`;
    const next = nextCleaning(p.rules, state.date, state.minutes);
    if (next) {
      const inProgress = next.off === 0 && state.minutes >= next.s;
      html += `<div class="row"><b>${inProgress ? "Cleaning until" : "Move by"}:</b> ${inProgress ? fmtTime(next.e) + " today" :
        `${fmtDate(next.date)}, ${fmtTime(next.s)} (${relDay(next.off)})`}</div>`;
    }
  } else {
    html += `<div class="row">The city's data lists no street cleaning for this curb. Check the posted signs.</div>`;
  }
  if (p.gis_rules) {
    html += `<div class="warn">The city's older GIS map (2019) lists ${p.gis_rules.map(fmtRule).join("; ")} here instead. Check the sign on the block.</div>`;
  }
  const src = { city: "City street cleaning schedule", gis: "City GIS map (2019); not on the current schedule page, so check the sign", none: "City data" }[p.source];
  html += `<div class="src">Source: ${src}</div></div>`;
  return html;
}

function signPopup(s) {
  const trip = state.mode === "trip";
  const active = !trip && signActiveAt(s, state.minutes);
  const dates = s.from === s.to ? fmtDate(s.from) : `${fmtDate(s.from)} – ${fmtDate(s.to)}`;
  const hours = s.allDay ? "all day" : fmtRange(s.start, s.end);
  const longTerm = s.to > addDays(trip ? state.trip.to.date : state.date, 365);
  return `<div class="pop"><span class="tag sign">No parking${trip ? " during your trip" : active ? " now" : ""}</span>
    <h3>${esc(s.address)}</h3><p class="block">${esc(s.reason)}</p>
    <div class="row"><b>When:</b> ${longTerm ? `${hours}, ongoing` : `${dates}, ${hours}`}</div>
    <div class="src">Source: city temporary no-parking sign map. Vehicles in an active sign zone can be towed.</div></div>`;
}

// ------------------------------------------------------------------ render

function setInput(id, value) { // don't fight someone mid-edit
  const el = document.getElementById(id);
  if (el !== document.activeElement && el.value !== value) el.value = value;
}

function renderControls() {
  const trip = state.mode === "trip";
  for (const b of document.querySelectorAll(".mode-btn")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
  document.getElementById("moment-controls").hidden = trip;
  document.getElementById("trip-controls").hidden = !trip;
  document.getElementById("legend-now").textContent = trip ? "Cleaning while you're away" : "Cleaning now: don't park";
  document.getElementById("legend-clear").textContent = trip ? "Clear the whole time" : "No more cleaning this day";
  document.getElementById("legend-later-row").hidden = trip;
  if (state.trip) {
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    setInput("trip-from-date", state.trip.from.date);
    setInput("trip-from-time", hhmm(state.trip.from.minutes));
    setInput("trip-to-date", state.trip.to.date);
    setInput("trip-to-time", hhmm(state.trip.to.minutes));
  }

  const today = hobokenNow().date;
  const days = document.getElementById("days");
  days.innerHTML = "";
  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  for (const d of week) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (holidays.has(d) ? " holiday" : "");
    b.setAttribute("aria-pressed", String(d === state.date));
    const label = d === today ? "Today" : DAY[isoDow(d) - 1];
    b.innerHTML = `${label}<small>${fmtDate(d, { month: "short", day: "numeric" })}</small>`;
    b.title = holidays.get(d) || fmtDate(d, { weekday: "long", month: "long", day: "numeric" });
    b.onclick = () => { state.date = d; state.live = false; render(); };
    days.appendChild(b);
  }
  // Any other date
  const wrap = document.createElement("label");
  wrap.className = "chip date-chip";
  const off = !week.includes(state.date);
  wrap.setAttribute("aria-pressed", String(off));
  wrap.title = "Pick another date";
  const input = document.createElement("input");
  input.type = "date";
  input.value = state.date;
  input.setAttribute("aria-label", "Pick another date");
  input.onchange = () => { if (input.value) { state.date = input.value; state.live = false; render(); } };
  wrap.appendChild(input);
  if (off) { wrap.style.background = "var(--ink)"; wrap.style.color = "#fff"; }
  days.appendChild(wrap);

  document.getElementById("time").value = state.minutes;
  document.getElementById("time-text").textContent = fmtTime(state.minutes);
  document.getElementById("now-btn").setAttribute("aria-pressed", String(state.live));
}

function render() {
  if (!curbs || !map || !map.getSource("curbs")) return;
  renderControls();
  const trip = state.mode === "trip";
  const valid = !trip || tripValid(state.trip);
  const counts = { now: 0, later: 0, clear: 0, none: 0 };
  for (const f of curbs.features) {
    const rules = curbProps.get(f.properties.id).rules;
    const st = !valid ? "none" : trip ? tripStatus(rules, state.trip) : statusFor(rules, state.date, state.minutes);
    f.properties.status = st;
    if (f.properties.side) counts[st]++;
  }
  map.getSource("curbs").setData(curbs);
  map.setLayoutProperty("signs", "visibility", state.showSigns ? "visible" : "none");
  if (trip) renderTrip(valid, counts);
  else renderMoment(counts);
  if (popup && popup.isOpen() && popup._hpRender) popup.setHTML(popup._hpRender());
}

function setSigns(list, isActive) {
  map.getSource("signs").setData({
    type: "FeatureCollection",
    features: list.map((s) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { id: s.id, active: isActive(s) },
    })),
  });
}

const andList = (xs) => xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join("; ")}; and ${xs[xs.length - 1]}`;

function renderTrip(valid, counts) {
  const t = state.trip;
  const banner = document.getElementById("banner");
  banner.classList.toggle("warn", !valid);
  if (!valid) {
    setSigns([], () => false);
    banner.hidden = false;
    banner.textContent = "Pick a return time after you park.";
    document.getElementById("summary").textContent = "";
    document.getElementById("signs-count").textContent = "";
    return;
  }
  const during = signs.filter((s) => signDuringTrip(s, t));
  setSigns(during, () => true);
  document.getElementById("signs-count").textContent = signs.length ? `(${during.length} during your trip)` : "";

  const hols = tripHolidays(t);
  const tooLong = addDays(t.from.date, MAX_TRIP_DAYS) <= t.to.date;
  banner.hidden = !(hols.length || tooLong);
  banner.classList.toggle("warn", tooLong);
  banner.textContent = tooLong ? "Only the first two months of a trip are checked."
    : hols.length ? `No street cleaning on ${andList(hols.map((d) => `${fmtDate(d)} (${holidays.get(d)})`))}.` : "";

  document.getElementById("summary").innerHTML =
    `${esc(fmtWhen(t.from))} → ${esc(fmtWhen(t.to))}: <b>${counts.clear}</b> curb sides are clear the whole time, ` +
    `<b>${counts.now}</b> get cleaned while you're away.` +
    `<span class="note" style="display:block;margin-top:4px">New no-parking signs can go up with as little as 3 days' notice, so signs booked after you park won't show here.</span>`;
}

function renderMoment(counts) {
  const banner = document.getElementById("banner");
  banner.classList.remove("warn");

  const onDay = signs.filter((s) => signOnDate(s, state.date));
  const activeNow = onDay.filter((s) => signActiveAt(s, state.minutes)).length;
  setSigns(onDay, (s) => signActiveAt(s, state.minutes));
  document.getElementById("signs-count").textContent = signs.length ? `(${activeNow} now, ${onDay.length} this day)` : "";

  const hol = holidays.get(state.date);
  const weekend = isoDow(state.date) >= 6;
  banner.hidden = !(hol || weekend);
  banner.textContent = hol ? `${hol}: street cleaning is suspended all day.`
    : weekend ? "No street cleaning on weekends." : "";

  const when = `${state.date === hobokenNow().date ? "Today" : fmtDate(state.date)} at ${fmtTime(state.minutes)}`;
  document.getElementById("summary").innerHTML = hol || weekend
    ? `${esc(when)}: no curbs being cleaned.`
    : `${esc(when)}: <b>${counts.now}</b> curb sides being cleaned, <b>${counts.later}</b> later this day.`;
}

// --------------------------------------------------------------------- map

// Curb sides are drawn this many pixels off the centerline, by zoom.
const OFFSET_STOPS = [[13, 1.2], [15, 2.5], [17, 5], [19, 11]];

function offsetAt(zoom) {
  if (zoom <= OFFSET_STOPS[0][0]) return OFFSET_STOPS[0][1];
  for (let i = 1; i < OFFSET_STOPS.length; i++) {
    const [z1, v1] = OFFSET_STOPS[i], [z0, v0] = OFFSET_STOPS[i - 1];
    if (zoom <= z1) return v0 + ((zoom - z0) / (z1 - z0)) * (v1 - v0);
  }
  return OFFSET_STOPS[OFFSET_STOPS.length - 1][1];
}

// Screen distance from a point to a curb side as drawn (offset included).
function curbDistance(id, pt) {
  const off = curbProps.get(id).side ? offsetAt(map.getZoom()) : 0;
  const px = curbCoords.get(id).map((c) => map.project(c));
  let best = Infinity;
  for (let i = 0; i + 1 < px.length; i++) {
    const dx = px[i + 1].x - px[i].x, dy = px[i + 1].y - px[i].y, len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * off, ny = (dx / len) * off; // right of the direction of travel, on screen
    const ax = px[i].x + nx, ay = px[i].y + ny;
    const k = Math.max(0, Math.min(1, ((pt.x - ax) * dx + (pt.y - ay) * dy) / (len * len)));
    best = Math.min(best, Math.hypot(pt.x - ax - k * dx, pt.y - ay - k * dy));
  }
  return best;
}

// The curb side drawn closest to a tap; both sides of a narrow street are
// within finger range, so the topmost hit isn't good enough.
function curbAt(pt) {
  const box = [[pt.x - 12, pt.y - 12], [pt.x + 12, pt.y + 12]];
  const ids = [...new Set(map.queryRenderedFeatures(box, { layers: ["curbs-hit"] }).map((f) => f.properties.id))];
  let best = null, bestD = 14;
  for (const id of ids) {
    const d = curbDistance(id, pt);
    if (d < bestD) { best = id; bestD = d; }
  }
  return best;
}

function addLayers() {
  map.addSource("curbs", { type: "geojson", data: curbs });
  map.addSource("signs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  const isSide = ["!=", ["get", "side"], null];
  const offset = ["interpolate", ["linear"], ["zoom"], ...OFFSET_STOPS.flatMap(([z, px]) => [z, ["case", isSide, px, 0]])];
  const color = ["match", ["get", "status"], "now", COLORS.now, "later", COLORS.later, "clear", COLORS.clear, COLORS.none];

  map.addLayer({
    id: "curbs", type: "line", source: "curbs",
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": color,
      "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.5, 15, 2.5, 17, 4.5, 19, 9],
      "line-offset": offset,
      "line-opacity": ["case", isSide, 0.95, 0.5],
    },
  });
  map.addLayer({ // wider invisible line for easier tapping
    id: "curbs-hit", type: "line", source: "curbs",
    paint: { "line-color": "#000", "line-opacity": 0, "line-width": 16, "line-offset": offset },
  });
  map.addLayer({
    id: "signs", type: "circle", source: "signs",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3.5, 16, 6, 19, 10],
      "circle-color": ["case", ["get", "active"], "#7c3aed", "#ffffff"],
      "circle-stroke-color": "#7c3aed",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 1.5, 17, 2.5],
    },
  });

  const openPopup = (lngLat, renderFn) => {
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ maxWidth: "300px", closeButton: true }).setLngLat(lngLat).setHTML(renderFn()).addTo(map);
    popup._hpRender = renderFn;
    keepClearOfPanel(popup);
  };
  map.on("click", (e) => {
    const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    const sign = state.showSigns && map.queryRenderedFeatures(box, { layers: ["signs"] })[0];
    if (sign) {
      const s = signs.find((x) => x.id === sign.properties.id);
      if (s) return openPopup([s.lon, s.lat], () => signPopup(s));
    }
    const id = curbAt(e.point);
    if (id) openPopup(e.lngLat, () => curbPopup(curbProps.get(id)));
  });
  for (const layer of ["signs", "curbs-hit"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }
}

// Pan the map so a popup isn't hidden under the control panel (left card on
// desktop, bottom sheet on phones).
function keepClearOfPanel(p) {
  const panel = document.getElementById("panel").getBoundingClientRect();
  const box = p.getElement().getBoundingClientRect();
  const overlaps = box.left < panel.right && box.right > panel.left && box.top < panel.bottom && box.bottom > panel.top;
  if (!overlaps) return;
  const bottomSheet = panel.top > window.innerHeight / 3;
  map.panBy(bottomSheet ? [0, box.bottom - panel.top + 12] : [box.left - panel.right - 12, 0]);
}

// Frame Hoboken in the part of the map the panel doesn't cover.
function fitHoboken() {
  const panel = document.getElementById("panel").getBoundingClientRect();
  const bottomSheet = panel.top > window.innerHeight / 3;
  const padding = bottomSheet
    ? { top: 50, bottom: window.innerHeight - panel.top + 10, left: 10, right: 50 }
    : { top: 20, bottom: 20, left: panel.right + 10, right: 60 };
  map.fitBounds([[-74.0440, 40.7360], [-74.0225, 40.7585]], { padding, duration: 0 });
}

// If the map can't start, say why in the panel instead of leaving it blank.
function showFatal(err) {
  console.error(err);
  const msg = String((err && err.message) || err);
  const banner = document.getElementById("banner");
  banner.hidden = false;
  banner.classList.add("error");
  banner.textContent = typeof maplibregl === "undefined"
    ? "The map library didn't load from unpkg.com. An ad blocker, extension or network filter may be blocking it."
    : /webgl/i.test(msg)
      ? "The map couldn't start because WebGL is off in this browser. In Chrome: Settings > System > turn on \u201cUse graphics acceleration when available\u201d, then relaunch."
      : `The map couldn't start: ${msg}`;
}

async function init() {
  const now = hobokenNow();
  state.date = now.date;
  state.minutes = now.minutes;
  renderControls(); // so the panel works (and has its real size) even if the map fails

  if (typeof maplibregl === "undefined") throw new Error("maplibregl is not defined");
  map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/positron",
    center: [-74.0323, 40.7445],
    zoom: 14.4,
    minZoom: 12,
    maxBounds: [[-74.12, 40.69], [-73.94, 40.80]],
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "top-right");
  fitHoboken();
  // Our layers only need the style itself, not every basemap tile ("load").
  const mapReady = new Promise((resolve) => map.once("style.load", resolve));

  map.on("error", (e) => console.warn("map:", e.error || e)); // tile hiccups shouldn't break the page

  const [geo, hol, meta] = await Promise.all([
    fetch("data/street_cleaning.geojson").then((r) => r.json()),
    fetch("data/holidays.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()).catch(() => ({})),
  ]);
  for (const h of hol.holidays) holidays.set(h.date, h.name);
  curbs = { type: "FeatureCollection", features: geo.features.map((f) => {
    curbProps.set(f.properties.id, f.properties);
    curbCoords.set(f.properties.id, f.geometry.coordinates);
    return { type: "Feature", geometry: f.geometry, properties: { id: f.properties.id, side: f.properties.side, status: "none" } };
  }) };
  if (meta.built_at) {
    document.getElementById("built-at").textContent =
      `Schedule last refreshed ${new Date(meta.built_at).toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" })}` +
      (meta.gis_last_edit ? `; the city's GIS street map was last edited ${fmtDate(meta.gis_last_edit, { month: "short", day: "numeric", year: "numeric" })}.` : ".");
  }

  // Controls
  document.getElementById("time").addEventListener("input", (e) => {
    state.minutes = +e.target.value; state.live = false; render();
  });
  document.getElementById("now-btn").addEventListener("click", () => {
    const n = hobokenNow(); state.date = n.date; state.minutes = n.minutes; state.live = true; render();
  });
  for (const b of document.querySelectorAll(".mode-btn")) {
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      if (state.mode === "trip" && !state.trip) { // default: park now, back tomorrow at the same time
        const n = hobokenNow(), m = Math.ceil(n.minutes / 15) * 15 % 1440;
        state.trip = { from: { date: n.date, minutes: m }, to: { date: addDays(n.date, 1), minutes: m } };
      }
      render();
    });
  }
  const readTrip = () => {
    const val = (id) => document.getElementById(id).value;
    const mins = (v) => { const [h, m] = v.split(":").map(Number); return h * 60 + m; };
    if (!val("trip-from-date") || !val("trip-to-date") || !val("trip-from-time") || !val("trip-to-time")) return;
    state.trip = {
      from: { date: val("trip-from-date"), minutes: mins(val("trip-from-time")) },
      to: { date: val("trip-to-date"), minutes: mins(val("trip-to-time")) },
    };
    render();
  };
  for (const id of ["trip-from-date", "trip-from-time", "trip-to-date", "trip-to-time"]) {
    document.getElementById(id).addEventListener("change", readTrip);
  }
  document.getElementById("signs-toggle").addEventListener("change", (e) => { state.showSigns = e.target.checked; render(); });
  const panel = document.getElementById("panel");
  document.getElementById("collapse-btn").addEventListener("click", (e) => {
    const collapsed = panel.classList.toggle("collapsed");
    e.target.textContent = collapsed ? "Show" : "Hide";
    e.target.setAttribute("aria-expanded", String(!collapsed));
  });
  setInterval(() => {
    if (!state.live || state.mode !== "moment") return;
    const n = hobokenNow(); state.date = n.date; state.minutes = n.minutes; render();
  }, 60 * 1000);

  await mapReady;
  addLayers();
  render();
  loadSigns();
}

init().catch(showFatal);
