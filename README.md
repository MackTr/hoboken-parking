# Hoboken street cleaning map

A one-page map that shows which Hoboken curbs you can park on, for a given day or for the whole time you're away:

- **Street cleaning** for each side of each block on the day you pick: red if it gets cleaned that day, green if not, gray if no schedule is listed. Zoom in to see each red curb's cleaning time written next to it; tap a curb for its weekly schedule.
- **One-way arrows** down the middle of each one-way street once you zoom in, and each curb's popup says whether its street is one-way and which direction.
- **Leaving my car:** enter when you park and when you're back to see which curbs stay clear the whole time.
- **City holidays**, when street cleaning is suspended.
- **Temporary no-parking signs** (moving, construction, events, film shoots), loaded live from the city.

Always check the posted signs. Weather suspensions are only announced on [Nixle](https://local.nixle.com/city-of-hoboken-nj/).

## Run it

```bash
python3 scripts/build_data.py   # refresh data/ from the city (about 10 seconds)
python3 -m http.server 8000     # then open http://localhost:8000
```

No dependencies beyond Python 3.6+ and a browser. The page loads MapLibre GL and an OpenFreeMap basemap from public CDNs.

## Hosting

Live at **https://macktr.github.io/hoboken-parking/**. The [deploy workflow](.github/workflows/deploy.yml) rebuilds `data/` from the city every morning (and on every push to `main`), then publishes to GitHub Pages. If a build fails, nothing is deployed and the last good version stays up. You can also run it by hand from the Actions tab.

GitHub pauses scheduled workflows after 60 days with no commits to the repo. If that happens, the Actions tab has a button to turn the schedule back on.

## Where the data comes from

| Data | Source | How fresh |
|---|---|---|
| Curb geometry + 2019 schedule | City of Hoboken ArcGIS layer `Hoboken_Streets` | Last edited Dec 2019 |
| Current schedule | [hobokennj.gov street cleaning schedule](https://www.hobokennj.gov/resources/street-cleaning-schedule) | Scraped on each build |
| Holidays | [hobokennj.gov holiday schedule](https://www.hobokennj.gov/holiday-schedule) | Scraped on each build (built-in 2026 fallback) |
| No-parking signs | The city's [sign map](https://hpuvp.hobokennj.gov/parking) API | Live in the browser; `data/tnp_snapshot.json` is the fallback |
| One-way directions | [OpenStreetMap](https://www.openstreetmap.org/), through the OpenFreeMap basemap tiles | As current as the basemap. The city's 2019 layer disagrees on about 1 block in 10, mostly streets changed since (e.g. Sinatra Dr went one-way northbound in 2022) |

`scripts/build_data.py` places each row of the city's schedule table ("Willow Ave. to Jackson St.") onto the GIS block segments. **Where the table and the 2019 GIS layer disagree, the table wins**, and the curb's popup shows a warning with the older value. A few blocks the table doesn't list keep their GIS schedule; those popups say so too.

Each build writes `data/build_report.md`: how many rows were placed, every disagreement, and any rows that couldn't be placed. Read it after a build to see what changed.

### Known gaps

- **8th St and 9th St:** the schedule page and the GIS layer list the north and south sides the other way round. The map follows the schedule page, so check the sign on those blocks.
- **Vezzetti Way** isn't in the GIS layer, so its two rows aren't on the map.
- No data exists for permit zones, meters, or weather suspensions.

### Fixing a row by hand

`scripts/overrides.json` holds street aliases (e.g. Henderson St is the old name of Marin Blvd) and location fixes for rows the script can't read as written. Each entry has a `why`. Add an entry there and rebuild, rather than editing `data/` directly.
