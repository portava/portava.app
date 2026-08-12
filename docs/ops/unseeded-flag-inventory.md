> ## ⚠ SUPERSEDED 2026-08-12 — the numbers below are wrong
>
> Read [`flag-disposition.md`](./flag-disposition.md) instead.
>
> Every count in this file was derived from `check-flag-polarity.mjs`'s seed
> scanner, which truncated an `INSERT` statement at the first semicolon —
> including one inside a quoted description. Two migrations do that, hiding 23
> seeded flags. The true populations are **152 seeded / 30 live-unseeded / 14
> seeded-absent**, not 129 / 49 / 10.
>
> The reasoning here about *why* the drift matters, and the disposition rule
> itself, still hold. Only the arithmetic and the group membership are wrong —
> 19 of the "unseeded 49" are in fact seeded. Kept unedited as the record of what
> was believed before the scanner was fixed.

# The unseeded forty-nine — flag drift inventory

**Inventory only.** No flag was created, deleted, toggled or seeded in producing
this. Mirrors the published artifact "Unseeded Flag Reconciliation" so the data
survives a workspace restart. Read-only against project `ajrurzioarfkagpuxfnb`,
2026-08-12.

| Measure | Count |
|---|---|
| Live flags | 168 |
| Seeded by a migration (repo side) | 129 |
| **Live, never seeded** | **49** |
| Seeded **and** live | 119 |
| Seeded but absent from production | 10 |
| No code consumer | 25 |
| Read TRUE, gate nothing | 9 |

### Read the two denominators carefully

`129` is a **repo-side** count — distinct flag names appearing in an
`INSERT INTO feature_flags` statement under `src/migrations/`. Verified
2026-08-12 by replicating the matcher in `check-flag-polarity.mjs:1200-1212`
(269 migration files, 54 INSERT statements, 129 distinct names).

The other counts are **live-side**. Mixing them is easy and wrong:

- 129 + 49 = 178 ≠ 168. That subtraction does not mean anything.
- The identity that holds is **119 + 49 = 168**: seeded-and-live, plus
  live-but-never-seeded, equals live.
- And **129 − 119 = 10**: the seeded-but-absent, which is unit 3's population.

So the ten are a strict subset of the 129 names the repo seeds. The seeded set
is fully known from the repo alone; the live read only has to say which ten of
those 129 are missing.

## Why this is drift, not a guard defect

`check-flag-polarity.mjs` rule R6 asks whether every flag a migration seeds is
either read or declared inert. All 49 pass that question **trivially, because no
migration seeds them.** They entered production some other way — an admin
toggle, a console insert, a script — and the repository has no record they
exist. The remedy is not another rule; it is deciding, per flag, whether
production is right and the repository is missing a definition, or the
repository is right and production carries a row nobody meant to keep.

## Group A — 24 with a code consumer → codify

These gate real branches. The defect is that the definition lives only in
production: a restored environment gets no row, and each reads `false` through
the fail-closed helper. `MEDIA_HIDDEN_GEMS_CREATE_ENABLED` is the precedent — a
missing row made an entry point permanently invisible and read as a deliberate
design choice.

Per flag, not in bulk: the intended default is a judgement, and for the
`disable_*` / `invite_only_beta` entries it is the difference between a stop
that is armed and one that is not.

