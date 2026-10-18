#!/usr/bin/env python3
"""Build the data files behind the Hoboken parking map.

- Street segments and their street-cleaning schedule come from the City of
  Hoboken's ArcGIS layer. That layer was last edited in 2019, so every segment
  is cross-checked against the schedule table on hobokennj.gov, and the table
  wins when the two disagree.
- The city's holiday list (street cleaning is suspended on those days) and a
  snapshot of its temporary no-parking signs are saved alongside.

Everything is written to data/. Disagreements and table rows that could not be
placed on the map go to data/build_report.md.

Standard library only:  python3 scripts/build_data.py
"""
import collections
import datetime
import html
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OVERRIDES = ROOT / "scripts" / "overrides.json"

GIS_LAYER = ("https://services8.arcgis.com/LDmC4ZVHdfKcEzxl/arcgis/rest/services/"
             "Hoboken_Streets/FeatureServer/0")
SCHEDULE_URL = "https://www.hobokennj.gov/resources/street-cleaning-schedule"
HOLIDAYS_URL = "https://www.hobokennj.gov/holiday-schedule"
TNP_API = "https://api-hpuvp.hobokennj.gov/api/v1"
TNP_MAP_URL = "https://hpuvp.hobokennj.gov/parking"

# Used only if the holiday page can't be fetched or parsed.
FALLBACK_HOLIDAYS = [
    ("2026-01-01", "New Year's Day"), ("2026-01-19", "Martin Luther King Jr. Birthday"),
    ("2026-02-16", "Presidents Day"), ("2026-04-03", "Good Friday"),
    ("2026-05-25", "Memorial Day"), ("2026-06-19", "Juneteenth"),
    ("2026-07-03", "Independence Day"), ("2026-09-07", "Labor Day"),
    ("2026-10-12", "Columbus Day"), ("2026-11-03", "Election Day"),
    ("2026-11-11", "Veterans Day"), ("2026-11-26", "Thanksgiving Day"),
    ("2026-11-27", "Day after Thanksgiving"), ("2026-12-24", "Floating Holiday"),
    ("2026-12-25", "Christmas Day"),
]

SIDE_FIELDS = {"N": "STREETCLEANINGN", "S": "STREETCLEANINGS",
               "E": "STREETCLEANINGE", "W": "STREETCLEANINGW"}
SIDE_NAMES = {"N": "North", "S": "South", "E": "East", "W": "West"}
CARDINAL = {"N": (0, 1), "S": (0, -1), "E": (1, 0), "W": (-1, 0)}
DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

ORDINALS = {
    "first": "1st", "second": "2nd", "third": "3rd", "fourth": "4th", "fifth": "5th",
    "sixth": "6th", "seventh": "7th", "eighth": "8th", "ninth": "9th", "tenth": "10th",
    "eleventh": "11th", "twelfth": "12th", "thirteenth": "13th", "fourteenth": "14th",
    "fifteenth": "15th", "sixteenth": "16th", "seventeenth": "17th", "eighteenth": "18th",
}
SUFFIXES = {"street": "st", "avenue": "ave", "drive": "dr", "terrace": "ter",
            "place": "pl", "highway": "hwy", "boulevard": "blvd", "lane": "ln"}
# Names that refer to the same street as far as the schedule is concerned.
# scripts/overrides.json can add more.
STREET_ALIASES = {"sinatra dr n": "sinatra dr"}

# Local flat projection (meters) around Hoboken; plenty accurate at city scale.
LON0, LAT0 = -74.03, 40.745
MX = 111320 * math.cos(math.radians(LAT0))
MY = 110540
SNAP_M = 5.0  # vertices closer than this count as the same intersection
# When two streets don't share a vertex (gaps, streets that stop short), the
# crossing is taken where their lines meet if that point is this close to both.
NEAR_M = 200.0


def log(msg):
    print(msg, file=sys.stderr)


