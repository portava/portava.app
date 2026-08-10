# Admin moderation — coverage audit

**Date:** 2026-08-09 · **Trees:** `artifacts/api-server`, `travel-buddy-standalone` ·
**Status:** audit only, nothing built.

> **UPDATE 2026-08-09 — §E FK confirmed; §A storage bugs fixed; guard count corrected.**
>
> **§E foreign key — CONFIRMED, but latent, not active.** Queried live:
> `moderation_actions_target_user_id_fkey FOREIGN KEY (target_user_id)
> REFERENCES profiles(id) ON DELETE CASCADE`. The constraint is real and
> enforced, so resolving a post/place/trip/event/message/thread report *will*
> 500. **But the whole moderation system has zero rows** — `reports` 0,
> `moderation_reports` 0, `moderation_actions` 0, `user_account_states` 0
> (56 profiles). Nothing has ever been reported or moderated, so this has never
> fired in production. It is a first-use defect, not a live outage: severity
> below is downgraded from "blocks the majority of complaints today" to "breaks
> on the first non-user complaint ever filed". **Not yet fixed** — held pending
> direction.
>
> **§A storage orphans — FIXED.** The predicted cause (private bucket ⇒ signed
> URLs ⇒ slice fails) was wrong: there are **zero** signed URLs. The real cause
> is that `avatar_url`/`cover_photo_url` hold **three** formats, and the format
> the *current* upload endpoints write — a bucket-qualified path,
> `profile-media/avatars/…` (`routes/profile.ts:1015`) — is exactly the one the
> old `/object/public/` slice could not parse. See §A below.
>
> **Orphan census 2026-08-09 — and a live user-facing bug found while counting.**
> Nothing swept; counts only. See "Storage orphan census" below.
>
> **Guard count — 33, not 30 or 31.** `checkAdminGuard.ts` now detects guards by
> shape. Re-run against the pre-sweep tree: **33** local role gates, not the 30
> the original audit recorded nor the 31 this document claimed. See the guard
> section below.

Requirement audited, verbatim from the roadmap:

> "Admin moderation — delete any media/profile, restrict based on complaints"

## Verdict at a glance

| | Capability | Status |
|---|---|---|
| A | Delete any single media item, incl. storage object | **PARTIAL** |
| B | Delete / deactivate an entire profile | **PARTIAL** |
| C | Restrict short of deletion | **EXISTS** |
| D | Complaint intake | **PARTIAL** |
| E | Complaint queue an admin works from | **PARTIAL** |
| F | Audit trail | **PARTIAL** |
| G | Client admin UI | **PARTIAL** |

The headline: **"restrict based on complaints" is the better-built half.** C is
genuinely complete. The weak half is *"delete any media"* — for three of the
four media types named in the requirement there is no admin delete at all, and
the complaint queue that is supposed to drive moderation is split across two
tables with no link from an action back to the report that caused it.

---

## A. Delete any single media item — **PARTIAL**

The requirement names four media types. Admin coverage differs for each.

| Media type | Admin can delete? | Storage object removed? | Evidence |
|---|---|---|---|
| Profile photo (avatar) | **yes** | **yes** (best-effort) | `src/routes/admin.ts:1407` route, `:1427` `storage.remove` |
| Profile cover photo | **yes** | **yes** (best-effort) | `src/routes/admin.ts:1438` route, `:1457` `storage.remove` |
| Postcard image / video | **yes**, but not via an admin route | **yes** | `src/routes/postcards.ts:729` route, `:766` inline admin check, `:787` `storage.remove` |
| Highlight | **no** | n/a — no storage call at all | `src/routes/highlights.ts:466`, owner-only at `:482` |

### Storage trace (specifically requested)

Traced to the actual call in every case. Deletion of profile media does reach
Supabase Storage:

```ts
// src/routes/admin.ts:1420-1429  (DELETE /admin/users/:userId/avatar)
const marker = `/object/public/${PROFILE_MEDIA_BUCKET}/`;
const idx = oldUrl.indexOf(marker);
if (idx !== -1) {
  const oldPath = oldUrl.slice(idx + marker.length);
  await sc.storage.from(PROFILE_MEDIA_BUCKET).remove([oldPath]);
}
```

> **FIXED 2026-08-09.** Both paths now resolve the object path through
> `lib/storagePath.ts` (handles all three stored formats plus signed URLs),
> remove the object **before** nulling the column, and **fail loud** — a
> `db_error` with the column left intact — when the path cannot be derived or
> the removal fails. `external` (a seed URL with no object of ours) is reported
> as success, because it is. What follows describes the pre-fix state and the
> live evidence behind it.

Three qualifications, all of which make this PARTIAL rather than EXISTS:

1. **The storage delete is best-effort and silent.** It is wrapped in
   `try { … } catch { /* storage delete is best-effort */ }`
   (`admin.ts:1419`, `:1450`). The DB row is nulled regardless. A storage
   failure orphans the object with no error, no retry, and no log.
