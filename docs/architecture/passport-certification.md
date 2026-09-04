# Portava Passport — Certification Report

**Date:** 2026-09-03
**Branch:** `claude/passport-certification-20260903` (from `origin/main` @ `7c03bdc`)
**Scope:** Certify the Portava Passport program against the canonical spec
(`passport_spec.txt`, §1–§35 + TABLE 0–33). Audit-with-fixes: verify each of the
10 primary surfaces and 9 implementation phases, check the spec's hard
invariants against the code, run the relevant suites, fix small/safe
construction defects, and document larger gaps honestly.

**Live trees audited:**
- Backend: `artifacts/api-server/src/services/passport/*`, `routes/passport.ts`,
  `routes/availability.ts`, migrations `2260`/`2261`.
- Client: `travel-buddy-standalone/app/(tabs)/passport.tsx`,
  `app/passport/*`, `src/features/passport/*`, `src/components/passport/*`.

**Overall verdict:** **BUILT / certified with findings — ~92% construction complete.**
The projection engine and every hard privacy/authorization invariant are built,
enforced server-side, and covered by passing tests. Remaining work is
integration/navigation wiring, a §27 design-system deviation, and §32 telemetry —
documented below, none of which are silent correctness violations today.

---

## 1. Test results (construction gate)

| Suite | Command | Result |
|---|---|---|
| Backend typecheck | `cd artifacts/api-server && npx tsc --noEmit -p tsconfig.json` | **PASS** (exit 0, clean) |
| Backend — passport core (9 files) | `node --test` passportProjection, passportViewerContext, passportSharedContext, passportJourneys, passportTravelIdentity, passportTravelDnaWrite, passportContributions, availability, openToPlans | **105 pass / 0 fail** |
| Backend — stamps/trust/memory (13 files) | trust, trust-integration, stamps, stampAwardEngine, unifiedStamps, universalStamps, passportStamps, passportStampsCountFallback, passportStampsPagination, passportProfileAccess, passportStatsFromTripCompletion (+2 live-DB) | **274 pass / 0 real fail** |
| Backend — memory/blocking (6 files) | memories, memoriesBlockFailClosed, sharedMoments, blocks, blockExclusion, interactionPermissions | **123 pass / 0 fail** |
| Client | `cd travel-buddy-standalone && npm run check:all` | **ALL CHECKS PASSED** (exit 0) — tsc + lint + jest **395 suites / 2152 tests pass** |

**Total passport-relevant backend node:tests: 502 pass, 0 real failures.**

**Note on the 2 "failed" files.** `passportStampSelfVerification.test.ts` and
`passportMemorySelfVerification.test.ts` are **live-DB suites deliberately kept
out of the curated `npm test` list** (run only by `test:passport-stamp-verify` /
`test:passport-memory-verify` in the sanctioned live-DB CI job). They `import
"../lib/ciSupabaseGuard.mjs"`, which refuses at import time when
`KNOWN_PROD_PROJECT_REF` / `CI_SUPABASE_PROJECT_REF` are unset — i.e. in any
environment other than the guarded CI job. This is an environment guard against
pointing tests at production, **not a construction defect**. Confirmed
`package.json.scripts.test` contains neither filename.

---

## 2. Surface-by-surface verdict (TABLE 2)

