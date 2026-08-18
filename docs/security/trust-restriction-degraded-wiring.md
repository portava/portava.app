# Trust-restriction degraded-read wiring — summary and follow-up

**Status: done for the scope named; one instrumentation gap filed below, not fixed.**

## What this covers

`TrustRestrictionService.getRestrictionState`'s `degraded` flag was set in
both directions — fail-open (missing `trust_restrictions` table, not a
restriction) and fail-closed (a real query error, the check couldn't run) —
with no way for a caller to tell which. Fixed by adding an explicit
`degradedReason: 'fail_open' | 'fail_closed'` discriminator and wiring all
four direct callers (`trips.ts` hosting, `messaging.ts` messaging,
`callGatewayAdapter.ts`/`callPermissionEngine.ts` calls, `TrustPrivacyGuard.ts`
passive summary) to show the correct thing: silence on fail-open, the exact
retryable `degraded_unavailable` message
("We could not verify your permissions right now. Please try again
shortly.") on fail-closed, the real restriction message otherwise.

A second, independent instance of the same defect class was found and fixed
one layer up: `resolveInteractionPermissions`
(`artifacts/api-server/src/services/interactionPermissions.ts`) had its own
duplicate inline `trust_restrictions` query with the same fail-open/
fail-closed shape, but no discriminator — a fail-closed read there threw a
bare `Error` with no signal that the check failed rather than denied.
Replaced with a call to `getRestrictionState` and a new,
reused-not-duplicated `DegradedPermissionCheckError` (exported from
`TrustRestrictionService.ts` alongside a shared `DegradedReason` type) to
carry the discriminator through the one channel this function has for
fail-closed — an exception.

Branch: `claude/trust-restriction-degraded-wiring-20260818`. All work
committed there, nothing merged.

## FOLLOW-UP — the fix at `resolveInteractionPermissions`'s source only reaches one of its 15 callers

The source-level fix (delegating to `getRestrictionState`) is
**backward-compatible for every caller** — none of them inspected the shape
of the old thrown `Error`, so nothing broke. But only
`POST /users/:userId/message-request` in
`artifacts/api-server/src/routes/messaging.ts` — the route named in the
original follow-up that led to this fix — was given its own
`instanceof DegradedPermissionCheckError` handling to show the retryable
`degraded_unavailable` message on a fail-closed trust-restriction read.

**14 other call sites of `resolveInteractionPermissions` were found and are
untouched** — a fail-closed trust-restriction read reaching any of them
today still surfaces as whatever that route's own generic catch-all
produces (if it has one) rather than the honest, retryable message:

Production routes (12):
- `artifacts/api-server/src/routes/mutes.ts`
- `artifacts/api-server/src/routes/admin.ts`
- `artifacts/api-server/src/routes/interactionContext.ts`
- `artifacts/api-server/src/routes/friends.ts`
- `artifacts/api-server/src/routes/restrict.ts`
- `artifacts/api-server/src/routes/saves.ts`
- `artifacts/api-server/src/routes/blocks.ts`
- `artifacts/api-server/src/routes/tags.ts`
- `artifacts/api-server/src/routes/requests.ts`
- `artifacts/api-server/src/routes/passport.ts`
- `artifacts/api-server/src/routes/reports.ts`
- `artifacts/api-server/src/routes/follows.ts`

Test files that also call it directly (not runtime instrumentation targets,
listed for completeness of the caller count):
- `artifacts/api-server/src/test/coreActions.test.ts`
- `artifacts/api-server/src/test/profilePrivacy.test.ts`

**What the follow-up is, precisely:** for each of the 12 production routes,
determine how it currently handles an exception from
`resolveInteractionPermissions` (many will have their own generic
catch-and-500, mirroring what messaging.ts had before this fix), and add
the same `instanceof DegradedPermissionCheckError` branch messaging.ts now
has, with wording appropriate to that route's action (not necessarily the
same literal string — messaging.ts's exact retry string was specified for
that route's UX; each route's product owner should confirm its own
copy). This is a mechanical sweep once the pattern exists, not a design
question — the discriminator and error class already exist and are proven
by messaging.ts's tests.

Not done here, by design — this record exists so the sweep isn't lost, not
to schedule it.
