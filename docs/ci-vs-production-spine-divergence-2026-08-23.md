# CI-vs-production spine divergence

**Status: DOCUMENTATION ONLY. Nothing here was applied.** This records what
diverged, how it's known, and a proposed apply order for the owner to approve
or amend — it does not execute anything against either database.

**Audience:** whoever decides what gets applied to portava-ci and production,
and in what order.

---

## 0. The fact that shapes everything

Neither `origin/main` (the canonical migration tree) nor either live database
currently matches the other two. Three independent migration chains exist in
git, and each has been applied to at most one of the two databases:

| Chain | Migrations | On portava-ci | On production | In `origin/main` |
|---|---|---|---|---|
| Journey (observation/privacy/shadow rollout) | 2103, 2119, 2124–2127 (renamed 2026-08-23 from 2120–2123) | **No** — zero journey tables | **Yes** — all 9 tables live, applied 2026-08-21 | **No** — lives only on `fix/rls-hardening-signin-flake` |
| Canonical events / source registry / freshness policies | 2120–2123 (main's numbering) | **Yes** — verified live 2026-08-23 | **No** — absent, verified live 2026-08-23 | **Yes** — merged via #104/#105 |
| Intel (retention sweep, IG-02) | 2128–2133 | Read-only verified compatible (dependencies present); not yet created | **No** | **No** — PR #106 open, unmerged |

The journey/canonical-events collision (both chains independently claimed
2120–2123) is resolved in git as of this document — see
`docs/migrations.md` § "2026-08-23 — Journey files renumbered." That fixes
the git tree. It does not touch either database, and does not change the
fact that each database is still missing an entire chain the other has.

**How this was verified (2026-08-23):** live read-only queries against both
projects — `canonical_events`, `sources` (not `source_registry` — the table
is named `sources`; querying `source_registry` gives a false negative),
`external_place_references.source_id`, `freshness_policies`, and
`canonical_event_families` present on portava-ci and absent on production;
nine `journey_*` tables (`journey_observations`, `journey_retention_health`,
`journey_revocation_jobs`, `journey_segment_revisions`,
`journey_shadow_cohort_assignments`, `journey_shadow_ground_truth`,
`journey_shadow_qa_reports`, `journey_shadow_session_issuances`,
`journey_shadow_stages`) present on production and absent on portava-ci.
`places` is confirmed 0 rows on production (2026-08-23, read-only); portava-ci's
`places` row count was not checked as part of this document.

## 1. What must not happen

- Applying the canonical-events chain to production, or the journey chain to
  portava-ci, **without first re-verifying against the live schema at apply
  time** — this document is a snapshot, not a live source of truth. The
  project's own convention (`docs/migrations.md`'s top warning) is explicit
  that "applied" claims in written records are not authoritative.
- Applying any chain to production from an environment that isn't scoped for
  it. This document was researched from a Replit shell whose ambient
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` point at production
  (`ajrurzioarfkagpuxfnb`) — read-only checks are fine there, writes are not,
  per standing guardrail.
- Assuming the intel chain (2128–2133) is safe to apply to production just
  because it was read-only verified compatible against portava-ci — that
  check confirmed its *dependencies* exist on CI, not that the chain has ever
  actually been run anywhere. PR #106's own commit says plainly: "Still
  nothing applied to any database."
- Merging PR #106 or the journey branch to `main` and treating that as
  equivalent to applying to either database — merging updates the canonical
  tree; it does not touch either Supabase project.

## 2. Proposed apply order

Ordered so that later steps' prerequisites are satisfied by earlier ones, and
so CI is verified before anything touches production — matching the
project's established "stage through CI first" pattern.

1. **[OPERATOR] Apply the canonical-events chain (main's 2120–2123) to
   production.** This is the one item flagged as a genuine pending-production
   gap independent of anything else in this document: the chain is already
   merged to `main` and applied to CI, so this closes a known gap rather than
   deciding anything new. It has no dependency on the journey or intel chains.

2. **[OPERATOR] Open a PR merging the journey migrations (2103, 2119,
   2124–2127, now pushed on `fix/rls-hardening-signin-flake`) to `main`.**
   Brings the canonical tree in sync with what has been live on production
   since 2026-08-21. The rename in `docs/migrations.md` already documents
   why the numbers moved; nothing else about the files changed (361 tests
   passing, confirmed 2026-08-23).

3. **[OPERATOR] Apply the journey chain to portava-ci**, after step 2 merges.
   Brings CI in sync with production for this chain. Re-run the same
   live-presence check used in §0 afterward to confirm.

4. **Merge PR #106 (intel: retention sweep, end-to-end pipeline test,
   migration verification) to `main`**, once its own review lands. It
   depends on `freshness_policies`/`feature_flags` from the canonical-events
   chain, which step 1 will have made live on production and which already
   exists on CI — so this can proceed independent of steps 2–3.

5. **[OPERATOR] Apply the intel chain (2128–2133) to portava-ci first**,
   verify with the project's own test suite and a live-schema check, then to
   production. This is the first time this chain would be *applied* anywhere
   — treat it with the same rehearsal-before-apply discipline the journey and
   canonical-events chains already went through, not as a formality.

6. **`places` backfill from `discovery_places`** (`src/scripts/backfill-places-from-discovery.ts`,
   added 2026-08-23) is independent of the above — it only needs the `places`
   and `external_place_references` tables and `external_places_enabled`,
   all of which already exist on both projects. Run it on portava-ci first
   (dry-run by default; `--apply` to write), per standing instruction not to
   run it against production without a separate explicit decision. A
   read-only check against production (2026-08-23) found 184 `discovery_places`
   rows, 160 with usable lat/lng, 24 missing coordinates (mostly landmark/POI
   rows with no coordinate capture — sample recorded in the script's own
   dry-run output), `external_places_enabled` already on, and `places` at 0
   rows. The created-vs-linked split is only known once `--apply` actually
   runs, since it depends on live dedup state.

## 3. Open items this document does not resolve

- **QA account for real-login testing** — credential creation is an owner
  action, out of scope here.
- **Whether `places` should also be backfilled from `fsq_places`** via the
  existing `backfill-canonical-places.ts` — that script and the new
  discovery-sourced one are complementary (different provider, disjoint
  `provider_place_id` namespaces via the `(provider, provider_place_id)`
  unique key), not competing; both can run without conflicting with each
  other. Not sequenced here because neither was asked for beyond the
  discovery-sourced backfill.
- **Whether step 5's intel-chain apply to production should happen at all
  before IG-03's lawful-basis decision (D4)** lands — that's a product/legal
  call, not a migration-sequencing one, and is explicitly the owner's per the
  standing handoff notes.
