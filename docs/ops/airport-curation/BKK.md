# BKK curation packet (PROPOSED, UNVALIDATED)

> **Status: machine-prepared, NOT validated, NOT published.**
> This packet was prepared by the lane B2-CURATE research agent on 2026-10-19T02:09:46Z.
> Every value must be checked against its source URL by a human curator before use.
> Nothing in this packet has been validated or published.
> retrievedAt values come from session clock readings taken around each fetch; accurate to about one minute.

- IATA: BKK
- Airport name: Suvarnabhumi Airport (site header on https://suvarnabhumi.airportthai.co.th/, retrieved 2026-10-19T02:06:50Z; the SAT-1 article also uses "Suvarnabhumi International Airport (BKK)")
- State: `proposed_unvalidated`

## terminal_topology

Source: https://suvarnabhumi.airportthai.co.th/service/way-to-airport/detail/suvarnabhumi_airport_SAT-1 (official_airport), title "THE MIDFIELD SATELLITE 1 SUVARNABHUMI AIRPORT", retrievedAt 2026-10-19T02:07:05Z

| Field | Value | Source URL | retrievedAt |
|---|---|---|---|
| terminals[0] | id MTB, "Main Terminal Building" | https://suvarnabhumi.airportthai.co.th/service/way-to-airport/detail/suvarnabhumi_airport_SAT-1 | 2026-10-19T02:07:05Z |
| terminals[1] | id SAT-1, "Midfield Satellite 1 (SAT-1)" | same | same |
| gates | SAT-1: 28 contact gates (8 Code F, 20 Code E); no gate numbers stated | same | same |
| walkingLinks | MTB→SAT-1, train (APM, driverless, ~1 km tunnel), about 3 min including waiting | same | same |

Notes: the page does not explicitly say SAT-1 serves international flights. The 4th floor has passenger and airline lounges, with no names or hours. Main Terminal Building concourses and gates are not described.

## ground_transport

Source: https://suvarnabhumi.airportthai.co.th/service/way-to-airport/detail/754 (official_airport), title "Public Bus at Public Transportation Center, Suvarnabhumi Airport", retrievedAt 2026-10-19T02:07:20Z. **The post is dated January 24, 2022, so it may be stale.**

| Route (provider) | Destination | Pick-up point | "Service Time" as printed (NOT recorded as departures) | Source URL | retrievedAt |
|---|---|---|---|---|---|
| S1 (BMTA) | Sanam Luang | Passenger Terminal | 06:00-17:00 | https://suvarnabhumi.airportthai.co.th/service/way-to-airport/detail/754 | 2026-10-19T02:07:20Z |
| 555 (BMTA) | Rangsit (via Rama 9 Expressway) | Public Transportation Center | 04:30-19:00 | same | same |
| 554 (BMTA) | Rangsit (via Ramindra Road) | Public Transportation Center | 06:30-20:00 | same | same |
| 558 (BMTA) | Central Rama 2 | Public Transportation Center | 05:30-20:40 | same | same |
| 825 (The Transport Co., Ltd.) | Nong Khai | Public Transportation Center | 19:00 | same | same |
| 825 (The Transport Co., Ltd.) | Udon Thani | Public Transportation Center | 19:00 | same | same |
| 917 (The Transport Co., Ltd.) | Laem Ngop | Public Transportation Center | 08:20, 09:30 | same | same |
| 9907 (The Transport Co., Ltd.) | Chanthaburi | Public Transportation Center | 07:10, 13:20 | same | same |
| 9908 (The Transport Co., Ltd.) | Trat | Public Transportation Center | 08:20, 11:30 | same | same |
| 9909 (The Transport Co., Ltd.) | Laem Chabang | Public Transportation Center | 06:00-18:00 | same | same |
| 549 (Public Mini Bus) | Minburi | Public Transportation Center | 06:30-19:00 | same | same |
| 552 (Public Mini Bus) | On Nut | Public Transportation Center | 05:00-22:00 | same | same |
| 552A (Public Mini Bus) | Pak Nam | Public Transportation Center | 05:30-21:00 | same | same |
| 555 (Public Mini Bus) | Don Mueang | Public Transportation Center | 06:30-20:00 | same | same |
| 559 (Public Mini Bus) | Future Park Rangsit | Public Transportation Center | 06:30-20:00 | same | same |
| 389 (Roong Reuang Coach Co., Ltd.) | Pattaya | Passenger Terminal, 1st Floor, Exit 8 | 10:00-18:00 | same | same |
| 789 (Roong Reuang Coach Co., Ltd.) | Hua Hin | Passenger Terminal, 1st Floor, Exit 8 | 12:30 | same | same |

Notes: the "Service Time" column is shown here for the curator only. The page does not say these are departures from the airport, so no `transport_schedules` fact was made. `terminalIds` are omitted because the page's "Passenger Terminal" is not explicitly the "Main Terminal Building", and the Public Transportation Center is not a terminal. No journey times or frequency stated. Route 555 appears twice (BMTA to Rangsit, Public Mini Bus to Don Mueang).

## Unreachable sources

None returned errors. Consulted with no usable values:
- https://suvarnabhumi.airportthai.co.th/service/transportation (retrieved 2026-10-19T02:07:05Z): mode names only (Public car service, Public Bus, AOT Limousine, Taxi, Public Van).
- https://suvarnabhumi.airportthai.co.th/service/airport-guide (retrieved 2026-10-19T02:07:20Z): navigation and footer only.
- https://suvarnabhumi.airportthai.co.th/service/way-to-airport/detail/shuttle_bus_services_around_Suvarnabhumi_airport (retrieved 2026-10-19T02:07:20Z, dated January 24, 2022): internal shuttle lines A, B, C, D, F and Express. All lines start and end at the Public Transportation Center, and some stop at the Passenger Terminal (1F Exit 3/8, 2F Exit 5, 4F Exit 5). No hours, frequency, journey time or fee stated.

## Gaps

- **terminal_topology**: Main Terminal Building concourses and gates not described.
- **ground_transport (Airport Rail Link, taxi, limousine)**: not described on fetched pages. The ARL operator site was not fetched because its official domain could not be confirmed.
- **transport_schedules**: "Service Time" is not stated to be departures from the airport.
- **security_layout**, **overnight_lodging**, **entry_restrictions**: not stated on fetched pages.
- **lounge_hours**: SAT-1 4F lounges mentioned without names or hours.

## Official timing guidance (for the curator)

- https://suvarnabhumi.airportthai.co.th/ (home page, retrieved 2026-10-19T02:06:50Z): in the teaser for "Car Rental Services at Suvarnabhumi Airport", the page says "passengers should allow at least 2 hours in advance to ensure timely boarding". This is in a car-rental context, not a general check-in rule, and it does not distinguish international from domestic.

## Curator checklist

- [ ] open every source URL and confirm each value
- [ ] fix or delete anything not stated by the source
- [ ] decide timing_assumptions (Portava buffers) with a written rationale
- [ ] load via the admin curation route as proposed, then validate and publish in the admin workflow