2. **The path is recovered by string-slicing the public URL** — and live data
   shows that slice missing far more often than it hits. Measured against the
   56-row `profiles` table on 2026-08-09, `avatar_url` holds **three** shapes:

   | Shape | Rows | Old slice |
   |---|---|---|
   | `https://…/object/public/profile-media/avatars/…` | 2 | works |
   | `profile-media/avatars/<uid>/<file>.jpg` | 1 | **fails — silent orphan** |
   | external (picsum ×25, unsplash, dicebear) | 27 | skips, correctly — no object exists |

   Covers are the same: 1 public-url, 1 bucket-path, 25 external.

   The bucket-path shape is not legacy debris — it is what the upload endpoints
   return **today**: `res.json({ url: `${AVATAR_BUCKET}/${path}` })`
   (`routes/profile.ts:1015`, `:1086`). So the format the app currently writes
   was precisely the format the delete could not parse. Note also there is **no
   stored path column** on `profiles` (only `avatar_url`/`cover_photo_url`), so
   "derive from the column, not the URL" required parsing the column's value
   rather than reading a dedicated field.

   Both `profile-media` and `post-media` are private buckets
   (`storage.buckets.public = false`), confirmed live — but zero signed URLs are
   stored, so signed-URL parsing was never the failing case.
3. **There is no admin route to delete a single post media item.** The admin
   media endpoint only changes a status flag:

```ts
// src/routes/adminMedia.ts:257-266  (POST /admin/media/:id/moderate, target=post_media)
const newStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "flagged";
await sc.from("post_media").update({ moderation_status: newStatus }).eq("id", id)…
```

`adminMedia.ts` contains **no storage call whatsoever** — yet it already
selects the columns needed for one (`adminMedia.ts:53` selects
`storage_path, storage_bucket`). The path is in hand and unused. "Reject"
hides the media; the bytes stay in the bucket indefinitely.

> **FIXED 2026-08-09 — as a new `delete` action, not by changing `reject`.**
> `reject` still only hides (reversible status flip, Storage untouched).
> A separate `action: "delete"` for `target: "post_media"` removes the object
> **and its `thumbnail_storage_path` sibling** — a second object a naive fix
> would have orphaned — audits to `moderation_actions` against the media
> **owner** (`post_media.user_id`, so the §E foreign key is satisfied) with the
> bucket and path recorded in the previously-unused `metadata` column, and
> fails loud without deleting the row if Storage removal fails. Rationale:
> overloading `reject` would make every mis-click irreversible, and §F
> establishes there is nothing to recover with.

The only path that truly deletes postcard media — row *and* object — is the
**user-facing** `DELETE /postcards/:id/media/:mediaId`, which an admin can use
because of an inline role check (`postcards.ts:766`). It is not discoverable as
an admin capability, is absent from the admin API surface, and has no UI.

**Missing for EXISTS:** an admin delete for post media and highlights; storage
removal in the admin media path; a non-silent failure mode for orphaned
objects; a path derived from stored state rather than parsed out of a URL.

---

## B. Delete / deactivate an entire profile — **PARTIAL**

**An admin cannot delete an arbitrary profile.** The only admin execution path
requires a *pre-existing, user-initiated, still-pending* deletion request:

```ts
// src/routes/admin.ts:1763  POST /admin/deletion-requests/:id/execute
.select("user_id, status").eq("user_id", req.params.id).eq("status", "pending")
…
if (!reqRow) { sendError(res, "not_found", "Deletion request not found or already executed"); return; }
```

So for a user who has *not* asked to be deleted, the strongest admin action is
`ban` (`admin.ts:1279`), which sets `profiles.account_status = 'banned'` and
leaves all content in place.

When deletion does run, the cascade is thorough but not complete
(`src/services/accountDeletion/AccountDeletionService.ts`):

