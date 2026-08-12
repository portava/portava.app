# Flag disposition — the authoritative table

**Evidence only. No flag was created, deleted, toggled or seeded in producing
this.** Live values read 2026-08-12 from project `ajrurzioarfkagpuxfnb` through
the guarded read-only audit path (one `SELECT flag, enabled FROM
public.feature_flags`). Supersedes `unseeded-flag-inventory.md` in full — both
its numbers and its populations.

## Read this first: the previous numbers were wrong

The inventory this replaces reported **129 seeded / 49 live-unseeded / 10
seeded-absent**. Those figures came from a seed scanner with a defect, and every
one of them is wrong. The corrected populations are:

| Measure | Was | **Is** |
|---|---|---|
| Distinct seeded names (repo side) | 129 | **152** |
| Live flags | 168 | 168 |
| Seeded **and** live | 119 | **138** |
| Live, never seeded | 49 | **30** |
| Seeded, absent from production | 10 | **14** |

`138 + 30 = 168` and `152 − 138 = 14` both hold.

### The defect

`check-flag-polarity.mjs` built its seeded population by finding `INSERT INTO
feature_flags` and then taking everything up to the next semicolon —
`rest.indexOf(';')`. A semicolon inside a **quoted description** therefore ended
the statement early and every row after it disappeared:

```sql
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('RENT_BUDDY_ADMIN_ONLY_MODE', false, 'Admin-only mode: only users with admin role...'),
  ('RENT_BUDDY_CASH_BALANCE_ENABLED', false, '...cash balance; ledger pending'),  -- ← cut here
  ('RENT_BUDDY_PACKAGES_ENABLED', false, '...')                                   -- ← invisible
```

Two migrations do this — `0090_rent_buddy_rollout_tables.sql` and
`2068_live_places_rollout_flags.sql` — hiding **23 seeded flags, 8 of them read
by nothing.**

This is the same class of bug, with the same consequence, as the missing
`public.` qualifier that the file's own preamble already records: rule R6
("every seeded flag is either read or declared inert") **cannot fail on a flag
it never saw**, so the check reported a clean population precisely because it
was blind. The scanner did not report a gap; it reported that there wasn't one.

`src/test/flagPolaritySeedScan.test.ts` exists to catch exactly this by scanning
independently — and it did not, because it had independently written
`rest.indexOf(";")` too. Two implementations, one failure mode, perfect
agreement, no signal. Both are fixed in this commit, and the test now carries a
fixture that keeps failing against the old behaviour even if every
semicolon-bearing description is later reworded away.

> **Schema note.** The column is `feature_flags.flag`, not `key`. The sketch
> `select key from feature_flags` in the previous inventory would have errored.

## The disposition rule

**KEEP** = a code branch reads the flag and changes behaviour. **DROP** = none
does. This is the rule `2080_retire_inert_seeded_flags.sql` applied to the
previous ten, unchanged:

- Being **loaded** is not being read. `compass/flags.ts` `loadFlags()` pulls
  every `COMPASS_%` row into a `Record` on every Compass request; a name in that
  map with no `isEnabled()` call site is DROP.
- Being a key in a **requirements map** is not being read.
  `live_places_world_feed_enabled` and `place_chat_enabled` are keys in
  `LIVE_PLACES_REQUIREMENTS` (`lib/featureFlags.ts:106-107`) and in the client's
  mirror, but neither is ever passed to `isLivePlacesCapabilityEnabled()`.
- A **name collision** is not a reader. `ACTIVITY_SCORE_VERSION` has four
  references; all four are the exported const `ACTIVITY_SCORE_VERSION = "1.0"`
  (`CreatorActivityScoreService.ts:50`), unrelated to the flag row.
- A **comment** is not a reader. `ACTIVITY_SCORE_MAX_BOOST` appears twice, both
  in prose.

### Computed-key blind spot, closed

Every dynamic flag-name construction in either tree was enumerated:

```
compass/CompassEligibilityEngine.ts:49   `COMPASS_${item.type.toUpperCase()}_ENABLED`
compass/CompassSafetyFilter.ts:139       `COMPASS_${item.type.toUpperCase()}_SAFETY_BLOCK`
compass/CompassNotificationEngine.ts:297 `COMPASS_${category...}_SAFETY_BLOCK`
```

