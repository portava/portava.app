# DAD curation packet (PROPOSED, UNVALIDATED)

> **Status: machine-prepared, NOT validated, NOT published.**
> This packet was prepared by the lane B2-CURATE research agent on 2026-10-19T02:09:46Z.
> Every value must be checked against its source URL by a human curator before use.
> Nothing in this packet has been validated or published.
> retrievedAt values come from session clock readings taken around each fetch; accurate to about one minute.

- IATA: DAD
- Airport name: Da Nang (label from the task brief; NOT confirmed from a fetched official page)
- State: `proposed_unvalidated`

## Facts

None. No official page that could be reached stated any value for the seven fact kinds.

## Unreachable sources

| URL | Error |
|---|---|
| https://danangairport.vn/ | TLS error: unable to verify the first certificate |
| https://danangairport.vn/airport-guide-transport-between-terminal | TLS error: unable to verify the first certificate |
| https://www.vietnamairport.vn/danangairport/ | HTTP 301 to https://outlook.office.com/owa/acv.vn/ (webmail login, not followed) |
| https://vietnamairport.vn/danangairport/en/tin-tuc/passenger-information/passenger-guide | HTTP 301 to https://acv.vn/ (corporate home, not followed) |
| https://acv.vn/cang-hang-khong-quoc-te-da-nang | Client-side rendered; only the title "ACV - Sân bay" and a loading placeholder came back |
| https://www.acv.vn/danangairport/en | HTTP 404 Not Found |

## Gaps

- **airportName**: not confirmed from a fetched official page.
- **terminal_topology**, **ground_transport**, **transport_schedules**, **security_layout**, **lounge_hours**, **overnight_lodging**, **entry_restrictions**: no official page reachable. danangairport.vn appears to serve an incomplete TLS certificate chain, so automated fetches fail. It likely opens in a normal browser.

Suggested curator follow-up: open danangairport.vn in a browser. Its airport-guide pages (departure, arrival, transfer, between terminals, facilities) look like the right sources, but none of their content was read here.

## Official timing guidance (for the curator)

None found (no airport page reachable).

## Curator checklist

- [ ] open every source URL and confirm each value
- [ ] fix or delete anything not stated by the source
- [ ] decide timing_assumptions (Portava buffers) with a written rationale
- [ ] load via the admin curation route as proposed, then validate and publish in the admin workflow
