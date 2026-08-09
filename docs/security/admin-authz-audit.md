# Admin authorization — variant audit and finding 17

**Two findings. The second is more serious than the first and changes what
"consolidate onto the strictest implementation" means.**

Date: 2026-08-08. Branch `bughunt-20260805`. Read-only against production;
no writes, no schema changes, no call sites changed.

---

## 0. Why this document exists

The task was: diff the duplicated `requireAdmin` implementations, identify any
**security-relevant** differences, and name the variant to make canonical
**before** touching call sites — because consolidating onto a weaker
implementation is a privilege-escalation regression, not a cleanup.

Doing that diff surfaced a second issue underneath it. Both are below. **No
consolidation has been performed.**

---

## 1. The variant audit

**30 route files define a local admin guard.** `lib/adminAudit.ts` exists but
exports only `logAdminAccess` and `accessReason` — it is the natural home, not
an existing one. Nothing currently shares this guard.

Names vary (`requireAdmin`, `requireAdminGuard`, `requireAdminCtx`,
`requireAdminForStamps`), which is why the duplication survived grep review.

### 1a. The one security-relevant difference

**`routes/rentABuddyRollout.ts` accepts a wider role set than every other
variant:**

```ts
const role = (data as any)?.role ?? "";
if (!data || (role !== "admin" && role !== "owner")) { /* 403 */ }
```

All 29 others require exactly `role === "admin"`. This is the only genuine
authorization divergence in the set, and it cuts both ways:

- **Consolidating everything onto this variant would widen admin access on 29
  routes** — a privilege-escalation regression. Must not happen.
- **Consolidating this variant onto admin-only narrows access** on the rollout
  routes. Production evidence: `profiles.role` is `user` × 55 and `admin` × 1.
  **No `owner` row exists**, so narrowing breaks nobody today — but whether
  `owner` is a planned role is a product decision, not a refactor.

### 1b. Differences that look security-relevant and are not

Stated explicitly, because inflating these would obscure the one that matters.

| Difference | Files | Verdict |
|---|---|---|
| `const { data, error }` + `if (error \|\| !data \|\| ...)` vs `const { data }` + `if (!data \|\| ...)` | ~10 discard `error` | **Not a weakness.** supabase-js returns `data: null` on error, so `!data` denies. Both **fail closed**. The discarded `error` costs diagnosis, not safety |
| `rentABuddySpec.ts` omits `!data`, uses `(profile as any)?.role !== "admin"` | 1 | **Equivalent.** `undefined !== "admin"` denies. Fail closed |
| Role read via user client (RLS applies) vs service client | ~6 use service | **Availability, not authorization.** If RLS hides the row, `data` is null → deny. Fail closed either way |
| `getServiceClient() ?? client` fallback vs requiring the service client | `circle.ts`, `placesCanonical.ts` require it | **Not an auth difference.** The fallback affects what the route can *do* after authorization, not who passes it |
| `compassGraph.ts` returns `auth` with no service client | 1 | Capability difference only |

### 1c. One variant is not drop-in replaceable

`routes/hiddenGems.ts` has a different contract entirely:

```ts
async function requireAdmin(sc: any, userId: string): Promise<boolean>
```

It is a **predicate**, not a guard: it does not call `requireUser`, does not
send a 403, and returns a boolean the caller must check. Swapping it for the
guard shape without reading each call site risks converting "checked" into
"ignored return value". It needs call-site-by-call-site review, not a
mechanical replacement.

### 1d. Recommended canonical — subject to §2

> **SUPERSEDED 2026-08-09 — location only.** This section originally proposed
> `lib/adminAudit.ts` as the home. The canonical guard shipped in `c8205e770`
> as **`lib/requireAdmin.ts`** instead, and that is the single canonical. See
> `admin-guard-consolidation.md`. An authorisation gate and an audit-logging
> module are separate concerns: `adminAudit.ts` is imported by routes that log
> without gating, and folding a gate into it would make both harder to reason
> about and give the gate a reason to be imported for non-gate purposes.
> Every requirement below was carried over unchanged — only the filename moved.

Make canonical the **strict `role === "admin"`** form, error-checked, in
`lib/requireAdmin.ts`:

- strict equality on `"admin"` — never the `admin || owner` widening;
- keep `error` and deny on it (no behaviour change, better diagnosis);
- return `{ userId, displayName, client, sc }`, the superset shape already used
  by `admin.ts` and `adminPlaceImages.ts`, so no call site loses a field;
- `getServiceClient() ?? client` retained — removing the fallback would break
  the test strategy the `admin.ts` comment documents.