| Flag | Live | First consumer |
|---|---|---|
| `ACTIVITY_DISCOVERY_BOOST_ENABLED` | false | `api:lib/creatorActivityScoreScheduler.ts:70` (+2) |
| `CREATOR_FATIGUE_ENABLED` | false | `api:lib/rankLog.ts:36` |
| `DISCOVERY_DIVERSITY_ENABLED` | false | `api:compass/CompassFeedBuilder.ts:497` (+2) |
| `MEDIA_HIDDEN_GEMS_CREATE_ENABLED` | **true** | `app:src/components/media/MediaQuickCreateSheet.tsx:128` |
| `NEW_CONTRIBUTOR_BOOST_ENABLED` | false | `api:services/ranking/DiscoveryRankingService.ts:354` (+1) |
| `RANKING_EXPERIMENT_ENABLED` | false | `api:routes/adminRankingMetrics.ts:278` (+3) |
| `RENT_BUDDY_ADMIN_ONLY_MODE` | false | `api:routes/rentABuddyRollout.ts:171` |
| `RENT_BUDDY_BETA_ONLY_MODE` | false | `api:routes/rentABuddyRollout.ts:410` |
| `RENT_BUDDY_GROUP_BOOKINGS_ENABLED` | **true** | `api:routes/rentABuddyRollout.ts:245` |
| `RENT_BUDDY_NIGHTLIFE_ENABLED` | **true** | `api:routes/rentABuddyRollout.ts:304` |
| `RENT_BUDDY_OFFERS_ENABLED` | **true** | `api:routes/rentABuddyRollout.ts:271` |
| `RENT_BUDDY_PACKAGES_ENABLED` | **true** | `api:routes/rentABuddyRollout.ts:258` |
| `RETURNING_USER_BOOST_ENABLED` | false | `api:services/ranking/DiscoveryRankingService.ts:355` (+1) |
| `UNDEREXPOSED_CONTENT_BOOST_ENABLED` | false | `api:services/ranking/DiscoveryRankingService.ts:356` (+1) |
| `city_launch_mode` | false | `app:src/screens/admin/featureFlags.machine.ts:23` |
| `disable_messaging` | false | `api:routes/messaging.ts:1682` (+2) |
| `disable_posting` | false | `api:routes/posts.ts:396` (+1) |
| `disable_rent_buddy_booking` | false | `api:lib/rentBuddyKycGate.ts:13` (+2) |
| `invite_only_beta` | false | `api:routes/auth.ts:128` (+2) |
| `moment_recaps_enabled` | false | `api:lib/places/recaps.ts:17` |
| `passport_contribution_events_enabled` | **true** | `api:routes/passportStamps.ts:311` |
| `shared_moments_chat_enabled` | false | `api:routes/sharedMoments.ts:109` |
| `shared_moments_clustering_enabled` | false | `api:routes/sharedMoments.ts:94` |
| `shared_moments_compass_suggestions_enabled` | false | `api:routes/sharedMoments.ts:93` |

## Group B — 9 that read TRUE and gate nothing → retire first

No reader in **either** shipping tree. An operator reading the admin list sees
trust caps and trust restrictions switched on. Nothing consults them. These go
first, because they are the ones an operator is currently misled by.

`rent_buddy_available_now_enabled`, `rent_buddy_marketplace_enabled`,
`rent_buddy_packages_v2_enabled`, `rent_buddy_requests_enabled`,
`rent_buddy_tips_enabled`, `trust_admin_dashboard_enabled`,
`trust_caps_enabled`, `trust_public_levels_enabled`,
`trust_restrictions_enabled`

Note the pairing: `RENT_BUDDY_PACKAGES_ENABLED` (uppercase) **is** read at
`rentABuddyRollout.ts:258`, while `rent_buddy_packages_v2_enabled` is not. A
v1/v2 split where only v1 is wired.

## Group C — 16 that read FALSE and gate nothing → retire

`ACTIVITY_SCORE_DECAY_ENABLED`, `ACTIVITY_SCORE_MAX_BOOST`,
`ACTIVITY_SCORE_VERSION`, `ANTI_GAMING_RANKING_ENABLED`,
`COMPASS_V2_AB_ENABLED`, `RENT_BUDDY_CASH_BALANCE_ENABLED`,
`RENT_BUDDY_DELAYED_POSTING_REQUIRED`, `live_places_world_feed_enabled`,
`location_intelligence_phase1` … `location_intelligence_phase6`,
`place_chat_enabled`, `rent_buddy_earnings_ledger_enabled`

Disposition for B and C is the same as the ten retired on 2026-08-12: delete the
row, add nothing to the seed.

## Why the 49 must be reconciled before the 10

Production holds `location_intelligence_phase1` … `phase6` — unseeded, all
`false`, no reader.

The migrations seed `location_phase1_gps`, `location_phase2_zones`,
`location_phase3_geofence`, `location_phase4_discovery`, `location_phase5_pulse`,
`location_phase6_crew` — none of which exist in production. They are **six of
the ten seeded-but-absent.**

Two parallel six-flag families, one on each side of the drift, describing the
same rollout under two naming schemes, **and neither side is read by anything.**
Reconciling the 49 and the 10 separately would produce two different answers for
one decision.

Both halves of that claim are now verified repo-side: the migrations do seed
`location_phase1_gps`, `location_phase2_zones`, `location_phase3_geofence`,
`location_phase4_discovery`, `location_phase5_pulse`, `location_phase6_crew` —
and those six are the only `location_*` names the migrations seed.

### The other four seeded-but-absent are not yet identified

The artifact names six of the ten. The remaining four are a subset of the 129
seeded names and require one live read to pin down:

```sql
-- the ten = seeded names minus what production holds
select key from feature_flags;   -- then diff against the 129
```

Establish them before starting unit 3. The candidate list is bounded and known,
so this is a diff, not a search.

## Method and limits

- Consumers derived by literal-string search across both shipping trees,
  excluding tests and generated types. "none" means no reference in either.
- A literal-string search misses a flag read through a computed key. Treat
  "no consumer" as strong evidence, not proof, before deleting a row.

**Held and untouched:** `post_media` read policy, `content_stamps` retention.
