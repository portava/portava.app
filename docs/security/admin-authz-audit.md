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

### 1e. Correction — "plain" was the wrong classification (2026-08-09)

This audit sorted the 30 guards by **selected columns, role comparison, and
status code**, and called everything that matched on those three "plain". The
sweep found that classification too narrow. Six guards match on all three and
still are not drop-in replaceable, because a guard's semantics also include:

| Dimension | Why it matters | Divergent |
|---|---|---|
| **Client source** | Reading `profiles` through the service client bypasses RLS; through the caller's client it does not. Same query, different trust model. | `circle.ts`, `placesCanonical.ts`, `rentABuddySpec.ts`, `rentABuddyRollout.ts` |
| **Configuration-failure behaviour** | A guard that *requires* the service client returns 503 `server_not_configured` when it is absent. The shared guard falls back to the user client and proceeds — a change in the permissive direction. | `circle.ts`, `placesCanonical.ts` |
| **Error envelope** | `sendError()` vs a hand-written `res.status(403).json(...)`; a body with no `message` field; a message differing by one character. Clients may match on these. | `circle.ts` (message), `rentABuddySpec.ts` (no `message`), `rentABuddyMarketplace.ts` (trailing period) |
| **Returned identity** | Returning the raw `requireUser` result, or the full `user` object rather than `userId`, is a call-site contract. | `compassGraph.ts`, `circle.ts` |
| **Returned role as a second gate** | A call site that branches on the returned `role` is making a *second* authorisation decision the guard does not make. Converting the guard silently moves that decision's input. | `rentABuddyRollout.ts` |

So the count that matters is not "30 guards, 2 exceptions" but **24 converted,
6 held back**: 1 carve-out (`hiddenGems.ts`, converted to `isAdmin`) plus these
6. None is a security finding — every one still fails closed. They are cases
where converting would have changed behaviour silently, which on an
authorisation sweep is the outcome to avoid even when the change looks harmless.

#### Why `rentABuddyRollout.ts` was missed by this very correction

It was added on 2026-08-09, *after* §1e was first written, and the miss is
instructive rather than incidental.

§1d had already classified this route under **"needs the `owner` decision"**.
Once a route carries a label, the label becomes the thing you check. The
`roles` option answered the labelled question completely and correctly — and
because it did, nobody re-ran the other five dimensions against it. §1e was
written in the same session and still did not list it, because §1e was derived
from the routes that had *no* label, not from all thirty.

Two axes diverge here, not one:

- **Client source.** The local guard reads through `getServiceClient() ??
  auth.client`; the shared guard reads through the caller's client. In practice
  the row is the caller's own and RLS almost certainly permits both — but §1e's
  own rule is that plausibility is not evidence on an authorisation path.
- **Returned role as a second gate.** Line ~626 branches on
  `admin.role !== "owner"` to gate QA-override, a *distinct* authorisation
  decision layered on top of the guard's admin-or-owner check. The shared guard
  does return `role`, so this survives mechanically — but it means the
  conversion moves the input to two authorisation decisions, not one.

A conversion was made and reverted (`b42787bbc`, reverted). Its commit message
asserts "no call site reads the returned `role`". **That claim is false** — it
came from a grep whose own exclusion filter removed the matching line. The
mistake is recorded here because the revert alone does not correct the log, and
because the failure mode is worth naming: *a search that can exclude the
evidence it is looking for is not a verification.*

**Rule added:** a label from an earlier pass is a hypothesis, not a
classification. Re-run every dimension against every route, including the ones
already explained.

**Rule for the next sweep:** a guard is drop-in replaceable only when the
client source, RLS behaviour, configuration-failure behaviour, error envelope,
response shape, and selected columns all match. Columns and status code alone
are not sufficient evidence.

### 1f. Drift coverage must follow a query when it moves into `lib/` (2026-08-09)

Consolidation moved `.from("profiles").select("role")` out of the route files.
Three schema-drift sanity checks failed immediately — `adminStamps.ts`,
`adminGeocode.ts`, `trust-admin.ts` — and they were **right to fail**. Every
schema-drift test reads `src/routes/`; none reads `src/lib/`. Hoisting the
query moved an authorisation query out of drift coverage altogether.

The tempting fix — delete the three now-unmatched `profiles` assertions —
would have turned a real loss of coverage into a silent one, which is the same
failure mode this consolidation exists to prevent, one level up.

What was done instead (`c7b1bea85`): the drift test appends the shared guard's
source to any route that imports it, so route-level coverage survives the
hoist, **and** `lib/requireAdmin.ts` is checked in its own right so the
coverage does not depend on who imports it.

Two things this surfaced, both worth remembering:

- The extractor was literal-only, so `.select(columns)` — a column list held
  in a `const` — yielded **no refs at all** and passed vacuously. The guard's
  `withDisplayName` branch (`display_name`, `username`, `handle`) was entirely
  unchecked. Same-file `const` resolution was added.
- Green was not accepted as proof. Injecting a dead column into the guard
  failed 5 tests across all four consumers; only then was the coverage
  believed.

**Invariant:** moving a query into a shared module moves its drift coverage
with it. A static guard keyed on file paths silently stops guarding the moment
the code it watches moves — and reports green while doing it.

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

### RESOLVED 2026-08-09 — with a caveat that matters more than the fix

**The column is no longer self-writable. Verified live, and verified by tests
that are proven capable of failing.**

The remedy chosen was options 1 + 2 together — a column-level `REVOKE` plus a
trigger — for a reason worth keeping: `REVOKE UPDATE (role)` is the narrower and
more precise barrier, but a single future `GRANT UPDATE ON profiles TO
authenticated` re-grants every column silently. A grant has no memory of intent.
The trigger is what survives that. Option 4 (tighten `WITH CHECK`) was discarded
because RLS cannot see `OLD` and collapses into needing a trigger regardless.
Option 3 (split the column out) was deferred — see below.

#### The caveat: the protection was live but existed in no migration

When this fix was picked up, the live database **already had** the trigger
(`trg_profiles_role_privileged`), both functions
(`enforce_profile_role_privileged`, `caller_may_write_profile_role`), the
privileged RPC (`admin_set_profile_role`), and the narrowed column grants —
applied out-of-band, committed to no migration file, covered by no test, and
described in no document. A repo-wide search for all four identifiers returned
nothing.

That is a worse state than it looks. The vulnerability was closed in production
while **a database rebuilt from the migration tree would still have been
vulnerable**, and nothing anywhere would have caught the difference. This is the
third instance of live-vs-migration drift recorded in this repo (see finding 16,
and `post_saves.id` / `posts_comments.updated_at` in
`docs/admin/moderation-coverage.md`), and the first where the drift was a
security control.

`2078_profiles_role_not_self_writable.sql` captures the live state verbatim and
idempotently. Applying it to production is a no-op; its purpose is that a
rebuild reproduces the protection.

#### Verified live (2026-08-09, read-only)

| Precondition from the original finding | State now |
|---|---|
| `authenticated`/`anon` hold `UPDATE` on `role` | **Revoked.** Only `postgres` and `service_role` retain it |
| No trigger protects `role` | **`trg_profiles_role_privileged`** guards INSERT *and* UPDATE |
| No explicit privileged path | **`admin_set_profile_role(uuid, text)`**, `EXECUTE` to `service_role` only |
| RLS `profiles_update` | **Unchanged** — deliberately; RLS cannot restrict columns |
| Role distribution | 55 `user`, 1 `admin` — unchanged before and after |

#### Tests — `src/test/profileRoleNotSelfWritable.test.ts`

12 tests, all passing against the live database. Each negative assertion was
**proved capable of failing** by mutation: a copy asserting the vulnerable
outcome was run, and every negative test failed as required (7 in the first
pass, 5d in a second targeted pass). A green run on an already-fixed database
would otherwise prove nothing.

Two details the tests deliberately encode:

- **They re-read `role` through the service client** rather than trusting the
  returned error. An UPDATE matching zero rows under RLS returns *no error*, so
  "no error" and "the write happened" are different claims.
- **Test 5b asserts atomicity** — `role` smuggled alongside a permitted column
  must fail the whole statement. A partial write would be worse than an outright
  bypass, because it would look like a successful profile edit.

#### Two things this fix does NOT do

1. **`is_official` still carries a column-level `UPDATE` grant** for
   `authenticated` and `anon` — one barrier where `role` now has two. Logged as
   **finding 19**.

   **Verified NOT exploitable (2026-08-09), by execution rather than
   inference.** An ordinary authenticated user attempting
   `update({ is_official: true })` on their own row via PostgREST is refused:
   `is_official can only be set by the service role`, and the column reads
   `false` afterwards on an authoritative service-client re-read. The probe user
   was deleted; the probe script was not committed.

   Severity is further limited by what the flag *is*: a display badge
   (`isOfficial` in the profile/post serializers) and a ranking input
   (`portavaRank.ts`). **No authorisation gate reads it** — unlike `role`, which
   all 33 admin guards read. Worst case is a counterfeit badge and a ranking
   boost, not privilege escalation.

   Two latent weaknesses worth knowing before anyone relies on it:
   - `enforce_is_official_service_role` tests
     `current_setting('role', true) NOT IN (...)`. If that setting were ever
     NULL, `NULL NOT IN (...)` yields NULL, the `IF` does not fire, and the
     exception is skipped. `caller_may_write_profile_role()` avoids this with
     `COALESCE(NULLIF(...), 'none')`. Not reachable via PostgREST, which always
     sets the role — it needs a direct connection with no role GUC, i.e. an
     already-privileged one.
   - The trigger guards only elevation to TRUE. Clearing the flag is ungated,
     though RLS confines that to the caller's own row.

   Recorded as an asymmetry to reconcile, not a task, and explicitly not a
   reason to hold anything up.
