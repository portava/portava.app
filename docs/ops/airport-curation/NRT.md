# NRT curation packet (PROPOSED, UNVALIDATED)

> **Status: machine-prepared, NOT validated, NOT published.**
> This packet was prepared by the lane B2-CURATE research agent on 2026-10-19T02:09:46Z.
> Every value must be checked against its source URL by a human curator before use.
> Nothing in this packet has been validated or published.
> retrievedAt values come from session clock readings taken around each fetch; accurate to about one minute.

- IATA: NRT
- Airport name: Narita International Airport (page title "NARITA INTERNATIONAL AIRPORT", https://www.narita-airport.jp/en/, retrieved 2026-10-19T02:05:05Z; operated by NAA)
- State: `proposed_unvalidated`

## terminal_topology

Source: https://www.narita-airport.jp/en/access/shuttlebus/ (official_airport), title "Traveling Between Terminals | NARITA INTERNATIONAL AIRPORT", retrievedAt 2026-10-19T02:05:30Z

| Field | Value | Source URL | retrievedAt |
|---|---|---|---|
| terminals | T1 "Terminal 1", T2 "Terminal 2", T3 "Terminal 3" | https://www.narita-airport.jp/en/access/shuttlebus/ | 2026-10-19T02:05:30Z |
| walkingLink | T1→T3, shuttle, about 14 min (route 1) | same | same |
| walkingLink | T3→T2, shuttle, about 3 min (routes 1 and 3) | same | same |
| walkingLink | T2→T1, shuttle, about 10 min (routes 1 and 2) | same | same |
| walkingLink | T1→T2, shuttle, about 10 min (route 2) | same | same |
| walkingLink | T2→T3, shuttle, about 6 min (route 3) | same | same |
| walkingLink | T2↔T3, walk via access corridor, no time stated | same | same |

Notes: these shuttles run in the "Before Security Check" area. Transit passengers after the transit security check use separate shuttles (linked page, not fetched). Directions are read from the printed route order. Times may be longer in road congestion. First/last departures and intervals were not in the fetched content.

## ground_transport

Source: https://www.narita-airport.jp/en/access/train/ (official_airport), title "Rail | NARITA INTERNATIONAL AIRPORT", retrievedAt 2026-10-19T02:05:30Z

| Service | Major stops listed | Terminals | Source URL | retrievedAt |
|---|---|---|---|---|
| Keisei Skyliner | Nippori, Keisei Ueno (some trains stop at Aoto, Shin-Kamagaya) | T1, T2, T3 | https://www.narita-airport.jp/en/access/train/ | 2026-10-19T02:05:30Z |
| Keisei Access Express | Higashi-Matsudo, Keisei Takasago, Aoto, Nippori, Keisei Ueno | T1, T2, T3 | same | same |
| Keisei Main Line | Keisei Narita, Keisei Funabashi, Keisei Takasago, Aoto, Nippori, Keisei Ueno | T1, T2, T3 | same | same |
| JR Narita Express (NEX) | Tokyo, Shinagawa, Shibuya, Shinjuku, Yokohama | T1, T2, T3 | same | same |
| JR Line | Chiba, Tokyo, Ueno, Ikebukuro, Shinjuku, Yokohama | T1, T2, T3 | same | same |

Notes: Narita Airport Station serves Terminal 1 (5-minute walk); Airport Terminal 2·3 Station serves Terminal 2 (5-minute walk) and Terminal 3 (10-minute walk). No journey times, first/last trains or frequency stated.

## overnight_lodging

Source: https://www.narita-airport.jp/en/service/transportation/ (official_airport), title "Transportation / Accommodation / Refreshment Space | NARITA INTERNATIONAL AIRPORT", retrievedAt 2026-10-19T02:05:45Z

| Option | Kind (agent classification) | Terminal | Source URL | retrievedAt |
|---|---|---|---|---|
| Capsule Hotel | sleep_pods | T2 | https://www.narita-airport.jp/en/service/transportation/ | 2026-10-19T02:05:45Z |
| Showers, Nap Rooms | rest_area | T1 | same | same |
| Showers, Nap Rooms | rest_area | T2 | same | same |

Notes: category names with terminal tags only. No operator names, floors, side or hours. The `kind` mapping is the agent's classification and must be confirmed. "Hotels around the airport" (off-site) excluded.

## Unreachable sources

None. Also consulted, no usable values:
- https://www.narita-airport.jp/en/sitemap/ (retrieved 2026-10-19T02:05:15Z): used only to find page paths.
- https://www.narita-airport.jp/en/service/lounge/ (retrieved 2026-10-19T02:05:30Z): categories only.
- https://www.narita-airport.jp/en/airportguide/connect/ (retrieved 2026-10-19T02:05:30Z): index page, no transit rule.

## Gaps

- **transport_schedules**: no first/last departures in fetched content; rail operators' sites not fetched.
- **security_layout**: security pages not fetched within the per-airport URL budget.
- **lounge_hours**: lounge page shows categories only.
- **entry_restrictions**: connecting-flights page has no landside-exit rule; the international-connection subpage was not fetched.
- **overnight_lodging details**: hours, side and operator names not stated.

## Official timing guidance (for the curator)

None found on the fetched pages. The sitemap lists departure procedure pages (/en/airportguide/inter-dep/ and /en/airportguide/dom-dep/) that may state it; not fetched.

## Curator checklist

- [ ] open every source URL and confirm each value
- [ ] fix or delete anything not stated by the source
- [ ] decide timing_assumptions (Portava buffers) with a written rationale
- [ ] load via the admin curation route as proposed, then validate and publish in the admin workflow
