// Hoboken street cleaning map. Curb schedules and holidays come from data/
// (built by scripts/build_data.py); temporary no-parking signs are fetched
// live from the city's sign map API, falling back to the last snapshot.

const SIGNS_API = "https://api-hpuvp.hobokennj.gov/api/v1";
const TZ = "America/New_York";
const COLORS = { now: "#dc2626", later: "#f59e0b", clear: "#16a34a", none: "#9ca3af" };
const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const REASONS = { MOVING: "Moving", CONSTRUCTION: "Construction", EVENT: "Event", DELIVERY: "Delivery", FILMSHOOT: "Film shoot" };

const state = { date: null, minutes: 0, live: true, showSigns: true };
let curbs = null;            // FeatureCollection sent to the map (id, side, status only)
const curbProps = new Map(); // id -> full properties (rules, block, source)
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

function curbPopup(p) {
  const status = statusFor(p.rules, state.date, state.minutes);
  const side = p.side_name ? `${p.side_name} side` : "";
  const block = [p.from, p.to].filter((x) => x && x !== "end").join(" → ") || "";
  let html = `<div class="pop"><span class="tag ${status}">${STATUS_TEXT[status]}</span>
    <h3>${esc(p.street)}${side ? " · " + side : ""}</h3>${block ? `<p class="block">${esc(block)}</p>` : ""}`;
  if (p.rules.length) {
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
  const active = signActiveAt(s, state.minutes);
  const dates = s.from === s.to ? fmtDate(s.from) : `${fmtDate(s.from)} – ${fmtDate(s.to)}`;
  const hours = s.allDay ? "all day" : fmtRange(s.start, s.end);
  const longTerm = s.to > addDays(state.date, 365);
  return `<div class="pop"><span class="tag sign">No parking${active ? " now" : ""}</span>
    <h3>${esc(s.address)}</h3><p class="block">${esc(s.reason)}</p>
    <div class="row"><b>When:</b> ${longTerm ? `${hours}, ongoing` : `${dates}, ${hours}`}</div>
    <div class="src">Source: city temporary no-parking sign map. Vehicles in an active sign zone can be towed.</div></div>`;
}

// ------------------------------------------------------------------ render

function renderControls() {
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
  const counts = { now: 0, later: 0, clear: 0, none: 0 };
  for (const f of curbs.features) {
    const st = statusFor(curbProps.get(f.properties.id).rules, state.date, state.minutes);
    f.properties.status = st;
    if (f.properties.side) counts[st]++;
  }
  map.getSource("curbs").setData(curbs);

  const onDay = signs.filter((s) => signOnDate(s, state.date));
  const activeNow = onDay.filter((s) => signActiveAt(s, state.minutes)).length;
  map.getSource("signs").setData({
    type: "FeatureCollection",
    features: onDay.map((s) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { id: s.id, active: signActiveAt(s, state.minutes) },
    })),
  });
  map.setLayoutProperty("signs", "visibility", state.showSigns ? "visible" : "none");
  document.getElementById("signs-count").textContent = signs.length ? `(${activeNow} now, ${onDay.length} this day)` : "";

  const banner = document.getElementById("banner");
  const hol = holidays.get(state.date);
  const weekend = isoDow(state.date) >= 6;
  banner.hidden = !(hol || weekend);
  banner.textContent = hol ? `${hol}: street cleaning is suspended all day.`
    : weekend ? "No street cleaning on weekends." : "";

  const when = `${state.date === hobokenNow().date ? "Today" : fmtDate(state.date)} at ${fmtTime(state.minutes)}`;
  document.getElementById("summary").innerHTML = hol || weekend
    ? `${esc(when)}: no curbs being cleaned.`
    : `${esc(when)}: <b>${counts.now}</b> curb sides being cleaned, <b>${counts.later}</b> later this day.`;

  if (popup && popup.isOpen() && popup._hpRender) popup.setHTML(popup._hpRender());
}

// --------------------------------------------------------------------- map

function addLayers() {
  map.addSource("curbs", { type: "geojson", data: curbs });
  map.addSource("signs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  const isSide = ["!=", ["get", "side"], null];
  const offset = ["interpolate", ["linear"], ["zoom"],
    13, ["case", isSide, 1.2, 0], 15, ["case", isSide, 2.5, 0], 17, ["case", isSide, 5, 0], 19, ["case", isSide, 11, 0]];
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
    const curb = map.queryRenderedFeatures(e.point, { layers: ["curbs-hit"] })[0];
    if (curb) openPopup(e.lngLat, () => curbPopup(curbProps.get(curb.properties.id)));
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

async function init() {
  const now = hobokenNow();
  state.date = now.date;
  state.minutes = now.minutes;

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
  renderControls(); // so the panel has its real size before framing the map
  fitHoboken();
  // Our layers only need the style itself, not every basemap tile ("load").
  const mapReady = new Promise((resolve) => map.once("style.load", resolve));

  const [geo, hol, meta] = await Promise.all([
    fetch("data/street_cleaning.geojson").then((r) => r.json()),
    fetch("data/holidays.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()).catch(() => ({})),
  ]);
  for (const h of hol.holidays) holidays.set(h.date, h.name);
  curbs = { type: "FeatureCollection", features: geo.features.map((f) => {
    curbProps.set(f.properties.id, f.properties);
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
  document.getElementById("signs-toggle").addEventListener("change", (e) => { state.showSigns = e.target.checked; render(); });
  const panel = document.getElementById("panel");
  document.getElementById("collapse-btn").addEventListener("click", (e) => {
    const collapsed = panel.classList.toggle("collapsed");
    e.target.textContent = collapsed ? "Show" : "Hide";
    e.target.setAttribute("aria-expanded", String(!collapsed));
  });
  setInterval(() => {
    if (!state.live) return;
    const n = hobokenNow(); state.date = n.date; state.minutes = n.minutes; render();
  }, 60 * 1000);

  await mapReady;
  addLayers();
  render();
  loadSigns();
}

init();
