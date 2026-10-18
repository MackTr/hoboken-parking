# Street cleaning build report

Built 2026-10-18T22:58:42+00:00. City GIS layer last edited 2019-12-03.

- City table rows placed on the map: **119** of 121
- Curb sides where city table and GIS agree: 863
- Curb sides where they **disagree** (city table used): 31
- Curb sides only in the city table: 11
- Curb sides only in GIS (GIS used, may be stale): 9

## Street aliases (scripts/overrides.json)

| Schedule name | GIS name | Why |
|---|---|---|
| Henderson St. | Marin Blvd | Henderson St is the old name of Marin Blvd. The GIS layer's Marin Blvd segment has the same Monday 1-2 pm, both-sides rule the schedule gives Henderson St. |
| River Terrace | River St | The GIS layer labels River Terrace as River St north of 5th St. Its geometry matches OpenStreetMap's River Terrace, and its Wed/Thu rules match the schedule's River Terrace rows. |

## Manual location fixes (scripts/overrides.json)

| Row | Read as | Why |
|---|---|---|
| Clinton St. | West | Monday - 9 am to 10 am | Newark St. to Seventeenth St. | Newark St. to north boundary | 17th St isn't in the GIS layer; Clinton St's segments end just north of 16th St. |
| Clinton St. | East | Tuesday - 9 am to 10 am | Newark St. to Seventeenth St. | Newark St. to north boundary | 17th St isn't in the GIS layer; Clinton St's segments end just north of 16th St. |
| Newark St. | North | Friday - 8 am to 9 am | Washington St. to north boundary | Washington St. to east boundary | Newark St runs east-west, so 'north boundary' can only mean the east end. The GIS layer has the same Fri 8-9 am rule east of Washington St. |

## Disagreements (city table wins)

| Street | Block | Side | GIS (2019) | City table |
|---|---|---|---|---|
| 8th St | Bloomfield St to Washington St | North | Fri 13:00-14:00 | Wed 13:00-14:00 |
| 8th St | Bloomfield St to Washington St | South | Wed 13:00-14:00 | Fri 13:00-14:00 |
| 8th St | Castle Point Ter to Stanley Dr / Wittpen Walk | North | Fri 13:00-14:00 | Wed 13:00-14:00 |
| 8th St | Castle Point Ter to Stanley Dr / Wittpen Walk | South | Wed 13:00-14:00 | Fri 13:00-14:00 |
| 8th St | Garden St to Bloomfield St | North | Fri 13:00-14:00 | Wed 13:00-14:00 |
| 8th St | Garden St to Bloomfield St | South | Wed 13:00-14:00 | Fri 13:00-14:00 |
| 8th St | Hudson St to Castle Point Ter | North | Fri 13:00-14:00 | Wed 13:00-14:00 |
| 8th St | Hudson St to Castle Point Ter | South | Wed 13:00-14:00 | Fri 13:00-14:00 |
| 8th St | Park Ave to Garden St | North | Fri 13:00-14:00 | Wed 13:00-14:00 |
| 8th St | Park Ave to Garden St | South | Wed 13:00-14:00 | Fri 13:00-14:00 |
| 8th St | Washington St to Hudson St | North | Fri 13:00-14:00 | Wed 13:00-14:00 |
| 8th St | Washington St to Hudson St | South | Wed 13:00-14:00 | Fri 13:00-14:00 |
| 8th St | Willow Ave to Park Ave | North | Fri 13:00-14:00 | Wed 13:00-14:00 |
| 8th St | Willow Ave to Park Ave | South | Wed 13:00-14:00 | Fri 13:00-14:00 |
| 9th St | Adams St to Grand St | North | Wed 15:00-16:00 | Fri 15:00-16:00 |
| 9th St | Adams St to Grand St | South | Fri 15:00-16:00 | Wed 15:00-16:00 |
| 9th St | Clinton St to Willow Ave | North | Wed 15:00-16:00 | Fri 15:00-16:00 |
| 9th St | Clinton St to Willow Ave | South | Fri 15:00-16:00 | Wed 15:00-16:00 |
| 9th St | Grand St to Clinton St | North | Wed 15:00-16:00 | Fri 15:00-16:00 |
| 9th St | Grand St to Clinton St | South | Fri 15:00-16:00 | Wed 15:00-16:00 |
| 9th St | Jackson St to Monroe St | North | Wed 15:00-16:00 | Fri 15:00-16:00 |
| 9th St | Jackson St to Monroe St | South | Fri 15:00-16:00 | Wed 15:00-16:00 |
| 9th St | Jefferson St to Adams St | North | Wed 15:00-16:00 | Fri 15:00-16:00 |
| 9th St | Jefferson St to Adams St | South | Fri 15:00-16:00 | Wed 15:00-16:00 |
| 9th St | Madison St to Jefferson St | North | Wed 15:00-16:00 | Fri 15:00-16:00 |
| 9th St | Madison St to Jefferson St | South | Fri 15:00-16:00 | Wed 15:00-16:00 |
| 9th St | Monroe St to Madison St | North | Wed 15:00-16:00 | Fri 15:00-16:00 |
| 9th St | Monroe St to Madison St | South | Fri 15:00-16:00 | Wed 15:00-16:00 |
| Marshall St | Paterson Ave to 2nd St | East | Thu 14:00-15:00 | Mon 14:00-15:00 |
| Newark St | Park Ave to Garden St | North | Fri 08:00-09:00 | Fri 11:00-12:00 |
| Washington St | 7th St to 8th St | East | Mon-Fri 08:00-09:00 | Mon-Fri 09:00-10:00 |

