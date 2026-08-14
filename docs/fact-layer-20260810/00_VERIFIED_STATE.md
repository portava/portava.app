# 00_VERIFIED_STATE.md — the canonical factual layer

Built 2026-08-10 against the clone at **13dcfe3**
(`scratchpad/repo`, HEAD = `13dcfe3 part-b: live_pulse surface + behavioral gate`).
The LIVE repo is far ahead, at **c89f09a77**. `node_modules` is absent and no
database is reachable from where this was written; nothing here was executed.

---

## HOW TO USE THIS DOCUMENT

**A claim that appears here, with a tag, is citable.** Cite it by its heading and
its anchor (file:line / query / commit). Do not restate it — reference it. The
previous attempt failed because three documents restated the same facts and the
three restatements diverged three ways.

**A claim that is absent here is not citable.** Absence is not permission to
assume. If P1 architecture work needs a fact that is not in this file, the fact
must be established and added here *first* — the governing rule is: *no P1
architecture work may use an unverified factual claim as a prerequisite.*

**Adding a fact requires the same tag.** Exactly one of:

| Tag | Meaning |
|---|---|
| `[CLONE 13dcfe3]` | Verified by reading the clone, with file:line. Reproducible by anyone with the clone. |
| `[LIVE <commit>]` | Verified in the live repo by another agent and reported here. The clone is too old to confirm it. Says who/when and what must be re-run. |
| `[DB <date> · <project>]` | Established by a live database query. Query text **and the project queried** required. |
| `[UNVERIFIED]` | Believed, unproven. Labelled as such, never stated as fact. |

**Dates in `[DB]` tags are UTC, and two of them are closer together than they
look.** The container clock is UTC and crossed midnight mid-session, so
`[DB 2026-08-10]` and `[DB 2026-08-11]` on the `post_event_links` chain (§2.7,
§2.9) are **hours apart, not a day**. A reader comparing them would otherwise
infer a gap that did not happen — and, worse, might read the production apply as
a considered next-day decision rather than what it was: the immediate
continuation of the same session that found the drift. Where a tag's date matters
to an argument, prefer the ordering to the arithmetic.

**A `[DB]` tag that does not name the project is void.** This repo talks to at
least two Supabase projects — production, ref `ajrurzioarfkagpuxfnb`
(`.github/workflows/live-db.yml:150`, §9.7), and the non-production project,
**ref `hwokxgbmezheskbzskfr`** — and a fact true of one is routinely false of the
other (§2.7/§2.9 is exactly that collision). Where the source of a `[DB]` entry
did not record which project was queried, the tag says **`project not recorded`**
and the entry is listed in §10.3. That is not a formality: an unattributed live
observation cannot be reproduced or contradicted.

**The non-production project: ref is the identifier, `portava-ci` is an alias.**
The identifier is **`hwokxgbmezheskbzskfr`**, anchored in the live repo at
`docs/ci/BOOTSTRAP.md:10` ("CI (non-production), currently EMPTY"), `:421`,
`:646`, `:853-855` and `:1111` **[LIVE 8dc0dd2bc]**, and set as
`CI_SUPABASE_PROJECT_REF` (`.github/workflows/live-db.yml:144`). `portava-ci` is
the **Supabase dashboard display name** — which is exactly why it appears in no
config: display names are not identifiers and nothing in the tree consumes one.
Cite the ref; use the nickname only as a human label.

⚠ **Two claims in the original header were wrong, and both were artefacts of the
clone being stale.** (1) "The non-production ref is operator-supplied and appears
nowhere in the tree" — the ref is in `docs/ci/BOOTSTRAP.md` in the live repo.
(2) "The name `portava-ci` appears nowhere in the clone (`grep -rn 'portava-ci'`
returns nothing)" — true of the clone at `13dcfe3`, **false of the live repo**,
where it occurs five times: `auditMigrationsVsLive.ts:229`,
`docs/migrations.md:133`, `:140`, `:164`, and `docs/ci/BOOTSTRAP.md:75`
**[LIVE 8dc0dd2bc]**. Everywhere this document went on to mark the non-production
project's identity `[UNVERIFIED]` on the strength of that grep, the finding was
an artefact of grepping a clone that predates those files. Those entries are
corrected below rather than deleted, so the reasoning stays visible.

⚠ **The BOOTSTRAP table calls `hwokxgbmezheskbzskfr` "currently EMPTY", which
does not sit easily with §2.9** — where the same project is recorded as holding
`post_event_links` with `relrowsecurity` observed and then fixed. Both cannot be
current. The likely reading is that "EMPTY" describes the project at the time
BOOTSTRAP was written, before the 2026-08-10 sweep populated it, but **that is
[UNVERIFIED]** — no query establishes the ordering. Do not cite "EMPTY" as
current state without re-checking.

**An untagged fact is a defect.** If you cannot verify something, tag it
`[UNVERIFIED]` rather than dropping it — the gap is information.

**This document contains no proposals.** No recommendations, no design, nothing
about what should be built. Only what is.

**Where this document corrects the brief it was built from**, the correction is
marked ⚠ **DIVERGENCE** and states both readings. Six of these exist. Treat every
one as blocking until an owner resolves it.

---

## 1. CANONICAL TREE

**1.1** `travel-buddy-standalone/` is the canonical mobile app tree; the API
server is canonical at `artifacts/api-server`. **[CLONE 13dcfe3]** —
`replit.md:3` (SOURCE OF TRUTH banner, "updated 2026-08-05"), restated at
`replit.md:16`, `replit.md:91-93`.

**1.2** SUPERSEDED 2026-08-14 — `artifacts/travel-buddy/` is now ARCHIVED (`bc1bef404`), not merely frozen. As recorded: LEGACY-FROZEN: deleted 2026-08-04,
resurrected 2026-08-05, do not edit; artifacts→standalone sync disabled by
default behind `PORTAVA_ENABLE_LEGACY_SYNC=1` in `scripts/post-merge.sh` and
`scripts/sync-standalone.sh`. **[CLONE 13dcfe3]** — `replit.md:3`, `replit.md:92`.

**1.3** Canonical-tree identity has flipped inside a single day before, so the
banner must be re-read each session rather than remembered. **[CLONE 13dcfe3]** —
`.agents/memory/canonical-tree-flip-and-baseline-verify.md`.

---

## 2. MIGRATIONS AND LIVE DRIFT

**2.1 There is no migration runner and no `schema_migrations` table.**
Migrations are applied by hand through the Supabase Management API and recorded
by hand in `docs/migrations.md`; nothing reconciles the two.
**[CLONE 13dcfe3]** — `docs/migrations.md:43`;
`.agents/memory/migration-applied-vs-committed.md:6`;
`artifacts/api-server/src/scripts/checkMigrationPrefixes.ts:45-46` records the
verification: *"verified 2026-08-09: no table matching '%migration%' in `public`
or `supabase_migrations`"* (the surrounding rationale runs to `:50`), and
`docs/migrations.md:43-44` records the same sentence. That underlying query is
**[DB 2026-08-09 · project not recorded]** — neither source names the project it
was run against — recorded in-repo, not re-run here. See §10.3.

**2.2 Consequence, stated in-tree: a migration file is not evidence in either
direction.** A committed file does not mean applied
(`0108_rent_buddy_spec_tables.sql` logged applied 2026-07-05 but never ran;
the 0047–0113 rent_buddy chain found unapplied 2026-07-16; a 2026-07-17 audit
found ~40 files with missing objects). "Appears in no migration file" does not
mean drift either. **[CLONE 13dcfe3]** —
`.agents/memory/migration-applied-vs-committed.md`.

**2.3 The canonical migrations directory is
`artifacts/api-server/src/migrations`, holding 229 numbered `.sql` files.**
**[CLONE 13dcfe3]** — counted by
`find . -name '[0-9][0-9][0-9][0-9]_*.sql' … | sed 's|/[^/]*$||' | sort | uniq -c`
run in the clone; matches the 229 figure recorded at
`.agents/memory/migration-applied-vs-committed.md` ("229 files, 2026-08-10").

**2.4 ⚠ DIVERGENCE — numbered `.sql` exists under 22 directories in the clone,
not 21.** The brief this document was built from says 21. Counted in the clone:

```
229 artifacts/api-server/src/migrations   68 artifacts/api-server/migrations
 33 migrations (repo root)                14 supabase/migrations
 13 docs/sql                              10 . (repo root itself)
  6 files/artifacts/api-server/src/migrations
  5 docs/migrations                        4 db/migrations
  3 travel-buddy-standalone/migrations     3 artifacts/travel-buddy/migrations
  2 portava-stamp-wave1-files/…            1 × 10 further drop directories
```

**[CLONE 13dcfe3]**. Twenty-six directories contain *any* `.sql`; twenty-two
contain `NNNN_*.sql`. Any count in this tree rots — re-run the `find`, do not
cite the number. Whoever wrote 21 should say which filter produced it.

**2.5 `auditMigrationsVsLive.ts` does not see the whole tree.** It scans only the
canonical dir; `--include-legacy` adds only `artifacts/api-server/migrations/`.
The repo-root `migrations/` is frozen-guarded but **never audited against live**,
and every drop directory is outside its reach entirely. **[CLONE 13dcfe3]** —
`.agents/memory/migration-applied-vs-committed.md`; gate reachable via
`grep -n 'include-legacy' artifacts/api-server/src/scripts/auditMigrationsVsLive.ts`.

**2.6 `0026_highlights.sql` cannot be replayed against the live schema.** The
file declares `highlight_replies` with `user_id` and `deleted_at`:
**[CLONE 13dcfe3]** — `artifacts/api-server/src/migrations/0026_highlights.sql:72`
(`user_id uuid NOT NULL REFERENCES profiles(id)`) and `:74` (`deleted_at
timestamptz`); its RLS policies at `:80-82` reference both columns.
The **live** table has neither — its columns are
`(id, highlight_id, replier_id, thread_id, created_at)`.
**[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb` AND non-production
`hwokxgbmezheskbzskfr`]** — established against live by the prior session. The
tag previously read `project not recorded`; corrected 2026-08-11, because the
live repo records both projects for this exact check at `docs/migrations.md:164`
("Verified against production and portava-ci, 2026-08-10") followed by the same
five-column list at `:168` **[LIVE 8dc0dd2bc]**. The clone still cannot confirm a
live column list — that limitation is unchanged — but the attribution gap is
closed on both projects, and the column list agrees across them.

**2.7 — BEFORE and AFTER. Both are kept.** The BEFORE state is the evidence that
justified the apply; overwriting it would delete the reasoning that led here.

**2.7 BEFORE (2026-08-10) — Twelve objects declared by migrations did not exist
in production: 8 indexes, 1 table (`post_event_links`), 3 policies.**
**[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb`]** — the prior session's
live audit, run through the read-only production front door (§9.4), which is the
only sanctioned route to production and is therefore what the entry's own word
"production" denotes; the ref is fixed in-tree at
`.github/workflows/live-db.yml:150` **[CLONE 13dcfe3]**.
The further claim that the twelve *were* applied to a non-production project
named `portava-ci` is **[UNVERIFIED]**: no second query was reported, and the
string `portava-ci` occurs nowhere in the clone. No clone anchor exists for the
count or the object list.
*(Corrected 2026-08-11 — two separate claims were bundled here. The project's
**identity** is settled: ref `hwokxgbmezheskbzskfr`, dashboard alias
`portava-ci`, anchored at `docs/ci/BOOTSTRAP.md:10` **[LIVE 8dc0dd2bc]**; the
"occurs nowhere" grep was run against the stale clone. Whether the twelve were
**applied** there is still **[UNVERIFIED]** — no second query was ever reported,
and naming the project does not supply one. The object list is no longer
unanchored: see 2.7 AFTER.)*
⚠ The list of the twelve is **[UNVERIFIED]** as reproduced anywhere in this
document: only the total and the breakdown were reported. A reader who needs the
names must re-run `auditMigrationsVsLive.ts` against production through the
read-only front door (§9.4). *(Superseded by 2.7 AFTER: the names are now
recorded. The BEFORE text is kept unedited as the state at the time.)*

**2.7 AFTER (2026-08-11) — nine of the twelve are applied to production; three
are deliberately not. `audit:schema` reports no missing objects.**
**[DB 2026-08-11 · production `ajrurzioarfkagpuxfnb`]** — applied by hand in one
`BEGIN … COMMIT` transaction in the Supabase SQL editor and verified after
`COMMIT`; operator-executed and reported, not observed by the session that wrote
this entry. Recorded in `docs/migrations.md` under *2026-08-11 — Schema drift
reconcile*.

The **nine applied** — 1 table and 8 indexes, which also settles the BEFORE
entry's ⚠ that the object list had never been written down:

| File | Objects |
|---|---|
| `20260731_post_event_links.sql` | table `post_event_links`; `idx_post_event_links_post_id`; `idx_post_event_links_event_id` |
| `0186_geo_indexes.sql` | `user_location_state_geo_idx`; `events_geo_idx`; `posts_geo_idx`; `hidden_gems_geo_idx`; `hidden_gems_approx_geo_idx` |
| `2044_hidden_gems_canonical_place_id.sql` | `hidden_gems_canonical_place_idx` |

The **three not applied** are the policies, deliberately: `media_assets_public_select`,
`media_attachments_public_select`, `users_view_highlight_replies` — allowlisted
at `artifacts/api-server/src/scripts/auditMigrationsVsLive.ts:221-236` as
reviewed-and-decided-against, with the reasoning written out there
**[CLONE 13dcfe3]**. Their absence is the restrictive direction.

Verification queries and results, post-`COMMIT`, same date and project: object
presence returned **ten rows, `present = true` on every one** (table, eight
indexes, and `post_event_links.relrowsecurity`); `pnpm run audit:schema` exited
**0** over **4021 claimed objects** with no missing objects. Before the apply it
exited 1 with 9 missing across the three files above.

**2.8 `post_event_links` is declared by
`artifacts/api-server/src/migrations/20260731_post_event_links.sql:6`** (plus two
indexes at `:13-14`). **[CLONE 13dcfe3]**

**2.9 `2070_rls_hardening.sql`'s RLS block is a guarded `DO` that no-ops when its
target is absent, and never retries.** **[CLONE 13dcfe3]** —
`artifacts/api-server/src/migrations/2070_rls_hardening.sql:89-94`:

```sql
DO $$ BEGIN
  IF to_regclass('public.post_event_links') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.post_event_links ENABLE ROW LEVEL SECURITY';
  END IF; END $$;
```

The same shape is used for all twelve tables the migration covers (`:24-29`,
`:34-39`, `:80-85`, `:100-105`, `:110-115`, …). The file's own header at
`:17-19` states the existence check is there for idempotency.

