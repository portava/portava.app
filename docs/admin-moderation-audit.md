# Admin moderation — what exists, what is missing

Investigation only, except for one verified bug fixed alongside (§6).
Date: 2026-08-08. Branch `bughunt-20260805`.

**Headline: far more exists than the brief assumed.** A permission model, a
reports queue, an appeals table, an account-state model, a moderation audit log
and 30 admin route files are all already built. The gaps are real but they are
*consistency and coverage* gaps, not greenfield.

---

## 1. Permission model — exists, consistent in effect, duplicated 30 times

Every admin endpoint gates on `profiles.role === 'admin'`. There is exactly one
role. No hierarchy, no scoping, no per-surface permissions.

`requireAdmin` (or `requireAdminGuard`) is defined **privately in 30 separate
route files**, in 20 textually distinct variants.

I checked whether the variants differ in security-relevant ways. **They do
not.** All 30 resolve the caller, read `profiles.role`, and deny unless it is
`'admin'`. The 20 variants are quote style, formatting, return shape
(`{userId, sc}` vs `{user, sc}` vs `boolean`), and whether the Supabase `error`
is checked explicitly before `!data` — which is a no-op for the deny path,
since an error yields no data and both branches deny.

So this is a maintainability problem, not a live vulnerability. Worth saying
precisely, because "20 different implementations of the admin check" sounds
like a hole and is not one.

**Missing:**
- No shared `requireAdmin` in `lib/`. A future change to admin semantics must
  be made in 30 places, and the 31st file will get it wrong.
- No role hierarchy. "Admin" is all-or-nothing: whoever can retune the ranking
  config can also ban users and delete media.
- No scoping (region, surface, seniority).

## 2. Reports queue — exists and is well shaped

`reports` table:

```
reporter_id, target_type, target_id, context_type, context_id,
reason_code, reason_detail, severity, status,
reviewed_by, reviewed_at, moderation_notes, created_at, updated_at
```

Consumed by `routes/reports.ts`, `routes/admin.ts`, `routes/adminMedia.ts`,
`routes/mediaFeed.ts`, `routes/reviews.ts`. Admin screens exist at
`app/admin/content-reports.tsx` and `app/admin/place-mismatch-reports.tsx`.
A separate `hashtag_reports` table exists for tag abuse.

`POST /admin/reports/:id/hide-content` resolves the report target, writes an
audit row **fail-closed** (aborts if the audit write fails), then hides the
content. That is the best-built moderation path in the codebase and is the
pattern the others should follow.

**Missing:** no SLA/ageing, no assignment or claim mechanism (two admins can
work the same report), no dedupe of many reports against one target, no
reporter-reputation weighting.

## 3. Appeals — table exists, largely unwired

`appeals` (migration `0070_appeals.sql`): `appellant_id`, `target_type` (11
enum values), `target_id`, `reason`, `evidence_url`, `state`
(`submitted|under_review|approved|denied`), `moderator_id`, `resolution_note`.

`routes/appeals.ts` exists but writes **no** audit rows (0 references to
`moderation_actions` or `logAdminAccess`). The migration header says
"NOT applied automatically — run in Supabase SQL Editor", so whether the table
exists in production is unverified from here.

## 4. Account states — TWO parallel models, and they disagree

This is the important one.

| Model | Written by | Read by |
|---|---|---|
| `profiles.account_status` (`active`/`suspended`/`banned`) | `POST /admin/users/:id/suspend`, `/ban`, `/reinstate` | **`lib/mediaEligibility.ts` — the feed gate** |
| `user_account_states` (`state`, `reason`, `expires_at`, `set_by`) | `/suspend`, `/ban`, **and** `PATCH /admin/users/:id/moderation-action` | `circleAccessGuard.ts`, `profileVisibility.ts` |

`POST /admin/users/:id/suspend` writes **both**. Correct.

`PATCH /admin/users/:id/moderation-action` with `temporary_suspension` or
`permanent_ban` writes **only `user_account_states`**.

`lib/mediaEligibility.ts` reads **only `profiles.account_status`** — zero
references to `user_account_states`.

**Consequence: a user banned through the moderation-action endpoint keeps
having their content served in the media feed.** Verified by reading both
write paths and the read path. See §6.

## 5. Content deletion — three signals, and no admin path to media

`posts` carries three independent "this is gone" signals:

- `deleted_at` (timestamptz)
- `status` (enum `post_status`) — user delete sets `'deleted'`
- `post_status` (enum `delayed_post_status`) — admin removal sets `'removed'`

To its credit `lib/mediaEligibility.ts` gates on **all** of `status`,
`post_status`, `moderation_status` and creator account status, so admin removal
does hide content from the media feed. The three-column design is confusing but
the feed path handles it.

Soft delete (`deleted_at`) exists on `posts`, `posts_comments`, `highlights`,
`messages`, `passport_postcards`. Not on `post_media`, which has only
`moderation_status`.

Two user-facing delete paths disagree:
- `DELETE /posts/:postId` sets `status='deleted'` **and** `deleted_at`.
- `DELETE /media/:id` sets `status='deleted'` only, **no `deleted_at`**.

**The brief's first requirement — "admins can delete any media from any
profile" — is NOT met.** `DELETE /media/:id` is strictly owner-scoped
("Only the owner can delete this post") with **no admin bypass**. What admins
can do today:
- `POST /admin/media/:id/moderate` — sets `post_status`/`moderation_status`
  (hide, not delete). **Writes no audit row.**
- `POST /admin/reports/:id/hide-content` — hides a post/trip/event, audited,
  but only reachable via a report, and `post_media` is not a target type.
