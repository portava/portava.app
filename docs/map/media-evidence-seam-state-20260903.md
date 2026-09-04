# §22 media evidence — the seam is half-wired, and the missing half is a surface, not a line

**Date:** 2026-09-03
**Scope:** the media→intel evidence seam (`lib/media/mediaEvidenceLink.ts`) as it
reaches — or fails to reach — the §22 map contribution path.
**Verdict:** the WRITE half has **no production caller** and cannot honestly be
given one today. This note records exactly what is built, what is missing, and
what would have to exist first. Nothing was faked to close the gap.

An architecture audit flagged `linkMediaEvidence` as "implemented and tested but
with no production caller". **That claim is correct.** It was verified at
`37f5faa22` (origin/main), not assumed.

---

## What IS built

| Piece | Where | State |
|---|---|---|
| Write adapter `linkMediaEvidence` | `artifacts/api-server/src/lib/media/mediaEvidenceLink.ts:97` | implemented, 13 tests, **no production caller** |
| Read adapter `observationsHaveEligibleMediaEvidence` | same file, `:206` | implemented **and wired** |
| Aggregator consumption | `artifacts/api-server/src/lib/intelProjectionAggregator.ts:294-301` | live in the projection path |
| §35 eligibility gate `isEvidenceEligible` | `artifacts/api-server/src/lib/media/mediaEvidenceEligibility.ts` | implemented, consumed by both halves |
| Storage: `intel_evidence.media_asset_id` + partial unique index | `artifacts/api-server/src/migrations/2255_media_evidence_seam.sql` | applied-ready |
| Master flag `media_evidence_enabled` | seeded **OFF** by `2255`, with a postcondition that raises if it ships ON | OFF |
| Tests | `artifacts/api-server/src/test/mediaEvidenceSeam.test.ts` | registered in the package `test` script |

So the seam is a pipe that is **connected at the outlet and open at the inlet**.

## What is NOT built

`linkMediaEvidence` is referenced from exactly one file in the repository —
`src/test/mediaEvidenceSeam.test.ts`. No route, service, worker, scheduler or
script reaches it, on `main` **or on any other branch** (scanned).

The consequence is precise and worth stating, because it is invisible from the
read side: `intel_evidence.media_asset_id` has **no writer anywhere in the
product**. Even with `media_evidence_enabled` flipped ON, the wired read half
would query, find nothing, and return `false` on every claim — the same value
the flag-OFF branch hard-codes. Flipping the flag today buys two extra database
round-trips per claim and changes no output.

## Why there is nowhere honest to call it from

`linkMediaEvidence(sc, { observationId, actorId, asset })` needs **an
`intel_observations` row and a canonical `media_assets` row at the same moment**.
No production path in this repository ever holds both. Five independent gaps,
each verified:

1. **The §22 media prompt is not reachable in the UI.** `MapContributionSheet`
   renders the photo/video prompt only when the caller supplies `onRequestMedia`
   (`src/components/map/MapContributionSheet.tsx:119`). The one mount site,
   `app/map/index.tsx:1546`, does not supply it — so the prompt is filtered out
   and no user can emit a `media` contribution. (This is deliberate and correct:
   the sheet "will not emit a media contribution without a real asset".)

2. **There is no upload step on the map capture path.** The client contribution
   carries `mediaUri` — a *device-local* file URI
   (`src/features/map/truth/liveTruth.ts:585`), forwarded verbatim by
   `src/services/mapObservations.ts`. Nothing uploads it to storage, and nothing
   creates a `media_assets` row for it. There is no asset to link.

3. **The server refuses the `media` kind, on purpose.**
   `POST /api/map/observations` maps only `crowd_level`, `queue` and
   `entry_access` to canonical claims (`routes/mapObservations.ts:214`); `media`
   is rejected as `unsupported_kind` (`:415`) with the recorded reason at `:223`:
   *"a media asset is not an enumerated state; media capture belongs to the
   moment/highlight surface"*. A refused contribution writes no observation — so
   there is no `observationId` for the seam to link to.