def fetch(url, as_json=False):
    req = urllib.request.Request(url, headers={
        "User-Agent": "hoboken-parking-map/0.1 (personal street-cleaning map)",
        "Accept": "application/json" if as_json else "text/html,*/*",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body) if as_json else body


def xy(lon, lat):
    return ((lon - LON0) * MX, (lat - LAT0) * MY)


def norm_street(name):
    s = (name or "").lower().replace(".", " ").strip()
    s = re.sub(r"^the\s+", "", s)
    s = " ".join(ORDINALS.get(w, SUFFIXES.get(w, w)) for w in s.split())
    return STREET_ALIASES.get(s, s)


# ---------------------------------------------------------------- schedules

def to_hhmm(hour, minute, ampm):
    h = int(hour) % 12 + (12 if ampm == "pm" else 0)
    return "%02d:%02d" % (h, int(minute or 0))


def parse_schedule(text):
    """'Monday through Friday - 8 am to 9 am' -> {'days': [1..5], 'start': '08:00', 'end': '09:00'}.
    Days are ISO weekdays (1 = Monday)."""
    s = text.lower().replace("noon", "pm").replace("12 pm pm", "12 pm")
    m = re.search(r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:to|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)", s)
    if not m:
        raise ValueError("no time range in %r" % text)
    daypart = s[:m.start()]
    found = [(d.start(), DAY_NAMES.index(d.group(0)) + 1)
             for d in re.finditer("|".join(DAY_NAMES), daypart)]
    if not found:
        raise ValueError("no day in %r" % text)
    if len(found) == 2 and re.search(r"through|thru|-|\bto\b", daypart[found[0][0]:found[1][0]]):
        days = list(range(found[0][1], found[1][1] + 1))
    else:
        days = sorted(set(d for _, d in found))
    return {"days": days, "start": to_hhmm(*m.group(1, 2, 3)), "end": to_hhmm(*m.group(4, 5, 6))}


def rule_key(rule):
    return (tuple(rule["days"]), rule["start"], rule["end"])


def rules_text(rules):
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    out = []
    for r in sorted(rules, key=rule_key):
        d = r["days"]
        days = ("%s-%s" % (names[d[0] - 1], names[d[-1] - 1]) if len(d) > 2
                else "/".join(names[x - 1] for x in d))
        out.append("%s %s-%s" % (days, r["start"], r["end"]))
    return "; ".join(out) or "-"


# ------------------------------------------------------------- GIS segments

def fetch_segments():
    feats, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": "1=1", "outFields": "FID,FULLNAME," + ",".join(SIDE_FIELDS.values()),
            "outSR": 4326, "f": "geojson", "orderByFields": "FID",
            "resultOffset": offset, "resultRecordCount": 1000,
        })
        page = fetch(GIS_LAYER + "/query?" + q, as_json=True)
        feats += page["features"]
        more = page.get("exceededTransferLimit") or (page.get("properties") or {}).get("exceededTransferLimit")
        if not more or not page["features"]:
            break
        offset += len(page["features"])
    info = fetch(GIS_LAYER + "?f=json", as_json=True)
    last_edit = (info.get("editingInfo") or {}).get("dataLastEditDate")
    return feats, last_edit


def build_segments(feats, anomalies):
    """Split multi-part lines, drop unnamed and duplicate segments."""
    segs, seen = [], {}
    for f in feats:
        p = f["properties"]
        name = (p.get("FULLNAME") or "").strip()
        geom = f.get("geometry") or {}
        parts = geom.get("coordinates") or []
        if geom.get("type") == "LineString":
            parts = [parts]
        if not name:
            continue
        for coords in parts:
            if len(coords) < 2:
                continue
            ends = sorted([tuple(round(c, 5) for c in coords[0]), tuple(round(c, 5) for c in coords[-1])])
            key = (norm_street(name), tuple(ends))
            gis = {s: (p.get(fld) or "").strip() for s, fld in SIDE_FIELDS.items()}
            if key in seen:
                prev = segs[seen[key]]
                if gis != prev["gis_text"]:
                    anomalies.append("Duplicate GIS segment on %s (FID %s and %s) with different schedules; kept FID %s."
                                     % (name, prev["fid"], p["FID"], prev["fid"]))
                continue
            seen[key] = len(segs)
            segs.append({
                "fid": p["FID"], "name": name, "street": norm_street(name),
                "coords": coords, "xy": [xy(*c[:2]) for c in coords], "gis_text": gis,
            })
    return segs