| # | Surface | Verdict | Evidence |
|---|---------|---------|----------|
| 1 | Passport Home | **PARTIAL** | Owner tab `app/(tabs)/passport.tsx` (hero `:709`, Open-to-Plans chip `:727`, trust summary `:642`, stats `:730`, owner actions via `PassportQuickLinks`, recent stamps `:824`, memories tab). Gaps: §3 "high-priority previews" for **Shared Context / Featured Journey / next Trip** not surfaced on home; **Make a Plan** absent from viewer view (`app/passport/[username].tsx`). |
| 2 | Stamps | **BUILT** | `PassportProjectionService.mapStamp`; client `PassportStampCollection.tsx`, `StampCard.tsx`, `StampDetailModal.tsx`. Card lacks a verified/decorative marker (§12 latent — see Findings F2). |
| 3 | Journeys | **BUILT** | `PassportJourneyService.ts` (group year→country→city `:308`, Featured Journey `:281`, visibility `:101`, date coarsening `:195`); client `JourneysScreen.tsx`, route `app/passport/journeys.tsx`. |
| 4 | Memories | **BUILT (owner) / PARTIAL (viewer)** | `PassportMemoryService.ts` + `MemoriesTab.tsx`. Public passport passes `memories={[]}` (`app/passport/[username].tsx:481`) — a visitor's Memories tab is empty though the projection filters memories server-side. |
| 5 | Plans | **BUILT (owner) / PARTIAL (viewer)** | `PlansScreen.tsx` (per-plan visibility `:57`, trip overlap + Connect `:146`); projection `buildUpcomingPlans` (§16 per-plan). Public passport passes `trips={[]}` (`[username].tsx:482`). |
| 6 | Availability | **BUILT** | `OpenToPlansService.ts` + `AvailabilityScreen.tsx` (§7 explicit-only `:296`, weekly grid, intents, group/travel/social). |
| 7 | Trust & Credentials | **BUILT** | `buildTrust` + `TrustPrivacyGuard`; client `TrustScreen.tsx` (domain rows, confidence band, capability chips, no report counts). |
| 8 | Travel Identity | **BUILT** | `PassportTravelIdentityService.ts` (Show/Hide/Not-Me); `TravelIdentityScreen.tsx`. Client persistence unwired (Findings F5). |
| 9 | My World | **BUILT** | `PassportMapService.ts` (coarse city/country only); `MyWorldScreen.tsx`, route `app/passport/my-world.tsx`. |
| 10 | Shared Context | **BUILT but ORPHANED** | `SharedContextService.ts` + `SharedContextScreen.tsx` fully implemented; route registered — but **no `router.push` anywhere** reaches it (Findings F1). |
| + | Share / QR / Bump | **BUILT** | `passportQrProjection.ts` (minimal allow-list), `PassportQrSheet.tsx` (two-step Bump), reachable via QuickLinks. |

---

## 3. Phase-by-phase verdict (TABLE 31)

| Phase | Scope | Verdict | Evidence |
|---|---|---|---|
| 1 — Identity Foundation | Shell, hero, identity, verification, stats, privacy | **BUILT** | `buildIdentity`/`buildStats`; server-side privacy filtering in `buildPassportProjection`. |
| 2 — Travel Identity | Stamps, Journeys, Memories, My World | **BUILT** (public-viewer Memories/Plans partial) | UnifiedStampService, JourneyService, MemoryService, MapService + client screens. |
| 3 — State & Availability | Current city, Availability, Open to Plans, temporary intent | **BUILT** | `buildTravelerState`, `buildAvailability`, `OpenToPlansService` (§7/§8/§31), migration `2260`. §8 windows flag-gated OFF. |
| 4 — Trust | Trust summary, credentials, domain trust, capability projection | **BUILT** | `buildTrust`, `TrustPrivacyGuard`, `buildOwnerCapabilities`/`buildViewerActions`, `TrustScreen`. |
| 5 — Shared Context | Mutuals, overlap, availability intersection, Trip overlap | **BUILT (backend) / PARTIAL (unreachable UI)** | `SharedContextService` complete + tested; client screen orphaned. |
| 6 — Real-World Action | Make a Plan, Compass integration, Trip invitations | **PARTIAL** | `compassHandoff` seed + `can_make_plan` capability + `PlansScreen` Connect exist; "Make a Plan" not on Home/viewer, Compass link is a handoff seed only. |
| 7 — Reputation | Contributor identity, host reputation, expertise | **BUILT** | `PassportReputationService` (paid excluded, no follower-count), `ContributionCard`, TrustScreen contributions. |
| 8 — Sharing | QR Passport, Bump Passport, temporary event Passport | **PARTIAL** | QR + affirmative Bump BUILT; **temporary event Passport** not found. |
| 9 — Intelligence | Travel DNA, yearbook, deeper Experience Graph | **PARTIAL** | Travel DNA BUILT (inference + Show/Hide/Not-Me, migration `2261`); **yearbook / deeper Experience Graph** not built as passport surfaces. |

---

## 4. Hard invariants — verified

All file paths are under
`artifacts/api-server/src/` (backend) or `travel-buddy-standalone/src/` (client).