**Consequence, reported observed live:** `post_event_links` had
`relrowsecurity=false` after creation, because the table did not exist when 2070
ran and 2070 never re-runs; a sweep of the migration's twelve tables found this
was the only such misfire.
**[DB 2026-08-10 · non-production `hwokxgbmezheskbzskfr`]** — project supplied
2026-08-11 and corroborated in the live repo, which records the same sweep and
names it: `docs/migrations.md:133-134` ("Swept against production and portava-ci,
2026-08-10. Exactly one had actually misfired: `post_event_links`") and `:140`
("creating the table on portava-ci left it with `relrowsecurity = false`")
**[LIVE 8dc0dd2bc]**. The tag previously read `project not recorded`; it was
never unrecorded, only absent from the clone this document was built against.

⚠ **This entry and §2.7 cannot both describe the same project.** §2.7 records
`post_event_links` as **absent from production**; a table that does not exist has
no `pg_class.relrowsecurity` row to observe. The only reading under which both
reports are true is that **§2.9 was run against the non-production project**
(where the table was created) and §2.7 against production (where it was not).
That reading is **[UNVERIFIED]** — it is inferred from the two reports being
jointly consistent under no other assignment, not from anything either report
states. The alternatives are that one of the two observations is wrong, or that
§2.7's "production" and §2.9's "live" are the same project and the pair is
simply contradictory.

**SETTLED FOR PRODUCTION (2026-08-11): `post_event_links.relrowsecurity = true`.**
**[DB 2026-08-11 · production `ajrurzioarfkagpuxfnb`]** — query
`select relrowsecurity from pg_class where oid = to_regclass('public.post_event_links')`,
run after the `COMMIT` described in §2.7 AFTER; operator-executed and reported.
The table was created and the RLS enable applied **by hand in the same
transaction**, precisely because 2070's guarded `DO` had already run against a
project where the table was absent and never retries. Production is therefore no
longer an instance of the misfire; it is an instance of the misfire having been
worked around by hand, which is a different fact and is why the two are recorded
separately.

**The ⚠ above is resolved, in the direction it predicted, and by direct record
rather than by elimination.** §2.7 BEFORE establishes that production had no
`post_event_links` on 2026-08-10, and a table that does not exist has no
`relrowsecurity` to read — so the `relrowsecurity=false` observation cannot have
been production's. The live repo says so outright at `docs/migrations.md:140`:
it happened on `portava-ci`, ref `hwokxgbmezheskbzskfr`. The two entries describe
different projects, exactly as the ⚠ inferred; the inference is now redundant.

**CLOSED for the non-production project too, and this corrects an earlier
revision of this entry.** A prior revision (2026-08-11) recorded §2.9 as "STILL
OPEN for the non-production project." That was wrong: the live repo already
recorded both the project and the remedy, and the revision was written without
reading `docs/migrations.md:133-151`. What the repo records:
`relrowsecurity = true` on `hwokxgbmezheskbzskfr`, fixed by **re-running that one
idempotent `DO` block** and verified (`docs/migrations.md:144-147`)
**[LIVE 8dc0dd2bc]**. Note the two projects were fixed by different means and the
distinction is load-bearing: on the non-production project re-running 2070's `DO`
block sufficed **because the table already existed there**; on production the
table did not exist, so the create and the enable had to go in one transaction
(§2.7 AFTER). Same defect, two remedies, because the precondition differed.

**What remains open is narrower than the project ref.** The underlying
observation still has no query text and no timestamp beyond the date, on either
project — `docs/migrations.md:144` says "verified" without reproducing the read.
Anyone re-establishing it should record ref, query and result together:
`select relname, relrowsecurity from pg_class where relname = 'post_event_links';`
Neither project needs a re-run for correctness; both would benefit from one that
leaves an anchor. See §10.3.

**2.10 A concurrent Claude Code session can be misread as history.**
`2078_profiles_role_not_self_writable.sql` shipped a drift note claiming its
objects pre-existed out of band; it was retracted — a peer session had applied
2078 live at ~10:11 without committing, and the session that queried at ~11:18
read work-in-progress as history. **[CLONE 13dcfe3]** —
`.agents/memory/migration-applied-vs-committed.md`, and the retraction in
`docs/security/admin-authz-audit.md` §"RETRACTED".

**2.11** `0199_rank_events_live_pulse_surface.sql` exists in the canonical
directory. **[CLONE 13dcfe3]** — file present in
`artifacts/api-server/src/migrations/`. Whether it is applied live is
**[UNVERIFIED]**; `routes/rankEvents.ts:94-97` warns it must be applied before
the `live_pulse` surface enum is widened, or the analytics insert is silently
rejected.

---

## 3. SCHEMA AND CONSTRAINTS

**3.1 `feature_flags` live columns are
`flag text, enabled boolean, description text, updated_at timestamptz,
metadata jsonb`** — identical in the two projects queried.
**[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb` and non-production
`hwokxgbmezheskbzskfr`]**, both queried by the prior session. Corrected
2026-08-11: the non-production project was reported by its dashboard alias
`portava-ci`, whose ref is `hwokxgbmezheskbzskfr`
(`docs/ci/BOOTSTRAP.md:10` **[LIVE 8dc0dd2bc]**). The earlier `[UNVERIFIED]`
marking rested on the nickname appearing nowhere in the stale clone. Re-runs
should still record the **ref**, not the alias — a display name can be changed in
the dashboard without changing anything a query can see.

**3.2 The four base columns are declared by
`0037_feature_flags.sql:4-9`.** **[CLONE 13dcfe3]**

**3.3 `metadata jsonb` is added by `0065_phase7_safety.sql:36`**
(`ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS metadata jsonb;`), and
**that migration IS applied** — the column is present live per §3.1.
**[CLONE 13dcfe3]** for the declaration;
**[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb` and one non-production
project]** for the application, inherited from §3.1's column query.
This resolves quarantine blocker 2 (§10.1).

**3.4 Cohort or percentage targeting is expressible in `metadata` with no schema
change — AS A SCHEMA FACT ONLY. NOTHING READS THE COLUMN.** The column is untyped
`jsonb` (§3.1), so it can *hold* such a payload. **[CLONE 13dcfe3]** for the
column's type.

⚠ **CORRECTION 2026-08-10 — this entry was previously stated without the second
half, and was read as though the mechanism exists. It does not.** §6.2 records
that the *discovery* loader cannot see `metadata`; that understates it. The only
function in the tree that selects the column at all is `lib/featureFlags.ts`
`getFlagRow`, and it has **zero callers**:

```
grep -rn "getFlagRow" --include='*.ts' artifacts/api-server/src \
  | grep -vE '(\.test\.ts|/__tests__/|featureFlags\.ts)'
  → no output
```

So there is no reader anywhere — not a loader that skips it, no reader at all.
The `metadata` column has been written into the schema and never consumed
(§6.9 ⚠, §6.10). **[LIVE 719b8431e]**

**WHAT THIS INVALIDATES.** Any proposal that carries configuration in
`feature_flags.metadata` — including doc 01's `DISCOVERY_ENGINE_MODE` — is
proposing to build the reading mechanism, not to use one. "Expressible with no
schema change" is true and is not the same claim as "supported". The distance
between them is: a reader, every call site that must consult it, and a decision
about what an unreadable or absent `metadata` payload means, which is the same
missing-row-versus-error question §6.8 had to settle for the stops. Under the
governing rule (no P1 architecture work on an unverified prerequisite), a design
resting on this needs the mechanism specified, not cited.

**3.5 `content_distribution_stats.eligible_impressions` is declared
`INTEGER NOT NULL DEFAULT 0`.** **[CLONE 13dcfe3]** —
`artifacts/api-server/src/migrations/2059_content_distribution_stats.sql:18`;
incremented by `+ 1` at `:153`. A second, differing declaration
(`BIGINT NOT NULL DEFAULT 0`) exists at
`artifacts/api-server/supabase/migrations/20260801_ranking_discovery_foundation.sql:68`
— two files declare the same column with different types. Which one is live is
**[UNVERIFIED]**.

**3.6 `compass_served_recommendations.recommendation_id` is declared
`TEXT NOT NULL UNIQUE`.** **[CLONE 13dcfe3]** —
`artifacts/api-server/src/migrations/0055_compass_ux.sql:123`.

**3.7 `rank_events` has no `metadata` column in the live schema.**
**[CLONE 13dcfe3]** for the assertion as written in code —
`artifacts/api-server/src/routes/mediaFeed.ts:1731-1732` states it and works
around it by encoding `watchedMs` into an `event_type` suffix. The live column
list itself is **[UNVERIFIED]** here.

**3.8 `rank_events.surface` is constrained by a live CHECK.** The route's zod
enum is `["pulse","discovery","events","live_pulse"]`. **[CLONE 13dcfe3]** —
`artifacts/api-server/src/routes/rankEvents.ts:99`. The route's own comment at
`:94-97` records that `surface` reaches the live CHECK a second time via the
analytics insert. `rank_events.item_kind` is constrained to
`('post','event','plan','buddy','place','gem')` per
`artifacts/api-server/src/lib/rankLog.ts:141`. **[CLONE 13dcfe3]**

---

## 4. RANK_EVENTS AND THE BEHAVIOUR STORES

**4.1 `rank_events` is a mutable state table, not an event log.**
`POST /api/rank-events/outcome` selects the most recent row filtered
`.eq("outcome","impression")` and then **UPDATEs that row in place**.
**[CLONE 13dcfe3]** —
`artifacts/api-server/src/routes/rankEvents.ts:137` (the filter),
`:158-161` (`.update({ outcome, outcome_at }).eq("id", row.id)`).

**4.2 One impression therefore holds exactly one terminal outcome, forever.**
Once updated, the row no longer matches `outcome='impression'`, so a second
outcome for the same (user, item, surface) finds no row and returns 404.
**[CLONE 13dcfe3]** — `routes/rankEvents.ts:152-156`
(`if (!row) sendError(res,"not_found", …)`). **Behaviour chains are structurally
impossible on this table**, and converting an impression into an outcome
destroys the exposure denominator, because the impression row is the denominator.

**4.3 A second, additive analytics row IS written for most outcomes.** It is a
new row with `outcome:"analytics"` (an explicit sentinel so it can never match
the impression-finding query) and an `event_type` from
`OUTCOME_TO_ANALYTICS_EVENT`. **[CLONE 13dcfe3]** —
`routes/rankEvents.ts:182-199`, sentinel documented at `:193-194`.
This row does not restore the denominator: it is a separate row with no
`features` and no link back to the consumed impression.

**4.4 ⚠ DIVERGENCE — "every `rank_events` writer but one discards the `{ error }`"
is FALSE at 13dcfe3.** Of eight insert sites, **three read the error and five
discard it** — so the claim understates the reading sites and misdescribes the
rest as uniform:

*Read the error:*
- `routes/rankEvents.ts:63-74` — destructures `{ error }`, `req.log.warn`s,
  then `res.json({ ok: true })` at `:76`. This is the "reads it and returns
  ok:true anyway" case, and it is real.
- `routes/mediaFeed.ts:1742-1757` — destructures `insertErr`, warns, and sets
  `counted = false`, which **gates downstream analytics** at `:1764`. Here the
  error is load-bearing.
- `lib/rankLog.ts:454-455` — `const { error } = await …; if (error) onError?.(error)`.

*Discard the error:*
- `services/ranking/CreatorCapEnforcer.ts:74` — `.then(() => {}, () => {});`
  **[CLONE 13dcfe3]**, read at that line. Both handlers are empty, so the
  resolved value — which is where `{ error }` lives — is never bound at all.
  This is the same shape as `routes/rankEvents.ts:184-198` below, and belongs on
  this side of the split, not the other.
- `lib/rankLog.ts:124` — `await sc.from("rank_events").insert(rows);` bare,
  inside a `try{}catch{}` that silently swallows (`:134-136`).
- `lib/rankLog.ts:204` — same shape, swallow at `:205-207`.
- `routes/mediaFeed.ts:1472` — bare insert, `catch { /* non-fatal */ }` at `:1482`.
- `routes/rankEvents.ts:184-198` — `.then(() => {}, err => warn)`; a
  non-throwing client resolves, so the `{ error }` in the resolved value is
  dropped and the rejection handler never fires.

**[CLONE 13dcfe3]** throughout. `lib/rankLog.ts:454` is new work: HEAD is
`13dcfe3 part-b: live_pulse surface + behavioral gate`. *Inference, labelled as
such and not a fact of this entry:* the original claim may have been true before
this commit. Nothing here establishes that — the pre-`13dcfe3` state was not
read. It must not be carried forward as written, and it must be re-checked
against
**[LIVE c89f09a77]**, which is further ahead still.

**4.5 THE MEASUREMENT — live `rank_events` holds zero rows with
`surface = 'discovery'`.** Observed distribution as recorded:

```
179775  pulse      12556  compass      5200  events      (discovery: absent)
```

**[CLONE 13dcfe3]** — the repo records this at
`docs/algorithm/discovery-impression-gap.md:1-13` (counts in the fenced block at
`:7-13`), attributed there to
`artifacts/api-server/src/scripts/checkRankEventsSurfaces.ts` at commit
`5c525ffca` (`:3`). That is the whole of what is verified here: **that the repo
records these counts.** The underlying query was not re-run, the source document
records **no date and no project** for it, so the live state itself is
**[UNVERIFIED]** from this document. See §10.3.

*Also verified, and independent of the counts:* `discovery` is a permitted value
of `surface` (§3.8) and `routes/discovery.ts` does call `logImpression` — at
exactly one place, `:1433`, on one of six serve exits (§5.1). **[CLONE 13dcfe3]**

**THE INFERENCE — labelled as such, and NOT the fact of this entry.** From
"zero rows" plus "one logging site on one of six exits" one may reason toward a
ranking bypass rather than a logging gap. The source document **explicitly
refuses to license that step**: it states the supported statement is
*"Discovery ranking may rarely or never execute on the dominant serve path"* and
that *"'Discovery has zero ranking impressions' is not sufficient to conclude
'Discovery impressions are broken'"*
(`docs/algorithm/discovery-impression-gap.md:22-25`), and it names the invariant
that motivates the refusal — `rank_events` must mean *this entity was actually
processed by the ranker with a real feature vector*, so rows must not be
manufactured for cached or unranked objects to close a telemetry gap (`:27-29`).

**Which of the six exits actually dominates in production is unmeasured**
(§10.4), and it is the missing quantity that separates "bypass" from "gap".
Cite the measurement. Do not cite "bypass" as a fact of this document.

**4.6 `content_distribution_stats.eligible_impressions` counts CONVERSIONS, not
exposures.** `upsertDistributionStats` has exactly one caller, and it is inside
the outcome handler. **[CLONE 13dcfe3]** — defined at
`services/ranking/DiscoveryRankingService.ts:939`; the only call is
`routes/rankEvents.ts:205`, reached only after a successful impression→outcome
update at `:158-167`. The route's own comment at `:201-204` says so:
*"An outcome confirms the impression was real: increment eligible_impressions"*.
Anything normalised by this column returns ≈1.0.

**4.7 Four parallel behaviour stores already exist, declared in migrations.**
**[CLONE 13dcfe3]**:

| Table | Declared at | Shape |
|---|---|---|
| `media_events` | `2039_media_events.sql:14-19` | `id, event_type, payload jsonb, occurred_at` |
| `compass_feedback_events` | `0055_compass_ux.sql:17` | raw feedback action log |
| `compass_served_recommendations` | `0055_compass_ux.sql:120-130` | incl. `recommendation_id TEXT NOT NULL UNIQUE` (§3.6) |
| `compass_outcome_events` | `20260729_compass_outcome_learning.sql:15-28` | 8-stage chain `viewed→saved→went→stayed→liked→invited→made_memory→returned`, `UNIQUE (user_id, recommendation_id, stage)` |

These are **declared**. Whether each exists live is **[UNVERIFIED]** — see §2.2.
Note the contrast with §4.2: `compass_outcome_events` supports a multi-stage
chain per recommendation by construction; `rank_events` cannot.

**4.8** `routes/rankEvents.ts` also exposes a direct impression write
(`POST /api/rank-events`) for surfaces that generate their own impressions;
`event_type` is restricted to `place_view` and `surface` is hard-coded
`"living_page"`. **[CLONE 13dcfe3]** — `routes/rankEvents.ts:33-40`, `:63-70`.
Note `"living_page"` is not in the `SURFACE_VALUES` enum at `:99`, so this
surface can be written but never reported against.

---

## 5. DISCOVERY: SERVE TOPOLOGY AND CACHES

All references are `artifacts/api-server/src/routes/discovery.ts` unless stated.
The file is 2282 lines. **[CLONE 13dcfe3]** throughout this section — every
anchor below was read in the clone.

**On second-source corroboration, stated exactly.**
`artifacts/api-server/src/scripts/checkDiscoveryCacheKeys.ts` cites some of the
same anchors in its header comment, and it is worth knowing which, because a
second in-tree citation of the same line is weak evidence that the line has not
moved. Its header block at `:1-45` cites exactly these `routes/discovery.ts`
anchors and no others:

| Anchor cited by the script | At script line | Used below in |
|---|---|---|
| `:1089` (`serveCachedPlaces` declaration) | `:11` | §5.1 (as `:1105`, the `res.json`), §5.4 |
| `:1114` (L1 hit) | `:13` | §5.1 row 1 |
| `:1130` (L2 fresh hit) | `:14` | §5.1 row 2 |
| `:1151` (L2 stale hit) | `:15` | §5.1 row 3 |
| `:1339` (`rankCandidates`) | `:16` | §5.8(a) |
| `:1433` (`logImpression`) | `:17` | §5.1 row 6 |
| `:159` (`cacheKey`) | `:26` | §5.2 (as `:159-161`) |
| `:1203-1207` (cold write-back) | `:27` | §5.2 |
| `:1124` (fall-through to cold) | `:44` | §5.5 |

plus `lib/discoveryPersistentCache.ts:85` and `:19` at script `:28-29` (§5.2).

**Every other anchor in §5 has exactly one source: this session's reading of the
clone.** In particular the script's `:1-45` does **not** cite `:1105`, `:1161`,
`:1228`, `:1263`, `:1270`, `:1441`, `:1447`, `:1025`, `:152-157`, `:1222`,
`:1262`, `:1223-1231`, `:1092`, `:1100`, `:1101`, `:1086-1088`, `:173/:244/:263`,
`:1295-1322`, `:1350-1397`, `:1408-1420`, `:1211/:1215/:1274`, or any
`DiscoveryRankingService` or `CreatorCapEnforcer` line. Some of those (`:144`,
`:153`, `:173`, `:1228`, `:1398`, `:1415`, `:1418`, `:1427-1433`, `:1542`) are
cited **elsewhere in the same script**, outside `:1-45`; where that matters it is
noted at the entry (§5.5).

Two limits on how much the corroboration is worth: the script and this document
were both written against the same snapshot, so agreement between them says
nothing about the live tree at `c89f09a77`; and the script **has never been run**
(§9.11), so its anchors have never been exercised either. Re-grep the quoted
text; do not trust the number.

**5.1 The main GET handler has six place-serving exits.** Three more `res.json`
calls exist in the handler but serve no places (`:1161` no-geocode empty,
`:1447` catch-all empty).

| # | Line | Path | Ranked? | Logged? |
|---|---|---|---|---|
| 1 | `:1114` → `:1105` | L1 hit → `serveCachedPlaces` | no | no |
| 2 | `:1130` → `:1105` | L2 fresh hit | no | no |
| 3 | `:1151` → `:1105` | L2 stale hit (+ background revalidate) | no | no |
| 4 | `:1228` | Compass candidate-cache hit | pre-ranked, not re-ranked | no |
| 5 | `:1270` | Compass cold rank (`rankItemsForDiscovery`) | yes | no |
| 6 | `:1441` | portavaRank path | yes | **yes** (`:1433`) |

**Five of six return before any logging; three of six return before any ranker.**
`logImpression(servedScored, callerUserId, "discovery")` is called at exactly one
place, `:1433`, on exit 6 only.

**5.2 Cache A (L1 + L2) is user-independent and never ranks.**
`cacheKey(dest, cat, radius)` = `` `${dest.toLowerCase().trim()}:${cat}:${radius}` ``
— no user component. `:159-161`, used at `:1025`. L1 is a process-local `Map`
(`:144`); L2 is the Postgres `discovery_cache` table
(DDL at `artifacts/api-server/src/migrations/0168_discovery_cache_ddl.sql`),
written by `lib/discoveryPersistentCache.ts` `writePlacesToDb`, TTL `PLACE_TTL_MS`
= 2 hours. Cold fetch writes the key straight back into both layers at
`:1203-1207`.

**5.3 Cache B (`_compassCandidateCache`) is per-user and stores post-ranking
order, discarding the feature vectors.** Key
`` `${userId}:${destination}:r${radiusKm}:s${sortBy}` `` at `:155-157`; TTL 10
minutes at `:152`; the stored value is `{ places: DiscoveryPlace[]; at: number }`
at `:153` — `DiscoveryPlace`, not `ScoredCandidate`, so the features are gone.
Written at `:1263`, read at `:1223-1231`. Skipped entirely for
`sortBy === "nearest"` (`:1222`, `:1262`).

**5.4 A cached serve produces a DIFFERENT list than the cold fetch that populated
it.** `serveCachedPlaces` re-queries community DB places live and re-merges them
with the cached OSM array on every hit: `queryDbPlaces` at `:1092`,
`mergeAndDedup` at `:1100`, `applyFilters` at `:1101`. Only the OSM array is
cached; the header comment at `:1086-1088` states this deliberately.

**5.5 There is no in-flight deduplication on the places path.**
`_geocodePending` (`:173`, used `:244`, `:263`) dedupes **geocode only**. A
request that finds no L2 row falls straight through to the cold fetch; N
concurrent requests for the same key each perform their own Overpass fetch.
**[CLONE 13dcfe3]** — corroborated at `checkDiscoveryCacheKeys.ts:43-49`
("*There is NO in-flight deduplication on the places path*", naming
`discovery.ts:1124` and `:1155`), and the `_geocodePending` contrast at `:51-53`
("*it exists ONLY for geocode*", naming `discovery.ts:173`, `:244`, `:263`).
`:42` is a banner rule, not prose.

**5.6 On the one path that ranks and logs (exit 6), the creator-linked,
viewer-history and novelty fields of the *DiscoveryRankingService* input vector
are hardcoded constant.** The thirteen fields listed here are the constant ones;
**§5.8(b) lists the fields of the same vector that are not**, and §5.8(a) records
that this applies to the DRS re-rank pass only, not to portavaRank. Neither
half of this may be quoted without the other. `:1350-1382`:

```
creatorId: null (:1353)          isFollowedByViewer: false (:1371)
createdAt: null (:1354)          flagCount: 0 (:1363)
country:   null (:1356)          shareCount: 0 (:1365)
languageCode: null (:1359)       commentCount: 0 (:1366)
isFirstImpression: false (:1381) isUnfamiliarCategory: false (:1381)
accountAgeDays: null (:1380)     repeatCount: null (:1380)
```

and the viewer context at `:1383-1397` passes `seenItemIds: new Set()` (`:1394`),
`lastActiveAt: null` (`:1396`), `lat/lng: null` (`:1390`).

**5.7 Four DRS signals are therefore structurally zero, and the creator cap
never binds.** Each is provable from the callee:

- **relationshipRelevance** — `DiscoveryRankingService.ts:477`:
  `if (!input.creatorId) return 0;` → always 0.
- **activityBoost** — `DiscoveryRankingService.ts:775-777`: with `creatorId`
  null, `activityData = { score: 0, spam_penalty: 0 }`; `calcActivityBoost`
  at `:498` returns 0 for `activityScore <= 0` → always 0.
- **fatiguePenalty** — `DiscoveryRankingService.ts:779-781`: `isFatigued` is
  `false` when `creatorId` is null; `calcFatiguePenalty` at `:537-539` returns 0
  → always 0.
- **explorationBoost** — `DiscoveryRankingService.ts:482-487` requires
  `input.isFirstImpression`, hardcoded `false` → always 0.
- **CreatorCapEnforcer short-circuits** — `CreatorCapEnforcer.ts:104-107`:
  `if (!creatorId) { accepted.push(output); continue; }`. Every item takes this
  branch, so `creatorCounts` never increments and the cap
  (`DEFAULT_MAX_PER_CREATOR = 2`, `:41`) never binds; no
  `ranking_diversity_reordered` row is ever written for discovery.

**[CLONE 13dcfe3]** for all five.

**5.8 ⚠ DIVERGENCE — "the feature vector is hardcoded constant … counts 0" is
imprecise in two ways, and the imprecision matters.**

*(a) It conflates two rankers.* The **portavaRank** call at `:1339` receives a
**real** viewer context: `followedIds` loaded from `user_follows` at `:1295-1299`
and `interestTags` loaded from `compass_user_preferences` at `:1307-1313`,
assembled at `:1317-1322`. The hardcoding at `:1350-1397` applies to the
**DiscoveryRankingService** re-ranking pass only. §5.7 holds precisely because
those five consumers are all DRS-side. Any claim of the form "Discovery ranks on
a constant vector" is wrong; the correct claim is "Discovery's DRS re-rank pass
ranks on a constant vector, while portavaRank does not."

*(b) "counts 0" is not uniform.* Three engagement counts are **derived from
real data**, not zeroed: `saveCount: p.savedCount ?? 0` (`:1364`),
`impressionCount: Math.max(1, p.savedCount ?? 1)` (`:1367`),
`uniqueViewerCount: p.savedCount ?? 0` (`:1368`), plus `hasMedia` (`:1360`),
`completeness` (`:1361`), `positiveReviewRate` from `rating` (`:1362`),
`tags`/`category`/`distanceKm`/`lat`/`lng`. Note `impressionCount` is floored at
1 using `savedCount` — a saved-count proxy standing in for an impression count.
Only the *creator-linked, viewer-history and novelty* fields are constant.
**[CLONE 13dcfe3]**

**5.9 The DRS pass is fire-and-forget and order-only.** `drsRankItems` failure
is caught at `:1420` and the portavaRank order is preserved; the cap and slot
analytics at `:1411-1419` are explicitly "fire-and-forget side effects that emit
`rank_events` rows; they never affect feed order" (`:1408-1410`).
**[CLONE 13dcfe3]**

**5.10 Compass on discovery is gated by `COMPASS_V1_RULE_BASED_ENABLED`**, read
through `compass/flags.ts` `isEnabled` at `:1215`, and only for
`category === "for_you"` with an authenticated caller (`:1211`). Any throw falls
through to the rule-based path (`:1274`). **[CLONE 13dcfe3]**

---

## 6. FEATURE FLAGS

**6.1 The `COMPASS_%` prefix filter.** `compass/flags.ts` loads flags with
`.like("flag","COMPASS_%")`. A `DISCOVERY_*` flag asked of **this loader**
returns `false` forever, with no error, and "unseeded" is indistinguishable from
"deliberately off". **[CLONE 13dcfe3]** —
`artifacts/api-server/src/compass/flags.ts:26-29` (the query), `:51-54`
(`return flags[flag] ?? false`), `:35-37` (`catch { return {}; }` — an error is
also indistinguishable).

**6.2 The same loader cannot read `metadata`.** It selects only
`("flag, enabled")` (`compass/flags.ts:26-28`), caches
`Record<string, boolean>` (`:12`), and `isEnabled` returns `boolean` (`:51`).
So although cohort/percentage targeting is expressible in `metadata` with no
schema change (§3.4), **the discovery path's current loader cannot see it.**
**[CLONE 13dcfe3]**

**6.3 `DISCOVERY_*` flags are not universally broken — only through that loader.**
`compass/CompassFeedBuilder.ts:497` and `:606` read
`DISCOVERY_DIVERSITY_ENABLED` through `lib/featureFlags.ts` `isFlagEnabled`,
which does `.eq("flag", flag)` with no prefix filter and works fine.
**[CLONE 13dcfe3]** — `lib/featureFlags.ts:14-26`. §6.1 must always be stated
with "through `compass/flags.ts`" attached.

**6.4 ⚠ DIVERGENCE — there are more than three flag loaders.** Three are shared:

| Loader | Scope | Cache | Failure direction |
|---|---|---|---|
| `lib/featureFlags.ts` `isFlagEnabled` (`:14-26`) | one flag, `.eq` | none | `false` on error |
| `lib/featureFlags.ts` `getFlagRow` (`:32-50`) | one flag, `+ metadata` | none | `null` on error |
| `compass/flags.ts` `getFlags`/`isEnabled` (`:41-54`) | `COMPASS_%` only | process-wide, 30 s TTL (`:9`) | `{}` → every flag `false` |
| `routes/featureFlags.ts` (`:20-35`) | whole table, public `GET /api/feature-flags` | none | HTTP `db_error` |

…and at least **four more private re-implementations** exist, each with its own
error behaviour: `lib/safeReturnScheduler.ts:33-46`,
`lib/accountDeletionScheduler.ts:33-45`, `routes/passportStamps.ts:56-70`
(whose comment at `:66-68` records that *this local copy previously failed
OPEN*, an inconsistency since corrected), and `lib/rankLog.ts:30-40`
`isFatigueEnabled`, which carries **its own private TTL cache**
(`_fatigueFlagCachedAt` / `FATIGUE_FLAG_TTL_MS`, `:31`) — a fifth cache with a
fifth expiry, independent of `compass/flags.ts`'s 30 s one. Beyond those, ~13
call sites query `from("feature_flags")` inline
(`lib/stamps/generationWorker.ts:518,630`,
`lib/stamps/criteria/index.ts:33`, `lib/creatorActivityScoreScheduler.ts:68`,
`lib/fsq/fsqPlaces.ts:133`, `compass/CompassPipeline.ts:81`,
`compass/CompassFrontLoadEngine.ts:287`, `compass/CompassNotificationEngine.ts:299`,
`compass/CompassSearchDecayService.ts:142`, and five scripts).
**[CLONE 13dcfe3]** — "three loaders" understates the problem; state it as
**"four shared entry points and at least four private re-implementations"**, and
use that phrasing everywhere (§10.2 item 4 asks the question in the same terms).
**Exactly two** of these carry a cache, and the two expiries are independent:
`compass/flags.ts` 30 s (`:9`) and `lib/rankLog.ts` `FATIGUE_FLAG_TTL_MS`
(`:31`). `lib/featureFlags.ts` has **none** — an absent cache is not a third
independent cache. The consequence stands on the two that exist: two code paths
reading the same flag can disagree for the length of the longer TTL.

**6.5 `lib/featureFlags.ts` additionally implements a flag *hierarchy*.**
`LIVE_PLACES_REQUIREMENTS` (`:57-68`) makes ten Live-Places flags conjunctions
of their parents; `resolveFeatureFlags` (`:70-78`) applies it, and the public
route applies it before responding (`routes/featureFlags.ts:35`). A flag read
directly via `isFlagEnabled` **does not** get this resolution. **[CLONE 13dcfe3]**

**6.6 Eleven distinct emergency-stop flags are read through `isFlagEnabled`, at
18 call sites.** **[CLONE 13dcfe3]** —
`disable_unknown_message_requests` (`routes/messaging.ts:426`),
`disable_messaging` (`:1682`, `:1996`),
`disable_media_uploads` (`:2000`, `routes/postcards.ts:381`, `routes/posts.ts:92`,
`routes/profile.ts:1019`, `:1092`, `routes/events.ts:5285`),
`disable_location_sharing` (`routes/location.ts:94`),
`disable_rent_buddy_booking` + `disable_rab_bookings` (`routes/rentABuddy.ts:1005-1006`),
`disable_profile_search` (`routes/follows.ts:535`),
`disable_posting` (`routes/posts.ts:339`),
`disable_new_event_creation` (`routes/meetups.ts:133`),
`disable_signups` (`routes/auth.ts:124`, `:170`),
`disable_tagging` (`routes/tags.ts:59`).

⚠ **CORRECTION 2026-08-10 — there are TWELVE, not eleven, and 21 call sites, not
18.** This entry's list is built on the `disable_*` PREFIX and therefore misses
`find_your_circle_disabled`, which uses the `*_disabled` SUFFIX and is read at
three further sites in `lib/circleAccessGuard.ts` (one per guard function:
`canViewCirclePresence`, `canBeSeenByViewersBatch`, `canViewCirclePresenceBatch`).
It is seeded by `0108_circle_schema_tracked.sql:99` with the description
*"Emergency kill switch — disables all Find Your Circle endpoints"*, so it is a
stop by its own declaration and belongs in this count.

The omission matters more than the corrected number: **a naming convention was
used as the population filter, and the one flag that spells the convention
backwards fell out of the census.** That is the same blind spot
`scripts/check-flag-polarity.mjs` was built to close, and the reason it keys on an
enumerated flag inventory rather than a `disable_*` pattern. The check reports
**12 STOP** flags, which is this corrected number. **[LIVE 719b8431e]** — the
three `circleAccessGuard.ts` sites were read live; their clone-era line numbers
are **[UNVERIFIED]**.

**6.7 At 13dcfe3 those stops still disengage when the DB is unhealthy.**
`isFlagEnabled` returns `false` on error (`lib/featureFlags.ts:21`, `:24`). For a
*capability* gate false-on-error is fail-closed, and the file's header says so
(`:4-5`). For a `disable_*` gate, `false` means **"do not stop"** — so a DB
outage disengages all eleven. `0065_phase7_safety.sql:40-41` states this was the
original intent (*"fail-open (feature stays ON) on DB errors"*).
**[CLONE 13dcfe3]**

**6.8 SETTLED 2026-08-10. Eleven stop flags were converted at `c89f09a77`, across
20 `isFlagEnabled` calls at 19 guard sites. The conversion did NOT change
`isFlagEnabled`; it added a separate stop-specific reader.** **[LIVE c89f09a77]**
— verified by reading the live tree, superseding this entry's previous
**[UNVERIFIED]** on which call sites changed.

`lib/featureFlags.ts` now exports `isKillSwitchEngaged` alongside the unchanged
`isFlagEnabled`. Its contract, which is the whole point of the split:

- a query **error** → returns `true` (state unknown → the stop ENGAGES);
- a **missing row** (`maybeSingle()` gives `data=null, error=null`) → returns
  `false` (no stop configured → it does NOT engage).

The second half is load-bearing: inverting it would turn every unseeded flag into
an outage. `isFlagEnabled` keeps false-on-error, which remains correct for
capability gates (§6.7).

The 11 flags across 19 guard sites (20 calls — `disable_media_uploads` is six
sites, and `routes/rentABuddy.ts` reads two flag names in one `if`):
`disable_media_uploads` (`routes/posts.ts`, `routes/events.ts`,
`routes/profile.ts` ×2, `routes/postcards.ts`, `routes/messaging.ts`),
`disable_messaging` (`routes/messaging.ts` ×2),
`disable_unknown_message_requests` (`routes/messaging.ts`),
`disable_posting` (`routes/posts.ts`),
`disable_signups` (`routes/auth.ts` ×2 — the enforcement gate and the
`/auth/signup-status` advisory endpoint),
`disable_location_sharing` (`routes/location.ts`),
`disable_new_event_creation` (`routes/meetups.ts`),
`disable_profile_search` (`routes/follows.ts`),
`disable_rent_buddy_booking` + `disable_rab_bookings` (`routes/rentABuddy.ts`,
one guard), `find_your_circle_disabled` (`lib/circleAccessGuard.ts` ×3).

⚠ **§6.9's eleven and this entry's eleven are DIFFERENT SETS. Do not reconcile
them by counting.** §6.9's eleven are the eleven *rows* seeded by `0065`, which
include the four `freeze_*` flags and exclude everything seeded by `0117` and
`0108`. This entry's eleven are the flags *converted* at `c89f09a77`. They differ
in both directions:

- in §6.9, not here: the four `freeze_*` flags — never converted because they
  have no reader to convert (§6.10);
- here, not in §6.9: `disable_signups`, `disable_posting`, `disable_messaging`,
  `disable_rent_buddy_booking` (seeded by `0117:31-34`) and
  `find_your_circle_disabled` (seeded by `0108_circle_schema_tracked.sql:99`);
- in §6.9 and §6.6, not here: `disable_tagging`, converted in an earlier commit
  and already reading through `isKillSwitchEngaged` at `c89f09a77`.

Twelve distinct stop flags exist in total (§6.6 ⚠ correction). The arithmetic
that reconciles all three entries: §6.6's 18 clone-era call sites, minus the one
`disable_tagging` site converted earlier, plus the three
`find_your_circle_disabled` sites §6.6 omits, gives the 20 calls converted here.

**6.8a This was a deliberate reversal of a documented decision, not a bug fix.**
`0065_phase7_safety.sql:39-41` (clone numbering) stated the fail-open behaviour as
intent: *"Routes gate on these flags and fail-open (feature stays ON) on DB errors
so a DB outage never silently locks users out of the app."* That is the original
author choosing "users keep working during an outage" over "the stop holds during
an outage". `c89f09a77` reversed that choice for the eleven, accepting the
lock-out risk in exchange for the stop actually stopping, and its commit message
framed the prior behaviour as a defect. **That framing was wrong on this point;
the trade-off was explicit, not accidental.** The reversal is still the right call
— an emergency stop that disengages when the database is unhealthy is not a stop —
but the record should show a decision overturned, not an oversight corrected. The
migration comment has been marked SUPERSEDED in place rather than deleted, so the
original trade-off stays visible where the next reader meets it.
**[LIVE 719b8431e]**

**6.9 The emergency flags are seeded `false` by two migrations, not one.**
**[CLONE 13dcfe3]**

- `0065_phase7_safety.sql:42-54` — one `INSERT … ON CONFLICT (flag) DO NOTHING`
  whose eleven value rows are `:43-53`: seven of the §6.6 stops
  (`disable_unknown_message_requests` `:43`, `disable_new_event_creation` `:44`,
  `disable_rab_bookings` `:45`, `disable_tagging` `:46`,
  `disable_location_sharing` `:47`, `disable_profile_search` `:48`,
  `disable_media_uploads` `:49`) **plus** the four `freeze_*` flags at
  `:50-53` (`freeze_city` `:50`, `freeze_event` `:51`, `freeze_circle` `:52`,
  `freeze_booking` `:53`).
- `0117_beta_feature_flags.sql:31-34` — the remaining four §6.6 stops:
  `disable_signups` `:31`, `disable_posting` `:32`, `disable_messaging` `:33`,
  `disable_rent_buddy_booking` `:34`.

The earlier citation `0065…:42-50` was wrong in both directions: it stopped
inside the row list at `freeze_city` while naming three flags seeded outside it,
and it implied 0065 seeds all eleven of §6.6's stops, which it does not — the
eleven rows in 0065 are a *different* set of eleven from §6.6's eleven.

`freeze_city`/`freeze_event`/`freeze_circle`/`freeze_booking` carry their target
IDs in `metadata` per the migration's own comment at `0065_phase7_safety.sql:34-35`.
**[CLONE 13dcfe3]**

⚠ **CORRECTION 2026-08-10 — "the original and only in-tree consumer of the
`metadata` column" is withdrawn. There is no consumer.** The migration comment
*declares* where the target IDs are to be stored; nothing reads them. The only
function in the tree that selects the column is `lib/featureFlags.ts` `getFlagRow`
(`select("enabled, metadata")`), and it has **zero callers** outside its own
definition:

```
grep -rn "getFlagRow" --include='*.ts' artifacts/api-server/src \
  | grep -vE '(\.test\.ts|/__tests__/|featureFlags\.ts)'
  → no output
```

`getFlagRow` is itself uncalled, so the parameterised-emergency-flag mechanism is
inert end to end: no reader for the four flags (§6.10), and no reader for the
column they were given to carry their targets. **[LIVE 719b8431e]**

**6.10 The four `freeze_*` flags are operator-visible emergency stops with no
reader anywhere in the repository.** `0065_phase7_safety.sql:39` heads their
INSERT block *"These are kill-switches for safety incidents"*, and each row
describes itself as an emergency control: *"Emergency: freeze city-scoped
features"* (`:74`), *"…freeze a specific event"* (`:75`), *"…freeze a specific
circle"* (`:76`), *"…freeze a specific booking"* (`:77`). Nothing reads them.
Repo-wide, every extension, excluding the seeding migration itself:

```
grep -rn "freeze_city\|freeze_event\|freeze_circle\|freeze_booking" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  --include='*.sql' . | grep -v node_modules | grep -v 0065_phase7_safety.sql
  → no output
```

They are seeded `false` (§6.9), they appear in the admin flag list (the public
`GET /api/feature-flags` returns the whole table, §6.4), and an operator can
toggle them. Toggling them has no effect on any code path.

**The consequence, and why this is a §6 entry rather than a curiosity:
mid-incident, an operator-visible stop with no reader is indistinguishable from
the failure the other eleven had (§6.7).** In both cases the operator flips the
switch and the thing they are trying to stop keeps happening. §6.7's eleven failed
that way only while the database was unhealthy; these four fail that way always.
Same class as the FL-06 orphan recorded in-tree at `routes/rentABuddy.ts`
(*"`disable_rab_bookings` was an orphan with no reader, so that admin toggle was a
silent no-op"*) — that one was given a reader; these four were not.

⚠ Those `0065` line numbers are **post-edit**. The SUPERSEDED block described in
§6.8a was inserted into that file's comment header in the same change, moving the
rows down by 24 lines; §6.9's `[CLONE 13dcfe3]` citations (`:50-53`) remain
correct for the clone and must not be "corrected" to match these.

⚠ **TAG NOTE — this entry is `[LIVE 719b8431e]`, not `[CLONE 13dcfe3]`.** It was
requested as `[CLONE 13dcfe3]`; that tag cannot honestly be applied, because
`13dcfe3` is not a reachable object in this repository (`git cat-file -t 13dcfe3`
→ *"Not a valid object name"*). The greps above were run against the live working
tree. Applying a clone tag to a live observation would be exactly the provenance
defect this document exists to prevent. A reader with the clone should re-run both
greps there; the seeding migration is old enough that the result is very unlikely
to differ, but "unlikely to differ" is not a tag.

**6.11 `check:flag-polarity` originally could not see a flag that is seeded but
never read; a second population was added to close that.**
`scripts/check-flag-polarity.mjs` (added at `88e2b4fe3`) built its inventory from
flag *reads* under `src/`, so a flag with no read site never entered the
population and was never asked to carry a classification. It enforced *"every flag
that is read is classified and read through the reader its class demands"* but not
*"every flag that is declared has a reader"*. §6.10 is the instance that exposed
it.

**RESOLVED — a second population now scans `INSERT INTO feature_flags` across
`src/migrations/` and requires every seeded name either to be read or to carry an
`INERT_SEEDED_FLAGS` entry with a reason and a disposition** (`write-reader`,
`remove-from-seed`, or `owner-decision`). Current state: **131 flags seeded across
264 migrations (47 INSERT statements) — 78 read, 46 declared inert.** The four
`freeze_*` entries are `owner-decision` with both remedies named.
**[LIVE — this session; the commit adding INERT_SEEDED_FLAGS]**

⚠ **The second population immediately found four defects in the first**, which is
the argument for having both:

1. `compass/flags.ts` `isEnabled` was **not in the reader list at all** — a fourth
   shared reader, missed. It reads `COMPASS_V1_RULE_BASED_ENABLED` at
   `routes/discovery.ts:1215` and `COMPASS_TELEGRAPH` at `routes/compass.ts:3490`;
   both flags were invisible to the check until it was added.
2. `COMPASS_TELEGRAPH` is **read but seeded by no migration**, so through the
   `COMPASS_%` loader it is permanently `false` and indistinguishable from
   deliberately-off — the trap §6.1 records, now with a named instance.
3. The `purposeFlag(req.purpose)` declaration claimed the function returns *one of
   two* flag names. It returns **three** — `lib/visuals/service.ts:99` also returns
   `ai_trip_covers_enabled`. The prose was wrong; a machine-checked `covers` list
   now holds the enumeration.
4. `RENT_BUDDY_MVP_MODE` is read through a **private `getFlag` helper** at
   `routes/rentABuddyRollout.ts:233` that the reader scan did not recognise.

**6.12 `push_notifications_enabled` is admin-WRITABLE and read by nothing.**
`routes/notifications.ts:642` maps it into the admin toggle map as
`pushNotificationsEnabled: 'push_notifications_enabled'`, so an admin request
updates the row; nothing reads it, and push delivery runs unconditionally. A worse
shape than the `freeze_*` four: those are switches nobody wired, this is a switch
someone deliberately surfaced in the admin API and still nobody wired. It produces
*"I turned push off and it kept sending"*. **[LIVE 719b8431e]**

---

## 7. MEDIA AND UPLOAD OWNERSHIP

**7.1 Sharp's re-encode is what strips metadata.** `lib/mediaProcessing.ts`
`processImage` auto-orients from EXIF, caps the longest edge, and strips ALL
metadata (EXIF/GPS/XMP) as a side effect of re-encoding. **[CLONE 13dcfe3]** —
`lib/mediaProcessing.ts:7-8`, `:74`, `:85`.

**7.2 Three upload paths skip that re-encode.** **[CLONE 13dcfe3]**:

**(a) `routes/postcards.ts` signed-upload.** The server issues
`createSignedUploadUrl(storagePath)` at `:473-475` and the client PUTs raw bytes
directly to storage — the server never sees them. The strip happens **only in the
completion handler**, which downloads, sniffs, `processImage`s and re-uploads
with `upsert: true` at `:569-591`. The handler's own comment at `:560-565`
states the reason. **An abandoned compose never reaches completion, so the
un-stripped original stays in the bucket** for as long as nothing removes it.
For the sweeper question see **§7.15**, which is where that evidence lives; the
word "permanently" is **not** established by either entry — see §10.4.

⚠ **CORRECTION, 2026-08-10 — FALSE EVIDENCE WITHDRAWN.** An earlier revision of
this entry stated, under a `[CLONE 13dcfe3]` tag, that a grep for
`processing_status` outside tests "returns only `routes/adminMedia.ts:63` (a
read/list) and `routes/postcards.ts:449` (the write)". **That is false, was never
reproducible, and must not be cited.** Re-run in the clone this session:

```
grep -rn "processing_status" --include='*.ts' artifacts/api-server/src \
  | grep -vE '(\.test\.ts|\.spec\.ts|/__tests__/|/tests?/)'
  → 60 hits in 17 files
```

The filter matters: excluding by *file path* as above gives 60/17; the looser
`grep -vi test`, which drops any matching line containing the word, gives 59/16
(it additionally hides `scripts/seed-test-media.ts`). Quote the command with the
count. Hits by file: `routes/postcards.ts` 10, `routes/posts.ts` 9,
`scripts/checkMediaObjects.ts` 6, `lib/database.types.ts` 6, `routes/passport.ts`
5, `routes/pulse.ts` 4, `routes/featured.ts` 4, `routes/adminMedia.ts` 3,
`lib/mediaFeedItem.ts` 3, `scripts/backfill-media-assets.ts` 2,
`routes/mediaFeed.ts` 2, and one each in `scripts/seed-test-media.ts`,
`scripts/seed-demo-social.ts`, `lib/mediaEligibility.ts`, `lib/mediaAssets.ts`,
`lib/mediaAnalytics.ts`, `lib/mediaAccess.ts`. **[CLONE 13dcfe3]**

The most consequential omission was `lib/mediaAccess.ts:216`, which selects
`processing_status` inside the **authorization** path (§8.7) — the column
participates in an access decision, so no claim of the form "nothing else reads
this column" may be made.

**The no-sweeper conclusion survives, on different evidence and stated once, at
§7.15**: no scheduled deleter, and nothing that can enumerate a bucket. It is
re-derived there from the `.remove(` call inventory, not from this grep. The grep
was never evidence for it — a column being read in few places says nothing about
whether anything deletes objects.

**(b) `routes/posts.ts` HEIC fallback.** On `processImage` throw, a
`image/heic` file is stored verbatim: `uploadBuf` stays `rawBody` (`:129`) and
the catch at `:156-160` warns and falls through rather than rejecting. Any other
image type is rejected as corrupt at `:161-166` — the comment there notes
storing it *"would also skip the GPS strip"*. The upload at `:173-175` sends
`uploadBuf`.

**(c) `routes/stampCatalog.ts` admin `imageBase64`.** `POST
/admin/stamps/catalog/:id/upload` accepts a base64 body (`:971`), validates only
the **client-declared** `mimeType` against an allowlist (`:973`, `:981-984`),
applies the size check at `:987-990`, then uploads the raw buffer with **no
`sniffMedia` and no `processImage`** at `:996-998` — into `stamp-artwork`, the
public bucket (§8.1), returning a public URL at `:1005`.

⚠ **The declared 5 MB cap is unreachable — do not cite "5 MB" as this endpoint's
limit.** `MAX_SIZE_BYTES = 5 * 1024 * 1024` is declared at `:974` and checked at
`:987-990`, but `app.ts:129` installs `express.json({ limit: "256kb" })` globally
and the API router is mounted after it at `app.ts:168`, so a JSON body carrying
5 MB of base64 (~6.7 MB) is rejected by the body parser before the handler runs.
The effective ceiling is ~256 KB of JSON ≈ **~190 KB of image bytes**.
**[CLONE 13dcfe3]** An earlier revision of this entry recorded the 5 MB figure as
plain current state; that reading is superseded here.

**7.3 EXIF/GPS census: 293 image objects, 9 carry EXIF, ZERO carry GPS, 42
unreachable from any render path, nothing written.**
**[DB 2026-08-10 · project not recorded]** — prior session, live. No clone anchor
exists for any of these five numbers **and the report did not say which project
was censused**, which matters here more than elsewhere: a census of the CI
project would say nothing about production's corpus. See §10.3.
⚠ Do not conflate this with §7.4: different population, different date.

**7.4 A separate, earlier reconciliation found 116 `post_media` rows all reading
`processing_status='ready'` while 114 pointed at storage objects that do not
exist**, on published/public posts with `public_url` populated, undetected for
three weeks. **[CLONE 13dcfe3]** for the record of it —
`artifacts/api-server/src/scripts/checkMediaObjects.ts:1-14`, dated 2026-08-09
in that header. The check exists because `processing_status` records what the
pipeline *believed*, never what is in the bucket.

---

### §7.5 – §7.24 — the ingest census

⚠ This heading read "§7.5 – §7.20" until 2026-08-10 while the section already ran
to §7.23. A new entry numbered from the heading collides with a live entry — §7.21
is cited four times by `upload-ingest-consolidation.md`. Number from the last
entry, not from the heading.

Added 2026-08-10. **Paths in §7.5–§7.20 are relative to `artifacts/api-server/src/`
unless written out from the repo root.** Every entry is **[CLONE 13dcfe3]** unless
its own tag says otherwise, and every line number was read in the clone.

**7.5 `lib/mediaProcessing.ts` already contains the four primitives a canonical
ingest path would need.** `sniffMedia(buf)` — magic-number sniff, `null` on no
match, `:31-57`. `processImage(input, sniffed, maxDim)` — `sharp(...).rotate()
.resize(...)` then a format re-encode, `:80-104`. `makeThumbnail(processed)`,
`:107-113`. `computePHash(input)` — fail-soft, `null` on any sharp error,
`:129-157`. The metadata strip is a **side effect of re-encoding**, not an
explicit call: the file header asserts sharp "strips metadata by default on
re-encode" (`:7-13`). There is no `.withMetadata()` in the pipeline and no strip
assertion anywhere. **[CLONE 13dcfe3]**

**7.6 Exactly three route modules import `mediaProcessing`:** `routes/postcards.ts:23`,
`routes/posts.ts:44`, `routes/profile.ts:11`. That import list is the map of what
is and is not covered by the re-encode. **[CLONE 13dcfe3]**

**7.7 Videos are not transcoded in this tier** — sniffed and size-capped only;
`lib/mediaProcessing.ts:17-18` states the limitation. **[CLONE 13dcfe3]**

**7.8 Eight entry points write bytes to storage.** Established by grepping every
`.storage.from(...).upload(...)` and `.createSignedUploadUrl(...)` call in the
server tree and reading each call site. **[CLONE 13dcfe3]** for every anchor;
bucket-privacy column is **[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb`]**
per §8.1, and applies to production only.

| # | Entry point | Anchor | Server sees bytes? | sharp re-encode? | Bucket |
|---|---|---|---|---|---|
| A | `POST /api/media/upload` | `routes/posts.ts:75-76` | yes (raw body) | yes, except the §7.2b HEIC fallback | `post-media` |
| B | `POST /api/me/avatar/upload` | `routes/profile.ts:1002-1003` | yes | yes | `profile-media` |
| C | `POST /api/me/cover/upload` | `routes/profile.ts:1075-1076` | yes | yes | `profile-media` |
| D | `POST /api/postcards/:id/media/upload-url` | `routes/postcards.ts:369`, signed URL `:473-475` | **no** | **no, not at this step** | `post-media` |
| D′ | `POST …/media/:mediaId/complete` | `routes/postcards.ts:513`; download `:571`, sniff `:574`, `processImage` `:576`, re-upload `upsert:true` `:577-579` | yes, **after** the object exists | yes, in place | `post-media` |
| E | `POST /admin/stamps/catalog/:id/upload` | `routes/stampCatalog.ts:961`, upload `:996-998` | yes (base64 JSON) | **no** (§7.2c) | `stamp-artwork` |
| F | `POST /admin/stamps/catalog/:id/recompose` | `routes/stampCatalog.ts:1120`, `:1122` | server-generated raster | n/a | `stamp-artwork` |
| G | Stamp generation worker | `lib/stamps/generationWorker.ts:484-488` (`uploadBufferToPath`), callers `:969-978` | provider bytes | hero buffer stored **as-is** | `stamp-artwork` |
| H | AI visuals service | `lib/visuals/service.ts:425-427` | provider bytes | yes — `buildDerivatives` re-encodes to WebP, `lib/visuals/derivatives.ts:43-55` | `post-media` or `AI_VISUAL_BUCKET` (`lib/visuals/service.ts:66`) |

**7.9 There are no multipart handlers in the server.** No `multer`, `busboy` or
`formidable`; the only two "multipart" hits are comments at
`routes/stampCatalog.ts:19` and `:970`. Bytes enter by exactly three mechanisms:
a hand-rolled raw-body collector (A/B/C), a base64 JSON field (E), or a signed
storage URL the server never sees (D). **[CLONE 13dcfe3]**

**7.10 The raw-body collectors buffer the entire body in memory before the
handler runs.** `routes/posts.ts:77-82` and `routes/profile.ts:1004-1009` are the
same four-line `req.on("data")` / `Buffer.concat` shape. Entry point A's declared
video ceiling is 100 MB (`routes/postcards.ts:29` for the postcard path's
constant). **[CLONE 13dcfe3]**

**7.11 The §7.2b HEIC fallback is reachable by choosing twelve bytes.**
`sniffMedia` classifies *any* `ftyp` box whose brand starts `hei` or `mif` as
`image/heic` (`lib/mediaProcessing.ts:46-50`). A crafted file with that brand
that sharp cannot decode takes the store-raw branch at `routes/posts.ts:157-160`
rather than the reject branch at `:161-166`. The gap is HEIC-specific and the
comment at `:158-159` says it is deliberate. **[CLONE 13dcfe3]**

**7.12 On the HEIC fallback the server tells the client the file was not
processed and stores it anyway.** `processed` stays `false`
(`routes/posts.ts:135`, image branch entered at `:138`) and is returned in the
response; `width`/`height` stay `null`, no thumbnail is built, and `phash` stays
`null`, so the dedup worker skips the row (`routes/posts.ts:154`;
`startMediaDedupWorker` at `index.ts:143`). **[CLONE 13dcfe3]**

**7.13 The postcard signed-upload window, stated as a sequence.**
**[CLONE 13dcfe3]**:

```
t0  POST …/media/upload-url   → post_media row inserted processing_status='pending',
                                moderation_status='pending'  (postcards.ts:449-450)
                                storagePath built at :463, signed URL at :473-475
t1  client PUT → storage      → OBJECT EXISTS. Raw client bytes. Server saw none of them.
      ┌──────────── the window ────────────┐
t2  POST …/complete           → download :571, sniff :574, processImage :576,
                                re-upload upsert:true :577-579 — window closes
```

The pending row is inserted **before** the signed URL is issued, so every
pre-completion object has a row pointing at it.

**7.14 `t2` is not bounded by latency; it is bounded by whether the client
finishes.** In the canonical client
(`travel-buddy-standalone/src/components/PostcardComposer.tsx:317-321`), a failed
`completeUpload` calls `setError(...)`, `setPhase('pick')` and **returns** —
no cleanup call, no retry, no delete. **[CLONE 13dcfe3]**
⚠ The legacy tree `artifacts/travel-buddy/` (§1.2) contained a near-identical copy (archived at `bc1bef404`);
the two `PostcardComposer.tsx` files **differ**, at lines 29 and 779 only (a
theme-token import and an avatar size constant). `src/services/postcards.ts` is
byte-identical between the trees. Cite the standalone path.

**7.15 Nothing in the server sweeps storage objects by media state.**
**[CLONE 13dcfe3]**, established by enumerating every `.storage.from(...).remove(...)`
call in the server tree (eleven, excluding tests):
`routes/adminMedia.ts:338`, `routes/admin.ts:1539`, `routes/memories.ts:663`,
`routes/postcards.ts:787`, `routes/stories.ts:635`, `routes/profile.ts:746`,
`:1158`, `:1185` — all user- or admin-initiated deletes;
`lib/stamps/generationWorker.ts:1092` — that worker's own failure rollback;
`services/accountDeletion/AccountDeletionService.ts:186` — reached from a
scheduler (`lib/accountDeletionScheduler.ts:24`) but keyed on a **deleted
account**, never on media processing state; `lib/storagePath.ts:41` is a doc
comment, not a call. There is no `.storage.from(...).list(...)` call anywhere
outside `scripts/`. `index.ts:66-198` starts the schedulers and workers; none of
them selects `post_media` by `processing_status`. Five of those start calls are
named `*Sweeper` — `startZombieTokenSweeper` (`index.ts:80`),
`startEventWaitlistSweeper` (`:81`), `startInviteSlotSweeper` (`:90`),
`startXXCatalogSweeper` (`:123`), `startRankingFatigueSweeper` (`:160`) — so the
scheduled-sweeper shape is well established in this tree; none of the five
touches storage. `routes/adminMedia.ts:57-65`
filters `processing_status IN ('failed','error','processing','pending','queued')`
— an admin **report** over rows, not a sweeper, and it enumerates rows, not
objects.

**Scope of this entry, stated so it is not over-read.** It establishes that
**this clone contains no automatic sweeper**: no scheduled job deletes by media
state, and no code path can discover an object it does not already hold a row
for. It does **not** establish that an abandoned object survives indefinitely —
that is a claim about the live bucket, not about the tree, and three things
outside the clone could end retention: Supabase-side lifecycle configuration, an
operator invoking `routes/adminMedia.ts:338` by hand, and the live tree at
`c89f09a77`. **The word "permanently" is not licensed by this entry**; it is
**[UNVERIFIED]** and is carried as an open question at §10.4.

**7.16 A pre-completion abandoned object is invisible to both halves of
`scripts/checkMediaObjects.ts`.** The script runs two reconciliations: dangling
rows (`post_media` rows whose object is missing, `:118-135`) and orphan objects
(objects with no `post_media` row, `:137-146`). An abandoned pre-completion
object is neither — its row exists (§7.13, inserted at `postcards.ts:449`) and
the object exists. The orphan count is computed at `:137-146` and **not failed
on**, so it is printed and dropped. **[CLONE 13dcfe3]** The header's own
statement of the class of blindness is at `:6-13`; the sentence "it simply cannot
see the bucket" is at `:11-12`.

**7.17 `thumbnailPath` is client-supplied, size-bounded only, and unscoped.**
`completeSchema` accepts `thumbnailPath: z.string().max(500).optional()`
(`routes/postcards.ts:508`); it is concatenated into `thumbnail_url` at `:595-596`
and written to `thumbnail_storage_path` at `:632` with no ownership-prefix check
and no sniff. The canonical composer's `completeUpload` payload
(`travel-buddy-standalone/src/components/PostcardComposer.tsx:307-315`) does not
include the field, so no shipped client sends it. **[CLONE 13dcfe3]**

**7.18 On the postcard path the stored `mime_type`, the object `contentType` and
the path extension can all disagree.** `routes/postcards.ts:625` writes
`mime_type: p.mimeType` — the client's declared value — while `:579` re-uploaded
the object with `contentType: img.mime`, and the path extension was fixed at
`:463` from the declared MIME. `processImage` converts HEIC to JPEG
(`lib/mediaProcessing.ts:95-99`), so a HEIC input yields JPEG bytes with
`contentType: image/jpeg` at a path ending `.heic` with a DB row saying
`image/heic`. **[CLONE 13dcfe3]**

**7.19 `appStorageUrlInfo` validates bucket and origin, not ownership.**
`lib/mediaUrl.ts:30-70` (the file is 70 lines). Allowed buckets are `post-media`
and `profile-media` (`:11`); a full URL must match the `SUPABASE_URL` origin
(`:37-52`); a bare `<bucket>/<path>` form is also accepted (`:62-69`); `..` is
rejected (`:44`, `:68`). **No check ties the path to the calling user.** The
module header names "other users' objects by guessed URL" among the holes it was
written to close (`:5-8`). Three reference endpoints depend on it:
`routes/messaging.ts:2007`, `routes/events.ts:5299`, and the `appMediaRef` zod
refinement at `lib/postSchemas.ts:58-71`, whose comment at `:48-56` records three
legacy reference shapes accepted "during migration". **[CLONE 13dcfe3]**

**7.20 `ensureStorageBucket` creates buckets with `public: true`.**
`routes/profile.ts:49-55`, `createBucket(bucket, { public: true })` at `:51`; it
is invoked on every avatar upload (`:1044`) and every cover upload (`:1117`), and
its error path only warns (`:52-54`). It is a no-op today because
`profile-media` already exists as `public=false` (§8.1). In any project where the
bucket does not yet exist, the first avatar upload creates it **public**.
**[CLONE 13dcfe3]**

**7.21 `disable_media_uploads` is checked on A, B, C and D, and not on E.**
`routes/posts.ts:92`, `routes/profile.ts:1019`, `:1092`, `routes/postcards.ts:381`;
`routes/stampCatalog.ts:961-1006` contains no flag check. **[CLONE 13dcfe3]**
For the failure direction of that check see §6.7 and §6.8.

**7.22 `lib/storagePath.ts` already uses the discriminated-result pattern for a
different invariant.** `StorageRef` is a four-arm union at `:40-48`
(`path` / `external` / `none` / `unresolvable`), and the header at `:32-37`
states the reason: "nothing to delete" and "I could not work out what to delete"
must never be collapsed. **[CLONE 13dcfe3]**

**7.23 The canonical client gets byte-level upload progress from XHR.**
`travel-buddy-standalone/src/services/postcards.ts:240-283` — `xhr.upload`
`progress` listener at `:265-267`, `xhr.open('PUT', signedUrl)` at `:280`. This
file is byte-identical in the legacy tree. **[CLONE 13dcfe3]**

---

**7.24 URL-shape histogram of the durable media URL columns: SIX rows across the
whole database hold an absolute public storage URL.**
**[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb`]** — produced by
`src/scripts/auditMediaUrlShapes.ts` through the read-only production front door
(§9.4); the script prints the ref it queried, which is what makes this tag valid
rather than void under the rule at the top of this document. Counts only: every
column is consumed by a `CASE` inside SQL and never appears in a select list, so
no URL value left the database.

Columns censused: `events.cover_url`, `trips.cover_url`, `post_media.public_url`,
`post_media.feed_url`, and `unnest(posts.media_urls)` (per element, not per post).

⚠ **THE PER-COLUMN BREAKDOWN IS NOT RECORDED HERE AND MUST BE PASTED IN.** The
figure this entry carries is the TOTAL — `absolute_storage_PUBLIC` = **6** across
all five columns — which is the number that decides the design question. The
per-column split was reported to this session as a total only, and inventing the
distribution would be exactly the defect §7.3 is listed in §10.3 for. Until the
run's output is pasted in, **only the total is citable**; the per-column rows are
**[UNVERIFIED]**.

**What the total decides.** Six is small enough that the legacy population is a
one-off `UPDATE`, not a migration programme. The consequence runs the other way
from what the brief assumed: the *rows* are trivial, and the *routes* are the
work. Three production routes return media URLs to callers that never hydrate
through `POST /api/media/sign`, so each one keeps re-creating the dependency
regardless of how many rows are fixed today:

| Route | Auth | What it emits |
|---|---|---|
| `routes/og.ts` | none (optional bearer) | `events`/`trips.cover_url` verbatim as `og:image`, to link-preview scrapers |
| `routes/featured.ts` | none | `post_media.thumbnail_url ?? public_url` |
| `routes/placeLiving.ts` | none | `posts.media_urls[0]` |

A backfill without those three routes converted leaves the class intact: the
writers stop minting absolute URLs, the six rows get rewritten, and these three
keep handing raw storage URLs to unauthenticated callers the moment any row
holds one again. **[LIVE 719b8431e]** for the three routes and their auth
posture.

---

## 8. STORAGE BUCKETS AND POLICIES

**8.1 Production bucket privacy: `post-media` public=false, `profile-media`
public=false, `stamp-artwork` public=TRUE.**
**[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb`]** — prior session; the
entry's own subject is production, reachable only through the read-only
production front door (§9.4), and the ref is fixed in-tree at
`.github/workflows/live-db.yml:150` **[CLONE 13dcfe3]**. Bucket privacy in the
non-production project was not reported and is **[UNVERIFIED]** — §7.20 is the
entry that turns on that gap.

**8.2 The in-repo bucket-privacy check does not cover `stamp-artwork`.**
`scripts/check-media-bucket-privacy.ts:15` — `const BUCKETS = ["post-media",
"profile-media"];`. So the one public bucket, which is also the destination of
the unsniffed admin upload path (§7.2c), is outside the guard's coverage.
**[CLONE 13dcfe3]**

**8.3 Production has SEVEN `storage.objects` policies; `0103_post_media.sql`
declares THREE.** The four others are declared by no migration in the tree.
**[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb`]** for the count of seven —
obtained through the read-only production front door (§9.4), which is what makes
"production" the named target; **[CLONE 13dcfe3]** for the three:
`post_media_storage_owner_insert` (`0103_post_media.sql:117-121`),
`post_media_storage_owner_delete` (`:132-136`),
`post_media_storage_public_read` (`:140-143`).
⚠ The names of the four undeclared policies are **[UNVERIFIED]** as reproduced
here — the count was reported, the list was not.

**8.4 `post_media_storage_public_read` grants SELECT TO public across the whole
`post-media` bucket, which is a private bucket.** **[CLONE 13dcfe3]** —
`0103_post_media.sql:140-143`:

```sql
CREATE POLICY "post_media_storage_public_read"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'post-media');
```

No path/owner predicate. The migration's own header at `:9` still describes the
bucket as *"post-media (public, accepts image/* and video/*)"* — stale relative
to §8.1. Whether this policy is among the seven live is **[UNVERIFIED]**.

**8.5 The declared intent of `0103`'s policy block.** Its comment at `:113-116`
says the policies "restrict direct (non-signed-URL) storage access", that "signed
upload URLs issued by the API server bypass RLS", and that the policies are
"defence-in-depth for clients that attempt direct bucket access". The two owner
policies are predicated on the caller's own user-prefix folder
(`storage.foldername(name))[1] = auth.uid()::text`, `:123` and `:137`); the
public-read policy (§8.4) has no such predicate. **[CLONE 13dcfe3]**

**8.6 Storage paths are guessable by construction.**
`post-media/{user.id}/{postId}/{mediaId}.{ext}` on the postcard path
(`routes/postcards.ts:463`) and `post-media/{user.id}/{Date.now()}.{ext}` on the
post-media path (`routes/posts.ts:170-171`); the second carries roughly
millisecond entropy scoped to a known user id. **[CLONE 13dcfe3]**

**8.7 `lib/mediaAccess.ts` is the only place block lists, post visibility and
moderation state gate a `post-media` read.** `:212-232` looks the path up in
`post_media`, refuses `moderation_status` of `rejected` or `flagged`, then
resolves the parent post's visibility. Every signed URL is issued behind it
(`routes/mediaFile.ts:23-24`), and `routes/mediaFile.ts:9-12` records that both
buckets are private and that authorization runs before signing.
**[CLONE 13dcfe3]**

**8.8 The relay and the reference validator hard-code the same two buckets.**
`routes/mediaFile.ts:29` and `lib/mediaUrl.ts:11` each hold
`{post-media, profile-media}`; `lib/postSchemas.ts:46` holds the same set. A
bucket absent from all three is unreachable through the relay and
unreferenceable through `appMediaRef`. **[CLONE 13dcfe3]**

---

## 9. CI ENFORCEMENT AND ITS LIMITS

**9.1 `ciSupabaseGuard.mjs` is a side-effect import that asserts in-process before
any client is constructed, and cannot be skipped by editing workflow YAML.**
It is placed first in each entry point, so ES module evaluation order runs it
before every sibling import — including `@supabase/supabase-js` — and a
`process.exit()` means the importing module's body never runs: no client, no URL
fetch, no query. **[CLONE 13dcfe3]** —
`artifacts/api-server/src/lib/ciSupabaseGuard.mjs:22-43`, mechanism at `:28-37`,
sole statement at `:208`.

**9.2 It replaced five defeated rounds of YAML scanning.** The prior arrangement
asserted the rule in a workflow step and tried to prove the step was present,
unconditional, first and real; each round was defeated by a construct the
previous scan did not model (comments, `env:` indirection, `if:`, step order,
shell conditionals, `secrets[...]` index form). **[CLONE 13dcfe3]** —
`ciSupabaseGuard.mjs:7-20`.

**9.3 It fails closed and has no off switch.** Every non-verdict outcome is a
refusal (repo root not found, policy script missing, `bash` unspawnable, child
signalled, non-zero exit); refusal is exit **2**, deliberately, because 1 is
reserved to mean "died involuntarily and proved nothing". There is no
"credentials absent so skip" branch — that state is exactly the historical
failure this work exists to delete. **[CLONE 13dcfe3]** —
`ciSupabaseGuard.mjs:152-198`.

**9.4 ⚠ DIVERGENCE — there are TWO front doors, not one.**
`ciSupabaseGuard.mjs` is the strict one (CI project only, hard-coded
`MODE_CI_PROJECT_ONLY`, `:201-208`); `lib/ciProdReadOnlyAuditGuard.mjs` is a
second, narrower door permitting a **read-only audit of declared production**,
only outside CI, only when the operator names it via
`PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'`.
**[CLONE 13dcfe3]** — `ciSupabaseGuard.mjs:45-53`;
`checkMediaObjects.ts:53-60`. Four read-only scripts sit behind it —
`auditMigrationsVsLive.ts`, `checkMediaObjects.ts`, `checkMissingLiveColumns.ts`,
`checkWritePathColumns.ts` — and *this is how the live-drift findings in §2.7
and §8.3 were obtained*. Any statement that "the guard permits only the CI
project" is wrong and would make §2.7 unreproducible.

**9.5 Four entry points import the strict guard, because they change state:**
`checkRankEventsSurfaces.ts` (real INSERT probe, rolled back),
`rlsHardening.test.ts`, `profileRoleNotSelfWritable.test.ts`,
`isOfficialPrivileged.test.ts` (create and delete real auth users, mutate
`profiles.role` and `profiles.is_official`). **[CLONE 13dcfe3]** —
`ciSupabaseGuard.mjs:58-61`, `:79-97`.

**9.6 The policy is not reimplemented in JS.** The guard *runs*
`.github/scripts/assert-nonprod-supabase.sh` via `lib/supabaseTargetPolicy.mjs`,
so the allowlist lives in exactly one place. Refusal conditions:
`KNOWN_PROD_PROJECT_REF` unset/malformed; `CI_SUPABASE_PROJECT_REF`
unset/malformed; `SUPABASE_URL` empty/unparseable; resolved ref ≠
`CI_SUPABASE_PROJECT_REF`; resolved ref = `KNOWN_PROD_PROJECT_REF`.
**[CLONE 13dcfe3]** — `ciSupabaseGuard.mjs:137-151`.

**9.7 `KNOWN_PROD_PROJECT_REF` is hard-coded in the workflow as
`ajrurzioarfkagpuxfnb`.** **[CLONE 13dcfe3]** —
`.github/workflows/live-db.yml:150`. `CI_SUPABASE_PROJECT_REF` is supplied by
the operator as a repo variable or environment secret and is **not** hardcoded
in the workflow (`:144`; `docs/ci/README.md:860-864`) — still true. **Its value
is nevertheless documented**: `hwokxgbmezheskbzskfr`, at
`docs/ci/BOOTSTRAP.md:10` and `:646` **[LIVE 8dc0dd2bc]**. "Not hardcoded in the
workflow" was read elsewhere in this document as "unknown"; it means only that
the workflow reads it from configuration. A project ref is not a secret —
`live-db.yml:136-137` says so in as many words.

**9.8 Whether these suites pass against a fresh non-production project has never
been verified.** They have only ever been run by hand against whatever project
the developer had configured. **[CLONE 13dcfe3]** — `docs/ci/README.md:890-894`,
stated in the repo's own words.

**9.9 — RESOLVED 2026-08-11 by direct enumeration. `SUPABASE_PROJECT_TOKEN` is
NOT project-scoped.** The credential's prefix is **`sbp_`**, and
`GET https://api.supabase.com/v1/projects` with it returns **three projects**
(§9.9a) — production among them. It is an **account-level token that reaches every
project on the account**. **[DB 2026-08-11 · account-level enumeration, all three
refs listed in §9.9a]**. The subsections below are kept as the record of how this
sat unresolved for a month; read §9.9d first for what it cost.

**9.9a — the account holds THREE projects, all reachable by the CI credential.**
**[DB 2026-08-11 · account-level enumeration via
`GET https://api.supabase.com/v1/projects`]**

| ref | display name |
|---|---|
| `zheztcvfhkwbouspesew` | `travel-buddy` |
| `hwokxgbmezheskbzskfr` | `portava-ci` |
| `ajrurzioarfkagpuxfnb` | `travel-buddy` |

All three are reachable by the value currently in `SUPABASE_PROJECT_TOKEN`; that
is what the enumeration returning them means. `ajrurzioarfkagpuxfnb` is the ref
pinned as `KNOWN_PROD_PROJECT_REF` (`.github/workflows/live-db.yml:150`)
**[LIVE 8dc0dd2bc]**.

⚠ **Which of the two `travel-buddy` projects is production is NOT established
here and must not be inferred from this table.** Both refs are recorded as
reachable; identification is left open deliberately. `supabase/.temp/linked-project.json`
(tracked) records `{"ref":"ajrurzioarfkagpuxfnb","name":"travel-buddy"}` — that
constrains the question but does not close it, since it says nothing about what
`zheztcvfhkwbouspesew` is. Treat `zheztcvfhkwbouspesew` as **unidentified and
credential-reachable**, which is the security-relevant fact regardless of its role.

**9.9b — `portava-ci` as a display name is CONFIRMED, and the earlier "appears
nowhere" reading was searching a place that could not hold the answer.**
The non-production project `hwokxgbmezheskbzskfr` does carry the dashboard display
name `portava-ci`. **[DB 2026-08-11 · account-level enumeration]** — promoted from
`[UNVERIFIED]`. Note the **evidence source is the account API, not the tree**:
display names live in the vendor's account metadata and are never in a repository,
so `grep -rn 'portava-ci'` returning nothing was not evidence of absence — it was a
search in a medium that structurally cannot contain the fact. Earlier revisions of
this document treated that grep as probative twice (header ⚠, §10.3). **Rule: a
grep can only refute a claim about the tree. For a claim about the vendor's
account, the tree is not a witness.**

**9.9c — THE FINDING THAT OUTRANKS THE COUNT: two projects share one display
name, so no human-readable identifier discriminates between them.**
`zheztcvfhkwbouspesew` and `ajrurzioarfkagpuxfnb` are both named `travel-buddy`.
Consequences, in order of severity:

1. **Any instruction that identifies a Supabase project by NAME is defective** —
   it cannot resolve to one project, and one of the two candidates is production.
   A sweep of the tree for this class is in progress; its population is reported
   to the owner before any correction, deliberately.
2. **A name-based allowlist could never have worked here** — not "would have been
   weaker", could not have functioned. See §9.9e / `assert-nonprod-supabase.sh`.
3. **`portava-ci` is the only one of the three names that is unambiguous**, which
   is precisely why the five in-tree uses of it (`docs/migrations.md:133`, `:140`,
   `:164`, `docs/ci/BOOTSTRAP.md:75`, `auditMigrationsVsLive.ts:229`) happen to be
   safe today. They are safe by luck of naming, not by construction, and a
   dashboard rename breaks them silently.

**9.9d — the premise was broader than the requirement, and the excess breadth is
what made it unverifiable.** The claim being carried was *"Supabase offers no
project-scoped Management API token"* — a statement about a **vendor's product
catalogue**. No repository can settle that, which is exactly why it sat
`[UNVERIFIED]`, why it was ruled non-citable, and why it hardened into a gate
blocking promotion of this entire document. **The architecture never needed it.**
What the guard's design actually rests on is the far narrower *"this credential is
not scoped"* — a property of one value in one environment variable, answerable by
one authenticated GET, and it was one `curl` away for the whole month. The broad
claim and the narrow one were treated as the same claim because the broad one
implies the narrow one; but implication runs one way only, and the direction that
mattered — verifiability — ran the other. **Generalisable rule: when a load-bearing
claim cannot be verified, check whether what is actually load-bearing is narrower
than what is being claimed.** A claim about a product category needs a vendor; a
claim about the credential in your hand needs a request.

**9.9 ⚠ DIVERGENCE (superseded — retained as the record) — the repo contradicts
"Supabase offers no project-scoped token."** The brief states Management API
tokens (`sbp_`) are account-level, that
no project-scoped variant exists, and that this is *why* the allowlist guard
exists — the credential cannot be scoped, so the target must be. The clone
instead documents a project-scoped token as the **preferred** CI credential:

- `docs/eas-runbook.md:314` — *"`SUPABASE_PROJECT_TOKEN` | Project-scoped,
  read-only. Safe to store as a repo secret … **Preferred.**"*
- `docs/eas-runbook.md:319-325` — a step-by-step UI path to create one:
  *Project Settings → API → Project API tokens → Generate new token → scope Read*.
- `docs/ci/README.md:882` — *"Create a project-scoped token and put it in
  `SUPABASE_PROJECT_TOKEN`."*
- Every Management-API script reads `SUPABASE_PROJECT_TOKEN` first and falls back
  to `SUPABASE_ACCESS_TOKEN`: `auditMigrationsVsLive.ts:195`,
  `checkMissingLiveColumns.ts:147`, `checkWritePathColumns.ts:257`,
  `checkRankEventsSurfaces.ts:339`; the same variable is wired in
  `.github/workflows/live-db.yml:190`, `:344`.

**[CLONE 13dcfe3]** for all of the above. The claim about Supabase's product
surface is a **vendor** fact, not a repo fact, and is **[UNVERIFIED]** from here —
no reading of this clone can settle it.

**REWORKED 2026-08-11 after a full-tree grep of the LIVE repo. The vendor
question is NOT closed. What changed is the weight of the evidence on each
side — and it moved a long way.** **[LIVE 8dc0dd2bc]** for everything in this
block. Four findings:

**(a) The 29 lines are one claim, not 29.** Searching the live tree for
`project-scoped|Project-scoped|Project API tokens` (excluding `node_modules` and
`_incoming/`) returns **29 lines across 15 files**. They are not independent:
`git log -S` puts the origin at **`19f28c679`, 2026-07-15**, which introduced
both `docs/eas-runbook.md:314`'s table and `scripts/print-github-secrets.sh:10`;
the TypeScript scripts' identical parenthetical
`(project-scoped, preferred for CI)` arrives two days later at **`0b25c17c8`,
2026-07-17**; and **five files name `docs/eas-runbook.md` as their source**
(`check-db-triggers.sh:15`, `check-engagement-indexes.sh:16`,
`pre-release-check.sh:615`, `print-github-secrets.sh:13`, `replit.md:78`).
The corroboration count for "project-scoped" is **one document, copied**, not
fifteen. An earlier count of "thirteen files, twenty-one lines"
(`ci-readme-addition.md:113`) used a narrower pattern; both counts describe the
same single-origin body of text.

**(b) The "read-only" half is already retracted in-tree, by a newer and more
rigorous document.** `docs/ci/README.md:469-470` states plainly: *"it does not
make the credential read-only. The Management API token in the environment
**can write**; the mode constrains what the process does."* That file was last
touched **2026-08-10**; `docs/eas-runbook.md` was last touched **2026-07-15** and
has not been revised since. So the repo does not speak with one voice — it speaks
with an old voice and a new one, and the new one contradicts the old on
read-only. Three files still call the token read-only
(`eas-runbook.md:314`, `:376`, `print-github-secrets.sh:10`, plus
`check-db-triggers.sh:14-16`'s "Scope it to read"). **Those lines are wrong by
the repo's own newer account**, independent of how the vendor question lands.

**(c) On "project-scoped" the repo does not contradict itself — but the guard's
own rationale presupposes the opposite.** `.github/scripts/assert-nonprod-supabase.sh:31-40`
argues for an allowlist over a denylist because *"a second production project, a
colleague's personal project, a customer's project, a typo that happens to
resolve — all of those passed the denylist"*, and `docs/ci/README.md:796` warns
of credential jobs *"free to run against any project `SUPABASE_URL` happened to
hold."* Both arguments only bite if the credential is accepted by projects other
than its own. **That is a presupposition, not a demonstration**: the guard failing
open proves the *guard* did not stop the call, not that the *API* would have
answered it. Corroborating and not more: both token names are byte-interchangeable
in the same `Authorization: Bearer` header against the same endpoint
`https://api.supabase.com/v1/projects/{ref}/database/query`
(`auditMigrationsVsLive.ts:262`, `.agents/memory/live-db-vs-local-postgres.md:41-47`),
and the fallback name is documented everywhere as an `sbp_…` **account** personal
access token (`replit.md:78`, `eas-runbook.md:356`, `:421`). **Nothing in the tree
records what prefix `SUPABASE_PROJECT_TOKEN` actually holds**, and **nothing
validates token scope anywhere** — every guard in this repo checks the project
*ref*, never the credential.

**(d) A stale doc is a permitted answer here, and is the reading the evidence
best supports.** The runbook's five-step path is *Project Settings → API →
Project API tokens → Generate new token → scope Read*
(`eas-runbook.md:319-325`, `:384-390`, `print-github-secrets.sh:46-48`). "Project
Settings → API" is the project's **data-plane** key page. Whether a token created
there was ever accepted by `api.supabase.com` — a **control-plane** endpoint — is
exactly the vendor fact this document cannot establish. **[UNVERIFIED]**, and
flagged as inference rather than evidence: the most economical explanation is
that a 2026-07-15 runbook described a dashboard affordance that either no longer
exists, or was never the Management-API credential in the first place, and that
28 further lines inherited the error by copy. **This is offered as the leading
hypothesis, not as a finding.** It is not to be cited as settled, and §9.9 does
not close on it.

**§9.9 blocks nothing further. Final status of all three claims:**

1. *"`SUPABASE_PROJECT_TOKEN` is read-only"* — **RESOLVED FALSE** (2026-08-11,
   prior pass), by `docs/ci/README.md:469-470` **[LIVE 8dc0dd2bc]**. Citable. All
   ten in-tree sites saying otherwise were corrected in the same pass.
2. *"`SUPABASE_PROJECT_TOKEN` is project-scoped"* — **RESOLVED FALSE**
   (2026-08-11). Prefix `sbp_`; `GET https://api.supabase.com/v1/projects`
   returns three projects (§9.9a). It is account-level and reaches production.
   **Citable.**
3. *"Supabase offers no project-scoped Management API token"* — **still
   [UNVERIFIED]** and **still not citable**, but **DEMOTED from blocker to open
   question**. It is a vendor product-catalogue fact that nothing here can settle,
   and — per §9.9d — nothing here needs it. If such a token exists, adopting it is
   an **optimization** (defence in depth alongside the ref allowlist), not a
   foundation. Do not let it gate anything again.

**Consequence for the guard, stated so it is not overread.** (2) resolving false
means the ref allowlist is confirmed load-bearing on this axis — it is the only
thing constraining which project CI reaches, because the credential constrains
nothing. That vindicates the guard's design while refuting the *justification*
originally given for it. See §9.9b for what the enumeration additionally showed
about identifying projects by name.

**9.10 The non-database checks import no guard, deliberately:** frozen-dir,
async-handlers, migration-prefixes, test-runner-flags read only files on disk.
`check:guard-coverage` is what makes both doors' coverage a fact rather than a
claim. **[CLONE 13dcfe3]** — `ciSupabaseGuard.mjs:106-110`;
`artifacts/api-server/scripts/check-guard-coverage.mjs`.

**9.11 `checkDiscoveryCacheKeys.ts` is not wired into any workflow.** It is
SELECT-only, sits behind the read-only door, and is registered in
`READ_ONLY_AUDIT_ENTRY_POINTS` in `check-guard-coverage.mjs`.
**[CLONE 13dcfe3]** — `ciSupabaseGuard.mjs:99-104`.

**9.12 One documented, permanent migration-prefix collision exists: prefix 2059**
(`2059_content_distribution_stats.sql` + `2059_stamp_artwork_generation_source_placeholder.sql`).
Both were verified applied live, so neither can be renumbered; the allowlist
matches on the exact file set, so a third file at that prefix fails the check.
**[CLONE 13dcfe3]** — `checkMigrationPrefixes.ts:57-66`, rationale `:40-56`.

**9.13 Six Management-API entry points; each derives the project from
`SUPABASE_URL` and sends the token as a bare bearer.** All under
`artifacts/api-server/src/scripts/`. **[CLONE 13dcfe3]**:

| entry point | token read | ref derived | URL built | bearer |
|---|---|---|---|---|
| `auditMigrationsVsLive.ts` | `:195` | `:207` | `:211` | `:215` |
| `checkMissingLiveColumns.ts` | `:147` | `:159` | `:165` | `:169` |
| `checkWritePathColumns.ts` | `:257` | `:268` | `:274` | `:278` |
| `checkMediaObjects.ts` | `:82` | `:94` | `:98` | `:102` |
| `checkRankEventsSurfaces.ts` | `:339` | `:408` | `:420` | `:438` |
| `checkDiscoveryCacheKeys.ts` | `:399` | `:450` | `:462` | `:477` |

Every one reads `SUPABASE_PROJECT_TOKEN || SUPABASE_ACCESS_TOKEN` and interpolates
the derived ref into
`https://api.supabase.com/v1/projects/${projectRef}/database/query`.
⚠ The **derivation is not textually identical across the six**: four inline
`new URL(SUPABASE_URL).hostname.split(".")[0]`; `checkRankEventsSurfaces.ts:408`
and `checkDiscoveryCacheKeys.ts:450` read `hostname.split(".")[0] ?? ""` from a
hostname parsed earlier behind refusal gates. The *input* is `SUPABASE_URL` in all
six. Do not quote the one-line form as universal.

**9.14 The Management API endpoint these six use is `/database/query`, POSTed a
`{ query }` body — arbitrary SQL, whatever the caller puts in it.**
**[CLONE 13dcfe3]** — `checkMediaObjects.ts:105`;
`checkDiscoveryCacheKeys.ts:480` is the same shape. Nothing in the request
constrains the SQL, and nothing in the tree inspects it before sending.

**9.15 The guard script reads exactly three variables and inspects no
credential.** `.github/scripts/assert-nonprod-supabase.sh:57-59` reads
`SUPABASE_URL`, `CI_SUPABASE_PROJECT_REF`, `KNOWN_PROD_PROJECT_REF` and nothing
else. **[CLONE 13dcfe3]** For the refusal conditions see §9.6.

**9.16 Where each secret name is referenced in the workflows.**
**[CLONE 13dcfe3]** — `.github/workflows/live-db.yml`:

| secret name | referenced at | scope of that reference |
|---|---|---|
| `SUPABASE_URL` | `:189`, `:343`, `:453` | inside jobs declaring `environment: ci-nonprod-supabase` |
| `SUPABASE_PROJECT_TOKEN` | `:190`, `:344` | inside environment-declaring jobs |
| `SUPABASE_SERVICE_ROLE_KEY` | `:454` | inside an environment-declaring job |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `:455` | inside an environment-declaring job |
| `CI_SUPABASE_PROJECT_REF` | `:144` | **workflow-level `env:` block (`:133-150`), outside every job and every environment** |

The three environment declarations are at `:187`, `:341`, `:451`; the `jobs:` key
begins at `:152`, so `:144` precedes any job. The expression at `:144` is
`${{ vars.CI_SUPABASE_PROJECT_REF || secrets.CI_SUPABASE_PROJECT_REF }}`.
`.github/workflows/ci.yml` and `.github/workflows/unwired-checks.yml` reference the
`secrets` context nowhere and declare no environment — `ci.yml`'s only textual
match is the prose comment at `:3` ("runs with NO secrets").

**9.17 Twenty-one lines in thirteen files describe `SUPABASE_PROJECT_TOKEN` as
"project-scoped".** **[CLONE 13dcfe3]** — reproduced by
`grep -rn 'project-scoped\|Project-scoped' --include='*.md' --include='*.ts'
--include='*.sh' --include='*.mjs' --include='*.yml' docs/ artifacts/ scripts/
.github/` in the clone. Three of the twenty-one also call it **read-only**:
`docs/eas-runbook.md:314`, `:376`, `scripts/print-github-secrets.sh:10`.
`docs/ci/README.md` is itself two of the thirteen files, at `:269` (the Secrets
table, quoting the runbook's "Project-scoped, read-only" line) and `:882` (setup
step 4).

**9.18 What the tree records about the two token names.** **[CLONE 13dcfe3]**:

- `docs/eas-runbook.md:317` — both names "use the same Supabase Management API
  endpoint so no other config change is needed", and `SUPABASE_PROJECT_TOKEN` is
  checked first with fallback to `SUPABASE_ACCESS_TOKEN`.
- `docs/eas-runbook.md:356` and `:421` — `SUPABASE_ACCESS_TOKEN=sbp_...`,
  generated at `https://supabase.com/dashboard/account/tokens`, i.e. an **account**
  personal access token.
- `docs/eas-runbook.md:314` — `SUPABASE_PROJECT_TOKEN` is "Project-scoped,
  read-only … **Preferred**" for CI; `:319-325` gives a five-step UI path to
  create one (*Project Settings → API → Project API tokens → Generate new token →
  scope Read*); `docs/ci/README.md:882` instructs the same.
- No consumer validates a prefix, a scope, or a shape on either name — the six
  entry points in §9.13 read whichever is set and send it unchanged.

These are records of what the tree says. Whether Supabase actually offers a
project-scoped Management API token is **[UNVERIFIED]** and is §9.9.

**9.19 `scripts/print-github-secrets.sh` directs the operator to the repository
secrets page.** `:6` and `:18` both name
`https://github.com/<repo>/settings/secrets/actions`. **[CLONE 13dcfe3]** Whether
repository-scoped values for these names still exist in the GitHub console is
**[UNVERIFIED]** — no repository can observe it.

---

## 10. KNOWN UNRESOLVED

Every open question, stated as a question. Nothing below may be assumed.

### 10.1 The four quarantine blockers

**Blocker 1 — unresolvable load-bearing citation. RESOLVED.**
`06` declared "paths are relative to `artifacts/api-server/`" then cited
`docs/algorithm/discovery-impression-gap.md` four times. That file is at the
**repo root**: `docs/algorithm/discovery-impression-gap.md` exists;
`artifacts/api-server/docs/algorithm/` does not exist at all
(`artifacts/api-server/docs/` contains ten unrelated files). **[CLONE 13dcfe3]**
The citation resolves only against the repo root. Recorded in §4.5 with the
correct path.

**Blocker 2 — `feature_flags` described three incompatible ways. RESOLVED.**
Five columns live, the two queried projects identical, `metadata jsonb` present
and `0065_phase7_safety.sql:36` applied.
**[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb` and non-production
`hwokxgbmezheskbzskfr`]** + **[CLONE 13dcfe3]**. See §3.1–3.4. Ref supplied
2026-08-11; the tag previously read "one non-production project". The residual
question is not about the schema but about the loader: §6.2.

**Blocker 3 — cache-keying requirement contradicts itself. RESOLVED as a
question of fact.** L1 and L2 hold only the pre-rank OSM array under a
user-independent key (§5.2); only `_compassCandidateCache` stores post-ranking
output (§5.3), and it is already keyed per user. **[CLONE 13dcfe3]**
Those are the facts; **what follows from them for an experiment-arm cache key is
a design judgment and does not belong in this document** (see "This document
contains no proposals", above). The prior revision stated one here — that keying
L1/L2 by arm "buys no correctness and forces each arm to cold-fetch Overpass into
its own namespace" — and it has been removed. Doc 01 is where that evaluation
belongs; it should cite §5.2 and §5.3 rather than restate them.

**Blocker 4 — "populate the Discovery feature vector" scoped three ways. STILL
OPEN. Needs an owner decision, not a lookup.**
The mechanism doc 01 described is confirmed (§5.6–5.7): populating `creatorId`
alone simultaneously activates `relationshipRelevance`, `activityBoost`,
`fatiguePenalty` **and** the creator cap — four behaviours that have never
executed against real values. The open question is: *does that become its own
measured change with its own arm, or does it remain unmeasured prerequisite
work?* Add the precision from §5.8 before deciding: it is the **DRS** vector, not
portavaRank's, and three engagement counts are already real.

### 10.2 Questions raised by the six divergences

1. Which filter produced "21 directories" when the clone shows 22? (§2.4)
2. Did the "every writer but one discards `{ error }`" claim describe a state
   before `13dcfe3`, and what is true at `c89f09a77`? (§4.4)
3. Should the feature-vector claim be restated as DRS-only, and should
   `impressionCount: Math.max(1, savedCount ?? 1)` be treated as a constant or as
   a wrong proxy? (§5.8)
4. Is "three feature-flag loaders" meant to name a subset of the **four shared**
   entry points, and if so what is the status of the **four private
   re-implementations**? (§6.4) — the counts here are §6.4's counts verbatim;
   an earlier revision of this line said "three private duplicates", which
   contradicted §6.4 inside this document.
5. Does any statement of the CI guard need to name the read-only front door,
   given §2.7 and §8.3 depend on it? (§9.4)
6. Are Supabase Management API tokens project-scopable? (§9.9) — **the highest
   priority of the six**, because four in-repo documents and two workflow jobs
   depend on the answer. **Narrowed 2026-08-11, still open.** The read-only half
   is now resolved false in-tree; the scoping half needs one HTTP call with the
   real credential against a second project's ref (§9.9, "How to settle"). The
   grep that narrowed it also showed the repo-side case rests on a single
   2026-07-15 document copied 28 times, not on independent agreement — so the
   "the repo contradicts you" framing this entry was written under no longer
   holds in the form it was written.

### 10.3 Facts with no clone anchor, needing re-verification

**Live observations whose project was never recorded.** Under the rule at the top
of this document these tags are void until the project is supplied. Re-run each
one recording the project ref alongside the result:

- **§2.9 — `post_event_links.relrowsecurity` after 2070. CLOSED on both projects,
  2026-08-11.** Kept in this list, struck rather than deleted, because it was the
  highest-priority item here and how it closed is worth more than the fact that
  it did.
  - **Non-production, ref `hwokxgbmezheskbzskfr`** (dashboard alias
    `portava-ci`): observed `relrowsecurity = false`, then fixed by re-running
    2070's idempotent `DO` block and verified `true` —
    `docs/migrations.md:133-147` **[LIVE 8dc0dd2bc]**.
  - **Production, ref `ajrurzioarfkagpuxfnb`**: `relrowsecurity = true`,
    **[DB 2026-08-11 · production `ajrurzioarfkagpuxfnb`]**, verified after the
    hand-applied transaction in §2.7 AFTER.
  - **The reason this sat open was a stale-clone artefact, not a missing
    observation.** The project was recorded in `docs/migrations.md` the whole
    time; this document was built against clone `13dcfe3`, which predates that
    text, and the grep that "proved" `portava-ci` unknown was run there. **The
    lesson generalises to every remaining bullet in this list:** re-grep the live
    repo before re-running a query, or you will pay for a fact the repo already
    holds. An earlier 2026-08-11 revision of §2.9 recorded it as still open for
    the non-production project; that was this same mistake, made again, and is
    corrected in §2.9.
  - Still worth an anchor if anyone is in there anyway: `docs/migrations.md:144`
    says "verified" without reproducing the read, so neither project has query
    text on record. Not blocking.
- ~~**§2.6 — the live `highlight_replies` column list.**~~ **CLOSED 2026-08-11:**
  both projects named, and the column list agrees across them —
  `docs/migrations.md:164,168` **[LIVE 8dc0dd2bc]**. Same stale-clone artefact as
  §2.9.
- **§7.3 — the five EXIF-census numbers.** STILL OPEN, and the ref does not help:
  what is missing is *which* project was censused, not what the non-production
  project is called. A census of `hwokxgbmezheskbzskfr` would say nothing about
  production's corpus, which is why this one matters. Check
  `docs/media/` and `docs/ci/BOOTSTRAP.md` in the **live** repo before re-running.
- **§2.1 — the "no `schema_migrations` table" query of 2026-08-09.** Recorded
  in-repo at `checkMigrationPrefixes.ts:45-46` and `docs/migrations.md:43-44`;
  neither source names a project.
- **§4.5 — the zero-discovery-rows counts.** The source document records neither
  the date nor the project.
- ~~**§3.1 / §3.3 / §10.1 Blocker 2 — the non-production project's identity.**~~
  **CLOSED 2026-08-11. The non-production project is ref
  `hwokxgbmezheskbzskfr`.** That is the identifier; `portava-ci` is its Supabase
  dashboard **display name**, an alias — which is the whole reason it appears in
  no config file, since nothing in the tree consumes a display name. Anchored in
  the live repo at `docs/ci/BOOTSTRAP.md:10`, `:421`, `:646`, `:853-855`, `:1111`
  and wired as `CI_SUPABASE_PROJECT_REF` (`.github/workflows/live-db.yml:144`)
  **[LIVE 8dc0dd2bc]**; supplied by the operator 2026-08-11 and corroborated
  there. **Always cite the ref**: a dashboard display name can be changed without
  changing anything a query, a workflow or a grep can see, so a document keyed to
  the alias silently rots. See the ⚠ in the header for the two header claims this
  correction retires.

**Other facts with no clone anchor:**

- ~~The list of the 12 production-missing objects (§2.7) — count reported, names
  not.~~ **CLOSED 2026-08-11.** All twelve are now named in §2.7 AFTER: nine
  applied (1 table + 8 indexes, listed per file) and three policies deliberately
  not applied, anchored at `auditMigrationsVsLive.ts:221-236` **[CLONE 13dcfe3]**.
- The names of the four undeclared storage policies (§8.3).
- Whether `post_media_storage_public_read` is among the seven live (§8.4).
- The five EXIF-census numbers (§7.3).
- Which of the 18 emergency-stop call sites changed at `c89f09a77` (§6.8).
- Whether `0199_rank_events_live_pulse_surface.sql` is applied live (§2.11).
- Whether `eligible_impressions` is live as `INTEGER` or `BIGINT` (§3.5).
- Whether each of the four behaviour-store tables exists live (§4.7).
- The date of the zero-discovery-rows query (§4.5) — the source document records
  the counts but not when they were taken.
- Whether "bypass" or "logging gap" is the right reading of §4.5. That is an
  inference, not a measurement; the source document refuses it, and the quantity
  that would settle it (which of the six serve exits dominates) is in §10.4.

### 10.4 Questions the clone cannot answer at all

- **`post_media_storage_public_read` — two questions, not one, and the second is
  moot until the first is answered.**
  **(a) Is the policy live at all?** §8.4 verifies only that `0103` *declares* it,
  and §2.2 is that a migration file is not evidence of application in either
  direction. Production has seven `storage.objects` policies and the names were
  never reported (§8.3, §10.3). Settle by enumerating `pg_policies` for
  `storage.objects` in production through the read-only front door (§9.4).
  **(b) If it is live, what does `SELECT TO public` grant when the bucket is
  `public = false` (§8.1)?** Settle by probing: anonymous and authenticated direct
  reads of a known `post-media` path, with and without the relay
  (`routes/mediaFile.ts`).
  Both are **[UNVERIFIED]**. Any argument that turns on this policy must carry
  both, in this order.
- Does an abandoned postcard compose leave an un-stripped original **permanently**?
  **The word is [UNVERIFIED] and no entry in this document licenses it.** §7.15
  establishes only that *this clone* contains no automatic sweeper — no scheduled
  deleter, and nothing able to enumerate a bucket — and §7.15's own scope note
  lists the three things outside the clone that could still end retention
  (Supabase-side lifecycle configuration, a manual admin delete via
  `routes/adminMedia.ts:338`, and the live tree at `c89f09a77`). An
  absence-of-sweeper argument over a snapshot cannot reach "permanently".
  Only a live orphan sweep of `post-media` against `post_media` rows, run against
  a **named** project, can. Note `checkMediaObjects.ts` already computes the
  orphan-object count and deliberately does not fail on it (§7.16) — that count
  is the measurement, and it was never taken for this purpose.
  Any document using the word "permanently" must cite **this bullet**, not §7.2a
  and not §7.15.
- Which discovery serve path actually dominates in production.
  `checkDiscoveryCacheKeys.ts:30-45` derives a **ceiling**
  (`max cold fetches ≤ distinct_keys × window/TTL`) and is explicit that the
  ceiling is not a hard upper bound, because there is no in-flight dedup (§5.5).
  It has never been wired into a workflow (§9.11), so it has not been run
  against production.
