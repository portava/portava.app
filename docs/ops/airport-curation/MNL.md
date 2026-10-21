# MNL curation packet (PROPOSED, UNVALIDATED)

> **Status: machine-prepared, NOT validated, NOT published.**
> This packet was prepared by the lane B2-CURATE research agent on 2026-10-19T02:09:46Z.
> Every value must be checked against its source URL by a human curator before use.
> Nothing in this packet has been validated or published.
> retrievedAt values come from session clock readings taken around each fetch; accurate to about one minute.

- IATA: MNL
- Airport name: Ninoy Aquino International Airport (from the title of https://www.newnaia.com.ph/, retrieved 2026-10-19T02:02:25Z)
- State: `proposed_unvalidated`

Source domains used: miaa.gov.ph (Manila International Airport Authority) and newnaia.com.ph (New NAIA Infra Corp., the NAIA operator since September 2024). The curator should confirm that newnaia.com.ph is the current official operator site.

## terminal_topology

Source: https://www.miaa.gov.ph/index.php/faq (official_airport), heading "Frequently Asked Questions", retrievedAt 2026-10-19T02:03:00Z

| Field | Value | Source URL | retrievedAt |
|---|---|---|---|
| terminals[0] | id T1, name "NAIA Terminal 1" | https://www.miaa.gov.ph/index.php/faq | 2026-10-19T02:03:00Z |
| terminals[1] | id T2, name "NAIA Terminal 2" | same | same |
| terminals[2] | id T3, name "NAIA Terminal 3" | same | same |

Notes:
- The terminal names come from the FAQ's airline-by-terminal list, which the page attributes to newnaia.com.ph "as of March 10, 2026".
- The page does not say which terminal is international or domestic, so `serves` is omitted.
- Terminal 4 is not mentioned on this page.
- No gates, checkpoints or inter-terminal times are stated.

## Unreachable sources

| URL | Error |
|---|---|
| https://www.newnaia.com.ph/ | Client-side rendered; only the page title came back (used for airportName only) |
| https://newnaia.com.ph/transport | Client-side rendered; only the title "Getting To & From NAIA, Transport Options" came back |
| https://newnaia.com.ph/passenger-guide | Client-side rendered; only the title "NAIA Passenger Guide, Before You Fly & On Arrival" came back |

Also consulted, no usable values:
- https://www.miaa.gov.ph/ (retrieved 2026-10-19T02:01:50Z): home page, no terminal or passenger content.
- https://www.miaa.gov.ph/index.php/about-miaa/naia-aerodrome (retrieved 2026-10-19T02:02:05Z): no terminal or passenger content.

## Gaps

- **terminal_topology.serves / walkingLinks**: not stated on any reachable official page. The FAQ names "Shuttle bus transfers" only as a service category.
- **ground_transport**, **transport_schedules**: the operator's transport page renders client-side and returned no content.
- **security_layout**: not stated.
- **lounge_hours**: the FAQ names "Lounges" only as a category, with no names or hours.
- **overnight_lodging**: not stated.
- **entry_restrictions**: the FAQ refers passengers to their airline and the relevant embassy; no transit rule stated.

Suggested curator follow-up: open newnaia.com.ph/transport and /passenger-guide in a normal browser; they appear to hold the inter-terminal shuttle and transport content.

## Official timing guidance (for the curator)

None found on the reachable pages.

## Curator checklist

- [ ] open every source URL and confirm each value
- [ ] fix or delete anything not stated by the source
- [ ] decide timing_assumptions (Portava buffers) with a written rationale
- [ ] load via the admin curation route as proposed, then validate and publish in the admin workflow
