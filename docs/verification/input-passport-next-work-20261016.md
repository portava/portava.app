# Input / Passport — exact next-work queue, 2026-10-16

## Status and authority

Parent: `/Users/areyouok/portava-sandbox/wt-codex-discovery-completion-20261015`.
Read at HEAD `324ed0dd2b61371afc6f20a5a843f89406b57cc8`, including current uncommitted work.
Source references below are repository-relative to that parent; symbols accompany line numbers.
**No verdict changes. No bounded, unconditional full-closure assignment is established here.**
The parent accepts that distinction. Build authorization does not authorize changing owner contracts.
This is a persistent next-work queue, not another historical audit or a deployment-readiness claim.

Canonical source: from `artifacts/api-server`, run
`CENSUS_INTEGRITY_DUMP=W node --import tsx/esm src/scripts/checkCensusIntegrity.ts`.
The executed dump returned **43 Input W + 3 Passport W** (894 W across thirteen censuses).
The parser's last-statement result selects the rows; later qualifying prose and actual source determine the gap.
Board: `docs/verification/main-architecture-correction-board-20261016.md`.

## 1. G160 — timed itinerary import: closest code gap, incomplete closure contract

- Canonical row: `docs/architecture/census-input-intelligence.md:5306`, §34.2.
- Complete example: `docs/specs/Portava_Global_Input_Intelligence_Architecture_Developer_Spec.txt:256`:
  Friday / Dinner at 7 / Rooftop at 9 / Club around 11 → review → three Trip stops.
- Classification already preserves day/time hints:
  `artifacts/api-server/src/lib/inputAssistance/pasteExtraction.ts:472#export function classifyPaste(`.
- The mounted review displays them, but its accepted destination model discards them:
  `travel-buddy-standalone/src/platform/input-assistance/paste/PasteReviewSheet.tsx:229` and
  `travel-buddy-standalone/src/platform/input-assistance/paste/pasteReview.ts:159#export function acceptedDestinations(`.
- Executed read-only probe: one resolved-place fixture with `dayLabel: 'Friday'`, `timeHint: '7pm'`
  returned a destination carrying neither day nor time. This was a pure-model probe, not a full test suite.
- An existing time-capable target exists:
  `travel-buddy-standalone/src/features/trips/planning/tripPlan.ts:27#export interface CreatePlanItemPayload`
  accepts `dayDate` / `startsAt`;
  `travel-buddy-standalone/src/features/trips/planning/tripPlan.ts:112#export async function createPlanItem(` uses the existing endpoint.
- **Decision boundary:** generic itinerary labels need not resolve to catalog places. PR-D2-7c requires
  unmatched lines to be dropped: `docs/architecture/census-input-intelligence.md:7624` and
  `artifacts/api-server/src/lib/inputAssistance/pasteExtraction.ts:700#export function echoOnlyResolved(`.
  Do not assume an approved manual-item fallback or weaken that rule. Importing only resolved venues with
  times is useful partial work, not proof of the complete example. This note grants no new policy exception.
- **Return trigger:** settle how the complete example is represented while preserving paste privacy.
- **Then scope:** itinerary-specific review model/sheet, mounted Trip-plan entry and existing plan transport;
  shared classification/resolution, explicit date and ambiguous-clock confirmation, no new schema/provider.
- **Required tests:** complete three-stop example; zero writes before confirm; chosen rows only; ambiguous
  dates/AM–PM refused until clarified; partial failures and retry; cancellation/Trip switches; existing
  catalog-only, booking-redaction and unmatched-echo controls unchanged. No actual Trip writes during tests.

## 2. G361 — Trip-dependent prefetch: proposed design is not approved closure

- Canonical row: `docs/architecture/census-input-intelligence.md:3065`; current qualification is §45.5 at
  `docs/architecture/census-input-intelligence.md:8255` (six of seven steps).
- Generic prefetch is already built; only Gem → Neighbourhood is declared:
  `travel-buddy-standalone/src/platform/input-assistance/services/prefetch.ts:53#export const FIELD_DEPENDENTS`.
  `travel-buddy-standalone/src/platform/input-assistance/services/prefetch.ts:60#export function zeroStateCacheKey(` has no Trip/session identity.
- `trip.stop.place` remains registered/unmounted:
  `travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts:293`.
- **Return trigger:** resolve proposed W-IF-1 / A-3's mounted Trip-stop flow and Trip-scoped cache contract.
  Do not prefetch before a Trip exists or call another generic helper a closure.
- **Then scope:** Trip-stop mount, dependent-field declaration, matching cache read/write identity and
  prefetch after the existing Trip is known; preserve privacy/non-cacheable field rules.
