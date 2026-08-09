# Admin moderation — coverage audit

**Date:** 2026-08-09 · **Trees:** `artifacts/api-server`, `travel-buddy-standalone` ·
**Status:** audit only, nothing built.

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

Three qualifications, all of which make this PARTIAL rather than EXISTS:

1. **The storage delete is best-effort and silent.** It is wrapped in
   `try { … } catch { /* storage delete is best-effort */ }`
   (`admin.ts:1419`, `:1450`). The DB row is nulled regardless. A storage
   failure orphans the object with no error, no retry, and no log.
2. **The path is recovered by string-slicing the public URL.** If
   `avatar_url` is not a `/object/public/<bucket>/` URL — a signed URL, a CDN
   rewrite, an external host — `idx === -1` and the storage delete is skipped
   entirely while the DB update still succeeds. Silent orphan.
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
name-based detection — was itself an undercount. **The true figure was 31**, and
the correct split today is **24 converted / 7 outstanding**, not 24/6.

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
| 2 | Resolving a non-user report appears to 500 on the audit FK (§E). | **High** if real: the report queue cannot be cleared for post/place/trip/event/message/thread reports — the majority of complaints. | **0.5 d to confirm** (one query), **0.5 d to fix** (write content-target ids to `metadata`, keep `target_user_id` for the owning user). |
| 3 | No admin delete for post media or highlights; admin "reject" leaves bytes in the bucket forever, despite `adminMedia.ts` already selecting `storage_path`. | **High.** "Delete any media" is not met for the two most-reported types. Illegal or abusive content stays retrievable by URL. | **2–3 d** — admin delete endpoint reusing the postcards delete path, extended to highlights, with storage removal. The path is already selected, so the media half is closer to 1 d. |
| 4 | Actions are not linked to the report that triggered them. | **High for accountability.** "Restrict based on complaints" cannot be evidenced or reviewed after the fact. | **1 d** — record `report_id` in the existing unused `metadata jsonb`; no migration. |
| 5 | Audit records a user, never the content item; no reversal linkage. | **Medium-high.** A wrongful removal cannot be identified or undone. | **1–2 d** — add target-entity fields via `metadata`, plus `undo_of`. |
| 6 | Two report tables, two queues, disjoint entity vocabularies. | **Medium.** Complaints are split; an admin working one queue silently never sees the other. | **3–5 d** — unify into one queue view, or one intake with a discriminator. Data migration if merged. |
| 7 | Admin cannot delete a profile without a user-initiated request; cascade misses highlights, memories, bookings, trips, events. | **Medium.** Ban is the practical ceiling; content survives deletion when it does run. | **2–3 d** — admin-initiated path + extend the cascade, one decision per entity. |
| 8 | Storage deletes are silent best-effort with URL-derived paths. | **Medium.** Orphaned objects accumulate invisibly; content believed deleted stays fetchable. | **1–2 d** — use stored `storage_path`, log failures, add a reconciliation job. |
| 9 | No assignment/triage on either queue. | **Low-medium.** Fine for one moderator; collides with two. | **1–2 d** — `assigned_to` + filter, mirroring `trust_reviews`. |
| 10 | `requireVisualAdmin` invisible to `checkAdminGuard`; inline gates unwatched. | **Low today, structural.** The most destructive media delete is gated by an unwatched check. | **0.5 d** — widen the regex beyond `requireAdmin\w*`; fold `adminVisuals` into the outstanding set. |

**Roughly 15–25 days** for all ten. Gaps 1 and 2 together (~5 days) convert the
existing backend from unusable to usable, and are worth far more than their
share of the estimate.

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