All three are `COMPASS_*` shapes. `CompassItemType` (`compass/types.ts:172`) is
`event | post | user | buddy | trip | stamp | …`, with no member that would
produce `COMPASS_V2_AB_ENABLED` — the only `COMPASS_*` name in these
populations. Nothing here is reachable through a computed key.

## Population A — the 30 live-but-never-seeded

9 KEEP, 21 DROP.

| Flag | Live | Reader | Verdict | Note |
|---|---|---|---|---|
| `ACTIVITY_DISCOVERY_BOOST_ENABLED` | false | `api:lib/creatorActivityScoreScheduler.ts:70` | **KEEP** | gates the recalc job; also DiscoveryRankingService.ts:707 shadow-mode |
| `CREATOR_FATIGUE_ENABLED` | false | `api:lib/rankLog.ts:36` | **KEEP** | isFatigueEnabled(), 60s TTL cache, gates fatigue upsert |
| `DISCOVERY_DIVERSITY_ENABLED` | false | `api:compass/CompassFeedBuilder.ts:497` | **KEEP** | isFlagEnabled; also :606 and routes/pulse.ts:744 |
| `MEDIA_HIDDEN_GEMS_CREATE_ENABLED` | **true** | `app:src/components/media/MediaQuickCreateSheet.tsx:128` | **KEEP** | APP-TREE ONLY — no api-server reader |
| `NEW_CONTRIBUTOR_BOOST_ENABLED` | false | `api:services/ranking/DiscoveryRankingService.ts:709` | **KEEP** | flags map literal key, gates boost |
| `RANKING_EXPERIMENT_ENABLED` | false | `api:services/ranking/DiscoveryRankingService.ts:708` | **KEEP** | also adminRankingMetrics.ts:342 |
| `RETURNING_USER_BOOST_ENABLED` | false | `api:services/ranking/DiscoveryRankingService.ts:710` | **KEEP** | flags map literal key, gates boost |
| `UNDEREXPOSED_CONTENT_BOOST_ENABLED` | false | `api:services/ranking/DiscoveryRankingService.ts:711` | **KEEP** | flags map literal key, gates boost |
| `passport_contribution_events_enabled` | **true** | `api:routes/passportStamps.ts:311` | **KEEP** | local 1-arg isFlagEnabled (defined :56), fail-closed |
| `ACTIVITY_SCORE_DECAY_ENABLED` | false | NONE | **DROP** | zero references in either tree |
| `ACTIVITY_SCORE_MAX_BOOST` | false | NONE | **DROP** | only two prose comments in DiscoveryRankingService |
| `ACTIVITY_SCORE_VERSION` | false | NONE | **DROP** | name collision: refs are a TS const "1.0" in CreatorActivityScoreService.ts:50, not the flag |
| `ANTI_GAMING_RANKING_ENABLED` | false | NONE | **DROP** | zero references in either tree |
| `COMPASS_V2_AB_ENABLED` | false | NONE | **DROP** | not reachable via COMPASS_${item.type} — no v2_ab in CompassItemType |
| `location_intelligence_phase1` | false | NONE | **DROP** | zero references in either tree |
| `location_intelligence_phase2` | false | NONE | **DROP** | zero references in either tree |
| `location_intelligence_phase3` | false | NONE | **DROP** | zero references in either tree |
| `location_intelligence_phase4` | false | NONE | **DROP** | zero references in either tree |
| `location_intelligence_phase5` | false | NONE | **DROP** | zero references in either tree |
| `location_intelligence_phase6` | false | NONE | **DROP** | zero references in either tree |
| `rent_buddy_earnings_ledger_enabled` | false | NONE | **DROP** | zero references in either tree |
| `rent_buddy_available_now_enabled` | **true** | NONE | **DROP** | reads TRUE in prod, gates nothing |
| `rent_buddy_marketplace_enabled` | **true** | NONE | **DROP** | reads TRUE in prod, gates nothing |
| `rent_buddy_packages_v2_enabled` | **true** | NONE | **DROP** | reads TRUE in prod; v1 RENT_BUDDY_PACKAGES_ENABLED is the wired one |
| `rent_buddy_requests_enabled` | **true** | NONE | **DROP** | reads TRUE in prod, gates nothing |
| `rent_buddy_tips_enabled` | **true** | NONE | **DROP** | reads TRUE in prod, gates nothing |
| `trust_admin_dashboard_enabled` | **true** | NONE | **DROP** | reads TRUE in prod, gates nothing |
| `trust_caps_enabled` | **true** | NONE | **DROP** | reads TRUE in prod, gates nothing |
| `trust_public_levels_enabled` | **true** | NONE | **DROP** | reads TRUE in prod, gates nothing |
| `trust_restrictions_enabled` | **true** | NONE | **DROP** | reads TRUE in prod, gates nothing |

