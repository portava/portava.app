# Airport curation packets (Layover launch cities)

**Status: proposed, unvalidated.** Every packet here was prepared by a research
agent from official airport and operator web pages on 2026-10-19. Nothing in
this folder is validated or published. A human curator must check each value
against its source before anything reaches a traveller.

Packets: `FLL`, `MIA`, `MNL`, `HND`, `NRT`, `DAD`, `BKK` (`<IATA>.json` is the
input the workflow loads; `<IATA>.md` is the readable summary, with the
unreachable sources and the gaps).

## What a packet can and cannot do

- Loading a packet (`POST /api/admin/airport/curation/packets`, admin only)
  creates **proposals**. A proposal changes nothing a traveller sees: the
  airport stays at maturity L0 (airport-side guidance only), its buffers stay
  "unvalidated, no provenance", and no terminal context is pinned.
- A fact reaches travellers only after a named admin **validates** it (every
  quality check re-runs at that moment) and then **publishes** it.
- No packet contains `timing_assumptions`. The buffers are Portava's own
  judgment and must be proposed by a curator with a written rationale.

## Curator checklist (per airport)

1. Open every source URL in the `.md` and confirm each value. Delete or fix
   anything the page does not state.
2. Complete what the packet could not source. For example, HND lounges and NRT
   lodging do not say whether they are airside or landside, so their quality
   preview fails until the curator states it.
3. Propose `timing_assumptions` (all seven buffers plus a rationale) as a
   `curator_judgment` source.
4. Validate, then publish, in this order: `terminal_topology` →
   `ground_transport` → `timing_assumptions` → the semi-live kinds. Transport,
   lounges and lodging may only name terminals that the published topology
   declares.
5. The airport reaches L1 (landside guidance allowed, if the traveller's entry
   corridor is confirmed) only when topology, ground transport and timing are
   all published and unexpired.

## Expiry rules (§10 "typical freshness")

| class | kinds | default TTL | maximum |
| --- | --- | --- | --- |
| static topology | terminal_topology, ground_transport, timing_assumptions, entry_restrictions | 30 days from retrieval | 180 days |
| operational semi-live | security_layout, lounge_hours, transport_schedules, overnight_lodging | 72 hours from retrieval | 7 days |

TTL is counted from the time the source was read, not from the time it was
validated. A semi-live fact read on 2026-10-19 expires by default on
2026-10-22. After that it must be re-read and proposed as a new version. An
expired fact is treated as absent, so the gate fails closed.

## Endpoints (admin)

- `GET  /api/admin/airport/profiles/:id/curation`: all versions, the projection and the maturity rung
- `POST /api/admin/airport/profiles/:id/curation/facts`: propose `{ kind, value, source: { kind, url, title, note, retrievedAt }, expiresAt? }`
- `POST /api/admin/airport/curation/facts/:factId/validate | reject {reason} | publish | retract {reason}`
- `POST /api/admin/airport/curation/packets`: load a packet as proposals
- `POST /api/admin/airport/profiles/:id/calibrate`: recalibrate the time-of-day bands from measured error

Schema: migrations `3874_airport_curation_provenance_ttl.sql` and
`3880_airport_time_band_calibration.sql`. Neither is applied to any hosted
database yet.
