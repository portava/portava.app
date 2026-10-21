# MIA curation packet (PROPOSED, UNVALIDATED)

> **Status: machine-prepared, NOT validated, NOT published.**
> This packet was prepared by the lane B2-CURATE research agent on 2026-10-19T02:09:46Z.
> Every value must be checked against its source URL by a human curator before use.
> Nothing in this packet has been validated or published.
> retrievedAt values come from session clock readings taken around each fetch; accurate to about one minute.

- IATA: MIA
- Airport name: Miami International Airport (as named in the Miami-Dade Metrobus page title)
- State: `proposed_unvalidated`

## ground_transport

Source: https://www.miamidade.gov/global/transportation/mia-metrobus-service.page (official_operator, Miami-Dade County transit), title "Metrobus Routes Serving Miami International Airport (MIA)", retrievedAt 2026-10-19T01:56:40Z

| Field | Value | Source URL | retrievedAt |
|---|---|---|---|
| modes[0] | bus, Metrobus Route 7, to Downtown Bus Terminal / Dolphin Mall / Sweetwater | https://www.miamidade.gov/global/transportation/mia-metrobus-service.page | 2026-10-19T01:56:40Z |
| modes[1] | bus, Metrobus Route 37, to Hialeah / South Miami | same | same |
| modes[2] | bus, Metrobus Route 42, to Opa-locka / Coral Gables (no Sat/Sun service) | same | same |
| modes[3] | bus, Metrobus Route 57, to South Miami / SW 152 Street Park & Ride (weekdays only) | same | same |
| modes[4] | bus, Metrobus Route 110 (Route J), to Miami Beach | same | same |
| modes[5] | bus, Metrobus Route 150 (Miami Beach Airport Express), to Miami Beach | same | same |
| modes[6] | bus, Metrobus Route 238 (East-West Connection), to Dolphin Mall / Miami International Mall (weekdays only) | same | same |
| modes[7] | bus, Metrobus Route 297 (27th Avenue Orange MAX), to Opa-locka / Miami Gardens (weekdays only) | same | same |
| modes[8] | bus, Metrobus Route 338 (Weekend Express), to Dolphin Mall (weekends only) | same | same |

Notes:
- All routes stop at the MIA Metrorail station, ground level (drop-off east side, pick-up west side). No terminalIds because no terminal topology could be sourced.
- No journey times or hours on the page.
- Second official page (not merged into the JSON fact, mentioned in its notes): https://www.miamidade.gov/global/transportation/metrorail.page, retrievedAt 2026-10-19T01:57:30Z. It says Metrorail runs 5 a.m. to midnight daily; on weekends the Orange Line runs only as an Airport Shuttle train between Earlington Heights and MIA every 15 minutes. It does not state first/last trains from MIA.

## Unreachable sources

| URL | Error |
|---|---|
| https://www.miami-airport.com/ | ECONNREFUSED 65.87.66.20:443 |
| https://www.miami-airport.com/terminal_maps.asp | ECONNREFUSED 65.87.66.20:443 |
| https://www.miami-airport.com/public-transportation.asp | ECONNREFUSED 65.87.66.20:443 |
| https://miami-airport.com/ground-transportation.asp | ECONNREFUSED 65.87.66.20:443 |
| https://www8.miamidade.gov/global/transportation/mia-metrobus-service.page | ENOTFOUND (host); same page fetched from www.miamidade.gov |

Also consulted, no usable values: https://www.miamidade.gov/transportation-publicworks/rail_schedules.asp (title "Metrorail Schedule", retrievedAt 2026-10-19T01:58:30Z; no MIA times shown).

## Gaps

- **terminal_topology**, **security_layout**, **lounge_hours**, **overnight_lodging**, **entry_restrictions**: the airport operator site miami-airport.com refused every connection.
- **transport_schedules**: no official page reached states first/last departures from MIA (Metrorail or Metrobus).

## Official timing guidance (for the curator)

None found (airport site unreachable).

## Curator checklist

- [ ] open every source URL and confirm each value
- [ ] fix or delete anything not stated by the source
- [ ] decide timing_assumptions (Portava buffers) with a written rationale
- [ ] load via the admin curation route as proposed, then validate and publish in the admin workflow