1. **One viewer-context projection, server-side privacy filtering (§4/§30; client never re-derives auth).**
   - Single aggregate assembler `services/passport/PassportProjectionService.ts:888` `buildPassportProjection`; all filtering applied before return.
   - Viewer context resolved from the **canonical** `resolveInteractionPermissions` engine (`:409`), not a passport-specific re-implementation.
   - Route resolves `viewerId` **server-side** from the bearer token via `getOptionalViewerId` (`routes/passport.ts:1461`, `:1478`, `:1505`), never a client-supplied identity.
   - Client renders server flags only: `usePassportPlans.ts:210` `canMakePlan: proj.actions.can_make_plan`; TrustScreen note `TrustScreen.tsx:346`. Grep for client trust-threshold policy (`trust > N`) found **none**.

2. **Exact location never ordinary Passport data; My World coarse (§5/§23/TABLE 25).**
   - `mapStamp`/`buildUpcomingPlans`/`buildTravelerState` expose only city/country; no lat/lng on any read.
   - `PassportMapService.buildStats` selects `country, city, visibility` only (`:127`); `buildMapPayload` city/neighborhood only.
   - `user_stamps` stores `lat`/`lng` as provenance (`StampAwardEngine.ts:333`) but **no read/projection/map path selects them** (grep confirmed).
   - **DEFECT FIXED (D1):** traveler-state `label` embedded the city even when the viewer lacked location context — see §5.

3. **Trust domain-specific + confidence-aware; capability projection not a universal auth number; no private report counts/moderation/safety history (§9–§11).**
   - `buildTrust` (`PassportProjectionService.ts:661`): evidence-derived `confidence` (`:670`), per-category `strengths`, numeric `score` returned **only** on `context==="self"` (`:687`).
   - `trust/TrustPrivacyGuard.getSafeTrustSummary` returns `publicLevel` + human `strengths`/`restrictions` + `onProbation` boolean with "no detail exposed" — **no report counts, reporter ids, or raw scores**; `isEventLlmSafe` drops `reporter_id`/`reviewed_by`.
   - Owner capabilities (`buildOwnerCapabilities`) and per-viewer actions (`buildViewerActions`) are booleans; the client does not infer authorization from any score.

4. **Availability §7 explicit-vs-inferred + §31 never-stale.**
   - `OpenToPlansService.isVisibleTo` (`:168`): an inferred (`plan_derived`) window is never visible to a non-self viewer; expired windows never returned.
   - `recordInferredWindow` pins `source='plan_derived'`, `visibility='private'` (`:270`).
   - **DB backstop:** migration `2260` `CHECK (source = 'explicit' OR visibility = 'private')` makes a non-private inferred window unrepresentable, with a POSTCONDITION assertion that the CHECK exists.
   - Expiry re-evaluated on every read (`effectiveExpiry`/`isExpired`); `routes/availability.ts` returns non-expired only.

5. **QR minimal fields + Bump affirmative exchange (§25).**
   - `passportQrProjection.buildQrProjection` is a closed **allow-list** of 6 fields; extra profile keys dropped (`:82`).
   - `buildQrPayload` encodes the deep link only — "scanning never bypasses privacy policy" (`:132`).
   - `PassportQrSheet.tsx` Bump is two-step: `startBump → 'awaiting'` then `confirmBump` fires `onBumpConfirmed` only after explicit "Confirm exchange"; proximity never reveals a profile.

6. **Blocking propagates (§24).**
   - Passport blocking is not re-implemented: it flows through the canonical `resolveInteractionPermissions`; a blocked/unavailable viewer collapses to a minimal `restricted` card (`PassportProjectionService.ts:916`) with all actions false. Covered by `blocks`/`blockExclusion`/`interactionPermissions` tests (123 pass).

7. **Non-goals honored (§34).**
   - No dating/compatibility/match score: `SharedContextService` emits explainable facts + a qualitative `summaryLabel` derived from fact count (`:368`), never a numeric compatibility %. Repo grep for `match_score|compatibility|dating` in passport code found only unrelated interest-category labels.
   - Not raw exact-location (see invariant 2). Not self-awarded verification: `StampAwardEngine` is server-side-only ("never trust client-supplied eligibility"); `PassportStampService.VerificationLevel` has no client `verified` path.

8. **Travel Identity user control (§19).** `filterTravelIdentityForViewer` hides `hidden`/`not_me` items from non-owners; owner keeps all to toggle back. `writeTravelDnaPref` is owner-scoped + fail-closed on the capability flag; migration `2261` adds RLS `auth.uid()=user_id`.