## Population B — the 14 seeded-but-absent

6 KEEP, 8 DROP. The previous inventory named six of these and left four
"unidentified"; there were in fact **fourteen**, and the four it could not name
were never a residue — they are among the KEEPs.

| Flag | Live | Reader | Verdict | Note |
|---|---|---|---|---|
| `MEDIA_ACTIVE_CREATOR_BOOST_ENABLED` | — (absent) | `api:services/ranking/MediaFeedRankingService.ts:902` | **KEEP** | seeded 2040 (false); sets activeCreatorBoostEnabled |
| `rent_buddy_allow_bookings_without_kyc` | — (absent) | `api:lib/rentBuddyKycGate.ts:62` | **KEEP** | seeded 2074 (false); KYC override escape hatch, fail-closed |
| `location_phase1_gps` | — (absent) | NONE | **DROP** | seeded 0037; zero references |
| `location_phase2_zones` | — (absent) | NONE | **DROP** | seeded 0037; zero references |
| `location_phase3_geofence` | — (absent) | NONE | **DROP** | seeded 0037; zero references |
| `location_phase4_discovery` | — (absent) | NONE | **DROP** | seeded 0037; zero references |
| `location_phase5_pulse` | — (absent) | NONE | **DROP** | seeded 0037; zero references |
| `location_phase6_crew` | — (absent) | NONE | **DROP** | seeded 0037; zero references |
| `notifications_digest_enabled` | — (absent) | NONE | **DROP** | seeded 0037; zero references (distinct from the retired notification_digests_enabled) |
| `telegraph_suggestions_enabled` | — (absent) | NONE | **DROP** | seeded 0037; zero references |
| `MEDIA_NEW_CREATOR_BOOST_ENABLED` | — (absent) | `api:services/ranking/MediaFeedRankingService.ts:903` | **KEEP** | seeded 2040 (false); sets newCreatorBoostEnabled |
| `MEDIA_RETURNING_CREATOR_BOOST_ENABLED` | — (absent) | `api:services/ranking/MediaFeedRankingService.ts:904` | **KEEP** | seeded 2040 (false); sets returningCreatorBoostEnabled |
| `MEDIA_UNDEREXPOSED_BOOST_ENABLED` | — (absent) | `api:services/ranking/MediaFeedRankingService.ts:905` | **KEEP** | seeded 2040 (false); sets underexposedBoostEnabled |
| `MEDIA_CREATOR_FATIGUE_ENABLED` | — (absent) | `api:services/ranking/MediaFeedRankingService.ts:906` | **KEEP** | seeded 2040 (false); sets creatorFatigueEnabled |

### All five flags seeded by 2040 are absent — that migration never ran

`2040_media_ranking_boost_flags.sql` seeds five `MEDIA_*` flags in one
statement. **All five are missing from production**, and all five are read by
`MediaFeedRankingService.getFlagDefaults()`. A single statement with
`ON CONFLICT DO NOTHING` cannot insert partially, so the explanation is not
per-row deletion: **2040 was never applied to production.**

The broken scanner hid this too — it could see only one of the five, which
looked like a lone deleted row and invited exactly the wrong theory. The
consequence today is benign, because all five seed `false` and the reader
defaults each to `false` when the row is absent, so media ranking runs in
base-score-only mode either way. It is still a migration in the repository that
production has not run, and that is worth knowing independently of these flags.

### `rent_buddy_allow_bookings_without_kyc` — absent, and absent is the safe state

The sharpest row in the table. It is the override that permits Rent-a-Buddy
booking creation **while identity verification is non-operational** —
`rentBuddyKycGate.ts:38` calls enabling it "an explicit statement that you
accept unverified strangers meeting in person." Production has no working KYC
provider: both real adapters are stubs and the mock is refused in production.

It is read at `rentBuddyKycGate.ts:62` through `isFlagEnabled()`, which returns
false on any DB error, so **a missing row reads `false` and the gate stays
closed**. Production is in the safe state precisely because the row is absent.
`2074` seeds it `false`.

