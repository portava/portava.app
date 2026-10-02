# Sensing — the one consolidated production approval request

Prepared 2026-09-26 on branch `claude/sensing-completion-20260925` (PR #528); section H rewritten 2026-09-27.
**Nothing below has been executed on production** (`ajrurzioarfkagpuxfnb`),
which has only been read. Every schema step has been applied and verified on
`portava-ci`. The step-by-step procedure is
`docs/ops/sensing-cutover-runbook.md`; this page is the decision the owner
takes, in the order it must be taken.

Four states, kept apart on purpose:

| State | Where this work is |
|---|---|
| Built on the branch | yes, all of it |
| Merged | no |
| Deployed | no |
| Flag enabled / realised in production | no |

---

## 1. What user consent permits today, and what `surface` would need

**Today nobody has consented to having their passive sensing shown to
anyone.** Every recorded consent is `intel_contributions_v1`. Its words, the
only words anyone has agreed to, describe Quick Signals: explicit taps
combined with other travellers' reports. They say nothing about the phone
sensing in the background, and nothing about showing passive contributions
to other people.

**Changing the policy constant alone does not establish consent, and on this
branch it cannot surface anything.** `SENSING_ANON_GRANTED_SCOPES` is the
owner's ruling on what the store may do. The code now carries, separately,
what each person agreed to:

- a session carries the intersection of the policy and its holder's recorded
  consent (`lib/sensingConsentScopes`), so under v1 no session is issued at
  all;
- each contribution records whether its own session carried `surface`
  (3315's `surface_permitted`, default `false`);
- the publisher counts only those contributions, so a cohort publishes only
  if at least k people who each agreed to be shown are in it.

**What would permit the proposed surface disclosure:** a person granting the
v2 disclosure (`docs/contracts/sensing-consent-disclosure-v2.md`), whose third
paragraph reads: *"When enough people are counted, other travelers may see
that people are around a place right now, or that it isn't known. Never how
many, and never who."* That permits one thing: a zone-level "people are here"
or "not known", after the crowd threshold and the differencing gate. It does
not permit a count, a band, a list or anything that singles out a person.
It covers only contributions made under sessions issued after that person's
own grant. Existing v1 holders are not migrated; each must grant v2 anew.

---

## 2. The approvals requested, in order

Each numbered item is a separate decision. A later item does nothing useful
without the earlier ones, and the code refuses in that order.

### A. Schema on production

Apply with `scripts/src/apply-migrations.ts` where the service-role
credentials exist, so the ledger row and checksum are the runner's.

| Step | Files | Window | Prerequisite | Verify (read-only; runbook §2) | Recover |
|---|---|---|---|---|---|
| A1 | `2277`, `2278` | any time | Q0 all sensing tables empty | ledger rows; their own sections in `docs/migrations.md` | their rollbacks |
| A2 | `3002 → 3003 → 3310`, then the code (B1) | **one quiesced window** | A1; identity runbook §4 steps 1–4 | identity runbook §6; Q2 `subject_nullable = YES`, `pepper` non-NULL | identity runbook §5a, only while Q0 is all-zero; never un-quiesce on a failed deploy |
| A3 | `3311` | before B1 | — | Q2 `provenance_cols = 2`; both GIN indexes | `db/rollback/2026-09-26-3311-…`, then its ledger row |
| A4 | `3312` | before the client release (B2) | — | Q2 `feature_checks = 3`; 15 nullable columns; 0 FKs | `db/rollback/2026-09-26-3312-…`, then its ledger row |
| A5 | `3004`, `3110`, `3313` | before any flip in C | — | Q3 each seed `false` **and** Q1 its ledger row (a flag seed is invisible to schema checks); `published_store` non-NULL | each seed's rollback; 3110's own section |
| A6 | `3314` | before `memory_projection` ON | Q2b shows 2195's body (read 2026-09-26: it does) | Q2 `claim_refs = _uuid`; the GIN index; Q2b md5 `c12a0ff3cf71a23373b03f025fb2a938` | `db/rollback/2026-09-26-3314-…` (refuses while any session memory exists) |
| A7 | `3315` | before `surface` (E) | — | Q2 `surface_col = boolean`; zero rows read `true` | `db/rollback/2026-09-26-3315-…` (refuses while any row reads `true`) |
| A8 | `2841` (seeds `experience_session_enabled` FALSE) | before F2's verification | none; it adds no table (sessions are two rows on the existing `canonical_events`, present on production) | Q1 its ledger row **and** the flag row reading `false` (read 2026-09-26: applied on portava-ci by CI; **absent on production**, no ledger row, no flag row) | its postcondition refuses a TRUE seed; delete the row and the ledger row |

### B. Code and client

| Step | Change | Prerequisite | Verify | Recover |
|---|---|---|---|---|
| B1 | Deploy the api-server from PR #528's merged head | inside A2's window; A3 before it | runbook §4 smoke: publisher logs `surface_scope_not_granted`; no `provenance_unavailable`; `POST /v1/sensing/session` answers the pepper refusal | roll back the deploy while still quiesced (identity runbook §5) |
| B2 | Ship the client build (capture loop, commitment, consent gate by version) | A4 | the installed client does not start capture under v1 consent | ship the previous build; the server accepts both shapes |

### C. Operator artifact

| Step | Change | Prerequisite | Verify | Recover |
|---|---|---|---|---|
| C1 | Set `SENSING_CONTRIBUTOR_PEPPER` in the production environment | A2 | the ingest and the issuer stop answering the pepper refusal; the issuer then answers `disclosure_does_not_cover_passive_sensing` for every account (expected until D) | unset it; both refuse again |

### D. Consent v2 — the owner's decision on words, then one release

| Step | Change | Prerequisite | Verify | Recover |
|---|---|---|---|---|
| D1 | Approve the v2 title, four paragraphs, footnote and settings summary in `docs/contracts/sensing-consent-disclosure-v2.md`, or supply replacements | — | the client module and the contract file carry the same words | — |
| D2 | Decide whether the settings switch may grant v2 from its one-line summary, or must open the full text first | D1 | — | — |
| D3 | One release: `INTEL_CONSENT_DISCLOSURE_VERSION = "sensing_contributions_v2"` in `lib/intelConsent.ts` together with a client carrying the D1 words | D1, D2, B2 | `GET /v1/intel/consent` returns `currentDisclosureVersion: sensing_contributions_v2`; a grant from an older client is refused 409; a new grant records v2 | revert the constant in one release; v2 grants already recorded stay recorded and keep their meaning |

After D3, people who choose to grant v2 get sessions with
`collect`, `retain`, `aggregate`. Not `surface`, until E.

### E. The `surface` scope — the policy change

| Step | Change | Prerequisite | Verify | Recover |
|---|---|---|---|---|
| E1 | Add `"surface"` to `SENSING_ANON_GRANTED_SCOPES` in `lib/sensingContributionPolicy.ts`, reviewed and deployed | A7, D3 | new v2 sessions carry `surface`; contributions under them read `surface_permitted = true`; v1 holders and pre-E1 contributions read `false` | revert the line and deploy; the publisher and producer refuse on the next call |

### F. Flags — exact values

Every flag below reads `false` or has no row on production today (read
2026-09-26; `experience_session_enabled`, `sensing_publication_enabled` and
`sensing_presence_context_enabled` have no row because 2841, 3313 and 3004
are not applied there). The two capture flags `intel_capture_quick_signal` and
`intel_trail_followup` are `true` there and are **not** changed by this
request.

| Step | Flag | Value | Rows it serves | Prerequisite | Verify | Recover |
|---|---|---|---|---|---|---|
| F1 | `discovery_candidate_projection_enabled` | `true` | S49 | none on this branch | a served candidate carries `coverage` | set `false` |
| F2a | `experience_session_enabled` | `true` | S92, S112 (the sessions a memory is made from) | A8. An owner decision in its own right: it opens routes that WRITE canonical events for a person (open, read, close their own session; 12-hour lookback; no coordinate stored) | `GET` of the viewer's open session stops answering `feature_disabled` | set `false`; the routes refuse at once |
| F2 | `memory_projection` | `true` | S92, S112 | A6, F2a | the memory scheduler stops answering `disabled`; closing an eligible session writes one memory with its `claim_refs` | set `false`; the sweep expires what was projected |
| F3 | `sensing_publication_enabled` | `true` | S39, S24 | A5, A7, C1, E1, and at least k v2 contributors per cohort | `sensing publication pass` logs `published > 0`; new rows in `sensing_published_aggregates` carry no contributor column | set `false`; rows expire within 24 h, or `delete from public.sensing_published_aggregates` |
| F4 | `sensing_presence_context_enabled` | `true` | S39 | F3 | a Compass turn with `sensingZoneIds` gets the `[Zone presence …]` header, observed or unknown only | set `false`, before F3 |

### G. Outside every tool in this environment

| Step | Change | Verify |
|---|---|---|
| G1 | Republish `https://portava.replit.app` successfully (the last publish reads `failed`) | the publish status reads success |
| G2 | From outside the CI proxy: `curl -sI https://portava.replit.app`; obtain Supabase's at-rest encryption attestation | HSTS and TLS in the served headers (S17) |

### H. Media — exact values

Added 2026-09-26 for the media lanes (census-media §19–§32); rewritten
2026-09-27 for wave 8 (census-media §33–§44, integration §41).

**Production, read-only, 2026-09-27:**
- The Media tab is not in production's nav bar: `MEDIA_TAB_ENABLED` is `false`.
- `MEDIA_RANKING_ENABLED` is `false`, so the legacy Watch ranker returns
  chronological order. All four creator boosts and creator fatigue are `false`.
- `MEDIA_VIEW_MODE_FULLSCREEN_ENABLED` is `true`.
- `MEDIA_WORLD_SHELL_ENABLED` has no row: 2300, which seeds it, is not in
  production's ledger. 2037, 2040 and 2085 are.
- `media_canonical_enabled` is `false` (since 2026-09-25 15:39 UTC), and
  `media_canonical_read_enabled` has no row.
- `map_contributions_enabled` and `media_evidence_enabled` have no row, and
  `intel_evidence` holds 0 rows.
- `posts` holds 9 rows: 8 with mode `none` and no place name, and 1
  `delayed_until_time`, published.
- None of 3320, 3321, 3338, 3340–3343, 3350–3352, 3355–3362 is applied there.
  3320 and 3321 are applied to `portava-ci`; the rest are applied to no shared
  database. 3350–3352 and 3359–3362 were rehearsed on a local PostgreSQL 16
  cluster (census-map §45.11, census-media §44).
- `posts` grants: anon and authenticated hold table-level SELECT with no column
  restriction, and `posts_select` admits `can_see_post(id)` for every role. The
  gateway log for the last 24 hours shows only secret-key requests to
  `/rest/v1/posts`.

**What deploying this branch (B1) changes with no flag.** Each item below
narrows what a person sees of someone else's content, and each has a test that
a non-owner sees no more than before:
- Media reads (the Watch feed, the grid, `GET /media/:id`, place pages)
  honour the owner's post location mode. Before, they served the place name
  for `city_only`, `hidden` and `trusted_circle_only` posts. Also,
  `mapPublicPost` withholds the place for any mode it does not know
  (census-media §36.5).
- Pulse, Discovery's event posts and a trip's post feed apply the same rule
  for non-owners (§42). Compass, the Wall and the place pages follow once
  §43 is merged.
- The contributor-reputation route answers for the caller's own account only
  (§35.2 B).
- A postcard file that is held, flagged, limited, rejected or removed never
  counts toward the postcard and never becomes the passport cover (§37.8).
- The H7 colour changes to the shared sheets (H7) and lane K's contrast
  changes to Media surfaces (H8) become visible on the next client build.

| Step | Change | Value | Prerequisite | Verify | Recover |
|---|---|---|---|---|---|
| H1 | `media_canonical_enabled` (the canonical writer) | `true` | B1. An owner decision: it was turned off on production on 2026-09-25 | one upload writes one `media_assets` row (read-only count before and after) | set `false`; writes stop and the legacy stores stay authoritative |
| H2 | Apply 3320 (canonical contract constraints), then 3321 (§36 moderation vocabulary) | — | H1 (3321 refuses production until the writer's schema holds, which §23.2 found it does) | each migration's own postconditions; `media_assets.moderation_status` holds only §36 values | each ships a rollback under `db/rollback/` |
| H3 | Apply 3338, then `media_processing_worker_enabled` | `true` | H1 (assets must exist), B1 | the worker's pass logs `claimed`/`completed`; an owner's retry of a FAILED asset answers 202, and the asset reaches `ready` or `failed` | set `false`; the worker writes nothing on its next pass, and the retry refuses without writing |
| H4 | `media_canonical_read_enabled` | `true` | `lib/media/mediaCanonicalRead.ts` B1–B5: 2250's columns present (2470 on production); the writer seen landing a row (H1); the dimension sweep (H3); coverage measured after a backfill | a World projection serves a `media_assets` row; the coverage figure is recorded | set `false`; reads fall back to the legacy branches at once |
| H5 | **F1: the Media tab opens on the World shell.** Apply 2300, then 3340. Set `MEDIA_TAB_ENABLED`, `MEDIA_WORLD_SHELL_ENABLED` and `MEDIA_TAB_WORLD_DEFAULT_ENABLED` | all `true` | B1; a client build containing this branch; a `mobile-reachability-ledger` entry for the World shell as the tab's mode | census-media §34.6 row 1: the tab opens on the World header with World · Watch · Grid · Gems under it; it still opens on World after a relaunch with Watch last chosen | set `MEDIA_TAB_WORLD_DEFAULT_ENABLED` `false`: the tab lists Watch · Grid · Gems again and the persisted mode wins. Each seed's rollback refuses while its flag is `true` |
| H6 | **F2: the Watch surface.** Apply 3341, 3342 and 3343. Set `MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED` (place first; Ask Compass first and largest; no counts), `MEDIA_WATCH_TAP_TO_PLAY_ENABLED` (nothing plays until tapped) and `MEDIA_WATCH_STAGE24_RANKING_ENABLED` (§24 ordering replaces the watch-time ranker) | each `true`, independently | B1; a client build (for the first two); a device pass of expo-av pause and resume (tap-to-play) | census-media §34.6 rows 2–4; new `rank_events` for `watch_feed` carry `s24_*` features only; watch `GET /media/feed` latency | set each `false`; today's rail, autoplay and ranker return on the next fetch or request |
| H7 | A grading ruling for MD403 (§46 "high contrast"): does it cover the shared sheets Media opens? | **yes — RULED by the owner on 2026-09-27** ("Include comments, share, place picker, and plan picker in Media's contrast requirement … Keep MD403 open until verified") | none | **Built on PR #528's branch; not merged to main, not deployed** (census-media §33, §33.13). The five sheets, and everything they open without leaving the Media flow, are measured as asserted pairs: 272 sheet pairs, all passing, none pinned. The fixes go through two role tokens, `signalStrong` `#C43B23` and `muteStrong` `#696660`, and sixteen shared components; no existing token changed value. The consumer guard measures 310 pairs on 67 other files before and after: 103 improved, 207 unchanged, 0 worse. **MD403 stays W on verification only**: your review (H8) and a device review | revert §33's commits; `mediaContrast.test.ts` and the guard then name every pair that fails again |
| H8 | The visible changes to shipped Media surfaces and shared sheets | accept / revise, per change | B1 | **Before-and-after screenshots: https://claude.ai/artifact/Rvc6rMoFuV2yE5VUynPc11** (private until you share it). These are web renders from fixtures, not a device; the page lists how they differ. It covers the five Media screens, the add-gem assistant, the H7 sheets and their nested sheets, lane R's layout fixes (census-media §40), and F1/F2 previews with the flags on. TagPreviewSheet cannot be opened on web, so it needs a device. Then review on a device | revert the lines census-media §31.8, §31.13.15, §33.5 and §40 name; `mediaContrast.test.ts` then names each pair that fails again |
| H9 | **Lane P's three built surfaces.** Apply 3350, then `media_neighborhood_only_mode_enabled` ("Show neighborhood only" as a post location choice). Apply 3351, then `media_find_busier_enabled` (Find Busier on the rail and in Compass). Apply 3352, then `media_perspective_vantage_enabled` (a contributor names the vantage from §12's lists; place pages group by it) | each `true`, independently | B1; a client build; for vantage groups to be reachable, H5 | census-media §36.7, one line per row | set each `false`. 3350 adds an enum label that PostgreSQL cannot drop. Its rollback refuses while the flag is `true` or any post carries the value, and leaves the label inert |
| H10 | **Vendor stages.** 3355 `media_vision_provider_enabled` with `MEDIA_VISION_PROVIDER`; 3356 `media_moderation_classifier_enabled`; 3357 `media_transcoder_enabled`; 3358 `media_captions_enabled` | each `true` only after its vendor exists | a vendor per stage (§37.4), each an owner cost and data-protection decision; for 3356, a classifier OR a decision to staff a hold, plus the MD269 (a) rule (§37.8.5) | census-media §37.1 per row | set `false`; every stage fails closed with its flag off |
| H11 | Apply 3359 (a postcard with no countable file may have an empty cover) | — | B1 | `passport_postcards.media_url` is nullable; no row is null until a postcard loses its last countable file | its rollback refuses while any cover is null; then delete its ledger row |
| H12 | Apply 3360, run `rekeyIntelEvidenceReferences.ts` (a dry run first; `--apply` re-seals), then apply 3361; provision `INTEL_EVIDENCE_REFERENCE_KEY` (at least 32 characters, stable: there is no rotation tool) | — | B1 | the dry run prints 0 legacy rows (production has 0 `intel_evidence` rows); 3361's postconditions validate the CHECK and drop the function | each has a rollback that deletes its own ledger row; the key must not change while any sealed row exists |
| H13 | Apply 3362 (the client roles lose the private and per-post place columns of `posts`) | — | none: every pre-flight condition read on production on 2026-09-27 holds (census-media §44.9.1; 2148 in force, no client-key reader of `posts` in 24 hours) | census-media §44.9: on production anon and authenticated can read **39** columns (`tombstoned_at` and `perspective_vantage` are absent there; 40 once 3352 is applied) and service_role all 73; over HTTP with the public key `select=id` answers 200, and `select=original_lat`, `select=*` and `original_lat=gt.0` each answer 42501 | grant a missing non-location column in a new migration; only if that cannot wait, the rollback, which restores 2148 exactly and reopens the gap |
| H14 | Apply 3363 (the client roles lose the place columns of `pulse_geo_tags`, `passport_postcards` and `post_media`) | — | H13. Every pre-flight condition read on production on 2026-09-27 holds (census-media §44.15.1): the columns are exactly 17, 29 and 25; no client role holds column SELECT; nothing else depends on the columns; the 178 requests to the three tables in 24 hours all used the secret key | census-media §44.15: readable 4 of 17, 20 of 29 and 23 of 25 for anon and authenticated, service_role all; the anon-key probes answer 42501 on a withheld column | its rollback restores the prior SELECT grants and deletes its ledger row; it reopens the copies |
| H15 | Apply 3364 (no client role may write `pulse_geo_tags`: today any signed-in user can attach a forged venue to another author's untagged post, and Pulse serves it) | — | H14 is not required (3364 touches no SELECT). The only writer is the API's service client (census-media §44.18.1); §44.18.5's pre-flight and a gateway read of POST/PATCH/DELETE on `/rest/v1/pulse_geo_tags` (none in 24 hours on 2026-09-27) | §44.18.5: every client write privilege on the table is false; a signed-in `POST /rest/v1/pulse_geo_tags` answers 42501; a post created through the app still gets its geo tag | name the writer from the gateway's 42501s; only if that cannot wait, the rollback, which restores exactly the ACL 3364 recorded (on production `arwd`, never GRANT ALL) and deletes its ledger row |
| H16 | Apply 3365 (the `post_media` write boundary 2158 intended, as a narrowing only). Production's ledger says 2158 ran; its grants are absent, so an owner can insert media already `ready` with any `canonical_place_id` or `stamp_overlay` (`docs/ops/production-ledger-verification.md` §7). **Never run 2158 itself**: after 3363 it would re-grant table-level SELECT and 12 UPDATE columns (§44.18.3) | — | §44.18.5's pre-flight; no client code writes the `post_media` table (§44.12) | §44.18.5: authenticated holds INSERT on 14 columns, UPDATE on 0, no DELETE; anon holds no write; a signed-in insert carrying `processing_status` answers 42501; a post created through the app still gets its media | as H15, in reverse order: 3365's rollback before 3364's, 3364's before 3363's |

**Decisions the flags cannot take (census-media §34.6, §35.4, §36.4, §37.8.5):**
- **MD419, strict reading:** `MEDIA_VIEW_MODE_FULLSCREEN_ENABLED` = `false`
  removes Watch entirely. It is an existing flag, needs no code, and is needed
  only if "not the default" (H5) is not enough.
- **MD435:** §42 against §48 needs an owner ruling on which ranker stays.
- **MD289:** ratify or replace "looks social" (`busy` or `social` at
  confidence ≥ 0.6).
- **MD269 (a):** when the moderation stage holds a Pulse post's media, what
  happens to the post. The four options are in §37.8.5.
- **Lane P's choices, which you may overrule** (§36.3, §36.4.1):
  - MD262 was built as a new post location mode, not by making Media honour
    `pulse_geo_tags`. The row's earlier statement left that choice to you.
  - MD101 reads §32's "a quieter or cheaper version" as one example question,
    not a limit on §15's four comparators.
  - MD82–MD85: the contributor names the vantage, the post's category picks
    the list, and a post has one vantage.
- **Product definitions (§36.4):**
  - MD77: social expiry.
  - MD79: when a post's place stops being shown, and what it falls back to.
  - MD175: what Remix is.
  - MD255: where the `following` and `shared_moment` audiences live.
  - MD385: whose media may become a Memory.
  - MD446: what "Show Me Now" is.
- **Media → intelligence (§35.4):**
  - MD65 Q1–Q5: whether a Media photo may feed Live Intelligence, under which
    consent words, with what contributor identity, for which claim types, and
    with what effect on confidence.
  - MD197: whether Media may resolve another account's contributor tokens.
  - MD37: the §6 source of an ordinary upload.
  - MD71: whether a photo may be labelled `live`.
  - MD162: whether the Map gateway publishes zone names.
- **Direct client reads of posts and its copies (census-media §44.7, §44.16):**
  - §44.7 question 1, which rows a client role may see: (i) leave the rows as
    they are, (ii) add the API's publication gate to the posts row policies
    for non-authors, or (iii) take the client roles off `posts` and give
    post_media's policies a definer helper. After H13 and H14 no client role
    reads a location or state column, but a pending, draft or private post's
    row, `content` and `media_urls` stay readable.
  - §44.16 item 2: whether the `stamp_overlay` label the API serves discloses
    a withheld post's place. 3363 closes only the direct path.
  - §44.16 item 3: `passport_postcards.stamp_revoked_by`, which names a
    moderator, stays readable by client roles.
- **Do not turn on `map_contributions_enabled` before photo-naming consent
  words are approved.** v1's words name Quick Signals only. The branch now
  refuses a photo (409 `consent_does_not_cover_photos`) unless the
  contributor's recorded consent version is in `PHOTO_EVIDENCE_CONSENT_VERSIONS`,
  which is empty, and the app offers no photo step until the server says a
  photo would be kept (census-map §45). To allow photos, approve words that name
  photos and videos, then ship that version, its client text and its list entry
  in one release.
- **The Watch rail on short screens (F2 only).** On a 375×667 screen with 3341
  on, the rail needs 353 px and 339 px are free. Choose fewer rail controls on
  short screens, or a smaller Compass button (census-media §40.12).
- **The canonical postcard cover (before H1).** Choose who owns a postcard's
  canonical cover row (the system, the owner, or record who wrote it); whether a
  file that stops being the cover keeps its attachment; and whether the move
  runs while the writer flag is off (census-media §37.10.2).

### H-build. Builds and device runs this environment cannot reach

These are measured in census-media §37.3, not assumed:
- **Android:** `dl.google.com` is denied by the environment's network policy,
  and `maven.google.com` artifacts redirect there. Gradle's JDK 17 toolchain
  auto-download (`api.foojay.io`) answers 403, and only JDK 21 is installed.
  The remedy is to allow those hosts in the environment's network settings,
  or to install JDK 17 and the Android SDK in its setup script.
- **EAS:** `expo.dev` and `api.expo.dev` are denied, and no `EXPO_TOKEN`
  secret exists.
- **iOS:** no macOS host, so an iOS build is possible only through EAS.
- **Devices:** there is no `/dev/kvm`, so no emulator, and no physical
  device. MD282, MD284, F2's tap-to-play and H8 each need a device run.

---

## 3. What each approval moves, and what it cannot

| Rows | Moved by | Still not "production realised" until |
|---|---|---|
| S19 S97 S111 S118 | A1, A2, B1 | a real capture lands with a non-null contributor token |
| S18 S32 | A2, B1, C1, D3 | a v2 holder's device obtains a session and a contribution is written |
| S112 | A3, A6, A8, F2a, F2 | an erasure runs with both steps logged and no failures |
| S92 | A6, A8, F2a, F2 | a closed session produces a memory |
| S49 | F1 | a candidate is served with coverage |
| S39 S24 | A5, A7, C1, D3, E1, F3, F4 | a publication is recorded and a Compass turn reads it |
| S26 S66 | real use | real contributions meet the gates |
| S17 | G1, G2 | the headers are read |

For Media, census-media §41.2 lists all 49 rows that were not C when wave 8
began (42 still are), each with what activates it and what only the outside
world can verify. H5, H6 and H9–H16
move none of them to "production realised" by themselves: each still needs the
device run or production read named there.

## 4. Boundaries this request keeps

- No step here is executed by the integration owner. Production has been
  read, never written.
- The 2481 ledger row on `portava-ci` stays as it is.
- No consent is recorded, migrated or inferred on anyone's behalf.
- No individual contribution is ever exposed: publication is k-gated,
  differencing-gated and carries no contributor column, and consent is one
  bit per row that is never published.
