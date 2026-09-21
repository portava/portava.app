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

| | 2026-09-07 | 2026-09-08 (first pass) | 2026-09-08 (final) | why it moved |
|---|---|---|---|---|
| unguarded (ON, dead, and the code runs into it) | **11** | **7** | **4** | twelve prerequisite migrations applied |
| guarded (ON and dead, but the code refuses first) | 1 | 1 | 1 | `media_canonical_enabled`, held by an owner decision |

Verified by `checkFlagSchemaPrerequisites` against a snapshot refreshed in the
same change: `OK — 4 unguarded (all known), 1 guarded, 27 latent`, exit 0.

The four were retired **by applying the migration**, not by editing the list.
That distinction is the whole point: striking an entry makes the report shorter,
applying the migration makes the statement true.

## Classification key

`A` prerequisite migration now safe · `B` code capability guard needed ·
`C` stale flag, disable it · `D` owner decision · `E` external dependency

## Retired 2026-09-08

| Flag | Was missing | Resolved by | Class |
|---|---|---|---|
| `hidden_gems_enabled` | `hidden_gem_contributions` + 6 cols | **2252** applied | A ✅ |
| `safe_return_enabled` | `locate_friends_sessions`/`_members` + cols | **2219** applied — **class-B half still open, see below** | A ✅ / B ⚠ |
| `intel_trail_followup` | `intel_claims.observation_id`, `intel_presence_verifications` | **2274** + **2276** applied | A ✅ |
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

## Still ON and dead — the four

All four are the same blocker: **`2430` alone**, for its two
`intel_live_promoted_scopes` columns. `2120`, `2273`, `2274`, `2275` and `2276`
were applied to production on 2026-09-08, so `canonical_events`, the version
table, the claim version columns, `conflict_state` and
`intel_presence_verifications` all exist and those reads no longer fail.

| Flag | Prod enabled | Missing prerequisite | User impact today | Safe fix | Class |
|---|---|---|---|---|---|
| `intel_claim_projection_crowd` | TRUE | `intel_live_promoted_scopes.expires_at`, `.withdrawn_at` (**2430**) | The projection now has everywhere to write, but `liveClaimRead` still 42703s on the scope columns, so no Live state is served. | Apply 2430 — **CI rehearsal first** | **A** |
| `intel_limited_live` | TRUE | same | `liveClaimRead.ts:260`. No Live claim can be served. | with 2430 | **A** |
| `intel_live_label_crowd` | TRUE | same | Same read in `liveLabelsServable`. No LIVE label reaches a place surface. | with 2430 | **A** |
| `intel_capture_quick_signal` | TRUE | same | Capture now records presence verifications correctly; only the scope read remains. | with 2430 | **A** |

### Why `2430` is not in the applied batch

It is the **only** migration in this set absent from **both** databases. Its
seven siblings were already applied and verified on portava-ci, so applying them
to production closed a known CI-versus-production divergence and each carried a
real rehearsal behind it. `2430` has never run anywhere. It therefore does not
inherit that evidence and needs a CI rehearsal before it can be gated for
production. Applying it on the strength of its siblings' record would be exactly
the reasoning this matrix exists to prevent.

### The class-B item that applying a migration did NOT fix

`safe_return_enabled` no longer names absent schema, so it leaves the unguarded
list. **That is not the whole defect.** `routes/safeReturn.ts` reaches
`PassportProjectionService`, which reads the locate-friends tables **without
gating on `locate_friends_enabled`** — a flag that is now present and FALSE. So
a Safe Return call still carries an ungated read of another feature's schema; it
simply no longer crashes. The class-B fix — gate that read on its own flag, or
register a capability — is still owed, and is tracked here rather than being
allowed to disappear along with the class-A half.

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
