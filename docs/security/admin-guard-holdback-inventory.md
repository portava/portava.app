# Held-back admin guards — tracked inventory

**Status: 9 guards deliberately diverged from the canonical `requireAdmin`. No migrations. Not a backlog.**

Of 33 admin guards in this repo, 24 were consolidated onto the canonical
`lib/requireAdmin.ts`. These 9 were not. This document is the tracked record of
that decision so the divergence is auditable rather than looking like unfinished
work — someone reading `checkAdminGuard.ts` output should be able to find out in
one hop *why* each of these is still standing.

**They stay diverged deliberately. Revisit only when (a) the owning feature
changes, or (b) a review shows the divergence weakens authorization.** Neither
trigger has fired. Converting one is a decision, not a mechanical edit.

Companion document: [`admin-guard-consolidation.md`](./admin-guard-consolidation.md)
holds the full pre-consolidation audit, the per-guard evidence, and the
conversion traps. This file is the standing inventory; that one is the analysis.

---

## Security posture — the part that matters

**All 9 fail closed.** Verified by reading each guard, not by pattern-matching:
every one denies on query error, on missing row, and on unmatched role. The
divergences are in *client source, error envelope, returned identity, and
config-failure behaviour* — not in who is admitted.

One guard (`requireVisualAdmin`) is **stricter** than canonical. None is looser
except `rentABuddyRollout.requireAdmin`, whose extra `owner` acceptance is
**unreachable** — see the `owner` note below.

Live verification (2026-08-10):

| Check | Result |
|---|---|
| `profiles.role` distribution | 55 `user`, 1 `admin`, **0 `owner`** |
| `profiles_role_check` | `CHECK (role = ANY (ARRAY['user','admin']))` |

So `owner` is not merely absent from the data — it is **unrepresentable**. The
column CHECK rejects it, and since migration 2078 `admin_set_profile_role`
accepts only `('user','admin')`. Every `owner` branch below is formally dead
code, not a latent privilege path.

---

## The inventory

Dimensions that block a mechanical conversion are named per row. "Live
behaviour" is what production does today; "repo behaviour" is what the canonical
guard would do instead.

### 1. `requireAdmin` — `routes/circle.ts`

| | |
|---|---|
| **Live behaviour** | Requires a **service client**; returns **503** when config is missing; error via `sendError` with message `"Admin access required"`; returns `{ user }` |
| **Repo (canonical)** | Caller client; **proceeds** on config failure; canonical 403 envelope; returns `{ userId, client, sc }` |
| **Why diverged** | 4 independent dimensions: client source, config-failure, error envelope, returned identity. Call sites destructure `user`, so conversion is a call-site rewrite, not a swap |
| **Disposition** | **HOLD.** Largest gap of the nine. Convert only alongside the circle routes' own refactor |

### 2. `requireAdmin` — `routes/placesCanonical.ts`

| | |
|---|---|
| **Live behaviour** | Requires a service client; returns **503** on missing config |
| **Repo (canonical)** | Caller client; proceeds on config failure |
| **Why diverged** | 2 dimensions. The 503 is arguably *better* than canonical here — it distinguishes "misconfigured" from "forbidden" |
| **Disposition** | **HOLD.** Converting would lose a real signal. Revisit only if the canonical guard gains config-failure handling |

### 3. `requireAdminCtx` — `routes/rentABuddySpec.ts`

| | |
|---|---|
| **Live behaviour** | Error envelope has **no `message` field at all**; returns `{ auth, serviceClient }`; reads role through a service-preferred client |
| **Repo (canonical)** | Envelope always carries `message`; returns `{ userId, client, sc }` |
| **Why diverged** | 3 dimensions. The missing `message` is a **client contract** — a consumer may branch on its absence |
| **Disposition** | **HOLD** until the Rent-a-Buddy spec client contract is revisited. Do not "fix" the envelope in isolation |

### 4. `requireAdmin` — `routes/rentABuddyMarketplace.ts`

| | |
|---|---|
| **Live behaviour** | Error message carries a **trailing period**; returns the client as `svc`, not `sc` |
| **Repo (canonical)** | No trailing period; field named `sc` |
| **Why diverged** | 2 dimensions, **both purely mechanical**. No semantic difference whatsoever |
| **Disposition** | **HOLD, but this is the cheapest conversion of the nine.** Blocked only on someone accepting the user-visible message-text change. Best first candidate if the queue reopens |

### 5. `requireAdmin` — `routes/compassGraph.ts`