def index_streets(segs):
    """Per street: axis (EW/NS), unit direction (pointing east or north), and
    each segment's span along that direction."""
    by_street = collections.defaultdict(list)
    for i, s in enumerate(segs):
        by_street[s["street"]].append(i)
    streets = {}
    for key, idxs in by_street.items():
        pts = [p for i in idxs for p in segs[i]["xy"]]
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        sxx = sum((p[0] - cx) ** 2 for p in pts)
        syy = sum((p[1] - cy) ** 2 for p in pts)
        sxy = sum((p[0] - cx) * (p[1] - cy) for p in pts)
        ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
        ux, uy = math.cos(ang), math.sin(ang)
        # Which sides the GIS layer fills in says how the city thinks of a
        # diagonal street (Paterson Ave has north/south sides); else geometry.
        ns = sum(1 for i in idxs for sd in "NS" if segs[i]["gis_text"][sd])
        ew = sum(1 for i in idxs for sd in "EW" if segs[i]["gis_text"][sd])
        axis = "EW" if ns > ew else "NS" if ew > ns else ("EW" if abs(ux) >= abs(uy) else "NS")
        if (axis == "EW" and ux < 0) or (axis == "NS" and uy < 0):
            ux, uy = -ux, -uy
        streets[key] = {"axis": axis, "u": (ux, uy), "c": (cx, cy), "segs": idxs}
        for i in idxs:
            ts = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in segs[i]["xy"]]
            segs[i]["t"] = (min(ts), max(ts))
            segs[i]["tmid"] = (min(ts) + max(ts)) / 2
    return streets


def find_intersections(segs, streets):
    """crossings[street][other_street] = positions (t) along `street` where
    the two share a vertex. Also records each segment's cross street at each end."""
    cell = SNAP_M * 2
    grid = collections.defaultdict(list)
    for i, s in enumerate(segs):
        for p in s["xy"]:
            grid[(int(p[0] // cell), int(p[1] // cell))].append((i, p))
    crossings = collections.defaultdict(lambda: collections.defaultdict(list))
    for i, s in enumerate(segs):
        st = streets[s["street"]]
        ux, uy = st["u"]
        cx, cy = st["c"]
        ends = {0: set(), len(s["xy"]) - 1: set()}
        for vi, p in enumerate(s["xy"]):
            gx, gy = int(p[0] // cell), int(p[1] // cell)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for j, q in grid[(gx + dx, gy + dy)]:
                        o = segs[j]
                        if o["street"] == s["street"] or math.hypot(p[0] - q[0], p[1] - q[1]) > SNAP_M:
                            continue
                        crossings[s["street"]][o["street"]].append((p[0] - cx) * ux + (p[1] - cy) * uy)
                        if vi in ends:
                            ends[vi].add(o["name"])
        lo_end, hi_end = ends[0], ends[len(s["xy"]) - 1]
        ts = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in (s["xy"][0], s["xy"][-1])]
        if ts[0] > ts[1]:
            lo_end, hi_end = hi_end, lo_end
        s["from"] = " / ".join(sorted(lo_end)) or "end"
        s["to"] = " / ".join(sorted(hi_end)) or "end"
    return crossings


# ----------------------------------------------------------- city schedule

def fetch_schedule_rows():
    page = fetch(SCHEDULE_URL)
    rows = []
    for item in page.split('<div role="listitem" class="w-dyn-item">')[1:]:
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                 for c in re.findall(r"<h4>(.*?)</h4>", item, flags=re.S)]
        if len(cells) >= 4 and cells[0].lower() != "street":
            rows.append({"street": cells[0], "side": cells[1], "when": cells[2], "location": cells[3]})
    if len(rows) < 50:
        raise RuntimeError("Only %d rows parsed from the city schedule page; its layout may have changed." % len(rows))
    return rows


BOUNDARY_RE = re.compile(r"^(?:the\s+)?(north|south|east|west)(?:ern)?\s+boundary$")


def _line_meet(a1, a2, b1, b2):
    """Where the infinite lines through a1-a2 and b1-b2 meet (None if near-parallel)."""
    dax, day = a2[0] - a1[0], a2[1] - a1[1]
    dbx, dby = b2[0] - b1[0], b2[1] - b1[1]
    cross = dax * dby - day * dbx
    if abs(cross) < 0.35 * math.hypot(dax, day) * math.hypot(dbx, dby):  # < ~20 degrees
        return None
    k = ((b1[0] - a1[0]) * dby - (b1[1] - a1[1]) * dbx) / cross
    return (a1[0] + k * dax, a1[1] + k * day)


def _seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    k = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ((dx * dx + dy * dy) or 1)))
    return math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy)