9. **Migrations additive/idempotent/guarded.** `2260` and `2261` use `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`, precondition + postcondition `DO $$` assertions, RLS enabled, feature flags seeded **OFF** (`open_to_plans_windows_enabled`, `passport_travel_dna_enabled`). They enable nothing on apply.

---

## 5. Defects found and fixed

**D1 — Traveler-state label leaked coarse city to viewers without location context (§5/§23). FIXED.**
`services/passport/PassportProjectionService.ts` `buildTravelerState` gated the
structured `city` field behind `showCity` (`isSelf || canSeeLocationContext`) but
built the human-readable `label` from the raw city — so a public viewer whose
owner had not shared location context received `city: null` **but**
`label: "Traveling · Da Nang"`. The projection test already asserted
`travelerState.city === null` for that viewer (`passportProjection.test.ts:173`);
the label was the un-gated leak.

Fix: compute a single `displayCity = showCity ? city : null` and derive both the
label and the field from it. Viewers without location context now read
`"Traveling"` with no city; permitted viewers still read `"Traveling · <city>"`.
Re-ran the 105-test passport-core suite: **all pass**. `tsc` clean.

No other construction defect met the "small + safe" bar; the remaining gaps below
require product/design decisions or non-trivial data plumbing and are documented
rather than half-built.

---

## 6. Findings (documented, not fixed)

Severity is construction-completeness impact, not runtime severity.

