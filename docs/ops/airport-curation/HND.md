# HND curation packet (PROPOSED, UNVALIDATED)

> **Status: machine-prepared, NOT validated, NOT published.**
> This packet was prepared by the lane B2-CURATE research agent on 2026-10-19T02:09:46Z.
> Every value must be checked against its source URL by a human curator before use.
> Nothing in this packet has been validated or published.
> retrievedAt values come from session clock readings taken around each fetch; accurate to about one minute.

- IATA: HND
- Airport name: Haneda Airport (site header "HANEDA AIRPORT"; site name "Haneda Airport Passenger Terminal", https://tokyo-haneda.com/en/, retrieved 2026-10-19T02:03:25Z)
- State: `proposed_unvalidated`

## terminal_topology

Source: https://tokyo-haneda.com/en/access/travel_between_terminals/index.html (official_airport), title "Going Between Terminals | Access | Haneda Airport Passenger Terminal", retrievedAt 2026-10-19T02:03:45Z

| Field | Value | Source URL | retrievedAt |
|---|---|---|---|
| terminals | T1 "Terminal 1", T2 "Terminal 2", T3 "Terminal 3" | https://tokyo-haneda.com/en/access/travel_between_terminals/index.html | 2026-10-19T02:03:45Z |
| walkingLinks (shuttle) | T1→T2, T1→T3, T2→T1, T2→T3 (via T1), T3→T1, T3→T2 (via T1); no minutes stated | same | same |
| walkingLinks (train) | T1↔T3, T2↔T3 by Keikyu Line / Tokyo Monorail; no minutes stated | same | same |

Notes: free transit boarding tickets for transfer passengers at information counters (T1 B1F, T2 B1F, T3 2F; passport and boarding pass checked). Shuttle stops: T1 Bus Stop 8, T2 Bus Stop 9, T3 Bus Stop 0 (1F). The T1-T2 underground walkway is out of service for construction, so no walk link is recorded. No domestic/international label per terminal on this page.

## ground_transport

Source: https://tokyo-haneda.com/en/access/train/index.html (official_airport), title "Train & Monorail | Access | Haneda Airport Passenger Terminal", retrievedAt 2026-10-19T02:03:45Z

| Field | Value | Source URL | retrievedAt |
|---|---|---|---|
| rail to Shinagawa Station | about 15 min | https://tokyo-haneda.com/en/access/train/index.html | 2026-10-19T02:03:45Z |
| rail to Hamamatsucho Station | about 20 min | same | same |
| rail to Tokyo Station | about 30 min | same | same |
| rail to Yokohama Station | about 30 min | same | same |
| rail to Ueno Station | about 40 min | same | same |
| rail to Asakusa Station | about 40 min | same | same |
| rail to Shibuya Station | about 45 min | same | same |
| rail to Shinjuku Station | about 50 min | same | same |
| rail to Maihama Station (Tokyo Disney Resort) | about 50 min | same | same |
| rail to Narita Airport Station | about 105 min | same | same |
| terminalIds | T1, T2, T3 (Keikyu and Monorail platforms at B1F in T1 and T2; gates on 2F/3F in T3) | same | same |

UNCERTAIN: the page lists the Keikyu Line and Tokyo Monorail but does not say which line reaches which destination or whether a change is needed. The JSON names each mode "Keikyu Line / Tokyo Monorail (line not attributed by source)". The curator should split these by line using the operators' own sites.

## transport_schedules

Source: https://tokyo-haneda.com/en/access/travel_between_terminals/index.html (official_airport), retrievedAt 2026-10-19T02:03:45Z

| Service | First departure | Last departure | Source URL | retrievedAt |
|---|---|---|---|---|
| Free Shuttle Bus T1→T2 | 04:55 | 01:23 (next day) | https://tokyo-haneda.com/en/access/travel_between_terminals/index.html | 2026-10-19T02:03:45Z |
| Free Shuttle Bus T1→T3 | 05:04 | 01:32 (next day) | same | same |
| Free Shuttle Bus T2→T1→T3 | 05:00 | 01:28 (next day) | same | same |
| Free Shuttle Bus T3→T1→T2 | 04:47 | 01:15 (next day) | same | same |

Notes: these are inter-terminal shuttles, not city services. The page states 4-minute intervals from 5:00am to 8:00pm and 8-minute intervals from 8:00pm to 12:00am; `frequencyMinutes` is omitted because it varies. No journey times stated.

## lounge_hours

Source: https://tokyo-haneda.com/en/service/facilities/lounge.html (official_airport), title "Card Lounge | List of Services | Service Guide | Haneda Airport Passenger Terminal", retrievedAt 2026-10-19T02:04:05Z

| Lounge | Terminal | Location as printed | Hours | Source URL | retrievedAt |
|---|---|---|---|---|---|
| POWER LOUNGE SOUTH | T1 | 2F Domestic Departure Gate Area (South) | 06:00-21:00 | https://tokyo-haneda.com/en/service/facilities/lounge.html | 2026-10-19T02:04:05Z |
| POWER LOUNGE NORTH | T1 | 2F Domestic Departure Gate Area (North) | 06:00-20:30 | same | same |
| FOREST LOUNGE | T1 | 2F Domestic Departure Gate Area (North Satellite), in front of Gate 26 | 06:00-19:00 | same | same |
| POWER LOUNGE CENTRAL | T1 | 1F Domestic Arrival Lobby | 06:00-20:00 | same | same |
| Lounge Us | T2 | 4F Domestic Departure Gate Area (North) | 06:00-21:30 | same | same |
| POWER LOUNGE NORTH | T2 | 3F Domestic Departure Gate Area (North) | 06:00-21:30 | same | same |
| POWER LOUNGE CENTRAL | T2 | 3F Domestic Departure Lobby | 06:00-20:00 | same | same |
| POWER LOUNGE PREMIUM | T2 | 3F International Departure Gate Area | 06:30-01:30 (printed "6:30-25:30") | same | same |
| TIAT LOUNGE | T3 | 4F International Departure Gate Area | 24h | same | same |
| SKY LOUNGE | T3 | 4F International Departure Gate Area | 24h | same | same |
| SKY LOUNGE SOUTH | T3 | 3F International Departure Gate Area | 24h | same | same |
| The Centurion Lounge (AMEX) | T3 | 4F International Departure Gate Area | 08:00-22:00 | same | same |

Notes: card lounges only, so airline lounges are missing. `side` is omitted because the page gives floor and area, not airside/landside; the curator can map "Departure Gate Area" and "Lobby" to sides. T2 "Airport Lounge (South)" is marked closed and is excluded.

## entry_restrictions

Source: https://tokyo-haneda.com/en/flight/transit/int_int.html (official_airport), title "International to International | Use Connecting Flights | Flights | Haneda Airport Passenger Terminal", retrievedAt 2026-10-19T02:04:30Z

| Field | Value | Source URL | retrievedAt |
|---|---|---|---|
| landsideExitForTransit | requires_entry | https://tokyo-haneda.com/en/flight/transit/int_int.html | 2026-10-19T02:04:30Z |
| transitSummary | Intl-to-intl: follow "International Transit" signs; T2 and T3 linked by shuttle bus with guides to the transit security checkpoint. Passengers "entering the country once" follow the international arrival steps, then go to departures. | same | same |

UNCERTAIN: the page does not use the words immigration, landing examination or landside. `requires_entry` is read from its "entering the country once" framing. The section heading has an eligibility parenthetical that was not captured; the curator must read it.

## Unreachable sources

None. All six HND URLs fetched returned content. Also consulted: https://tokyo-haneda.com/en/flight/transit/index.html (title "Use Connecting Flights | Flights | Haneda Airport Passenger Terminal", retrievedAt 2026-10-19T02:04:05Z), an index page that only links to the four connection-type subpages.

## Gaps

- **security_layout**: no checkpoint names or hours fetched.
- **overnight_lodging**: the home page links to The Royal Park HOTEL, First Cabin and TIAT SKY HALL on other domains, but no airport page fetched states their kind, terminal, side or hours.
- **transport_schedules (city rail)**: Keikyu and Tokyo Monorail timetables not fetched (the airport page refers to the operators).
- **terminal_topology.serves**: not labelled on the source page.
- **lounge_hours (airline lounges)**: not on the card-lounge page.

## Official timing guidance (for the curator)

None found. The home page links a notice about a boarding deadline (https://tokyo-haneda.com/en/information/2026/detail_00053.html), which was not fetched.

## Curator checklist

- [ ] open every source URL and confirm each value
- [ ] fix or delete anything not stated by the source
- [ ] decide timing_assumptions (Portava buffers) with a written rationale
- [ ] load via the admin curation route as proposed, then validate and publish in the admin workflow
