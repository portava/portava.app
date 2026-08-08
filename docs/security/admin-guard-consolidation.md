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

- **Fallback client**: 7 lack `getServiceClient() ?? client`
  (circle, compassGraph, hiddenGems, placesCanonical, rentABuddyMarketplace,
  rentABuddySpec — plus hiddenGems by shape). The fallback exists so routes stay
  testable without service credentials; adding it is strictly permissive of
  tests, not of callers.
- **Selected columns**: only `admin.ts` selects
  `role, display_name, username, handle`; the rest select `role`. Preserved as
  the opt-in `withDisplayName`.
- **Quote style / error message**: identical semantics, `"admin"` vs `'admin'`.

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
2. Convert route files in batches, **starting with the 25 plain `requireAdmin`
   cases**, which are mechanical.
3. Convert the two divergent ones **individually and deliberately**:
   `rentABuddyRollout.ts` with `{ roles: ["admin","owner"] }`, `hiddenGems.ts`
   with `isAdmin`. Do not batch these.
4. `admin.ts` with `{ withDisplayName: true }`.
5. Land `checkAdminGuard.ts` and wire it into `run-all-checks.sh` **last** —
   it fails while any local guard remains, so it is the proof the sweep finished,
   not a step along the way.

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