def nearest_crossing(st, other, segs):
    """Best meeting point of two streets that don't share a vertex: (point, gap in m)."""
    best = None
    for i in st["segs"]:
        a = segs[i]["xy"]
        for j in other["segs"]:
            b = segs[j]["xy"]
            for a1, a2 in zip(a, a[1:]):
                for b1, b2 in zip(b, b[1:]):
                    p = _line_meet(a1, a2, b1, b2)
                    if p is None:
                        continue
                    gap = _seg_dist(p, a1, a2) + _seg_dist(p, b1, b2)
                    if best is None or gap < best[1]:
                        best = (p, gap)
    return best


def resolve_position(name, st_key, streets, segs, crossings):
    """Position along a street of a cross street or a boundary: (t, why_not, note)."""
    st = streets[st_key]
    m = BOUNDARY_RE.match(name.lower().replace(".", "").strip())
    if m:
        d = m.group(1)
        if st["axis"] == "EW" and d in ("east", "west"):
            return (math.inf if d == "east" else -math.inf), None, None
        if st["axis"] == "NS" and d in ("north", "south"):
            return (math.inf if d == "north" else -math.inf), None, None
        return None, "'%s' doesn't fit a street running %s" % (
            name, "east-west" if st["axis"] == "EW" else "north-south"), None
    other_key = norm_street(name)
    ts = crossings[st_key].get(other_key)
    if ts:
        ts = sorted(ts)
        return ts[len(ts) // 2], None, None
    if other_key not in streets:
        return None, "%s isn't in the city GIS layer" % name, None
    best = nearest_crossing(st, streets[other_key], segs)
    if not best or best[1] > NEAR_M:
        return None, "%s doesn't meet this street in the city GIS layer" % name, None
    (px, py), gap = best
    ux, uy = st["u"]
    cx, cy = st["c"]
    return (px - cx) * ux + (py - cy) * uy, None, "%s placed where the lines meet (%d m gap in GIS)" % (name, gap)


def apply_table(rows, segs, streets, crossings, overrides, report):
    """table_rules[(seg index, side)] = {rule_key: rule}."""
    fixes = {(f["street"], f["side"], f["location"]): f for f in overrides.get("location_fixes", [])}
    # (seg, side) -> {rule_key: (span, rule, row label)}; a narrower row is an
    # exception to a broader one covering the same curb (e.g. Grand St 10th-11th).
    candidates = collections.defaultdict(dict)
    for row in rows:
        fix = fixes.get((row["street"], row["side"], row["location"]))
        location = fix["use"] if fix else row["location"]
        label = "%s | %s | %s | %s" % (row["street"], row["side"], row["when"], row["location"])
        try:
            rule = parse_schedule(row["when"])
        except ValueError as e:
            report["unmatched"].append((label, str(e)))
            continue
        st_key = norm_street(row["street"])
        st = streets.get(st_key)
        if not st:
            report["unmatched"].append((label, "%s isn't in the city GIS layer" % row["street"]))
            continue
        ends = re.split(r"\s+(?:to|and)\s+", location.strip())
        if len(ends) != 2:
            report["unmatched"].append((label, "can't read location"))
            continue
        pos, why = [], None
        for e in ends:
            t, why, note = resolve_position(e, st_key, streets, segs, crossings)
            if why:
                break
            pos.append(t)
            if note:
                report["proximity"].append("%s: %s" % (label, note))
        if why:
            report["unmatched"].append((label, why))
            continue
        a, b = sorted(pos)
        hit = [i for i in st["segs"] if a < segs[i]["tmid"] < b]
        if not hit:  # a short range inside one long segment (Sinatra Dr 5th-6th)
            hit = [i for i in st["segs"] if min(segs[i]["t"][1], b) - max(segs[i]["t"][0], a) > 1.0]
        if not hit:
            report["unmatched"].append((label, "no GIS segments between those cross streets"))
            continue
        side = row["side"].strip().lower()
        sides = (["N", "S"] if st["axis"] == "EW" else ["E", "W"]) if side == "both" else [side[0].upper()]
        span = b - a
        for i in hit:
            for sd in sides:
                candidates[(i, sd)][rule_key(rule)] = (span, rule, label)
        report["matched"] += 1
        if fix:
            report["fixes"].append((label, fix["use"], fix.get("why", "")))
    table_rules = {}
    for (i, sd), cands in candidates.items():
        narrowest = min(span for span, _, _ in cands.values())
        keep = {k: r for k, (span, r, _) in cands.items() if span == narrowest}
        dropped = sorted(set(lbl for span, _, lbl in cands.values() if span != narrowest))
        if dropped:
            kept = sorted(set(lbl for span, _, lbl in cands.values() if span == narrowest))
            report["overlaps"].add("%s overrides %s" % (" + ".join(kept), " + ".join(dropped)))
        table_rules[(i, sd)] = keep
    return table_rules


# ------------------------------------------------------------------ output

def orient_for_side(coords, xys, side):
    """Return coords ordered so `side` is on the right of the direction of
    travel; the map then draws it with a positive line-offset."""
    dx, dy = xys[-1][0] - xys[0][0], xys[-1][1] - xys[0][1]
    cx, cy = CARDINAL[side]
    right = (dy, -dx)
    return coords if right[0] * cx + right[1] * cy >= 0 else coords[::-1]


def build_features(segs, streets, table_rules, report):
    feats = []
    for i, s in enumerate(segs):
        st = streets[s["street"]]
        axis_sides = ["N", "S"] if st["axis"] == "EW" else ["E", "W"]
        off_axis = [sd for sd in SIDE_FIELDS if sd not in axis_sides and s["gis_text"][sd]]
        if off_axis:
            report["anomalies"].append("%s (FID %s) runs %s but the GIS layer has a schedule for its %s side; ignored."
                                       % (s["name"], s["fid"], "east-west" if st["axis"] == "EW" else "north-south",
                                          "/".join(SIDE_NAMES[x] for x in off_axis)))
        base = {"street": s["name"], "from": s["from"], "to": s["to"], "fid": s["fid"]}
        any_rules = False
        sides_out = []
        for sd in axis_sides:
            gis_rules = []
            if s["gis_text"][sd]:
                try:
                    gis_rules = [parse_schedule(s["gis_text"][sd])]
                except ValueError as e:
                    report["anomalies"].append("FID %s %s side: %s" % (s["fid"], SIDE_NAMES[sd], e))
            city = list(table_rules.get((i, sd), {}).values())
            alt = None
            if city:
                rules, source = city, "city"
                if gis_rules and set(map(rule_key, gis_rules)) != set(map(rule_key, city)):
                    alt = gis_rules
                    report["disagree"].append((s["name"], "%s to %s" % (s["from"], s["to"]),
                                               SIDE_NAMES[sd], rules_text(gis_rules), rules_text(city)))
                elif not gis_rules:
                    report["city_only"] += 1
                else:
                    report["agree"] += 1
            elif gis_rules:
                rules, source = gis_rules, "gis"
                report["gis_only"].append((s["name"], "%s to %s" % (s["from"], s["to"]), SIDE_NAMES[sd], rules_text(gis_rules)))
            else:
                rules, source = [], "none"
            any_rules = any_rules or bool(rules)
            sides_out.append((sd, rules, source, alt))
        if any_rules:
            for sd, rules, source, alt in sides_out:
                props = dict(base, id="%s-%s" % (s["fid"], sd), side=sd, side_name=SIDE_NAMES[sd],
                             rules=sorted(rules, key=rule_key), source=source)
                if alt:
                    props["gis_rules"] = alt
                feats.append({"type": "Feature", "properties": props, "geometry": {
                    "type": "LineString", "coordinates": orient_for_side(s["coords"], s["xy"], sd)}})
        else:
            props = dict(base, id="%s" % s["fid"], side=None, side_name=None, rules=[], source="none")
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "LineString", "coordinates": s["coords"]}})
    for f in feats:  # trim coordinates to ~1 m
        f["geometry"]["coordinates"] = [[round(c[0], 6), round(c[1], 6)] for c in f["geometry"]["coordinates"]]
    return feats