The shipped guard satisfies all four, and adds `role` to the returned context
so a route opting into a wider set can tell which role matched.

**Two call sites cannot be mechanically converted** and are held back:
`rentABuddyRollout.ts` (needs the `owner` decision) and `hiddenGems.ts` (needs
call-site review). Both are now expressible on the shared guard — `roles` and
`isAdmin()` respectively — but each still requires the review this audit asked
for, and neither is a mechanical conversion.

---

## 2. Finding 17 — `profiles.role` is self-writable (CRITICAL, decision-ready)

**Every one of the 30 guards reads `profiles.role` as its source of truth. That
column is writable by the user it describes.**

Verified against production, read-only:

**a. RLS permits self-update of the whole row.**
```
profiles_update  USING (id = auth.uid())  WITH CHECK (id = auth.uid())
```
RLS is enabled (`relrowsecurity = true`). Postgres RLS **cannot restrict
columns** — a row-level policy that allows the update allows it for every
column.

**b. The `authenticated` role holds `UPDATE` on `profiles.role`.**
Column-level grants confirm `UPDATE` on `role` for `anon`, `authenticated`,
`postgres` and `service_role`. There is no column-level restriction narrowing
it.

**c. No trigger protects `role`.** Only two non-internal triggers exist on
`profiles`:
```
enforce_is_official_trigger → enforce_is_official_service_role
trg_profiles_updated        → set_updated_at
```
The first proves the risk class was recognised — someone protected
`is_official` with a service-role-only trigger. **`role` did not get the same
treatment.** That asymmetry reads as an oversight, not a decision.

**d. The path is reachable.** `travel-buddy-standalone/src/lib/supabase.ts`
creates a supabase-js client with the anon key and the user's session, talking
to PostgREST directly. An authenticated user's JWT carries the `authenticated`
Postgres role.

### Consequence

An authenticated user appears able to set their own `profiles.role` to
`'admin'` and thereby pass **all 30 admin guards simultaneously** — including
every one in §1, whichever is made canonical. Consolidation does not fix it;
consolidation makes it a single, cleaner chokepoint in front of an
already-open door.

### What was NOT done

**The exploit was not executed.** Confirming it end to end requires writing to
production, which this session is forbidden from doing. What is verified is
that *every precondition is present*: the policy permits the row, the grant
permits the column, no trigger intercepts it, and the endpoint is reachable.
That is the honest limit of a read-only audit — the preconditions are proven,
the exploitation is inferred.

`anon` also holds the `UPDATE` grant, but RLS gates it: `auth.uid()` is null
for anonymous requests, so `id = auth.uid()` matches no row. The vector is
authenticated users, not anonymous ones.

### Why this is decision-ready and not fixed here

Every available remedy changes production schema, policy, or grants:

1. **Trigger** mirroring `enforce_is_official_service_role` for `role` — the
   most consistent with what is already there.
2. **`REVOKE UPDATE (role) ON profiles FROM authenticated, anon`** — narrowest
   change, but a grant change.
3. **Split the column out** into an admin-only table — largest change, best
   long-term shape.
4. **Tighten `profiles_update`'s `WITH CHECK`** to compare `role` against its
   existing value — possible, but RLS cannot see `OLD`, so this needs a trigger
   anyway.

All four are schema/policy changes, explicitly out of scope. **Recorded, not
acted on.**

---

## 3. Decision-ready summary

1. **Finding 17 — `profiles.role` self-writable.** Pick a remedy from §2.
   Highest priority in this document; the admin guard is only as strong as this
   column.
2. **Is `owner` a real role?** (§1a) Zero rows today. If yes,
   `rentABuddyRollout` is correct and the others are wrong; if no, it should
   narrow to `admin`. This decides one call site either way.
3. **`hiddenGems.ts` predicate-vs-guard** (§1c) — needs call-site review before
   conversion.
4. Consolidation onto the §1d canonical is otherwise ready to proceed and is
   **not blocked** by 1–3; those three are carve-outs.

## 4. Verification note

- All 30 implementations were read in full, not sampled.
- Production facts (role distribution, RLS policies, column and table grants,
  triggers, RLS enablement) come from direct `pg_policy` / `pg_class` /
  `information_schema` queries, read-only.
- **Not verified:** that the escalation actually succeeds end to end. See §2.
- **Not verified:** whether any application-layer middleware intercepts
  PostgREST writes to `profiles`. The client talks to PostgREST directly
  (§2d), so such a layer would have to be inside Supabase, and none was found —
  but absence of evidence here is weaker than the positive grant/policy
  evidence above.