| Content | Deleted? | Evidence |
|---|---|---|
| Posts, comments, likes, saves, shares | yes | `:198` and the batch at `:263` |
| Post media + **storage objects** | yes | `:186` `storage.from(bucket).remove(...)`, batched 100 at a time |
| Messages (sender's rows) | yes | `:206` |
| Devices, key packages (E2EE) | yes | `:275`, `:280` |
| Stories, hidden gems, reviews, follows, notifications | yes | batch at `:263` |
| **Highlights** | **no** | absent from the service |
| **Memories** | **no** | absent from the service |
| **Rent-a-buddy bookings** | **no** | absent from the service |
| **Trips, events** | **no** | absent from the service |
| Profile row | anonymised tombstone, not deleted | `:13-30` — deliberate, documented |

The tombstone is a deliberate design choice (deleting the row would fire 163
FK cascades — `AccountDeletionService.ts:24-25`). But because the tombstone
survives, anything not explicitly deleted **survives with it**. Highlights,
memories, bookings, trips and events remain attached to an anonymised profile.

**Missing for EXISTS:** an admin-initiated deletion that does not require a
user request; cascade coverage for highlights, memories, bookings, trips,
events; a stated decision for each of those (retain vs delete) rather than
silence.

---

## C. Restrict short of deletion — **EXISTS**

This is the strongest area. There are many states between active and deleted.

| Action | Route | Effect |
|---|---|---|
| warn | `admin.ts:1212` | audit row only, no state change |
| restrict | `admin.ts:1232` | `user_account_states.state = 'restricted'` |
| suspend | `admin.ts:1251` | `profiles.account_status = 'suspended'` + state row, supports `expires_at` |
| ban | `admin.ts:1279` | `account_status = 'banned'`, permanent |
| restore | `admin.ts:1306` | back to `active`, lifts suspension/ban |
| restrict-bio | `admin.ts:1333` | clears and locks bio |
| restrict-messaging | `admin.ts:1350` | messaging limits |
| restrict-visibility | `admin.ts:1369` | visibility limits |
| hide-posts | `admin.ts:1388` | `profile_privacy_settings.show_posts = false` |

Documented state vocabulary (`src/migrations/0063_interaction_foundation.sql:154`):

```
state values: 'active' | 'suspended' | 'limited' | 'deleted' | 'deactivated' | 'banned'
```

A second, independent restriction system exists for trust
(`src/services/trust/TrustRestrictionService.ts:14`): `hosting`,
`private_plan_access`, `messaging`, `location_plan_join`, applied via
`trust-admin.ts` with expiry and lift support.

Two systems means `messaging` can be restricted from either
`admin.ts:1350` or the trust path, and neither knows about the other — worth
noting, but it is duplication, not a gap.

---

## D. Complaint intake — **PARTIAL**

Reportable, but through **two parallel systems writing two different tables**.

**System 1 — `reports`** (`src/routes/reports.ts:29`):

```ts
const TARGET_TYPES = ["user", "profile", "message", "thread", "trip", "post", "place", "event"] as const;
```

**System 2 — `moderation_reports`** (`src/routes/moderation.ts:27`):

```ts
const SUBJECT_TYPES = ["user", "post", "comment", "message", "event", "review", "buddy_listing", "media", "place"] as const;
```

Plus specialised intakes with their own tables: hidden gems
(`hiddenGems.ts:981` → `hidden_gem_reports`), highlights
(`highlights.ts:782`), place images, place mismatches, airport reports.

Against the entities the requirement implies:

| Entity | Reportable? | Where |
|---|---|---|
| Post | yes | both systems |
| Profile / user | yes | both (`user`, and `profile` in system 1 only) |
| Media item | yes | system 2 only (`media`) |
| Buddy | yes | system 2 only (`buddy_listing`) |
| Hidden gem | yes | separate table, neither system |
| Highlight | yes | separate path |
| Comment / review | yes | system 2 only |
| Trip / thread | yes | system 1 only |

**Missing for EXISTS:** a single intake. Today the reportable set depends on
which client sheet the user happened to open, `media` and `buddy_listing`
cannot be reported through system 1, and `trip`/`thread` cannot be reported
through system 2.

---

## E. The complaint queue — **PARTIAL**

Two queues, one per table, with no shared view:

| Queue | Route | Reads |
|---|---|---|
| Reports | `admin.ts:1547` `GET /admin/reports` | `reports` |
| Moderation reports | `admin.ts:1475` `GET /admin/moderation/reports` | `moderation_reports` |

| Queue function | Status | Evidence |
|---|---|---|
| List + filter + paginate | **yes**, both | `admin.ts:1475`, `:1547` |
| Resolve | yes | `admin.ts:1578` |
| Dismiss | yes | `admin.ts:1615` |
| Hide content from the report | yes | `admin.ts:1663` |
| **Assign / triage to an admin** | **no** | `reports` has `reviewed_by`/`reviewed_at` only (`0063:95-96`) — set at resolution, not assignment. No `assigned_to` column. (`trust_reviews` *does* have `assigned_to` — the general queues do not.) |
| **Action linked back to the report** | **no** | see below |

### An action is not linked to the report that triggered it

`moderation_actions` has no report reference
(`src/migrations/0063_interaction_foundation.sql:138-145`):

```sql
CREATE TABLE IF NOT EXISTS moderation_actions (
  id             uuid ... PRIMARY KEY,
  target_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  action_type    text NOT NULL,
  reason         text,
  performed_by   uuid REFERENCES profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

Resolving a report writes an action, but only carries the target across
(`admin.ts:1598-1600`) — the report id is dropped. The two can only be
correlated by target + timestamp proximity. So "restrict **based on
complaints**" is not reconstructable after the fact: you can see that a user
was restricted, and separately that a report existed, but not that one caused
the other.

A `metadata jsonb` column was added to `moderation_actions`
(`0164_write_path_drift_columns_2.sql:34`) and is **not used by
`logModerationAction`** — a report id could be recorded there with no
migration.

### Suspected defect — resolving a non-user report

`logModerationAction`'s second parameter is written to
`target_user_id`, which is `REFERENCES profiles(id)`:

```ts
// src/routes/admin.ts:1598-1600
const targetId: string = (reportRow as any).target_id as string;
const auditR = await logModerationAction(sc, targetId, adminUserId, parsed.data.action, …);
```

For a report with `target_type` of `post`, `place`, `trip`, `event`, `message`
or `thread` — all valid values (`reports.ts:29`) — `target_id` is **not a
profile id**. The insert should violate the foreign key, `auditR.ok` is false,
and the endpoint returns 500 `Audit write failed` *before* the report is
resolved. On this reading, **only user/profile reports can be resolved**.

> **Not verified against a live database.** No migration alters that FK
> (`0164` only adds `metadata`), so it should still be enforced. It cannot be
> reproduced in the test suite because the tests use hand-written fake clients
> that do not enforce foreign keys, and no test covers resolving a non-user
> report. Confirming this needs one query against production. It is listed as
> a gap below on the assumption it is real, but it is an inference from schema
> plus code, not an observation.

---

## F. Audit trail — **PARTIAL**

| Question | Answer | Evidence |
|---|---|---|
| Who did it | **yes** — `performed_by` | `0063:143` |
| When | **yes** — `created_at` | `0063:144` |
| Against whom | **yes** — `target_user_id` | `0063:140` |
| Against **what** (the content item) | **no** — only the user | see below |
| Why | partial — `reason text`, nullable, free text | `0063:142` |
| Reversible | **no** — by compensating action only | see below |

Audit writes are **fail-closed** on the destructive paths, which is the right
design and is done consistently: `admin.ts:1417`, `:1449`, `:1288`, `:1316`,
`:1396`, `:1782` all abort the action if the audit insert fails.

Two real limits:

- **The audit records a user, never a content item.** Removing one specific
  photo writes `action_type: "content_removed"` against the *user*
  (`admin.ts:1416`). Two avatar removals a month apart are indistinguishable in
  the log, and there is no record of *which* object was deleted — so a wrongful
  removal cannot be identified, let alone restored.
- **Nothing is reversible.** There is no `reversed_at` / `reversed_by` /
  `undo_of` column. `restore` (`admin.ts:1306`) writes a *new* row with
  `action_type: "account_restored"`. That is an acceptable append-only model,
  but it means reversal is a convention rather than a property: nothing links
  the restore to the ban it undid, and content deletes cannot be reversed at
  all because the storage object is gone and its path was never recorded.

`warn` (`admin.ts:1212`) inserts into `moderation_actions` directly rather than
through `logModerationAction`, so it is the one action not fail-closed.

---

## G. Client surfaces — **PARTIAL**

**36 admin screens exist** — it is not API-only. Admin screens are gated by
`useRequireAdmin()` (`travel-buddy-standalone/src/hooks/useRequireAdmin.ts:14`),
which redirects non-admins home.

What exists: `app/admin/` — content-reports, featured, feature-flags,
gaming-flags, geocode-cache, hashtags, media, place-images, place-mismatch-reports,
portava-posts (×3), schema-drift, stamps (×6), trust-detail, trust-reviews,
trust-settings, visuals. Plus `app/(rent-a-buddy)/admin/` — 9 more.

What is missing is precisely the surface this requirement is about:

| Capability | API | UI |
|---|---|---|
| Media moderation queue + moderate | yes | **yes** — `app/admin/media/index.tsx` |
| Report queue (`reports`) | yes | **read-only** — `app/admin/content-reports.tsx` calls only `fetchAdminReports` (`src/services/reportsAdmin.ts:46` — the file's only exported function; its other two exports are the result types) |
| Report queue (`moderation_reports`) | yes | **none** — no client reference to `admin/moderation/reports` |
| Resolve / dismiss a report | yes (`admin.ts:1578`, `:1615`) | **none** |
| Warn / restrict / suspend / ban / restore | yes (9 routes) | **none** — no client call to `/admin/users/*` |
| Delete avatar / cover | yes | **none** |
| Execute a deletion request | yes | **none** — no client reference to `deletion-requests` |

So an admin can *look* at the report queue in the app but cannot act on it, and
the entire user-restriction API — the "restrict based on complaints" half of
the requirement — has **no UI at all**. It is reachable only by hand-crafted
HTTP request.

*(`src/services/rentABuddyAdmin.ts:310` calls `/api/rent-a-buddy/admin/users/:id/risk-status`
— a separate buddy-risk namespace, not core user moderation.)*

---

## Guard cross-reference (specifically requested)

Against the sweep's **24 converted / 6 held back** split:

| Moderation surface | Guard | Sweep status |
|---|---|---|
| `admin.ts` — all user moderation, both report queues, deletion execute | shared `requireAdmin(req,res,{withDisplayName:true})` | converted `dd2368883` |
| `adminMedia.ts` | shared `requireAdmin` | converted `5b2a346fc` |
| `adminPlaceMismatch.ts` | shared | converted `5b2a346fc` |
| `adminPlaceImages.ts` | shared, `withDisplayName` | converted `dd2368883` |
| `appeals.ts`, `trust-admin.ts` | shared | converted `0f33ad144` |
| `hiddenGems.ts` admin routes | shared `isAdmin` predicate | converted `d74e730a1` |
| `rentABuddySpec.ts` — buddy disputes, no-shows | local `requireAdminCtx` | **held back (6)** |
| `rentABuddyMarketplace.ts`, `circle.ts`, `placesCanonical.ts`, `compassGraph.ts`, `rentABuddyRollout.ts` | local | **held back (6)** |

So every *core* moderation endpoint is on the shared guard. But the sweep's
accounting misses two categories, both found here:

### 1. A 31st local guard the duplication check cannot see

`adminVisuals.ts:34` declares:

```ts
async function requireVisualAdmin(req: any, res: any) { … }
```

It is a full admin guard — selects `role, display_name, username, handle`,
sends the same 403, then adds a feature-flag gate. `checkAdminGuard.ts` matches
`/function\s+(requireAdmin\w*)\s*\(/`, and `requireVisualAdmin` does not start
with `requireAdmin`, so **the check has never seen it**. Verified by running
that regex against the file: no match.

This means the "30 local guards" baseline in
`docs/security/admin-guard-consolidation.md` — which was produced by the same
name-based detection — was itself an undercount.

> **CORRECTED 2026-08-09 — the true figure is 33, not 31.**
> `checkAdminGuard.ts` now detects guards by **shape** (a function whose body
> both reads `profiles.role` and compares it to a literal role), not by name
> prefix. Re-run against the pre-sweep tree it reports **33**:
>
> | Guard | Count | Visible to the old name check? |
> |---|---|---|
> | `requireAdmin` | 24 | yes |
> | `requireAdminGuard` | 4 | yes |
> | `requireAdminForStamps` | 1 | yes |
> | `requireAdminCtx` | 1 | yes |
> | `requireVisualAdmin` (adminVisuals.ts) | 1 | **no** |
> | `checkRentBuddyAccess` (rentABuddyRollout.ts) | 1 | **no** |
> | `canEditEntity` (visuals.ts) | 1 | **no** |
>
> The first four sum to exactly 30 — the original audit's figure — confirming
> it counted the whole name-matching population and nothing else. Three role
> gates were structurally invisible to it. This document's own "31" was also
> wrong: it caught `requireVisualAdmin` by hand and assumed that was the only
> one.
>
> Current state: **24 converted / 9 outstanding** (33 − 24). The check reports
> those 9 and exits 1.
>
> Two of the three newly-visible gates are not route guards in the
> `requireAdmin` sense — `canEditEntity` is an admin-bypass predicate inside an
> ownership check, `checkRentBuddyAccess` returns an `AccessDecision` — but both
> are role gates reading the same self-writable `profiles.role` column, so they
> belong in the population being tracked.
>
> One false positive was found and eliminated while building this: brace
> balancing that ignored comments ran off the end of `compass.ts`, producing a
> 106,910-character "function body" that matched both patterns from unrelated
> code. The scanner now skips comments and returns nothing rather than a
> runaway slice when it desynchronises — a false positive teaches people to
> ignore the check, which is worse than a miss.

### 2. Inline admin gates, invisible by design

30 inline `role === 'admin'` comparisons exist in `src/routes/`. Most sit
inside the known local guards, but these are gates written directly in a
handler or helper, belonging to no guard at all:

| Location | What it gates |
|---|---|
| `postcards.ts:766` | **`DELETE /postcards/:id/media/:mediaId` — the only true media delete in the codebase, storage included** |
| `compassOutcomes.ts:78` | `GET /compass/value-delivered` |
| `rentABuddySpec.ts:779` … `:1970` (18 sites) | per-route re-checks *in addition to* `requireAdminCtx` |
| `compass.ts:3417`, `stamps.ts:805`, `reviews.ts:666`, `visuals.ts:61` | assorted |

`checkAdminGuard.ts` documents that it deliberately does not detect these
("Inline role comparisons that are not a declared guard function"). That is a
defensible scope decision, but it means the most destructive media operation in
the tree is gated by a check no tooling watches.

---

## Gap table — ordered by user-visible impact

| # | Gap | Impact | Estimate |
|---|---|---|---|
| 1 | No admin UI for warn/restrict/suspend/ban/restore, or for resolving reports. The API exists; nothing can reach it. | **Highest.** Moderation is currently not performable by a moderator — only by someone issuing raw HTTP. The requirement is effectively unmet in practice however complete the backend is. | **3–5 d** — one user-moderation screen + wire resolve/dismiss into the existing `content-reports.tsx`. No backend work. |
| 2 | **CONFIRMED, NOT YET FIXED.** Resolving a non-user report 500s on the audit FK (§E). Constraint verified live. | **Latent, not active** — every moderation table is empty, so it has never fired. Breaks on the first non-user complaint ever filed. | **0.5 d** — write content-target ids to `metadata`, keep `target_user_id` for the owning user. Confirmation done. |
| 3 | ~~No admin delete for post media~~ **FIXED** — `action:"delete"` on `/admin/media/:id/moderate` removes object + thumbnail + row. **Highlights still have no admin delete.** | **Reduced.** Post media now deletable; highlights remain. | **1 d remaining** — extend the same pattern to highlights. |
| 4 | Actions are not linked to the report that triggered them. | **High for accountability.** "Restrict based on complaints" cannot be evidenced or reviewed after the fact. | **1 d** — record `report_id` in the existing unused `metadata jsonb`; no migration. |
| 5 | Audit records a user, never the content item; no reversal linkage. | **Medium-high.** A wrongful removal cannot be identified or undone. | **1–2 d** — add target-entity fields via `metadata`, plus `undo_of`. |
| 6 | Two report tables, two queues, disjoint entity vocabularies. | **Medium.** Complaints are split; an admin working one queue silently never sees the other. | **3–5 d** — unify into one queue view, or one intake with a discriminator. Data migration if merged. |
| 7 | Admin cannot delete a profile without a user-initiated request; cascade misses highlights, memories, bookings, trips, events. | **Medium.** Ban is the practical ceiling; content survives deletion when it does run. | **2–3 d** — admin-initiated path + extend the cascade, one decision per entity. |
| 8 | ~~Storage deletes are silent best-effort~~ **FIXED** in all three paths — avatar/cover delete, the new media delete, and `cleanupOldMedia` (the actual orphan producer; the admin path had never run). **20 existing profile-media orphans still need a sweep**, not yet performed. | **Reduced to cleanup.** | **0.5–1 d** — reconciliation over profile-media. Do NOT extend it to post-media on the current numbers; see the census. |
| 9 | No assignment/triage on either queue. | **Low-medium.** Fine for one moderator; collides with two. | **1–2 d** — `assigned_to` + filter, mirroring `trust_reviews`. |
| 10 | `requireVisualAdmin` invisible to `checkAdminGuard`; inline gates unwatched. | **Low today, structural.** The most destructive media delete is gated by an unwatched check. | **0.5 d** — widen the regex beyond `requireAdmin\w*`; fold `adminVisuals` into the outstanding set. |
| 11 | **114 seeded `post_media` rows render as broken images**, 14 of them on a real active user's public profile. All have deterministic v5 post ids and objects that never existed (perfect correlation, zero exceptions) — nothing was lost and nothing is recoverable. | **Live user-facing** for that one account. `processing_status` says `ready`; only `check:media-objects` surfaces it. | **0.5 d** — delete the seeded rows and their seeded posts. NOT a restore; the diagnosis step is done. |

**Roughly 15–25 days** for the original ten; gap 11 is new and small but should be triaged first because it is the only one a user can see today. Gaps 1 and 2 together (~5 days) convert the
existing backend from unusable to usable, and are worth far more than their
share of the estimate.

---

## Storage orphan census — 2026-08-09

Counted, not swept. Nothing has been deleted.

### profile-media — 20 orphans, and the cause was not the admin path

| | |
|---|---|
| Objects in bucket | 25 |
| Unreferenced by any `avatar_url` / `cover_photo_url` | **20** (14 `avatars/`, 6 `covers/`) |
| Distinct users owning objects | 6 |

**None of these came from the admin delete path.** `moderation_actions` has 0
rows, so no admin has ever removed an avatar or cover — that endpoint has never
run in production. Gap 8's original framing ("every pre-fix delete stranded its
object") was true in principle and empty in practice.

The distribution names the real source: one user holds 11 objects, another 5,
another 3, and three hold 2. Those are **superseded uploads**. Each avatar
change should have removed its predecessor via `cleanupOldMedia`
(`routes/profile.ts`), which carried the identical marker-slice bug — and which
runs on every profile media change, where the admin path runs never.

> **FIXED 2026-08-09.** `cleanupOldMedia` now resolves through
> `lib/storagePath.ts`. "Fail loud" is adapted to its context: it runs in
> `setImmediate` after the response, so there is no request to fail and no
> column left to protect — instead an object that cannot be accounted for is
> logged with its path rather than dropped. Five tests added, and the suite was
> registered (it was one of the 88 that never ran, so the tests would have been
> invisible otherwise).

The 20 existing orphans still need a sweep. Sweeping before this fix would have
cleaned a set that immediately regrew.

### post-media — 33 unreferenced objects, LOW CONFIDENCE

| | |
|---|---|
| Objects in bucket | 35 |
| Not referenced by any `post_media.storage_path` | **33** |
| `post_media` rows | 116 |
| …whose `storage_path` has no matching object | **114** |

**Treat the 33 as unreliable, and do not sweep on it.** The inconsistency runs
in *both* directions at once: only 2 objects are referenced by a row, and only
2 rows point at an object that exists. A delete bug produces orphans in one
direction — objects outliving their rows. It does not simultaneously produce
114 rows referencing objects that were never there.

That signature points at seeding or a bucket wipe, not at a code defect, and it
means the 33 is measuring the same broken correspondence from the other side
rather than an independent finding. The new `adminMedia` delete cannot be the
cause either: `moderation_actions` is empty, so it has never run.

### The 114 dangling rows are ALL seed content — corrected 2026-08-09

> **CORRECTION.** An earlier version of this section called these "14 broken
> media items belonging to one real user" and treated it as content that user
> had lost. That was wrong in a way that changes the remedy, so the original
> analysis is kept below and corrected here.
>
> The discriminator is the **post id's UUID version**, and it correlates
> perfectly with object existence — zero exceptions across all 116 rows:
>
> | post_id UUID version | storage object | rows |
> |---|---|---|
> | **v4** (random — a genuine user upload) | **exists** | 2 |
> | **v5** (deterministic — generated by a seeding script) | **missing** | 114 |
>
> Every genuinely user-created post has its object. Every row missing an object
> belongs to a deterministically-generated post. **No user has lost anything.**
> The objects were never uploaded, which is also why they are not recoverable —
> confirmed by searching every bucket for the path and for the bare filename.
>
> What remains true: 14 of those seeded rows are attached to a **real, active
> account** (UUIDv4 user, `@gmail.com`, last sign-in 2026-08-07) whose own two
> uploads are intact. So that person's public profile does render 14 broken
> images — but the fix is removing seed pollution from a live account, not
> restoring lost media. Those are different actions with different risk, which
> is why the distinction mattered enough to correct.
>
> **Not acted on.** Deleting or hiding rows on a real account's public profile
> is a data decision about someone's visible content, and the remedy changed
> once the cause did. Recommended: remove the seeded rows (and their seeded
> posts) from that account. Flagged, not executed.

### Original analysis (superseded by the correction above)

Checked as instructed, because "data hygiene" and "users are looking at broken
images" are different problems.

| Owner cohort | Rows | Signals |
|---|---|---|
| Seed accounts | 100 | 20 users · UUID**v5** ids (deterministic, i.e. generated) · `@example.com` · **`last_sign_in_at` is null — never signed in** · created in batches on 2026-07-17 / 07-27 |
| **One real user** | **14** | UUID**v4** · `@gmail.com` · account created 2026-06-28 · **last signed in 2026-08-07** · has a genuine Supabase-hosted avatar |

**All 114 sit on posts that are `published` and `public`, with `public_url`
populated and `processing_status = 'ready'`.** So the client renders them and
gets a broken image; nothing in the data marks them as unavailable.

For the real user this is a **live user-facing bug, not a hygiene note**: 14
broken images and 1 broken video across 14 published public posts, on an
account that was active two days before this audit.

Scope and likely cause: their 14 broken items were all created on **2026-07-17**
— a single day — while their other 2 media items (2026-07-17 and 2026-08-07)
are intact. Both intact and broken rows use the same 3-segment path shape, so
this is not a path-format mismatch; the objects are simply absent. A bulk loss
around 2026-07-17 fits the evidence better than a per-upload failure, and the
2026-08-07 object proves the upload pipeline works now.

> **Not established:** what removed those objects. The date correlates with the
> seed-account creation batch, which suggests a bucket wipe after seeding, but
> that is a hypothesis and storage access logs were not consulted. Worth
> settling before anyone concludes the pipeline is healthy.

**Recommended order:** tell that user's 14 posts apart from the seed rows before
any sweep — a sweep keyed on "unreferenced object" would not touch them (their
problem is the opposite: rows without objects), but a cleanup keyed on
"dangling row" would silently delete a real person's posts.

---

## Reconciliation — `check:media-objects`

`processing_status` records what the pipeline believed, never what is in the
bucket. All 116 `post_media` rows read `'ready'` while 114 pointed at objects
that did not exist, every one on a published public post with `public_url`
set. The column was not lying about its own step; it simply cannot see
Storage, and that blindness is what hid this for three weeks.

`src/scripts/checkMediaObjects.ts` (`pnpm run check:media-objects`) compares
the two directly and reports both directions:

- **dangling rows** — a row whose object is absent → users see a broken image.
  These fail the check.
- **orphan objects** — an object no row references → wasted storage, and
  content believed deleted that is still fetchable. Reported as a count only,
  so a sweep is scheduled deliberately rather than forced by a red build.

Current output: **0 dangling, 33 orphans.** (Was 114 dangling as of 2026-08-09;
`0206` removed the 14 polluted `post_media` rows and `0207` removed the 21 seed
posts.)

Since `0208` it reconciles **both** stored objects per row — the original
(`storage_path`) and the feed variant (`feed_storage_path`). A row advertising a
variant whose object is missing is DANGLING for the same reason a missing
original is: the client is told it exists and renders a broken image. A NULL
`feed_storage_path` is not a fault — it is the documented "no variant, serve the
original" case. Variant objects are excluded from the orphan count, or the
feature working would manufacture orphans in proportion to its own success.
Column presence is probed via `information_schema`, so the script still runs
against a project without 0208.

Exits 2 when live credentials are absent, deliberately: a check that could not
run must not read as one that passed.

> **Wired into `run-all-checks.sh` on 2026-08-10** (`run_check`, nothing
> suppressed). It was held back while it failed *by design* — the seeded rows
> were real, so wiring it then would have meant a permanently-red check, and a
> permanently-red check is one `|| true` away from being no check at all. It has
> passed since 0207, so the 114-dangling state can no longer return silently.
> Note this makes `check:all` require live credentials: exit 2 (no credentials)
> is a FAIL, not a skip.

---

## Seed-post deletion and the 7 real-user rows — 2026-08-09

### What was deleted

A prior session deleted 100 seeded posts and accepted the FK cascade. **The
owner has since confirmed the seed-post deletion was authorised**, so the posts
themselves need no recovery and are not an open item.

The cascade also removed 7 rows owned by a **real signed-in user**
(`highrollsmoke@gmail.com`, `user_id 5f123260-976f-49f3-a102-52346b4fc0af`),
which were outside the intended scope:

| Table            | Rows | FK to `posts`      |
| ---------------- | ---- | ------------------ |
| `posts_comments` | 3    | `ON DELETE CASCADE` |
| `post_reactions` | 2    | `ON DELETE CASCADE` |
| `post_saves`     | 2    | `ON DELETE CASCADE` |
| **Total**        | **7** |                   |

A further **4 `content_stamps`** rows for the same user were also captured in
the backup. `content_stamps` has **no FK** to `posts` (it uses a polymorphic
`entity_type`/`entity_id` pair), so those 4 rows did **not** cascade and are
presumed still live — but they now point at `entity_id`s that no longer exist,
making them dangling rather than deleted.

### Backups — located and preserved

The prior session's backups **do still exist**. They were written to its
scratchpad under `/tmp/claude-1000/`, which survived the workspace reload.
Because `/tmp` is ephemeral, they have been copied to a durable location in the
working tree and verified by `sha256sum` against the originals:

```
recovery-backups/2026-08-09-seed-post-cascade/
  backup_engagement.json    e51e232e…  the 7 rows + 4 content_stamps
  backup_posts.json         e4c386ab…  100 rows
  backup_post_media.json    713ba3b4…  100 rows
  baseline.sql              the prior session's pre-delete count query
```

`recovery-backups/` is **gitignored** (`.gitignore:69`) — these files contain
real user content (comment bodies, user ids) and must not be committed.

> **Do not stage these under a dot-directory.** The first copy was written to
> `.recovery/` and had vanished from the working tree within ~20 minutes, while
> the `/tmp` originals survived — something in this workspace's sync/cleanup
> path prunes dot-directories. The visible `recovery-backups/` path was used
> instead. If these files are ever re-staged, avoid a leading dot and re-verify
> the copy still exists some minutes later.

The `/tmp` originals are still present as a second copy, but `/tmp` is
ephemeral and must not be treated as the surviving one.

### Are the 7 rows complete, or just ids?

**Complete rows, not ids.** Every one of the 7 carries a full column set, and
every column each table's migration declares `NOT NULL` is present and
populated. Checked against:

- `posts_comments` — `0024_post_engagement.sql:24`
- `post_reactions` — `0066_post_interaction_layer.sql:6`
- `post_saves` — `0097_post_saves.sql:12`

`post_reactions` matches its migration exactly (5 columns). The other two carry
**more** columns than the migration files define:

| Backup column                 | Provenance                                    |
| ----------------------------- | --------------------------------------------- |
| `posts_comments.parent_comment_id` | `0066_post_interaction_layer.sql:53` — accounted for |
| `posts_comments.original_language` | `20260810_content_translations.sql:39` — accounted for |
| `posts_comments.updated_at`   | **no migration defines it**                    |
| `post_saves.id`               | **no migration defines it** — `0097` gives `post_saves` a composite PK `(user_id, post_id)` and no `id` column at all |

So the backup is a superset of the migration-defined schema, consistent with it
having been captured as `select *` against live. That is a **second instance of
the pattern already recorded in finding 16**: live schema has drifted from the
migration files. It does not threaten the data — nothing is missing — but it
means a restore must be written against the *live* column set, not against these
migration files, or it will fail on columns that do not exist.

### Restore — PENDING A DECISION, NOT DONE

**Nothing has been restored and nothing has been deleted.** The owner is
deciding. This section records the state only.

The decision is not a simple "put them back", for one reason:

> **All 7 rows reference posts that no longer exist.** Their parent `post_id`s
> resolve to 5 distinct posts, and all 5 are inside `backup_posts.json` — i.e.
> all 5 were seed posts, whose deletion was authorised.

Consequently:

- Restoring the 7 rows **as-is is not possible** while the parents are gone. All
  three tables declare `post_id … REFERENCES posts(id)`, so the inserts would be
  rejected by the FK constraint.
- Restoring them **would require first re-creating 5 of the 100 seed posts** —
  re-introducing the seeded data the owner just authorised removing.
- The rows' standalone value is low: they are a comment `"hola"`, two QA-test
  comments (`"QA test - Watch feed comment"`, `"QA test reply comment"`), two
  emoji reactions, and two saves — **all of them interactions with seed content,
  and two of the three comments are self-described QA tests.**

The honest read is that these 7 are **legitimately orphaned, not lost value**.
They were a real user's interactions, but exclusively with fixture posts that no
longer exist; restoring them recreates dangling references to deleted content,
or forces partial un-deletion of the seed set. The same argument applies to the
4 surviving `content_stamps`, which are already dangling and may warrant
cleanup rather than preservation.

That said — the rows are a real user's data, they are safely preserved, and the
call is the owner's. The backup makes either choice reversible.

---

## Verification note

- Every file:line was opened and read; nothing is inferred from a grep hit alone.
- The storage question was traced to the `sc.storage.from(...).remove(...)` call
  in each path, and the *absence* of any such call in `adminMedia.ts` was
  confirmed by listing every storage reference in that file: the only one is
  `storage_path, storage_bucket` inside a `.select()` column list
  (`adminMedia.ts:53`), never a `.storage` call.
- The `requireVisualAdmin` blind spot was confirmed by executing
  `checkAdminGuard.ts`'s own regex against `adminVisuals.ts` — no match.
- **Not verified:** the §E foreign-key defect. It requires a live database; the
  test suite's fake clients do not enforce FKs and no test covers the path.
  It is stated as a suspected defect, not a confirmed one.
- **Not verified:** whether the live `moderation_actions` FK matches the
  migration. No migration alters it, but per this repo's own history
  (finding 16), live constraints have differed from migration files before.
- Estimates are build-only: no design, review, or QA time included.
- **Not verified against live:** the seed-post deletion accounting above was
  reconstructed from the prior session's backup files and the migration
  definitions — **no query was run against the live database** in the session
  that wrote it. The per-table counts (3 comments / 2 reactions / 2 saves, 100
  posts, 100 post_media) are what the backups *contain*, which is strong
  evidence of what was deleted but is not the same as confirming what is
  presently absent from live. The claim that the 4 `content_stamps` rows
  survived is an inference from `content_stamps` having no FK to `posts`, not an
  observation. Confirming both needs a read-only live count.
- The `post_saves.id` and `posts_comments.updated_at` drift was established by
  searching every `.sql` tree in the repo (`migrations/`,
  `artifacts/api-server/src/migrations/`, `artifacts/api-server/supabase/`)
  for `CREATE TABLE` and `ADD COLUMN` on those tables; absence of a defining
  migration is a repo-wide search result, not a spot check.