- `DELETE /admin/users/:userId/avatar` and `/cover` — audited.

There is no admin path to remove a specific `post_media` row, and no path at
all to media that has not been reported.

## 6. Audit log — exists, and covers a minority of destructive actions

Two mechanisms:

- `moderation_actions` (append-only) via `logModerationAction()` — user-directed
  moderation. `PATCH /admin/users/:id/moderation-action` writes one for **every**
  action and **fails closed** if the write fails. Good design.
- `admin_access_log` via `lib/adminAudit.ts` — **reads only**
  (`view`/`expand`/`export` of profile/event/trip/gps_event/check_in). Used by
  4 of 30 admin route files.

Neither records *deletions* outside `admin.ts`. Coverage by file
(destructive endpoints vs audit writes):

| File | destructive | audit |
|---|---|---|
| `admin.ts` | 33 | 30 |
| `adminCompass.ts` | 9 | 2 |
| `adminStamps.ts` | 8 | 2 |
| `trust-admin.ts` | 7 | 4 |
| `adminVisuals.ts` | 7 | **0** |
| `adminFeatured.ts` | 7 | **0** |
| `adminPlaceImages.ts` | 5 | **0** |
| `adminGeocode.ts` | 3 | **0** |
| `adminPortavaPosts.ts` | 3 | **0** |
| `adminRankingConfig.ts` | 2 | **0** |
| `adminMedia.ts` | 1 | **0** |
| `adminPlaceMismatch.ts` | 1 | **0** |
| `appeals.ts` | 0 | **0** |

`DELETE` endpoints with no audit at all: `adminFeatured`, `adminGeocode`,
`adminPortavaPosts`, `adminVisuals`, `airport`, `entryRequirements`,
`tripBudgetIntel`.

So "who deleted what, when, why" is answerable for user-directed moderation in
`admin.ts` and essentially nowhere else. `reason` is captured where auditing
happens; there is no enforcement that it is non-empty.

---

## 7. Proposal

### 7a. Permission model

Keep the single `admin` role for now — introducing a hierarchy is a policy
decision (§8). The unambiguous change is to **extract one `requireAdmin` into
`lib/adminGuard.ts`** and have the 30 files import it. That is a pure
consolidation with no behaviour change, and it is the precondition for ever
adding scoping without missing a file.

Recommended eventual shape, for when policy is decided:

```
admin_roles(user_id, role, scope, granted_by, granted_at, expires_at)
  role:  moderator | senior_moderator | admin | superadmin
  scope: null (global) | region | surface
```

- `moderator` — act on reports, hide content, warn, temp-suspend
- `senior_moderator` — + permanent ban, delete media, resolve appeals
- `admin` — + config, feature flags, ranking
- `superadmin` — + grant/revoke admin

### 7b. Audit log

Extend the existing `moderation_actions` pattern rather than inventing one.
Every destructive admin endpoint should call `logModerationAction()`
**fail-closed**, as `/admin/reports/:id/hide-content` already does. Require a
non-empty `reason` on any action that removes or restricts.

For targets that are not users, `moderation_actions.target_user_id` is a FK to
`profiles` — `hide-content` already works around this by resolving the content
owner. Either keep that convention everywhere or add a nullable
`target_type`/`target_id` pair. **Schema change — needs approval.**

### 7c. Reports queue

Add claim/assignment (`assigned_to`, `assigned_at`), target-level dedupe, and
ageing. Claim/assignment needs columns — **schema change, needs approval**.
Dedupe and ageing can be done read-side today.

### 7d. Admin media deletion

Add `DELETE /admin/media/:id` and `DELETE /admin/posts/:postId`, admin-gated,
soft-delete semantics (`deleted_at` + `status`), fail-closed audit, mandatory
reason. No schema change required for posts. `post_media` has no `deleted_at`,
so admin removal there must either use `moderation_status='rejected'` (works
today, already respected by `mediaEligibility`) or gain a column — **the
column is a schema change; the `moderation_status` route is not.**

---

## 8. Decisions the owner must make

Written up rather than guessed.

1. **Hard vs soft delete.** Everything today is soft (`deleted_at`, status
   enums). Hard delete matters for legal takedown and CSAM. Recommend: soft by
   default, with a separate audited `purge` reserved to superadmin, and a
   retention window after which soft-deleted rows are hard-deleted by a job.
2. **Appeals.** Table exists, flow is unwired. Who reviews? Can the deciding
   moderator review their own action? Is there a time limit? Recommend a
   different moderator must resolve, enforced in code.
3. **Who gets admin.** Currently anyone with `profiles.role='admin'`, settable
   only by direct DB access. No grant/revoke endpoint, no audit of who was made
   admin. Recommend a superadmin-only grant/revoke with mandatory audit.
4. **Reason mandatory?** Recommend yes for anything that removes or restricts.
   Cheap, and it is the difference between an audit log and a list of
   timestamps.
5. **Ban semantics.** Does a ban hide *past* content, or only stop new content?
   Today it hides everything in the feed via the creator gate. Confirm intended.
6. **Whether `profiles.account_status` or `user_account_states` is canonical.**
   §6 fixes the immediate divergence; collapsing to one model is a bigger change
   and needs a decision.

---

## 9. Verification note

Every claim above was read out of the code, not inferred from names. Where I
could not verify something from the repo — in particular whether migrations
`0070_appeals.sql` and the `admin_access_log` migration have actually been
applied in production — it is marked unverified rather than assumed. That
distinction is the whole reason this workstream found thirteen assumed-done
items.
