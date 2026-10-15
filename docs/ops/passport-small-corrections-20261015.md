# Passport small correction findings

Reviewed 2026-10-15 against detached head `5fad1c98c91bc783b2a12cefbb759f61e4d190f7` in
`/Users/areyouok/portava-sandbox/wt-codex-passport-small-20261015`.
The parent reports #759 merged at `5b2a20fdaaafb6805467b4284ae2ac2e63ccdf70` with the same tree.
No rebase, merge, commit, push, database access, migration application, flag change or new agent.
All edits are uncommitted and confined to this checkout. Shared dependencies are symlinked read-only
in use; no package installation, dependency edit or shared cache write was performed.

## Per ID disposition

| ID | Disposition | Exact remaining requirement |
|---|---|---|
| P42 | Already built but blocked, for the Passport supply/Compass portion; W unchanged | The owner must lift the Discovery content-ranker hold before that lane builds and tests an explicit-intent term weighted above generic interest. Alternatively the owner may explicitly narrow the requirement to people-ranking surfaces; this is a scope decision, not an engineer's inference. Discovery's term is not claimed built. |
| P61 | Already built but blocked; W unchanged | Owner-controlled verification/application of 2880 then 3800 in isolated beta, all four gates listed below, an eligible verified visit, and deployed/device proof. The separate per-traveller protected-place gap remains unresolved and is not waived. |
| P77 | Unresolved; W unchanged | Establish the authoritative consent-bearing association between the legacy Passport scrapbook and canonical Memories, or approve a canonical-feed replacement with legacy parity and revocation/deletion handling. Then reuse the existing audience/participant policy, project into the client DTO and implement/test People. No participant link or visibility was guessed. |

No assigned ID is claimed code-corrected. The bounded correction is documentary: P61's activation
inventory omitted two upstream gates. The new regression proves those omissions are detectable.
Passport remains 169 rows: C 165, W 3, N 0, X 1.

## P61 complete path

- `hidden_gems_enabled`: verify-visit route entry.
- `hidden_gem_verification_enabled`: verify-visit route entry.
- `hidden_gems_passport_enabled`: before the Passport side effect.
- `passport_place_stamps_enabled`: inside `awardPlaceStampForCheckin`.

The checked-in beta policy lists the first three ON and the last OFF. These are repository values,
not a fresh measurement of any environment and not permission to change them. 2880's predecessor
preconditions and 3800's vocabulary/index preconditions still apply. The sole producer requires a
successful, non-suspicious GPS check-in at an active hidden gem with a canonical place ID. Platform
protected-zone policy and the traveller's visibility preferences must be readable. Tests prove
deduplication and non-owner venue/neighborhood redaction, not real deployment or device behavior.
No per-traveller designated protected-place store exists in this path; D-84/OD-MAP-3 cannot be
fully certified without resolving that gap. Place QR and canonical-place plan-geofence producers
are also absent, as the existing census already records.

## P77 evidence and implementation boundary

- `docs/specs/Portava_Passport_Engineering_Architecture_and_Design_Spec.txt` section 15 requires
  Trips, Places, People, Timeline and Map; the four-view component is still mounted on the owner
  Passport at `travel-buddy-standalone/app/(tabs)/passport.tsx`, in the Memories section.
- `artifacts/api-server/src/services/passport/PassportMemoryService.ts` reads `passport_memories`;
  `artifacts/api-server/src/routes/passportStamps.ts` serves that collection. The client
  `PassportMemory` type and mapper have no participant field.
- `artifacts/api-server/baseline/20260819_baseline_structure.sql`, constraint
  `memory_tags_memory_id_fkey`, targets `public.memories(id)`, not `passport_memories(id)`.
  The manual/GPS/geofence/gem/safe-return Passport writers establish no canonical Memory link.
  `source_id` is optional text, not evidence that a canonical Memory with that ID owns these tags.
- `artifacts/api-server/src/services/memory/memoryParticipantVisibility.ts` already contains the
  consent/block/crew/name ladder. The missing association is distinct from missing privacy logic.
  Trip membership, a matching UUID, or co-location cannot substitute for Memory participant consent.
- The separate `PassportMemoryProjection` registration consumes canonical `memories` and
  `memory_items`, has no participant field, and is not what the Passport scrapbook route serves.
  Adding people only there would not implement the mounted People view.
- The Memory spec sections 5, 10, 18, 22 and 23 require consent, audience-scoped projections and
  revocation; section 22 explicitly forbids fabricated participant links during backfill.

## Ownership and existing work

Read the canonical P42/P61/P77 records from the shared backlog CSV without changing it. Read the
latest relevant Passport census sections, the underlying specs, `FLEET.md` and
`OWNER-DECISIONS-20261014.md`. No applicable AGENTS.md was found in the checkout or ancestor paths.
Read the Supabase and documentation-writing skills; no schema or Supabase feature was changed.

Swept file lists for all 44 open PRs before editing. Relevant overlaps: #736's canonical participant
ceiling, #739/#748's Memory people/block work, #751's shared-anchor client, #750/#752's shared
projection changes, and #521's already-present Memories unreadable-state changes. None supplies
the Passport scrapbook association. #748 owns census section 36, so this evidence uses section 37.
No shared Memory source-registry, canonical participant-policy, parent, Claude or other-worker file
was edited. The parent retains CI, merging and Wall ownership.

## Focused verification

All tests used one worker, sequentially. No full app typecheck, full test suite, live-DB test or CI run.

- API: 93 tests passed across `passportConsumerProjections.test.ts`, `passportPlaceStamp.test.ts`,
  `passportStampPlaceVocabulary.test.ts` and `memoryParticipantLadder.test.ts` under
  `artifacts/api-server/src/test/`. Command, from the API directory:
  `TSX_DISABLE_CACHE=1 SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=offline-test node --import tsx/esm --test --test-concurrency=1 src/test/passportConsumerProjections.test.ts src/test/passportPlaceStamp.test.ts src/test/passportStampPlaceVocabulary.test.ts src/test/memoryParticipantLadder.test.ts`.
- Client: 6 tests passed in `travel-buddy-standalone/src/components/__tests__/MemoriesTab.fourViews.component.test.tsx`.
  Command, from the standalone directory:
  `EXPO_NO_TELEMETRY=1 node node_modules/jest/bin/jest.js --runInBand --no-cache --watchman=false --runTestsByPath src/components/__tests__/MemoriesTab.fourViews.component.test.tsx`.
- Red first: the new P61 checklist regression fails against the original census because
  `hidden_gems_enabled` is missing from the activation evidence.
- Mutation: removing the second newly documented flag makes the same focused case fail on
  `hidden_gem_verification_enabled`. The mutation was restored.
- Census integrity, scope coverage, row-move labels and citation checks passed. Their existing
  citation-debt ceilings remain limitations, not proof of semantic correctness. `git diff --check`
  passed. The canonical parser still reports P42/P61/P77 as W.

## Self review

Reviewed the entire diff and underlying call chain. No runtime behavior, audience, consent or
deployment gate changes. The new test is a source/document inventory regression, not a replacement
for runtime route or device proof. Existing service and participant-ladder tests retain their own
scope; a passing People-absence test does not mean P77 is implemented. Existing citation anchors
were preserved by appending the test and census section. No independent agent review was requested.

## Exact changed paths

1. `artifacts/api-server/src/test/passportPlaceStamp.test.ts` — appends the upstream-gate inventory regression.
2. `docs/architecture/census-passport.md` — section 37, current blockers and complete activation path; no grade changes.
3. `docs/ops/passport-small-corrections-20261015.md` — this evidence and handoff report.