- **Required tests:** mounted next-field first-open cache hit; cold control; different Trips/accounts;
  context changes and late replies; unavailable/private answers never populate the wrong cache.

## 3. G134 — Save / Start directions: explicit action-contract hold

- Canonical row: `docs/architecture/census-input-intelligence.md:619`; the corrected current count is
  three of five at `docs/architecture/census-input-intelligence.md:6886` (§42.20).
- Add to Trip, Ask Compass and Open Map already dispatch in `travel-buddy-standalone/app/search.tsx:497`.
  Save and directions are absent from
  `travel-buddy-standalone/src/platform/input-assistance/types/suggestionAction.ts:18#export type SuggestionAction`.
- **Return trigger:** the owner resolves PR-D2-6's no-contract-extension hold for these two actions
  (`docs/architecture/census-input-intelligence.md:6835`, §42.19). The separately added `trip_action`
  does not imply general permission to invent more action types.
- **Then scope:** both producers, action/capability contracts and mounted search dispatch, using existing
  target authorization. Test both complete paths, refusal/cancel, unsupported clients and the existing three.

## Broader implementation is different from an external gate

- **G6 / G16:** genuine cross-app engine convergence, not exclusively deployment-blocked. The current
  shrink-only detector names thirteen engines, not the historical three/four:
  `travel-buddy-standalone/src/platform/input-assistance/services/__tests__/noIndependentEngines.test.ts:98#const KNOWN_ENGINES`.
  A one-hook migration cannot close either row. A separately scoped full migration must preserve each
  surface's privacy, fallback and target behavior, with mounted tests and the detector's exemptions shrinking.
- **G18:** all meaningful fields must register and mount their context. The current inventory is **26 fields:
  14 mounted / 12 registered_unmounted**, after the accepted Event location slice below; the old 8/24 header
  is historical. One mount is partial: full closure still needs meaningful-field coverage and policy parity.

## Passport and next-turn instruction

- **P42:** do not rebuild existing intent supply/ranking. Preserve the explicit remaining owner hold.
- **P61:** protected-place contract plus schema/activation/device proof, not another stamp helper.
- **P77:** authoritative scrapbook → canonical Memory association, not guessed UUID/Trip/participant joins.
  Exact current rows and prerequisites: `docs/architecture/census-passport.md:2845`, §37.1–§37.3.
- Do not redo Input structured-value, event-link, party-size or overnight fixes already integrated/reviewed.
- Next turn: check only a selected row's canonical result and named return trigger. If unchanged, rotate
  elsewhere for a bounded full-closure task; do not repeat the forty-three-row triage or regrade a partial fix.
- Preserve Compass and the separately owned Telegraph translations, Memories deletion and Trips risk work.
  No code, flags, dependencies, hosted/beta actions or verdicts change in this documentation reconciliation.

## Accepted bounded Event location connection — 2026-10-16

- `event.location` is no longer a missing mount on the actual `/events/create` wizard.
  Its existing picker declares `event_location` and the registered field ID:
  `travel-buddy-standalone/app/events/create/index.tsx:1001#assistContext="event_location"`.
  Only that inventory record changed:
  `travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts:305#fieldId: 'event.location',`.
  The separate EventComposerSheet remains outside this connection.
- The existing server venue binding now survives the client adapter, including known city/country,
  venue coordinates and timezone. No subtitle inference or city-ID/centroid substitution; missing facts
  stay unknown, canonical replacement clears stale point/zone, and typed city/country conflict confirmation
  remains explicit. The form's local owner/target/lifetime fence does not certify earlier shared-picker
  resolution, recents, selection-memory or prefetch side effects.
- Accepted evidence: 32 new mounted cases inside 76 client cases/seven suites; 76 node controls include
  actual server projection into the mapper. Independent review added 19 passing lifecycle/JSON/selection
  probes. These counts overlap; selected-file types and existing guards passed. Existing neighbor teardown
  and private-fixture warnings remain disclosed. See census Input §49 for source anchors and full limits.
- No private draft/Trip/circle context added to Input, no new provider/permission/policy, and no new draft
  write behavior. General autosave/account safety, draft reload, published-event timezone persistence and
  real-device/provider proof are not established. G6/G16/G18 remain W; no other row moves.
- Do not rebuild this accepted connection. The next read-only choice is one actual remaining unmounted
  field or a reproducible shared-picker side-effect lifetime defect. Require current consumer proof and
  an exact proposed write set before implementation; no speculative transmission/permission/provider
  expansion. G160/G361/G134's existing decision boundaries above are unchanged.
