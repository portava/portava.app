# Phase 0 foundation — buildout status (19 Aug 2026)

First foundational slice of the rollout blueprint's Phase 0 ("verified foundation"),
decomposed against the existing api-server. Code-level pieces are built on this branch;
environment/deploy/decision pieces are handed to Claude Code (Replit) below.

## Built here (this branch)
Three bedrock items, each a post-cutover canonical forward migration (prefix >= 2100) +
a lib module (30s-cache pattern from featureFlags.ts) + tests.

- **2101 source registry** — `sources` table (6-origin CHECK), `source_id` FK on the
  place/reference tables, deterministic fail-closed backfill; `src/lib/sourceRegistry.ts`
  (`resolveSourceId`, unknown -> null, never guesses). = blueprint "source registry".
- **2102 freshness policies** — `freshness_policies` table; seeds crowd=15m, vibe=30m,
  price=48h, structural=180d (owner-tunable defaults); `src/lib/freshnessPolicy.ts`
  (`isStale`/`expiresAt`, unknown -> stale). = blueprint "freshness policy by claim type".
- **2100 canonical events** — `canonical_events` append-only ingestion spine (9-verb CHECK;
  the 5-tuple live-output envelope columns source_count/freshness_seconds/confidence/
  privacy_eligible/expires_at; RLS deny-default + own-row SELECT + service-role INSERT;
  append-only triggers on UPDATE/DELETE/TRUNCATE, row+statement level, mirroring
  discovery_shadow_serves 2092/2093 and the 2093 grant fix); `src/lib/canonicalEvents.ts`
  (fire-and-forget writer; raw-GPS-key sanitizer + strict payload allow-list).
  = blueprint "canonical telemetry schema (append-only event ingestion)".

`database.types.ts` carries hand-added Row/Insert/Update stubs (regenerate after apply).
**The baseline and rlsDispositions.ts are DELIBERATELY UNCHANGED**: the baseline is the
immutable prod-at-cutover snapshot and the disposition ledger is bijected to it (387<->387);
new post-cutover tables enter both only at apply-time (below), never by editing the snapshot.

## Apply sequence (env-gated — owner / Claude Code, in order)
1. Apply migrations 2100, 2101, 2102 to the DB. They sort >= "2100" (post-cutover);
   `audit:schema` reports their objects missing-from-live until applied — expected.
2. Recapture the schema-only baseline from the live DB (now with the 3 tables), then
   regenerate `rlsDispositions.ts` via `parseBaselineSchema.ts` — keeps the
   baseline<->disposition bijection and `audit:live-unexplained` green with the new tables.
3. Regenerate `database.types.ts` from the live DB (replaces the hand-added stubs).
4. Wire producers behind flags (env-gated): emit `canonical_events` from instrumentation;
   stamp `source_id` on place writes; read TTLs from `freshness_policies`. Do not flip
   ingestion until the client no longer depends on any removed path.

## Remaining build-here roadmap (ordered; each builds on the three above)
Scaffold-only where an owner decision is embedded (no invented heuristics):
4. ✅ BUILT (2026-08-20, branch claude/phase0-wiring-20260820): Live-output envelope
   (`liveEnvelope.ts`) — composes source_count / freshness_seconds / expires_at from the
   source registry (2101) + freshness policies (2102). confidence and privacy_eligible are
   FAIL-CLOSED owner-decision seams (item 5 scorer / items 6-7 privacy), passed in and never
   invented here. + liveEnvelope.test.ts (14 tests, all green). Also registered the three
   phase0 tests (canonicalEvents/freshnessPolicy/sourceRegistry) that #94 left out of the
   package.json `test` script.
5. Claim/Observation/Verification/Contradiction (2106) — tables only; verification methods
   + contradiction resolution are OWNER decisions.