Codifying it is therefore a no-op in behaviour. What must not happen is a
"codify" that seeds it `true`, or an operator creating the row by hand to quiet
a drift report. The migration for it must seed `false` and assert the value
after insert.

## Population C — 19 that were mis-reported as unseeded

These are **not drift**. They are seeded and live — the healthy case. They
appear here only because the broken scanner classified them as "live but never
seeded", which is what made the old population 49 instead of 30. 15 are KEEP and
need no action at all. The 4 DROPs are genuinely inert seeded flags that R6
could not previously ask about; they are declared inert in this commit with
disposition `remove-from-seed`, and their retirement follows.

| Flag | Live | Reader | Verdict | Note |
|---|---|---|---|---|
| `RENT_BUDDY_ADMIN_ONLY_MODE` | false | `api:routes/rentABuddyRollout.ts:171` | **KEEP** | getFlag(); gates rollout access |
| `RENT_BUDDY_BETA_ONLY_MODE` | false | `api:routes/rentABuddyRollout.ts:410` | **KEEP** | getFlag(); gates rollout access |
| `RENT_BUDDY_GROUP_BOOKINGS_ENABLED` | **true** | `api:routes/rentABuddyRollout.ts:245` | **KEEP** | getFlag(); 403 group_bookings_unavailable |
| `RENT_BUDDY_NIGHTLIFE_ENABLED` | **true** | `api:routes/rentABuddyRollout.ts:304` | **KEEP** | getFlag(); 403 when off |
| `RENT_BUDDY_OFFERS_ENABLED` | **true** | `api:routes/rentABuddyRollout.ts:271` | **KEEP** | getFlag(); 403 offers_unavailable |
| `RENT_BUDDY_PACKAGES_ENABLED` | **true** | `api:routes/rentABuddyRollout.ts:258` | **KEEP** | getFlag(); 403 packages_unavailable |
| `city_launch_mode` | false | `app:src/screens/admin/featureFlags.machine.ts:34` | **KEEP** | APP-TREE ONLY — banner only, NO server enforcement |
| `disable_messaging` | false | `api:routes/messaging.ts:1682` | **KEEP** | isKillSwitchEngaged, fail-CLOSED; also :1997 |
| `disable_posting` | false | `api:routes/posts.ts:447` | **KEEP** | isKillSwitchEngaged, fail-CLOSED |
| `disable_rent_buddy_booking` | false | `api:routes/rentABuddy.ts:1005` | **KEEP** | isKillSwitchEngaged |
| `invite_only_beta` | false | `api:routes/auth.ts:128` | **KEEP** | isFlagEnabled; gates signup form |
| `moment_recaps_enabled` | false | `api:lib/places/recaps.ts:17` | **KEEP** | isLivePlacesCapabilityEnabled via ternary |
| `shared_moments_chat_enabled` | false | `api:routes/sharedMoments.ts:109` | **KEEP** | isLivePlacesCapabilityEnabled |
| `shared_moments_clustering_enabled` | false | `api:routes/sharedMoments.ts:94` | **KEEP** | isLivePlacesCapabilityEnabled |
| `shared_moments_compass_suggestions_enabled` | false | `api:routes/sharedMoments.ts:93` | **KEEP** | isLivePlacesCapabilityEnabled |
| `RENT_BUDDY_CASH_BALANCE_ENABLED` | false | NONE | **DROP** | zero references in either tree |
| `RENT_BUDDY_DELAYED_POSTING_REQUIRED` | false | NONE | **DROP** | zero references in either tree |
| `live_places_world_feed_enabled` | false | NONE | **DROP** | map key only (featureFlags.ts:106 + client mirror); never passed as a capability |
| `place_chat_enabled` | false | NONE | **DROP** | map key only (featureFlags.ts:107 + client mirror); never passed as a capability |

## Two findings that shape the remedy

### `city_launch_mode` — a kill switch with a banner and no enforcement

KEEP under the stated rule: `getActiveKillSwitches()`
(`app:src/screens/admin/featureFlags.machine.ts:34`) reads its value and drives
a prominent red "kill switch active" banner on the admin screen.

