# Live Places — rollout runbook

**Status: PLAN. Design only, for review before any execution.** Nothing in here
has been run. No flag has been flipped and no env var has been set as part of
writing it.

**Audience:** whoever turns Live Places on. Steps marked **[OPERATOR]** are not
executable by an agent or by CI — they need a human with console access, and
they are called out so the plan cannot be mistaken for something that runs
itself.

---

## 0. What this turns on, and the current state

Live Places is a family of surfaces gated by a **hierarchy** of flags, not a
single switch. `LIVE_PLACES_REQUIREMENTS` in `lib/featureFlags.ts` is the
authority: each capability requires every ancestor to be enabled, enforced by
`isLivePlacesCapabilityEnabled()`, and mirrored client-side in
`FeatureFlagsContext`.

Live values, read 2026-08-12:

| Flag | Live | Role |
|---|---|---|
| `external_places_enabled` | **true** | Canonical place discovery. Independent root. |
| `live_places_enabled` | false | Master switch for the experiential surfaces |
| `place_days_enabled` | false | requires the two above |
| `shared_moments_enabled` | false | requires the three above |
| `place_recaps_enabled` | false | requires `place_days_enabled` |
| `moment_recaps_enabled` | false | requires `shared_moments_enabled` |
| `live_places_world_feed_enabled` | false | requires `live_places_enabled` |
| `place_chat_enabled` | false | requires `live_places_enabled` |

So the root is already on and everything experiential is off. The rollout is
about the second column, in dependency order.

**Where each gate actually lives** — worth knowing before verifying "gated off",
because none of these is checked in the route file:

| Surface | Gate |
|---|---|
| Place living | `routes/placeLiving.ts:382`, `:469` |
| Place days | `lib/places/placeDays.ts:93` |
| Shared moments | `lib/places/sharedMoments.ts:6` |
| Recaps (place + moment) | `lib/places/recaps.ts:17`, a ternary over both flag names |

`routes/placeDays.ts` and `routes/placeRecaps.ts` are mounted with only
`requireUser` on the route itself. They are gated — one layer down, in the lib.
A verification pass that greps the route files for a flag check will conclude
they are ungated and be wrong.

---

## 1. Order, and why it is this order

The principle: **make the data correct while nobody can see it, then make it
visible.** Every step before the flag flips is reversible by doing nothing;
the flag flips are reversible by flipping back.

### Step 1 — the env gate, first **[OPERATOR]**

`FOURSQUARE_API_KEY` is the external-data credential
(`lib/foursquarePlaces.ts:35`, `lib/liveIntelligence.ts:131`). It fails
**gracefully**, not loudly: unset, the module logs
*"FOURSQUARE_API_KEY not set — venue search disabled"* and venue search returns
empty. An auth failure logs a warning and disables search the same way.

That is the right default and it is also the trap: **an unset or invalid key
produces empty results, not errors.** If the flags are flipped first, Live
Places comes up looking shipped and empty, and the symptom (no venues) is
identical to "this city has no data yet".

So the key goes in first, and is verified before anything else moves.

- **[OPERATOR]** set `FOURSQUARE_API_KEY` in the deployment environment.
- Verify by exercising a venue search path and confirming non-empty results,
  **not** by checking the variable is present. A present-but-invalid key is the
  case that matters, and it is invisible to a presence check.
- Confirm no `Foursquare auth failed` warnings in logs after the first calls.

### Step 2 — places data, second

With the key live and the flags still off, ingest and canonicalize places. This
is the long step and the one that benefits most from being invisible: every
mistake here is fixable without a user having seen it.

- Run the place ingest/backfill for the launch cities.
- Confirm canonical place rows resolve and are deduplicated.
- Confirm images resolve — this is where the media-URL shape work matters. Any
  place image stored as an absolute `/storage/v1/object/public/…` URL carries
  the project ref and will not survive an environment move
  (`2081_canonicalize_absolute_storage_urls.sql` covers the five audited
  columns; **`discovery_places.header_image_url` and `.image_url` are not among
  them and were not censused** — check them before launch).

### Step 3 — verify GATED-OFF, before any flip

This step is the one most likely to be skipped and is the whole reason the order
above buys anything. **Prove the surfaces are invisible while the data is live.**

For each of `placeLiving`, `placeDays`, `sharedMoments`, `placeRecaps`: call the
endpoint as an ordinary authenticated user and confirm it refuses or returns
empty *because of the flag*, not because the data is missing. With Step 2 done,
those two causes are finally distinguishable — before Step 2 they are not, which
is why this check is worthless if run earlier.

Check the client too: `FeatureFlagsContext.isEnabled` applies the same hierarchy
independently of the server. A capability whose parent is off must be hidden in
the app even if a server response would have allowed it.

### Step 4 — flag flips, in dependency order, one at a time

Deliberate, individual, and each one verified before the next. The hierarchy
means a child flipped before its parent changes nothing, which looks like a
broken flip and invites someone to start flipping things at random.

1. `live_places_enabled`
2. `place_days_enabled`
3. `shared_moments_enabled`
4. `place_recaps_enabled` · `moment_recaps_enabled`
5. `live_places_world_feed_enabled` · `place_chat_enabled`

**[OPERATOR]** each flip is an admin action on `feature_flags`. After each: load
the surface as a real user, and confirm the *next* surface down is still off.

⚠ **The client caches.** `FeatureFlagsContext` fetches on mount and on
foreground; `compass/flags.ts` holds a 30-second TTL cache server-side. A flip
is not observable instantly and a mobile client may need backgrounding. Do not
diagnose a flip as failed for at least a minute.

---

## 2. Rollback

**Rollback is flag or env reversal. There is no data rollback and none is
needed** — every step before Step 4 is additive, and ingested places are
harmless while unreferenced.

| Symptom | Reverse |
|---|---|
| A surface is wrong or unsafe | Flip that flag off. Children are gated by the hierarchy and go with it. |
| Whole family is wrong | Flip `live_places_enabled` off. One flip disables every experiential surface; `external_places_enabled` stays on and canonical discovery is unaffected. |
| External data is bad/expensive | **[OPERATOR]** unset `FOURSQUARE_API_KEY`. Degrades to empty results by design, no errors. |

Two properties make this safe and both are worth stating rather than assuming:
flipping a parent off disables children without touching their rows, so the
state you flipped into is recoverable exactly; and `external_places_enabled` is
an independent root, so nothing in this rollback disturbs canonical place
discovery, which is already live.

---

## 3. What this plan does not cover

- **Cost.** Foursquare is a metered external API. No budget, quota, or
  rate-limit ceiling is established here, and Step 2 is the step that spends.
- **`discovery_places` image URL shapes.** Not censused; named in Step 2 as a
  pre-launch check rather than silently assumed clean.
- **Which cities.** Launch scope is a product decision.
- **The upload staging boundary.** Place imagery arriving through the ingest
  path is not the same as user uploads and is out of scope here.
