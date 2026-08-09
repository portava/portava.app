# Admin guard consolidation — pre-consolidation audit

Audited at `ef9060e` on `bughunt-20260805`. **Read this before merging the
shared guard**, because the headline number is misleading in both directions.

## What was there

**30 local admin guards across 30 route files**, under four names:

| name | count |
|---|---|
| `requireAdmin` | 25 |
| `requireAdminGuard` | 3 — airport, appeals, reviews, trust-admin |
| `requireAdminCtx` | 1 — rentABuddySpec |
| `requireAdminForStamps` | 1 — passportStamps |

`lib/adminAudit.ts` already existed as a shared home, so the duplication was
not for want of somewhere to put it.

## Finding 1 — all 30 fail closed (the reassuring part)

Twelve variants do **not** destructure `error` from the profile lookup:

```
adminGeocode  adminStamps  appeals  hiddenGems  placesCanonical  rentABuddy
rentABuddyMarketplace  rentABuddyRollout  rentABuddySpec  reviews
stampCatalog  trust-admin
```

That looks like the exact failure shape as finding 16 (query errors, `error`
discarded, control silently no-ops). **It is not.** `supabase-js` returns
`data: null` on error, and every one of the twelve then guards on `!data` or
`?.role === 'admin'` / `?.role !== 'admin'`. An errored lookup therefore yields
`undefined === 'admin'` → false → 403.

Verified individually against all twelve, not inferred from the pattern.

So the missing `error` check is untidy, never exploitable. The shared guard
checks `error` explicitly anyway — not because the current behaviour is wrong,
but because relying on a client library's null-on-error contract in the one
place that gates admin access is a bet with no upside.

## Finding 2 — two genuine divergences (the part that matters)

These are why "just merge them" would have been wrong.

### 2a. `rentABuddyRollout.ts` accepts `owner` as well as `admin`

```ts
if (!data || (role !== "admin" && role !== "owner")) { … 403 }
```

Every other variant requires exactly `admin`. Consolidating naively would have
produced one of two silent failures:

- fold it onto the common guard → **`owner` loses access** to a working feature
- fold everything onto its guard → **`owner` gains admin rights across 29 other
  route groups**

Preserved as `requireAdmin(req, res, { roles: ["admin", "owner"] })`.

### 2b. `hiddenGems.ts` uses a different call shape

```ts
async function requireAdmin(sc, userId): Promise<boolean>
```

Predicate, not gate. It never sends 403 — its callers do. Mechanically
replacing it with the `(req, res)` form would write a 403 underneath a caller
that had already begun composing its own response.

Preserved as `isAdmin(sc, userId)`.

## Finding 3 — cosmetic differences, safe to normalise

> **CORRECTED 2026-08-09 during the sweep.** Two claims below were wrong. Both
> are struck through with the correction beneath. See §1e/§1f of
> `admin-authz-audit.md`.

- ~~**Fallback client**: 7 lack `getServiceClient() ?? client` (circle,
  compassGraph, hiddenGems, placesCanonical, rentABuddyMarketplace,
  rentABuddySpec — plus hiddenGems by shape). The fallback exists so routes stay
  testable without service credentials; adding it is strictly permissive of
  tests, not of callers.~~

  **Wrong, and wrong in the permissive direction.** `circle.ts` and
  `placesCanonical.ts` do not merely *lack* the fallback — they **require** the
  service client and return 503 `server_not_configured` when it is absent.
  Adding a fallback converts that refusal into "proceed using the caller's
  client", which is permissive of **callers**, not just of tests. Separately,
  `circle.ts`, `placesCanonical.ts` and `rentABuddySpec.ts` read `profiles`
  through the service client, **bypassing RLS**; the shared guard reads through
  the caller's client. Same query, different trust model.

  These five (the three above plus `rentABuddyMarketplace.ts` and
  `compassGraph.ts`) were **not converted**. Each needs its own reconciliation.
  None is a security finding — all still fail closed.