6. 🟡 PARTIAL (branch phase0-item10): k-anonymity MATH built — kAnonymity.ts
   (meetsKAnonymity / kAnonymize; the caller/owner supplies k, fail-closed below it; never
   invents the threshold). It is one input to item 4's privacy_eligible seam. + kAnonymity.test.ts
   (8 tests). DEFERRED: the sensitive-zone exclusion REGISTRY (2104) — owner data plus a
   geometry-model decision, left unmade rather than guessed.
7. Privacy ledger (2103 consent_grants + privacy_audit_events) — tables + recorder;
   retention durations + purpose vocabulary are OWNER decisions.
8. Retention policy + reaper (2107) — dry-run only; live deletion is owner-gated (irreversible).
9. Opportunity family (2105) — interfaces/stubs only; opportunity semantics are OWNER product.
10. ✅ BUILT (documented mapping — one line to change, branch phase0-item10):
    view `canonical_event_families` (2123, security_invoker=true so canonical_events' RLS is
    enforced for the querying role) tags each event exposure/action/outcome/satisfaction; grants
    mirror canonical_events (authenticated + service_role SELECT, anon nothing) via the 2093
    REVOKE-then-GRANT shape. src/lib/eventFamilies.ts holds the single verb->family map (the view
    CASE mirrors it; eventFamilies.test.ts pins it). MAPPING (owner-adjustable): impression=exposure;
    open/save/join/direction=action; arrival/completion/rejection=outcome; satisfaction=satisfaction.
    Auditor-safe: parseMigration folds the view into model.relations (schema-stripped), so
    audit:live-unexplained + audit:schema stay green after apply.
11. Ingestion trust-boundary tightening (2108) — flag-guarded; prod revoke env-gated on cutover.
12. ✅ BUILT (source_id provenance; freshness tie-in deferred, branch phase0-wiring):
    placeProvenance.ts — flag-guarded (`place_provenance_stamping_enabled`, a CAPABILITY flag
    auto-classified by the _enabled suffix; fail-closed) source_id stamp via resolveSourceId
    (2101), spread onto the three carrier-table writes (placeResolve -> external_place_references,
    discovery + wishlist -> discovery_places). A no-op {} spread until the flag is on AND the
    provider/source string resolves, so it is safe to ship dormant even on a DB where 2101's
    source_id column does not yet exist. + placeProvenance.test.ts (8 tests). NOTE: the
    freshness-policy (2102) tie-in is deferred — the place tables already carry
    last_fetched_at/last_verified_at, and mapping those to freshness_policies claim_types is an
    OWNER decision, not something to invent here.
13. Event Truth acceptance suite — scaffold; runs meaningfully only on live data.

## Pass to Claude Code (Replit — environment / decision bound)
- **A. Real-login QA** — owner creates a dedicated password QA account (credential entry is
  owner-only); author an e2e script through the genuine login endpoint (no token injection).
  Respect the $100 usage-credit stop during live QA.
- **B. Google SSO defect** — reproduce against the live OAuth flow; inspect redirect URI /
  client id+secret / callback in the deployed env (Google console owner-held). Do not accept
  provider consent screens on the owner's behalf.
- **C. Destination autocomplete (Google Places)** — scaffold behind the existing
  `external_places_enabled` fail-closed flag, ship disabled; needs a Places API key (owner via
  secret manager) + quota/billing.
- **D. Production surface** — API-only vs Expo/TestFlight is an owner ruling; if mobile, set up
  the build + distribution (respect the final-trigger preference for releases).
- **Producer-cutover follow-ons** (once scaffolds land): canonical_events dual-write + backfill
  + ingestion flip; DISCOVERY_ENGINE_MODE shadow->pde cohort rollout (owner presses the
  production toggle); privacy-ledger producer wiring + AccountDeletionService erasure;
  sensitive-zone registry population; retention reaper enable; compass_analytics client cutover.

Nothing here is applied or deployed. Migrations are applied by the owner in the env (never
from the Replit shell, which resolves to production).