## City table rows not placed on the map

| Row | Why |
|---|---|
| Vezzetti Way | South | Monday - 8 am to 9 am | Henderson St. to Washington St. | Vezzetti Way isn't in the city GIS layer |
| Vezzetti Way | North | Tuesday - 8 am to 9 am | Henderson St. to Washington St. | Vezzetti Way isn't in the city GIS layer |

## Curb sides only in GIS

| Street | Block | Side | GIS schedule |
|---|---|---|---|
| Sinatra Dr | 1st St to 2nd St | East | Mon 10:00-11:00 |
| Sinatra Dr | 2nd St to 3rd St | East | Mon 10:00-11:00 |
| Sinatra Dr | 3rd St to 4th St | East | Mon 10:00-11:00 |
| Sinatra Dr | 4th St to end | East | Mon 10:00-11:00 |
| Sinatra Dr | 4th St to end | West | Wed 08:00-09:00 |
| Sinatra Dr | Newark St to 1st St | East | Mon 10:00-11:00 |
| Sinatra Dr | end to 5th St | East | Mon 10:00-11:00 |
| Sinatra Dr | end to 5th St | West | Wed 08:00-09:00 |
| Sinatra Dr | end to end | West | Wed 08:00-09:00 |

## Overlapping rows (narrower row wins)

- Grand St. | East | Thursday - 2 pm to 3 pm | Eleventh St. to Tenth St. overrides Grand St. | East | Thursday - 1 pm to 2 pm | Sixteenth St. to Newark St.
- Grand St. | West | Wednesday - 2 pm to 3 pm | Eleventh St. to Tenth St. overrides Grand St. | West | Friday - 1 pm to 2 pm | Sixteenth St. to Newark St.

## Cross streets placed by line intersection

- Castle Point Terrace | East | Wednesday - 1 pm to 2 pm | Eighth St. and Tenth St.: Tenth St. placed where the lines meet (100 m gap in GIS)
- Castle Point Terrace | West | Friday - 1 pm to 2 pm | Eighth St. to Tenth St.: Tenth St. placed where the lines meet (100 m gap in GIS)
- Fifteenth St. | South | Wednesday - 3 pm to 4 pm | Sinatra Drive to Park Ave.: Sinatra Drive placed where the lines meet (106 m gap in GIS)
- First St. | North | Monday - 2 pm to 3 pm | Marshall St. to Willow Ave.: Marshall St. placed where the lines meet (1 m gap in GIS)
- First St. | South | Tuesday - 2 pm to 3 pm | Marshall St. to Willow Ave.: Marshall St. placed where the lines meet (1 m gap in GIS)
- Harrison St. | East | Monday - 3 pm to 4 pm | Fifth St. to the northern boundary: Fifth St. placed where the lines meet (109 m gap in GIS)
- Marshall St. | West | Thursday - 2 pm to 3 pm | First St. to Second St.: First St. placed where the lines meet (1 m gap in GIS)
- Marshall St. | East | Monday- 2pm to 3pm | First St. to Second St.: First St. placed where the lines meet (1 m gap in GIS)
- Paterson Ave. | Both | Thursday - 11 am to 12 noon | Monroe St. to west boundary: Monroe St. placed where the lines meet (21 m gap in GIS)
- River Terrace | East | Wednesday - 11 am to 12 noon | Fifth St. to Seventh St.: Seventh St. placed where the lines meet (152 m gap in GIS)
- River Terrace | West | Thursday - 1 pm to 2 pm | Fifth St. to Seventh St.: Seventh St. placed where the lines meet (152 m gap in GIS)
- Sinatra Drive | West | Wednesday 8 am to 9 am | Sixth St. to Fifth St.: Sixth St. placed where the lines meet (67 m gap in GIS)