- **F1 · MED — Shared Context surface is orphaned.** `SharedContextScreen.tsx` +
  route `/passport/shared-context` are fully built and tested, but no `router.push`
  reaches them. §3/§17 want Shared Context as a viewer-relationship surface / Home
  preview ("YOU TWO"). Wiring an entry point is a UX-placement decision (belongs on
  the *other* traveler's passport / Home preview), so it is left for a targeted
  integration change rather than an unverifiable UI insertion here.

- **F2 · MED (latent) — Stamp verification provenance not enforced on read/card
  (§12/§13).** `mapStamp` (`PassportProjectionService.ts:745`) emits
  `verification: "verified"` for **all** unified stamps by source-table rather than
  reading the row's own `verification_level`; the `"reported"`/`"decorative"` enum
  states are currently dead. Client cards (`StampCard.tsx`,
  `PassportStampCollection.tsx`) show no verified/decorative marker (provenance text
  appears only in `StampDetailModal.tsx`). **Safe today** — there is no
  self-reported/decorative write path into `user_stamps`/`passport_stamps`, so no
  decorative stamp exists to impersonate a verified one. Threading
  `verification_level` through `UnifiedStampService` (both source reads) + the card
  is a design-laden change (v1 GPS vs v2 achievement verification mapping) and is
  documented rather than half-built.

- **F3 · MED — Public passport tabs render empty Memories/Plans.**
  `app/passport/[username].tsx:481-482` hardcodes `memories={[]}` / `trips={[]}`,
  while the Stamps tab self-fetches via `viewingUserId`. The projection already
  returns privacy-filtered `memories`/`upcomingPlans`; the fix is to plumb a
  viewer-scoped fetch into `MemoriesTab`/`TripsTab` (matching the Stamps pattern) —
  a data-integration change, not a one-liner.

- **F4 · MED — §32 telemetry not wired.** None of the spec's passport events
  (`passport_viewed`, `passport_shared`, `passport_qr_scanned`, `availability_set`,
  `trust_summary_viewed`, `shared_context_viewed`, `my_world_opened`, …) are emitted
  by any passport screen or route. The app has an analytics mechanism elsewhere;
  passport instrumentation is simply absent.

- **F5 · LOW — Travel DNA client persistence unwired.** The backend
  `PUT /passport/me/travel-dna` (`routes/passport.ts:1537`) + `writeTravelDnaPref`
  exist and are tested, but `TravelIdentityScreen.tsx` is local-only and its comment
  ("no write endpoint yet") is **stale**. Because `passport_travel_dna_enabled` is
  seeded OFF, the endpoint would return `feature_disabled` anyway; wiring it is
  deferred until the capability is enabled.

- **F6 · LOW — Dual availability surfaces.** The owner passport chip pushes
  `/availability` (legacy `AvailabilityStore` quick-status screen) while QuickLinks
  pushes `/passport/availability` (the §7/§8 editor). They write to different
  backends; consolidating is a product decision, not a safe redirect.

- **F7 · LOW — Viewer actions on the public passport gate on `isAuthed`, not the
  server `can_message`/`can_view_*` capability flags.** No client-side trust math is
  performed (so §30 is not violated), but the public view does not consume the
  projection's capability block for Follow/Message.

- **F8 · DESIGN DEVIATION — §27 "dark-mode first" not met.** Passport surfaces use a
  static **light "paper"** palette (`theme/tokens.ts`, `theme/passportTokens.ts` —
  cream/white "passport paper"), not the spec's deep navy/black dark-mode-first
  system with purple/gold/green/blue accents. This is a coherent alternative (the
  physical-passport-paper metaphor) and does not affect function, but it is a
  literal deviation from §27 and colors are correctly paired with text/iconography
  (§27 last line) — verification pills, availability check+label, trust standing
  pills all carry text.

- **F9 · LOW — Phase 8 event Passport & Phase 9 yearbook/Experience-Graph not
  built** as passport surfaces (temporary event Passport, yearbook). Travel DNA (the
  bulk of Phase 9) is built.

Additional low/cosmetic notes from the read-through: `filterStampsV2` relies on
callers to exclude `metadata` from non-owner responses (not enforced in the guard);
`PassportMapService.verificationRank` omits `unverified` explicitly (cosmetic to a
"best verification per city" upgrade).

---

## 7. Runtime QA — cannot be certified by construction

The following require a real device/runtime and were **not** verified here; they
are out of scope for a static construction pass and should be checked before GA:

- **On-device rendering & layout** of all 10 screens on iOS + Android (hero overlap,
  glass effects, stamp perforation art, safe-area insets, tab reordering).
- **Device accessibility:** VoiceOver/TalkBack labels, focus order, dynamic-type
  scaling, and the §27 "color never the only status indicator" rule as experienced
  by a screen reader (statically the pairing is present; the lived a11y tree is not
  verified).
- **P95 latency & caching (§31):** short-TTL availability/state/trust projections vs
  cached identity/stamps; that stale availability is never rendered as current under
  real network conditions and clock skew.
- **Real push / booking / Compass hand-off:** `make_plan_started` → Compass →
  Telegraph end-to-end; `compassHandoff` consumed by a live Compass instance.
- **Live-DB RLS behavior:** the two `*SelfVerification` live-DB suites
  (`test:passport-stamp-verify`, `test:passport-memory-verify`) must be run in the
  sanctioned CI live-DB job — they are guard-refused outside it and were not
  executed in this pass.
- **QR scan round-trip:** scanning a real code resolves through server-side privacy
  re-projection (verified in code; not exercised against a camera + live API).
- **Flag-gated capabilities:** `open_to_plans_windows_enabled` and
  `passport_travel_dna_enabled` are OFF; the window CRUD and DNA persistence paths
  are built + unit-tested but have not run against a live enabled environment.

---

## 8. Final construction assessment

**~92% construction-complete.**

Justification (assessed by construction, not by usage/data, per project policy):

- **Backend ~97%.** The projection engine, privacy guard, trust projection,
  availability/open-to-plans domain, shared context, travel identity, unified
  stamps, journeys, memory, map and reputation are all built, enforce every hard
  invariant server-side, and pass 502 targeted node:tests with a clean `tsc`. One
  active leak (D1) was found and fixed; one latent hardening item (F2) is
  documented. Migrations are additive/idempotent/guarded.
- **Client ~86%.** All 10 surface screens + Share/QR exist, are routed, and pass
  the full `check:all` (2152 jest tests). The deductions are real integration/
  navigation gaps (F1 orphaned Shared Context, F3 empty public Memories/Plans,
  §3 Home previews / Make-a-Plan, F5 DNA persistence), the §27 dark-mode design
  deviation (F8), and absent §32 telemetry (F4).
- **Phases:** 1, 2, 3, 4, 7 BUILT; 5 built-but-unreachable UI; 6, 8, 9 PARTIAL.

The hard privacy and authorization invariants — the load-bearing ones for a
"portable human identity layer" — are **all satisfied and enforced on the
server**. The remaining ~8% is UI integration, one design-system choice, and
instrumentation, none of which are silent correctness failures. Passport is
certified as **construction-complete for its core with the findings above tracked
for closure before GA.**
