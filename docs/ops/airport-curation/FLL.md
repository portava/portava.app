# FLL curation packet (PROPOSED, UNVALIDATED)

> **Status: machine-prepared, NOT validated, NOT published.**
> This packet was prepared by the lane B2-CURATE research agent on 2026-10-19T02:09:46Z.
> Every value must be checked against its source URL by a human curator before use.
> Nothing in this packet has been validated or published.
> retrievedAt values come from session clock readings taken around each fetch; accurate to about one minute.

- IATA: FLL
- Airport name: Fort Lauderdale-Hollywood (label from the task brief; NOT confirmed from an official page)
- State: `proposed_unvalidated`

## Facts

None. No official page that could be reached stated any value for the seven fact kinds.

## Sources consulted (reachable, but no usable facts)

| URL | retrievedAt | Result |
|---|---|---|
| https://www.tri-rail.com/ (Tri Rail, South Florida Regional Transportation Authority) | 2026-10-19T01:54:50Z | Page lists "Fort Lauderdale Airport" only as a station option; no route, journey-time or shuttle facts |

## Unreachable sources

| URL | Error |
|---|---|
| https://www.fll.net/ | HTTP 301 to https://www.broward.org/airport |
| https://www.broward.org/airport | HTTP 403 Forbidden |
| https://www.broward.org/Airport/Business/about/Pages/FactSheets.aspx | HTTP 403 Forbidden |
| https://www.broward.org/Airport/Pages/maps.aspx | HTTP 403 Forbidden |
| https://www.broward.org/airport/Passengers/WhereIsMyAirline | HTTP 403 Forbidden |
| https://www.tri-rail.com/stations/fort-lauderdale-airport | HTTP 500 (tried twice) |
| https://media.tri-rail.com/Files/Schedules/Ride%20Partners/FLA-1_Airport_Shuttle_MAR23_PRINT.pdf | Fetched as binary PDF (metadata: last modified March 2023); text not extractable here, so no values were taken |

## Gaps

- **airportName**: not confirmed; every broward.org airport page returned 403.
- **terminal_topology**: broward.org airport pages blocked (403).
- **ground_transport**: Tri-Rail home page has no airport service facts; the airport station page returned 500.
- **transport_schedules**: Tri-Rail FLA-1 airport shuttle PDF unreadable here.
- **security_layout**, **lounge_hours**, **overnight_lodging**, **entry_restrictions**: no official page reachable.

Suggested curator follow-up: open broward.org/airport in a normal browser (the 403 looks like bot blocking, not a dead site) and the Tri-Rail FLA-1 shuttle PDF.

## Official timing guidance (for the curator)

None found (no airport page reachable).

## Curator checklist

- [ ] open every source URL and confirm each value
- [ ] fix or delete anything not stated by the source
- [ ] decide timing_assumptions (Portava buffers) with a written rationale
- [ ] load via the admin curation route as proposed, then validate and publish in the admin workflow