2. **Option 3 (split auth state out of `profiles`) remains deferred**, and the
   corrected guard count strengthens that. The original reasoning was that once
   all guards route through the canonical `lib/requireAdmin.ts`, `profiles.role`
   has one read site and the split becomes contained. But the true count is
   **33 guards, 24 converted / 9 outstanding** — not 30/24/6: `checkAdminGuard.ts`
   matched `requireAdmin\w*` and was structurally blind to `requireVisualAdmin`,
   `checkRentBuddyAccess`, and `canEditEntity`. The consolidation is further from
   done than the one-read-site argument assumes, so the split stays deferred.

#### Recorded for the guard consolidation to reconcile

`routes/rentABuddyRollout.ts` authorises `role === 'admin' || role === 'owner'`.
**No `owner` row exists in production.** `admin_set_profile_role` therefore
accepts only `('user','admin')`, and a test asserts `'owner'` is rejected —
propagating a zero-member role into a new security boundary would have made the
boundary speculative. The divergence belongs to the consolidation, not to this
fix.

#### ⚠ These tests do not run automatically anywhere. Checked, not assumed.

The instruction was to check rather than ask. The result is worse than "CI lacks
credentials":

1. **There is no CI.** No `.github/workflows/` directory exists. Nothing runs
   tests on push, on PR, or on merge. "CI" in this repo means a human running
   `pnpm test` or `pnpm run check:all`.
2. **`check:all` runs no tests at all.** `scripts/run-all-checks.sh` runs six
   static checks (`frozen-dir`, `async-handlers`, `migration-prefixes`,
   `test-runner-flags`, `write-path-columns`, `missing-live-columns`). Not one
   invokes the test suite.
3. **The curated `test` script pins Supabase to a dead address** —
   `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy`. Port 9 is
   the discard protocol. Any live-database test registered there is guaranteed
   to skip, by construction.

So there is no configuration in which registering this file into the curated run
causes it to execute. Registering it would produce a *permanent skip inside a
green suite* — the precise green-by-absence failure mode this test exists to
avoid. It is therefore in `UNREGISTERED_TESTS_ALLOWLIST.json`, alongside
`rlsHardening.test.ts`, which is allowlisted for the same reason.

**Consequence, stated plainly: finding 17 is fixed and verified, but nothing
will tell you if it regresses.** Dropping the trigger or re-granting the column
would be caught by no automated check. Running it is a deliberate act:

```
pnpm run test:profile-role-not-self-writable    # needs live credentials
```

The narrowest fix for the regression gap is a scheduled job — or any CI at all —
that runs the credentialled security tests (`test:rls-hardening`,
`test:profile-role-not-self-writable`) against a non-production project. That is
a separate piece of work and is **not** done here.

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
5. **Six further routes need their own reconciliation** (§1e) —
   `circle.ts`, `placesCanonical.ts`, `rentABuddySpec.ts`,
   `rentABuddyMarketplace.ts`, `compassGraph.ts`, and `rentABuddyRollout.ts`.
   Not security findings; all fail closed. Each diverges on client source,
   configuration-failure behaviour, error envelope, or a returned field used as
   a second gate — so each needs a decision rather than a conversion.

   `rentABuddyRollout.ts` additionally still needs the `owner` decision at
   item 2 above. The `roles` option answers that question, but answering it is
   not sufficient to convert the route: see §1e for why the label masked the
   other dimensions.

   Status as of 2026-08-09: **24 converted, 6 held back**.

## 4. Verification note

- All 30 implementations were read in full, not sampled.
- The classification they were sorted into was nonetheless too narrow — see
  §1e. Reading every implementation is not the same as comparing every
  dimension of every implementation.
- Production facts (role distribution, RLS policies, column and table grants,
  triggers, RLS enablement) come from direct `pg_policy` / `pg_class` /
  `information_schema` queries, read-only.
- **Not verified:** that the escalation actually succeeds end to end. See §2.
- **Not verified:** whether any application-layer middleware intercepts
  PostgREST writes to `profiles`. The client talks to PostgREST directly
  (§2d), so such a layer would have to be inside Supabase, and none was found —
  but absence of evidence here is weaker than the positive grant/policy
  evidence above.