def fetch_holidays():
    text = html.unescape(re.sub(r"<[^>]+>", "\n", fetch(HOLIDAYS_URL)))
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    out = []
    for n, line in enumerate(lines):
        m = re.match(r"^(?:\w+day),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$", line)
        if m and n + 1 < len(lines):
            d = datetime.datetime.strptime(" ".join(m.groups()), "%B %d %Y").date()
            out.append({"date": d.isoformat(), "name": lines[n + 1].replace("’", "'")})
    if len(out) < 5:
        raise RuntimeError("Only %d holidays parsed" % len(out))
    return out


def fetch_signs():
    signs = {}
    for path in ("parking", "parking/future"):
        for s in fetch("%s/%s" % (TNP_API, path), as_json=True)["data"]:
            signs[s["id"]] = s
    return sorted(signs.values(), key=lambda s: (s["start_date"][-4:] + s["start_date"], s["id"]))


def write_json(name, obj):
    (DATA / name).write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")


def write_report(report, meta, overrides):
    md = ["# Street cleaning build report", "",
          "Built %s. City GIS layer last edited %s." % (meta["built_at"], meta["gis_last_edit"] or "unknown"), "",
          "- City table rows placed on the map: **%d** of %d" % (report["matched"], report["rows"]),
          "- Curb sides where city table and GIS agree: %d" % report["agree"],
          "- Curb sides where they **disagree** (city table used): %d" % len(report["disagree"]),
          "- Curb sides only in the city table: %d" % report["city_only"],
          "- Curb sides only in GIS (GIS used, may be stale): %d" % len(report["gis_only"]), ""]
    if overrides.get("street_aliases"):
        md += ["## Street aliases (scripts/overrides.json)", "", "| Schedule name | GIS name | Why |", "|---|---|---|"]
        md += ["| %s | %s | %s |" % (k, v["to"], v.get("why", "")) for k, v in overrides["street_aliases"].items()] + [""]
    if report["fixes"]:
        md += ["## Manual location fixes (scripts/overrides.json)", "", "| Row | Read as | Why |", "|---|---|---|"]
        md += ["| %s | %s | %s |" % f for f in report["fixes"]] + [""]
    md += ["## Disagreements (city table wins)", "", "| Street | Block | Side | GIS (2019) | City table |", "|---|---|---|---|---|"]
    md += ["| %s | %s | %s | %s | %s |" % d for d in sorted(report["disagree"])] + [""]
    md += ["## City table rows not placed on the map", "", "| Row | Why |", "|---|---|"]
    md += ["| %s | %s |" % u for u in report["unmatched"]] + [""]
    md += ["## Curb sides only in GIS", "", "| Street | Block | Side | GIS schedule |", "|---|---|---|---|"]
    md += ["| %s | %s | %s | %s |" % g for g in sorted(report["gis_only"])] + [""]
    if report["overlaps"]:
        md += ["## Overlapping rows (narrower row wins)", ""] + ["- " + o for o in sorted(report["overlaps"])] + [""]
    if report["proximity"]:
        md += ["## Cross streets placed by line intersection", ""] + ["- " + p for p in report["proximity"]] + [""]
    if report["anomalies"]:
        md += ["## Other notes", ""] + ["- " + a for a in report["anomalies"]] + [""]
    (DATA / "build_report.md").write_text("\n".join(md), encoding="utf-8")