- ~~**Selected columns**: only `admin.ts` selects
  `role, display_name, username, handle`; the rest select `role`.~~

  **`adminPlaceImages.ts` selects the same four columns.** It is a two-file
  case, and `admin-authz-audit.md` §1d said so ("the superset shape already
  used by `admin.ts` and `adminPlaceImages.ts`") — this line contradicted it.
  Both now pass `{ withDisplayName: true }`; had either been converted without
  the flag, every audit-log label on that route would have silently become
  `null`.

- **Quote style / error message**: identical semantics, `"admin"` vs `'admin'`.
  Quote style yes — error **message** no. `rentABuddySpec.ts` sends a 403 with
  no `message` field at all, and `rentABuddyMarketplace.ts`'s differs by a
  trailing period. No test asserts on either, but a normalisation is still a
  response-body change and was not made blind.

## What ships

| file | purpose |
|---|---|
| `artifacts/api-server/src/lib/requireAdmin.ts` | the single guard — `requireAdmin()` gate + `isAdmin()` predicate |
| `artifacts/api-server/src/scripts/checkAdminGuard.ts` | fails CI if a route declares its own guard again |

`ALLOWED` in the check starts **empty** on purpose. The consolidation removes
every local guard, so any future entry is a deliberate, argued exception rather
than inherited debt.

## Migration order (do not reorder)

1. Land `lib/requireAdmin.ts`. Nothing imports it yet — zero behaviour change.
2. Convert route files in batches, **starting with the ~~25~~ 21 plain
   `requireAdmin` cases**, which are mechanical. *(Four of the presumed 25 were
   not plain — see the corrected Finding 3.)*
3. Convert the ~~two~~ **one** divergent one **individually and deliberately**:
   `hiddenGems.ts` with `isAdmin`. Do not batch. *(`rentABuddyRollout.ts` was
   listed here with `{ roles: ["admin","owner"] }`; it belongs at step 5 —
   the role set was never its only divergence.)*
4. ~~`admin.ts`~~ **`admin.ts` and `adminPlaceImages.ts`** with
   `{ withDisplayName: true }`.
5. Reconcile the ~~five~~ **six** semantics-sensitive routes individually
   (corrected Finding 3, plus `rentABuddyRollout.ts`). Each is a decision, not
   a conversion.
6. Land `checkAdminGuard.ts` and wire it into `run-all-checks.sh` **last** —
   it fails while any local guard remains, so it is the proof the sweep finished,
   not a step along the way.

**Status 2026-08-09 — 24 of 30 converted, 6 held back.** Steps 1, 2 and 4 are
done (batches `5b2a346fc`, `0f33ad144`, `dd2368883`). Of step 3's two
carve-outs, `hiddenGems.ts` is converted to the `isAdmin` predicate
(`d74e730a1`); `rentABuddyRollout.ts` is **not**.

`rentABuddyRollout.ts` was converted with `{ roles: ["admin","owner"] }` and
then **reverted** (`b42787bbc`). The `roles` option handles the role set
correctly, but this plan's step 3 framed the route as a role-set problem only,
and that framing hid two further divergences: the guard reads `profiles`
through the service client, and a call site branches on the returned `role` to
gate QA-override — a second authorisation decision. It moves to the step 5 set.
See §1e of `admin-authz-audit.md`.

Step 6 is **not** done and must not be until those six are resolved —
`check:admin-guard` exits 1 while any local guard remains, which is exactly
what it is for.

One thing the sweep added that this plan did not anticipate: hoisting the
`profiles` query into `lib/` silently removed it from schema-drift coverage,
because every drift test reads `src/routes/`. Repaired in `c7b1bea85`; see
§1f of the audit. **A file-path-keyed static check stops guarding when the code
it watches moves, and reports green while doing it.**

Add to `package.json`:

```json
"check:admin-guard": "node --import tsx/esm src/scripts/checkAdminGuard.ts"
```

## Verification performed here

- Guard detection run against the real `src/routes/` → **detects exactly 30**,
  matching the independent audit above.
- Fail-closed behaviour confirmed by reading all twelve error-discarding
  variants, not by pattern-matching.

## NOT verified here

- **Typecheck.** The audit clone has no `node_modules`, so `tsc` was not run
  against `requireAdmin.ts`. Run `pnpm run typecheck` in `artifacts/api-server`
  before relying on it.
- **Runtime behaviour.** No test executed the new guard. The existing admin
  test suites (`adminModeration`, `adminProfileActions`, `featureFlagsAdmin`,
  `trust-integration`, `compass-admin`, `safeReturnAdmin`, `adminVenueModeration`,
  and others) should pass unchanged — that is the acceptance criterion, and it
  has not been demonstrated.
- Whether any route **relies** on the absent fallback client. Adding it should
  be inert, but that is reasoning, not evidence.

---

# Assessment of the 9 outstanding guards — 2026-08-09

**Conclusion first: none of the 9 is proven equivalent. None was migrated.**

Every one diverges from the canonical guard on at least one semantic dimension,
so converting any of them is a decision, not a mechanical edit. The count above
("24 of 30, 6 held back") was wrong in both terms — see below.

## The count was wrong: 33 guards, not 30

`checkAdminGuard.ts` matched `requireAdmin\w*` and was **structurally blind** to
three guards that authorise on `profiles.role` under different names:

| Guard | File | Why the detector missed it |
|---|---|---|
| `requireVisualAdmin` | `routes/adminVisuals.ts` | Name does not start with `requireAdmin` |
| `checkRentBuddyAccess` | `routes/rentABuddyRollout.ts` | Not a guard shape at all — returns a decision object |
| `canEditEntity` | `routes/visuals.ts` | Ownership predicate; admin is one branch inside it |

So "detects exactly 30, matching the independent audit" was two instruments
sharing one blind spot, not corroboration. **33 total, 24 converted, 9
outstanding.** This is the same failure family as finding 18: a detector that
cannot see a thing reports it as absent rather than unexamined.

## Security result

**All 9 fail closed.** Verified by reading each, not by pattern-matching: every
one denies on query error, missing row, and unmatched role. The three
never-assessed guards introduce **no new vulnerability**, and
`requireVisualAdmin` is in fact *stricter* than canonical.

## Classification

| # | Guard | File | Blocking dimension(s) | Verdict |
|---|---|---|---|---|
| 1 | `requireAdmin` | `circle.ts` | client source (requires service client); config-failure (503 vs canonical's proceed); error envelope (`sendError`, message "Admin access required"); returned identity (`{ user }`, not `userId`) | **HOLD — 4 dimensions** |
| 2 | `requireAdmin` | `placesCanonical.ts` | client source (requires service client); config-failure (503) | **HOLD — 2** |
| 3 | `requireAdminCtx` | `rentABuddySpec.ts` | error envelope (**no `message` field at all**); returned identity (`{ auth, serviceClient }`); role read through service-preferred client | **HOLD — 3** |
| 4 | `requireAdmin` | `rentABuddyMarketplace.ts` | error envelope (message has a **trailing period**); returned field named `svc`, not `sc` | **HOLD — 2, both mechanical** |
| 5 | `requireAdmin` | `compassGraph.ts` | returned identity — returns the raw `requireUser` result, so call sites use `auth.user.id` / `auth.client` | **HOLD — 1, smallest gap** |
| 6 | `requireAdmin` | `rentABuddyRollout.ts` | accepts `admin`\|`owner`; role read through service-preferred client; **returned role is a second gate** (`:635`) | **HOLD — product decision** |
| 7 | `requireVisualAdmin` | `adminVisuals.ts` | fuses a feature-flag gate into the authorisation guard | **HOLD — auth half is exactly equivalent** |
| 8 | `checkRentBuddyAccess` | `rentABuddyRollout.ts` | not a guard: returns `AccessDecision`, owns no response | **NOT CONVERTIBLE — fragment only** |
| 9 | `canEditEntity` | `visuals.ts` | not a guard: ownership predicate, admin is one accepted path | **NOT CONVERTIBLE — fragment only** |

## Evidence for the three never-assessed guards

### 7. `requireVisualAdmin` — `adminVisuals.ts:34`

Its **authorisation half is byte-for-byte equivalent** to
`requireAdmin(req, res, { withDisplayName: true })`: same caller-client read,
same four columns, same `error || !data || role !== "admin"`, same 403 envelope,
and a return shape (`{ userId, displayName, client, sc }`) that is an exact
subset of the canonical context.

It is held back because it does a **second, non-authorisation thing**: it gates
on the `ai_visual_admin_review_enabled` flag and returns 403 `feature_disabled`.
Conversion means extracting that, not deleting it.

> ⚠️ **This conversion is [TRAP 1](#trap-1--requirevisualadmin-the-ordering-is-the-safety-property).
> Read it before touching this guard.** The admin check must run *before* the
> flag check. Checking the flag first — the tidier-looking arrangement — leaks
> whether an unreleased feature is enabled to any authenticated non-admin. The
> ordering is the safety property, not a style choice.

### 8. `checkRentBuddyAccess` — `rentABuddyRollout.ts:150`

Not an admin guard. It is the feature-access decision function for Rent a Buddy,
returning `{ allowed, code, message, httpStatus }` and sending no response. It is
also called from `rentABuddy.ts:1010`, so its contract is cross-file.

Only one fragment is admin logic — the admin-only-mode branch, which reads
`profiles.role` and accepts `admin` or `owner`. That fragment is expressible as
`isAdmin(sc, userId, ["admin","owner"])` and nothing else here is. It inherits
the `owner` decision below.

### 9. `canEditEntity` — `visuals.ts:53`

Not an admin guard. It answers "may this user edit visuals for this entity?",
where admin is the *first* of three accepted paths (admin, event host, trip
owner); places are admin-only. Returns boolean, takes an injected client.

Its first three lines are exactly `isAdmin(sc, userId)`. The rest is ownership
logic that must stay. Converting the fragment is safe but cosmetic — it removes
one `profiles` read spelled by hand, and changes no behaviour.

## The `owner` role is referenced three times and cannot exist

`owner` appears at three sites: `rentABuddyRollout.requireAdmin` (route access),
`checkRentBuddyAccess` (admin-only mode), and the QA-override gate at
`rentABuddyRollout.ts:635`.

**No `owner` row exists in production** (55 `user`, 1 `admin`), and as of
migration 2078 `admin_set_profile_role` accepts only `('user','admin')` — so the
supported path cannot create one.

### CORRECTION 2026-08-09 — the branches were formally dead, and `:635` is now removed

This section previously said `owner` "remains reachable by direct service-role
SQL, so the branches are not formally dead." **That was wrong.** A column CHECK
constraint forbids the value outright:

```
profiles_role_check  CHECK (role = ANY (ARRAY['user'::text, 'admin'::text]))
```

Verified by execution, not by reading the definition: `UPDATE profiles SET
role='owner'` was run as `postgres` (superuser, RLS-exempt, trigger-privileged)
and was **rejected with a check_violation**. No service-role or superuser SQL can
create an `owner`; it requires a DDL change to drop or alter the constraint
first. The branches were formally dead.

Full enumeration performed before removing anything — every path that could
produce an `owner` row:

| Path | Can produce `owner`? |
|---|---|
| `profiles_role_check` CHECK constraint | **No** — rejects it even as superuser (executed) |
| `role` column default | No — `'user'` |
| `admin_set_profile_role()` RPC (only explicit privileged path) | No — validates `IN ('user','admin')` |
| `trg_profiles_role_privileged` trigger | No — blocks non-privileged role writes entirely |
| Any HTTP request path | No — no route/service/lib writes `profiles.role` at all |
| Signup (`handle_new_user`) | No — inserts only (id, handle, username, name); also not wired to `auth.users` |
| Seeds | No — only ever write `role:"user"` |
| Migrations | No — none write `'owner'` to `profiles.role` |
| Other DB functions | No — none reference `owner` together with `profiles` |
| Live data | 0 `owner` rows; only `user` (55) and `admin` (1) |

**Resolution: the `:635` branch is removed.** A dead authorisation branch is worse
than no branch — it reads as a capability that exists, and the likely future
"fix" is someone provisioning an `owner` to make it work without ever learning
why it was unreachable.

> ⚠️ **This widened authorisation, deliberately.** Advancing to `public_mvp` on a
> failed checklist was previously impossible for *everyone*; it is now possible
> for an `admin` who supplies an `overrideReason`, and remains audit-logged as
> `qa_override`. That is the intended escape hatch finally working. If the intent
> was genuinely a two-tier privilege model, the correct fix is a real second role
> — not a branch that 403s everyone.

**The tests hid this.** `rentABuddyRollout.test.ts` asserted the old behaviour with
a fabricated fixture: `state.profiles[ADMIN_ID].role = "owner"`. The "happy path"
test exercised a state the database forbids, while its partner test asserted the
only outcome production could ever produce. Together they made a permanently
unreachable branch look fully covered. Both were rewritten against reachable
states. **A fixture that no schema constraint would accept is not coverage** —
this is the same class of failure as the checks in this repo that measured
nothing.

**Two `owner` references remain, deliberately**, at `rentABuddyRollout.ts:131`
(`requireAdmin`) and `:178` (`checkRentBuddyAccess`). Both are *permissive*
disjunctions (`role !== "admin" && role !== "owner"`), so the dead clause grants
nothing and changes no behaviour — unlike `:635`, which was a deny gate. They are
left for the guard consolidation to remove along with those two guards, rather
than touched piecemeal here.

## Named traps

Conversions on this list that are **more dangerous than they look**. Each is
recorded here because its failure mode is a refactor that makes the code
*tidier* — so it will not look like a mistake in review, and the next person to
try it needs to find this before they start, not after.

### TRAP 1 — `requireVisualAdmin`: the ordering is the safety property

**Site:** `adminVisuals.ts:34` (guard #7).

**Why it looks free.** Its authorisation half is *byte-for-byte equivalent* to
`requireAdmin(req, res, { withDisplayName: true })` — same caller-client read,
same four columns, same `error || !data || role !== "admin"` test, same 403
envelope, and a return shape that is an exact subset of the canonical context.
Every signal a reviewer normally uses says "drop-in replacement".

**What that reading misses.** The guard does a second, non-authorisation thing:
it gates on the `ai_visual_admin_review_enabled` feature flag and returns 403
`feature_disabled`. The *order* of those two checks is load-bearing:

```
CORRECT (today)                          WRONG (tidier-looking)
  1. admin check   → 403 forbidden         1. flag check    → 403 feature_disabled
  2. flag check    → 403 feature_disabled  2. admin check   → 403 forbidden
```

A non-admin hitting the wrong version gets `feature_disabled` when the flag is
off and `forbidden` when it is on. **The response distinguishes the two, so any
authenticated non-admin can probe the endpoint and read the release state of an
unshipped feature.** The correct order returns `forbidden` to a non-admin in both
cases, revealing nothing.

**Why this is a trap and not a note.** Nothing about the wrong version looks
wrong. It is shorter, it reads more naturally (cheap flag check first, expensive
DB read second), and it is what a performance-minded reviewer would *ask for*.
There is no test that fails, and per finding 18 there is no CI that would run one
if there were. The information leak is invisible at the call site and only
observable by diffing two error codes.

**Rule.** Converting this guard means extracting the flag gate and calling it
**after** the canonical admin guard. Never reorder them, and never merge them
into a single early-return that evaluates the flag first. If a future change
makes the flag check cheaper or moves it into middleware, that does not license
the reorder — the ordering is the security property, not an optimisation
artefact.

## Recommended order, if and when these are taken on

Ordered by risk, lowest first. Each needs its own change, and #6 needs an owner
decision before any code moves.

1. **#9 `canEditEntity`** — swap the fragment for `isAdmin`. No behaviour change.
2. **#5 `compassGraph.ts`** — one dimension; edit the call sites to the canonical
   context shape.
3. **#4 `rentABuddyMarketplace.ts`** — accept the trailing-period message change
   and rename `svc`→`sc`, or keep it as-is. Cosmetic but client-visible.
4. **#7 `requireVisualAdmin`** — extract the flag gate, preserving check order.
   ⚠️ **Read [TRAP 1](#trap-1--requirevisualadmin-the-ordering-is-the-safety-property)
   before touching this one.** It is the most inviting conversion on this list and
   the only one that can leak information by being tidied.
5. **#2 `placesCanonical.ts`**, then **#1 `circle.ts`** — both need a ruling on
   whether "no service client" should stay a 503 or become the canonical
   fallback. That is a real availability-vs-permissiveness choice.
6. **#3 `rentABuddySpec.ts`** — needs a ruling on the missing `message` field,
   which clients may match on.
7. **#6 `rentABuddyRollout.ts` + #8 `checkRentBuddyAccess`** — the `owner`
   decision is now made (see the correction above): `:635` is removed, and the
   two remaining `owner` clauses at `:131` and `:178` are permissive no-ops to be
   dropped with these guards. No longer blocked.

## NOT verified here

- **No conversion was performed and no behaviour was changed.** This is
  assessment only.
- **Call-site impact was read, not exercised.** The `admin.role` second gate and
  the cross-file use of `checkRentBuddyAccess` were confirmed by reading
  `rentABuddyRollout.ts:635` and `rentABuddy.ts:1010`; no test was run against
  them. Per finding 18, no automated run would have caught it if there were.