But that is its *only* reader. It sits in `KILL_SWITCH_FLAGS` beside
`disable_posting`, `disable_messaging`, `disable_rent_buddy_booking` and
`invite_only_beta` — each of which **also** has a server-side
`isKillSwitchEngaged()` call. `city_launch_mode` has none. Switching it on
announces that a kill switch is engaged while restricting nothing. That is the
`safety_notifications_enabled` failure mode of `2080` in a different costume.

This work does **not** resolve it in either direction: deleting the row would
remove a control an operator can currently see, and wiring it is a product
decision about what "city launch mode" should stop. It is recorded as
KEEP-with-a-defect and left to the owner.

### The polarity guard could not see the app tree

`check-flag-polarity.mjs` walks `api-server/src` only (`SRC`, line 171), so R6
fails any seeded flag whose only reader is in the mobile app. `city_launch_mode`
is exactly that, and neither existing escape hatch says anything true about it:
`INERT_SEEDED_FLAGS` asserts a flag is unread (false here), and
`UNRESOLVABLE`/`DIRECT_READS` entries are keyed to an api-server file and
expression that does not exist for an app-tree read.

This commit adds `APP_TREE_READS`, which records the app `file:line` and is
**machine-checked** by new rule R8: the guard opens the named app file and fails
if the flag literal is not there. If the read is deleted or the component moves,
the check fails instead of continuing to vouch for a reader that is gone. It is
a declaration list, not an exemption switch — the same argument the
`UNRESOLVABLE` `covers` arrays make for being lists rather than prose.

`MEDIA_HIDDEN_GEMS_CREATE_ENABLED` is the other app-only read, but it is not
seeded at all, so R6 never asks about it and it gets no entry. R8 enforces that:
an `APP_TREE_READS` entry for an unseeded flag is reported as stale.

## Implementation — built, CI-verified, production staged

Owner approved the classification on 2026-08-12. The migrations are committed and
verified against the CI project; **production is untouched and waits on the
owner's explicit go.**

| Outcome | Population | Count | Migration / action | CI result |
|---|---|---|---|---|
| **KEEP** — codify | live, unseeded, read | 9 | `2084` idempotent `INSERT … ON CONFLICT DO NOTHING` at live value | 9/9 present |
| **KEEP** — apply existing seed | seeded, absent, read | 6 | `2085` idempotent `INSERT`, all `false` | 6/6 present |
| **DROP** — delete row | live, unseeded, unread | 21 | `2086` `DELETE` | 0/21 remain |
| **DROP** — neutralise seed | seeded, absent, unread | 8 | seed removed from `0037`; `2086` `DELETE` is a zero-row no-op in prod | 0/8 remain |
| **REMOVE-FROM-SEED** | seeded **and** live, unread | 4 | row deleted by `2086` **and** seed removed from `0090`/`2068` | 0/4 remain |

**Production effect when applied: 168 → 149 rows.** `2084` inserts nothing (all
nine already exist — it reconciles the repository, not production), `2085`
inserts 6, `2086` deletes 25 of its 33 names (the other 8 are already absent).

### CI verification (`hwokxgbmezheskbzskfr`)

A fixture mirroring production was seeded first — the 25 DROP rows at their live
values, the 9 KEEP-A rows at their live values, and the 3 wired siblings — so the
migrations ran against representative state rather than an empty table.

- All three applied in order, cleanly; every post-condition passed.
- KEEP-A live values **byte-identical before and after**: `ON CONFLICT DO
  NOTHING` confirmed a genuine no-op, not an overwrite.
- `rent_buddy_allow_bookings_without_kyc` reads **false** after convergence.
- Re-applied a second time: row count unchanged. **Idempotent.**
- **Audit-log guard red-proofed**: an audit row was planted, `2086` refused with
  its `REFUSING` message, and the transaction rolled back leaving the flag
  intact. The `ON DELETE CASCADE` protection is real, not decorative.
- `check:flag-polarity` green throughout; seeded population 152 → 149
  (−12 neutralised, +9 codified). 91 flag tests pass.

Production apply block and per-block verification queries are staged, unversioned,
at `_incoming/prod-apply-flag-reconciliation.sql`. It begins with a full-table
snapshot step, because **the 25 deletes are the irreversible part** and no
migration restores them.

## Adjacent dead code — recorded, deliberately NOT touched

The approved unit was the classification, not the cleanup it makes visible.
Dropping these flags leaves the following orphaned; each is a follow-up, and none
was changed:

| Location | What is now dead | Why it was left |
|---|---|---|
| `api-server/src/lib/featureFlags.ts:106-107` | `live_places_world_feed_enabled` and `place_chat_enabled` keys in `LIVE_PLACES_REQUIREMENTS` | The flags are gone, so `resolveFeatureFlags()` will never find them in `rawFlags` and the entries are inert. Removing them is a code change to a shared helper, outside this unit. |
| `travel-buddy/src/context/FeatureFlagsContext.tsx:95-96` | the client mirror of those same two keys | Same, in the app tree. The two maps must be changed together or they drift. |
| `api-server/src/services/ranking/DiscoveryRankingService.ts:491,797` | two comments referencing `ACTIVITY_SCORE_MAX_BOOST` | Prose only — no code reads it. Left because editing comments is not a disposition. |
| `routes/admin.ts` / `routes/featureFlags.ts` filter lists | the 33 retired names are **not** added | Those lists keep behaviour identical on databases where the retirement has not yet been applied. Adding 33 names is a code change outside this unit — see the staged block. |

> **`ACTIVITY_SCORE_VERSION` is NOT dead code.** The flag of that name is
> dropped, but the four references in `CreatorActivityScoreService.ts:50,310` and
> `adminRankingMetrics.ts:44,507` are a TypeScript const `= "1.0"` that has
> nothing to do with the flag row. It is live code and must not be removed. This
> name collision is why the flag reported four "references" and still verdicts
> DROP.

## Original remedy plan (superseded by the table above)

The plan as first drafted, kept for the record. It is what the implementation
above executes.

| Bucket | Count | Remedy |
|---|---|---|
| A, KEEP — live, genuinely unseeded | 9 | Codify: idempotent `INSERT … ON CONFLICT DO NOTHING` at the live value |
| A, DROP — live, unseeded, unread | 21 | Retire: delete the row; there is no seed to neutralise |
| B, KEEP — seeded, absent, read | 6 | Apply the existing seed to production; all seed `false`, so no behaviour changes |
| B, DROP — seeded, absent, unread | 8 | Neutralise the seed; the `DELETE` is a zero-row no-op in production |
| C, KEEP — seeded and live, read | 15 | **No action.** Not drift. |
| C, DROP — seeded and live, unread | 4 | Delete the row **and** neutralise the seed in `0090` / `2068` |

The old numbers made this look like **24** flags needing codification. The true
figure is **9**. The other 15 are already seeded — the repository defines them
and always did — so codifying them would have added a second, duplicate seed row
for each, in migrations written to fix a drift they were not part of. Six of
those 15 are the `RENT_BUDDY_*` rollout gates seeded by `0090`, i.e. precisely
the flags the truncated statement hid. That is the concrete cost the scanner
defect would have imposed had the remedy been built on the numbers it produced.

### The `location_*` families resolve in opposite directions

Production holds `location_intelligence_phase1…6` — unseeded, all false, no
reader (population A). The migrations seed `location_phase1_gps …
location_phase6_crew` — absent from production, no reader (population B). Two
six-flag families describing one rollout under two naming schemes, one on each
side of the drift, **neither read by anything**. Both are DROP, but by different
mechanisms: the live six are deleted, the seeded six are removed from
`0037_feature_flags.sql`. Reconciling the populations separately would have
invited "codify one to match the other", creating six live rows for a rollout
that exists in no code.

## Method and limits

- Live values: one `SELECT` through the guarded read-only path. No write.
- Seeded set: the matcher from `check-flag-polarity.mjs`, replicated verbatim
  **including this commit's terminator fix**, over 270 files / 54 statements /
  152 distinct names.
- Readers: literal-string search across `api-server/src` and `travel-buddy`,
  excluding tests, `node_modules`, `.d.ts`, migrations and audit scripts; every
  hit then read in context to classify it as a branch, a map entry, a comment or
  a collision. Computed-key constructions enumerated separately (above).
- `mockup-sandbox` is not a shipping tree and was not scanned.
- A verdict of DROP is strong evidence, not proof, that no reader exists. The
  computed-key enumeration closes the known gap; a flag reached through some
  mechanism not listed above would still be missed.

**Held and untouched:** all production flag writes, `post_media` read policy,
`content_stamps` retention, the editorial-posts work, and the Step C grant.
