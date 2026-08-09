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
3. Convert the two divergent ones **individually and deliberately**:
   `rentABuddyRollout.ts` with `{ roles: ["admin","owner"] }`, `hiddenGems.ts`
   with `isAdmin`. Do not batch these.
4. ~~`admin.ts`~~ **`admin.ts` and `adminPlaceImages.ts`** with
   `{ withDisplayName: true }`.
5. Reconcile the five semantics-sensitive routes individually (corrected
   Finding 3). Each is a decision, not a conversion.
6. Land `checkAdminGuard.ts` and wire it into `run-all-checks.sh` **last** —
   it fails while any local guard remains, so it is the proof the sweep finished,
   not a step along the way.

**Status 2026-08-09 — 23 of 30 converted, 7 held back.** Steps 1, 2 and 4 are
done (batches `5b2a346fc`, `0f33ad144`, `dd2368883`). Held back: the two
carve-outs at step 3, and the five at step 5. Step 6 is **not** done and must
not be until those seven are resolved — `check:admin-guard` exits 1 while any
local guard remains, which is exactly what it is for.

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
