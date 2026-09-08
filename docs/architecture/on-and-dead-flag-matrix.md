# The ON-and-dead flags — live matrix

A flag is **ON-and-dead** when it is `TRUE` in production and the code behind it
names schema production does not have. The flag says the feature is on; the
database cannot answer it. Every call on that path fails — and, because
**supabase-js resolves on a database error**, usually fails *silently*.

Authority: `src/scripts/checkFlagSchemaPrerequisites.ts` (`KNOWN`), graded
against `lib/capability/snapshots/20260908-production-schema.json`. That
snapshot is a frozen capture — **it is the expiry date on every answer below.**
Re-measure before trusting this page; the numbers here are as of 2026-09-08.

## Count

| | 2026-09-07 | 2026-09-08 | why it moved |
|---|---|---|---|
| unguarded (ON, dead, and the code runs into it) | **11** | **7** | four prerequisite migrations applied |
| guarded (ON and dead, but the code refuses first) | 1 | 1 | `media_canonical_enabled`, held by an owner decision |

The four were retired **by applying the migration**, not by editing the list.
That distinction is the whole point: striking an entry makes the report shorter,
applying the migration makes the statement true.

## Classification key

`A` prerequisite migration now safe · `B` code capability guard needed ·
`C` stale flag, disable it · `D` owner decision · `E` external dependency

## Retired 2026-09-08

| Flag | Was missing | Resolved by | Class |
|---|---|---|---|
| `trust_engine_enabled` | `trust_profiles.evidence_weight`, `.evidence_count` | **2371** applied to production | A ✅ |
| `layover_plans_enabled` | `trip_kernel_execute()` | **2420** applied | A ✅ |
| `airport_mode_enabled` | `layover_recommendations.rec_key`, `trip_kernel_execute()` | **2410** + **2420** applied | A ✅ |
| `layover_safety_engine_enabled` | `layover_recommendations.rec_key` | **2410** applied | A ✅ |

**What retiring these does and does not mean.** It closes the schema half of
`capability = FLAG_ENABLED && SCHEMA_CAPABILITY_READY`: the flags are no longer
ON over a database that cannot answer them. It does **not** mean the features
run. The branch carrying their code is unmerged, and the layover upsert path is
behind `layover_stable_recommendation_ids_enabled`, which 2410 seeds FALSE.
**Nothing a traveller sees has changed.**

## Still ON and dead — the seven

| Flag | Prod enabled | Missing prerequisite | User impact today | Safe fix | Class |
|---|---|---|---|---|---|
| `intel_claim_projection_crowd` | TRUE | `canonical_events` (**2120**), `intel_state_snapshot_versions` (**2273**), `intel_claims.updated_at/.version` (**2274**), `intel_state_snapshots.conflict_state` (**2275**), scope columns (**2430**) | The Live spine never projects. `intelProjectionScheduler` 42703s on every tick and logs `reason:'error'`; the snapshot insert PGRST205s and is tallied as `skipped`. No Live state is ever computed. | Apply 2120 → 2273 → 2274 → 2275; then 2430 | **A** |
| `intel_limited_live` | TRUE | `intel_live_promoted_scopes.expires_at/.withdrawn_at` (**2430**), `conflict_state` (**2275**) | `liveClaimRead` 42703s, so **no Live claim can ever be served**. The pilot capability is on and cannot fire. | Apply 2275; 2430 needs a CI rehearsal first | **A** |
| `intel_live_label_crowd` | TRUE | same as above | Same read (`liveLabelsServable`). No LIVE label reaches any place surface. | With `intel_limited_live` — same sites | **A** |
| `intel_capture_quick_signal` | TRUE | `intel_claims.observation_id` (**2274**), `intel_presence_verifications` + 6 cols (**2276**), scope cols (**2430**), `conflict_state` (**2275**) | `IntelCaptureService` insert of presence verification PGRST205s; the observation read 42703s. Capture runs and drops evidence. | Apply 2274 → 2276 (both CI-proven) | **A** |
| `intel_trail_followup` | TRUE | `intel_claims.observation_id` (**2274**), `intel_presence_verifications` (**2276**) | Same `IntelCaptureService` sites via `SURFACE_FLAG`. Trail follow-up capture writes nothing. | With `intel_capture_quick_signal` | **A** |
| `hidden_gems_enabled` | TRUE | `hidden_gem_contributions` + 6 cols (**2252**) | `HiddenGemContributionService` reads and upserts a table that is not there. Gem contributions are lost. The rest of Hidden Gems is unaffected. | Apply **2252** (CI-proven) | **A** |
| `safe_return_enabled` | TRUE | `locate_friends_sessions`/`_members` + cols (**2219**) | `routes/safeReturn.ts` → `PassportProjectionService` reads the locate-friends tables. **The read is not gated on `locate_friends_enabled`** (which has no row in production) — so a Safe Return call carries an ungated read of another feature's schema. | Two independent fixes: apply **2219**, *and* gate that read on its own flag or register a capability. The guard is worth doing even after the migration lands. | **A + B** |

### And the one guarded entry

| Flag | Prod enabled | Missing prerequisite | User impact today | Safe fix | Class |
|---|---|---|---|---|---|
| `media_canonical_enabled` | TRUE | `media_assets.captured_at`, `.location_visibility`, `.provenance`, `.intelligence_eligibility` (**2250** / **2470**) | **None any more.** Registered as `MEDIA_CANONICAL`; `lib/mediaAssets.ts` refuses before building a payload (`refused_schema`, error-level log) and the legacy `post_media`/`media_urls` path stays authoritative. Before the guard this was the founding case: every canonical upsert PGRST204'd and every rejection was swallowed, for three weeks. | **Do not choose.** `MEDIA_CANONICAL_FLAG` is an owner decision: apply 2250/2470, or turn the flag off. `2250` additionally **cannot** be applied as written — its own postcondition asserts `media_canonical_enabled` is FALSE, and it is TRUE, so it fails on itself. `2470` is the same DDL without that postcondition. | **D** |

## Why every remaining one is class A, and what that costs

All eight prerequisite migrations exist in the tree, and **seven of the eight are
already applied and verified on portava-ci** — 2120, 2219, 2252, 2273, 2274,
2275, 2276. They are absent only in production. So these are not missing work;
they are the CI-versus-production divergence, and each already has a CI
rehearsal behind it.

**2430 is the exception: absent on both databases.** It has never been rehearsed
anywhere, so it does not inherit the others' evidence and needs CI first.

Class A does not mean "apply it now". Each still owes the full migration safety
gate against production's real data — CI proving a migration over an *empty*
table proves nothing about the same migration over a populated one. That trap
was hit this session: 2410's CI rehearsal ran against 0 rows while production
held 30, one session sharing 13 of them.

## Target

Production `TRUE` + prerequisites missing + **unsafe route** = **0**.

Note the third term. `media_canonical_enabled` is TRUE with prerequisites
missing and stays that way pending an owner decision — but its route is guarded,
so it does not count against the target. The target is about reachable dead
paths, not about the flag table looking tidy.

Currently **7 of 8** remaining entries are unguarded, i.e. still count.