4. **Nothing ever attaches media to an observation.** The canonical attach
   choke-point `recordEntityMedia` accepts `entityType: "observation"` in its
   closed set (`lib/mediaAssets.ts:316`), but its three production callers pass
   `postcard` (`routes/postcards.ts:915`), `memory`
   (`services/passport/PassportMemoryService.ts:140`) and `hidden_gem`
   (`services/hiddenGems/HiddenGemService.ts:156`). `entity_type='observation'`
   is written by nothing in the product.

5. **The visual capture surfaces that would carry a photo produce no
   observations either.** `lib/mediaVisualFreshness.ts:16` reads observations
   whose `capture_surface` is `moment`/`highlight`/`postcard`; the only
   `captureSurface` ever written in production is `quick_signal`
   (`routes/mapObservations.ts:442`). That read is dark for the same reason.

## What was deliberately NOT done

Each of these would have produced a green diff and a false claim of a live seam:

- **Calling it from the three existing `recordEntityMedia` callers.** A
  postcard/memory/gem id is not an observation id, and
  `intel_evidence.observation_id` is `NOT NULL REFERENCES intel_observations(id)`
  (`migrations/2130_intel_storage.sql:243`). Every insert would fail the foreign
  key — a seam that is "wired" and 100% broken is worse than one that is
  honestly dark.
- **Adding an `entityType === 'observation'` branch inside `recordEntityMedia`.**
  Nothing calls `recordEntityMedia` with `'observation'`, so this relocates the
  dead code under a busier filename and makes the next audit's grep come back
  clean. The defect would survive its own fix.
- **Making the map route accept `media`.** That requires inventing a claim type
  with a TTL, a hard-expiry, a value validator and a freshness policy. Those are
  `lib/intelContracts` / `lib/quickSignal` decisions, and the route says so in
  its own comments. A route inventing product vocabulary is scope creep with a
  spec reference attached.
- **Having the seam create the observation it needs.** Explicitly outside its
  boundary: the module "NEVER writes `intel_observations`/`intel_claims`/
  `intel_state_snapshots`". Live labels stay owned by the gated IG path.

## What would have to exist for the seam to go live

In dependency order. (1)–(3) are the minimum; (4) is the flag press.

1. **A claim type that a photo can back.** A §22 media answer has to become an
   observation of *something* before evidence can hang off it. Either add a
   media-bearing claim type to `lib/intelContracts` (with TTL, hard-expiry,
   validator, freshness policy), or — probably better — make the photo an
   **optional attachment to an already-supported prompt** ("it's packed, here's
   the queue"), which needs no new vocabulary at all and reuses `crowd.level` /
   `queue.wait` / `access.walk_in` exactly as they are.
2. **A map-side media upload producing a canonical asset.** The capture sheet
   needs an `onRequestMedia` implementation that uploads to storage and records
   a `media_assets` row carrying the `source_type` / `provenance` /
   `captured_at` that `isEvidenceEligible` reads. Without real provenance the
   §35 gate is guessing, and a guessing gate is worse than a closed one.
3. **The wiring itself — one call, after both exist.** Once the route writes an
   observation *and* holds an asset id, `linkMediaEvidence` is called with that
   pair. That is genuinely the small part, and it is the only part that is small.
4. **The flag press.** `media_evidence_enabled` ON, owner-pressed, after (1)–(3)
   are proven — never before, or the aggregator does work that cannot pay off.

## Risk while it stays dark

Low, and bounded by the flag. Nothing user-visible misreports: with
`media_evidence_enabled` OFF the aggregator's `hasEvidence` is hard-coded
`false`, `evidenceQuality` stays `0.3`, and confidence bands are byte-identical
to the pre-seam behaviour. The real risk is **documentary** — the seam reads as
built to anyone grepping for it, and this is the second audit to spend time
rediscovering that it is not. `mediaEvidenceLink.ts` now carries a banner
pointing here so the third one does not have to.