| | |
|---|---|
| **Live behaviour** | Returns the raw `requireUser` result, so call sites use `auth.user.id` and `auth.client` |
| **Repo (canonical)** | Returns `{ userId, client, sc }` |
| **Why diverged** | 1 dimension — **the smallest gap of the nine**. Identity shape only |
| **Disposition** | **HOLD.** Mechanically trivial; touches every Compass-graph call site, so it rides along with the next Compass change |

### 6. `requireAdmin` — `routes/rentABuddyRollout.ts`

| | |
|---|---|
| **Live behaviour** | Accepts `admin` **or `owner`**; reads role through a service-preferred client; the returned role acts as a **second gate** downstream |
| **Repo (canonical)** | `admin` only; single gate |
| **Why diverged** | **Product decision, not cleanup.** The returned role feeds a further authorization branch, so converting changes two things at once |
| **Disposition** | **HOLD.** The `owner` acceptance is dead (unrepresentable — see above), so this is **not** a live privilege gap. Revisit if an `owner` role is ever reintroduced — at which point this becomes urgent, because the branch would wake up |

### 7. `requireVisualAdmin` — `routes/adminVisuals.ts`

| | |
|---|---|
| **Live behaviour** | Authorisation half is **byte-for-byte equivalent** to `requireAdmin(req, res, { withDisplayName: true })`, *plus* a feature-flag gate on `ai_visual_admin_review_enabled` returning 403 `feature_disabled` |
| **Repo (canonical)** | Authorisation only; no flag gate |
| **Why diverged** | It does a **second, non-authorisation thing**. Conversion means *extracting* the flag gate, not deleting it |
| **Disposition** | **HOLD.** ⚠️ **Ordering is the safety property.** The admin check must run **before** the flag check; checking the flag first — the tidier-looking arrangement — leaks whether an unreleased feature is enabled to any authenticated non-admin. See TRAP 1 in the companion doc before touching this |

### 8. `checkRentBuddyAccess` — `routes/rentABuddyRollout.ts`

| | |
|---|---|
| **Live behaviour** | **Not a guard.** Feature-access decision function returning `{ allowed, code, message, httpStatus }`; sends no response. Also called from `rentABuddy.ts`, so its contract is cross-file |
| **Repo (canonical)** | N/A — canonical guard owns a response; this owns none |
| **Why diverged** | Category mismatch. Only one *fragment* is admin logic (the admin-only-mode branch, `admin`\|`owner`), expressible as `isAdmin(sc, userId, ["admin","owner"])`. Nothing else here is |
| **Disposition** | **NOT CONVERTIBLE — fragment only.** Inherits the dead-`owner` note. Leave whole |

### 9. `canEditEntity` — `routes/visuals.ts`

| | |
|---|---|
| **Live behaviour** | **Not a guard.** Ownership predicate answering "may this user edit visuals for this entity?" — admin is the *first* of three accepted paths (admin, event host, trip owner); places are admin-only. Returns boolean, takes an injected client |
| **Repo (canonical)** | N/A — canonical guard is an HTTP gate, not a predicate |
| **Why diverged** | Category mismatch. Its first three lines are exactly `isAdmin(sc, userId)`; the rest is ownership logic that must stay |
| **Disposition** | **NOT CONVERTIBLE — fragment only.** Swapping the fragment for `isAdmin` is safe but cosmetic: it removes one hand-spelled `profiles` read and changes no behaviour |

---

## Summary

| Disposition | Count | Guards |
|---|---|---|
| **HOLD** — conversion is a decision | 7 | 1–7 |
| **NOT CONVERTIBLE** — fragment only | 2 | 8, 9 |

If the queue ever reopens, the order by ascending risk is **#4** (purely
mechanical) → **#5** (identity shape only) → **#9** (cosmetic fragment) → **#2**
→ the rest. **#7 is not a beginner's conversion** regardless of how small the
diff looks, because of the ordering trap.

## Why the count was 9 and not 6

`checkAdminGuard.ts` matched `requireAdmin\w*` and was **structurally blind** to
three guards that authorise on `profiles.role` under other names —
`requireVisualAdmin` (name doesn't match), `checkRentBuddyAccess` (not a guard
shape), `canEditEntity` (predicate with an admin branch). So the earlier
"detects exactly 30, matching the independent audit" was two instruments sharing
one blind spot, not corroboration. **33 total, 24 converted, 9 outstanding.**

That is the same failure family as the migration sweeps in this repo: *a
detector that cannot see a thing reports it as absent rather than unexamined.*
When re-running any inventory here, check what the detector is structurally
incapable of matching before trusting its count.