def main():
    DATA.mkdir(exist_ok=True)
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}
    for name, alias in overrides.get("street_aliases", {}).items():
        STREET_ALIASES[norm_street(name)] = norm_street(alias["to"])
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    report = {"matched": 0, "agree": 0, "city_only": 0, "rows": 0, "disagree": [],
              "gis_only": [], "unmatched": [], "fixes": [], "anomalies": [],
              "proximity": [], "overlaps": set()}

    log("Fetching street segments from the city GIS layer...")
    raw, last_edit = fetch_segments()
    segs = build_segments(raw, report["anomalies"])
    streets = index_streets(segs)
    crossings = find_intersections(segs, streets)
    log("  %d features -> %d segments on %d streets" % (len(raw), len(segs), len(streets)))

    log("Fetching the city's street cleaning schedule table...")
    rows = fetch_schedule_rows()
    report["rows"] = len(rows)
    table_rules = apply_table(rows, segs, streets, crossings, overrides, report)
    feats = build_features(segs, streets, table_rules, report)
    write_json("street_cleaning.geojson", {"type": "FeatureCollection", "features": feats})
    log("  %d of %d table rows placed; %d curb features written" % (report["matched"], len(rows), len(feats)))

    log("Fetching holidays...")
    try:
        holidays, hol_source = fetch_holidays(), HOLIDAYS_URL
    except Exception as e:  # keep building; the fallback list covers 2026
        log("  WARNING: %s; using the built-in 2026 list" % e)
        holidays, hol_source = [{"date": d, "name": n} for d, n in FALLBACK_HOLIDAYS], "built-in fallback"
    write_json("holidays.json", {"source": hol_source, "holidays": holidays})
    log("  %d holidays" % len(holidays))

    log("Fetching temporary no-parking signs...")
    try:
        signs = fetch_signs()
        write_json("tnp_snapshot.json", {"fetched_at": now.isoformat(), "signs": signs})
        log("  %d signs" % len(signs))
    except Exception as e:  # the old snapshot stays in place
        log("  WARNING: couldn't fetch signs (%s); keeping the previous snapshot" % e)

    gis_edit = (datetime.datetime.fromtimestamp(last_edit / 1000, datetime.timezone.utc).date().isoformat()
                if last_edit else None)
    meta = {
        "built_at": now.isoformat(), "gis_last_edit": gis_edit,
        "counts": {"rows": len(rows), "rows_placed": report["matched"], "curbs": len(feats),
                   "disagreements": len(report["disagree"]), "gis_only": len(report["gis_only"])},
        "sources": {"gis": GIS_LAYER, "schedule": SCHEDULE_URL, "holidays": HOLIDAYS_URL,
                    "signs_api": TNP_API, "signs_map": TNP_MAP_URL},
    }
    write_json("meta.json", meta)
    write_report(report, meta, overrides)
    log("Done. See data/build_report.md")


if __name__ == "__main__":
    main()
