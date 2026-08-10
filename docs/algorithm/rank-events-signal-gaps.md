# rank_events — signal gaps found while extending attribution

Found while looking for the next outcome to instrument after `rsvp`/`join`
(commits `5b7c7fa87`, `0e4fe0038`, `75c11d5db`). Two are open questions about
production, one is a schema decision. **None is fixed here** — each needs
either a production fact this repo cannot supply, or a decision.

Related: `docs/algorithm/signal-audit.md` §3a (attribution), and the schema
reconciliation, which established that live CHECK constraints have been found
**wider** than the migration files declare.

---

## 1. The server writes surface values the declared constraint rejects

Migration `0153_add_rank_events.sql:25`:

```sql
surface text NOT NULL CHECK (surface IN ('pulse','discovery','events'))
```

The server writes two values outside that set:

| Value | Written at | Path |
|---|---|---|
| `living_page` | `routes/rankEvents.ts:66` | direct service-client insert |
| `compass` | server-side insert | Compass path |

And the Living Page insert is deliberately fire-and-forget:

```ts
// Fire-and-forget: failures are non-fatal — a missed signal is better than
// a broken Living Page load.
const { error } = await sc.from("rank_events").insert({ … surface: "living_page" … });
if (error) { req.log.warn({ err: error, … }, "rank-events: direct insert failed (non-fatal)"); }
```

**Two possibilities, and the repo cannot tell you which:**

- The live constraint has been widened out-of-band, these rows land, all is
  well. Plausible — reconciliation found exactly this pattern elsewhere.
- The live constraint still matches the migration, in which case **every
  Living Page and Compass impression is rejected by Postgres**, the error is
  logged at `warn`, swallowed, and two entire surfaces are missing from the
  ranking corpus. Nothing fails. Nothing alerts.

The trade-off in that comment is correct in isolation — a dropped signal
really is better than a broken page load. The problem is that it makes total,
permanent signal loss look identical to normal operation.

**To resolve:** `src/scripts/checkRankEventsSurfaces.ts` (added alongside this
doc) reports observed row counts per surface, prints the live constraint
definitions, and — for any surface a pending deploy depends on — runs a
**behavioural probe** against the live database.

```
cd artifacts/api-server
node --env-file-if-exists=.env --import tsx/esm src/scripts/checkRankEventsSurfaces.ts
```

### Why the gate is a probe and not a text parse

The gate used to answer "is `'live_pulse'` permitted live?" by running
`pg_get_constraintdef()` and regex-harvesting every single-quoted literal out
of the definition. That is irreducibly fragile: it harvested literals from
*any* clause (so a value named in a negative clause such as
`surface <> 'live_pulse'` read as PERMITTED), it never verified the definition
was a positive allow-list on `surface` at all, and with more than one CHECK on
`surface` the effective vocabulary is their intersection, which no single
definition string expresses. Every one of those is a way to print PERMITTED
about a database that would reject the row.

So the gate now asks the database, by attempting the write:

- one statement — a `DO` block — attempts a real `INSERT` with the required
  surface, sourcing an FK-valid `user_id` via `SELECT id FROM auth.users LIMIT 1`
  in the same statement and supplying known-good values for every other
  constrained column, so the row actually *reaches* the surface CHECK;
- it then **always** `RAISE`s, success path included, carrying the verdict in
  the exception message. Rollback is not a separate statement that could be
  skipped — it is the consequence of the only statement failing. There is no
  path where a `BEGIN` succeeded and a `ROLLBACK` did not run, because the probe
  never issues `BEGIN`;
- afterwards it counts rows matching the probe's sentinel `item_id` prefix and
  requires **zero** — matching the prefix, not this run's id, so it also catches
  a leak from any earlier run;
- error classes come from SQLSTATE captured by `GET STACKED DIAGNOSTICS`, never
  from message prose. `23514` check_violation means rejected — but only after
  the reported `CONSTRAINT_NAME` is matched against the live `pg_constraint`
  listing and shown to constrain `surface` and nothing else. An unattributable
  `23514` is fatal, not a clean "rejected". `23503` / `23502` mean the probe row
  shape is wrong and prove nothing about `surface`.

Constraint-definition text and the old literal harvest are still printed. They
are **informational only**, labelled as such, and can never set or override the
gate verdict.

**The script will not widen a constraint** — that is a production schema change
and belongs to a person.

### Exit code contract

The same table appears in the script header, in
`artifacts/api-server/docs/migrations.md`, and in
`artifacts/api-server/scripts/run-all-checks.sh`. **Proceed on exit 0 AND only
when the line `GATE live_pulse: PERMITTED` is present in the output. Block on
every other code, including one this script does not currently emit — and block
on an absent `GATE` line whatever the exit code.**

| Exit | Meaning | Action |
| --- | --- | --- |
| `0` | PROCEED — the probe insert was accepted live and rolled back, and no probe row persisted. The *informational* harvest may also have found a written value absent from the live definition (the standing `living_page` / `compass` finding above, expected on every run); it is printed prominently as a `FINDING` block and **does not change the exit code**. | PROCEED (after confirming the `GATE live_pulse: PERMITTED` line) |
| `1` | CRASHED — **never chosen by the script.** Node's default code for an involuntary death: uncaught exception, unhandled rejection, module-resolution failure, `tsx`/TypeScript load failure. The run died before reaching a verdict. | **BLOCK** |
| `2` | CANNOT-RUN — no live credentials, or `SUPABASE_URL` is unparsable, so the probe never ran and proved nothing | **BLOCK** |
| `3` | BLOCKED — every fail-closed condition the script chooses: probe rejected; unattributable or non-surface `check_violation`; `23503`/`23502` (the probe is wrong); read-only transaction; insufficient privilege; any other SQLSTATE; no probe sentinel in the response; `auth.users` empty; a probe row persisted or the pristine count could not run; no CHECK on `surface` (the half-applied-0199 state) or none at all; no CHECK on `outcome`; the `pg_constraint` read threw; **any throw that escapes `main()`** — `main().catch()` converts it to 3 rather than letting Node default it to 1 | **BLOCK** |

### Why exit 1 is reserved, and why nothing runs at module scope

Exit 1 used to be the *informational* code — the standing `living_page` /
`compass` finding — and was documented as "proceed". But 1 is also Node's
default exit code for **every** involuntary failure, so a crashed run and a
clean pass were the same observable result, under the one code operators were
told to ignore. Concretely, the project ref was derived at module scope:

```ts
const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
```

`new URL()` throws on a malformed value, and module scope is outside `main()`'s
catch — so a bad `SUPABASE_URL` terminated the process with exit 1 and
`run_gate` printed `PASSED`. A fatal condition wearing the code operators are
told to ignore is the exact failure this gate exists to prevent.

So exit 1 is now free: **nothing in the script chooses it**, and it means only
"the process died involuntarily". Environment validation and the URL parse both
happen inside `main()` (`requireTransport()`), where a failure is a printed
`BLOCKED` verdict with exit 2. Module scope holds only literals, `process.env`
property reads, and declarations — keep it that way.

Notably, "no CHECK constraint on `surface` exists live" is exit 3, not a pass:
an accepted insert there proves only that nothing is *enforced*, which is not
the same fact as "the value is permitted". Conversely, "more than one CHECK
mentions `surface`" is no longer fatal — the probe measures the effective
intersection directly — and is now only reported for a human.

`pnpm run check:all` runs the gate under exactly that rule (`run_gate` in
`scripts/run-all-checks.sh`), which scores a pass only when **both** hold: the
exit code is `0`, **and** `grep -qxF 'GATE live_pulse: PERMITTED'` matches the
captured output. Everything else fails, exit 1 included. The exit-code test
alone is not sufficient — the documented contract is "the GATE line must be
present", and a process that dies before printing a verdict can still leave a
passing-looking status behind. The gate needs live credentials by construction,
so in an environment without them it exits 2 and `check:all` **fails** — it does
not skip. A gate that no-ops without credentials is not a gate.

Note the script reports permitted-but-zero-rows separately from rejected. A
surface that is allowed and still has no rows is a different bug, and the two
are easy to conflate.

---

## 2. "Booked buddy" is top of the success hierarchy and emits nothing

The spec's ordering, strongest first:

> joined plan / attended / **booked buddy** → shared moment together → saved
> place/plan → Telegraph conversation → followed traveller → shared post →
> stamped → commented → profile/place opened → dwell time → raw impression

Booking is in the **top tier**. Today it emits no outcome at all:

- `app/(rent-a-buddy)/checkout.tsx:224` calls `createBooking(...)`
- no `fireRankOutcome` on that path
- `src/components/BuddyCard.tsx:76` `handleBook` navigates to checkout, also silent

**Why this was not simply wired.** The outcome enum has no value for it:

```
outcome  IN ('impression','tap','save','join','rsvp','attended')   + 'analytics' (0197)
surface  IN ('pulse','discovery','events')
```

Every honest option needs a decision:

| Option | Cost |
|---|---|
| Map booking → `join` | No schema change, but conflates "joined a meetup" with "booked a buddy" in the funnel. Nobody analysing it later could separate them — and the spec ranks them as distinct top-tier outcomes. |
| Add outcome `book` | Correct and unambiguous. Production CHECK constraint change. |
| Add surface `rent_a_buddy`, keep outcome `join` | Also unambiguous, arguably cleaner — the surface field is what already distinguishes contexts. Also a production CHECK constraint change. |

**Recommendation: the third.** `surface` is already the axis that separates
contexts, `join` genuinely describes the action, and it leaves the outcome
vocabulary stable. But it is a schema change either way, so it is a decision,
not an implementation detail.

If finding 1 shows the live surface constraint is already wider than declared,
this gets cheaper — `rent_a_buddy` might simply need adding to
`SURFACE_VALUES` in `routes/rankEvents.ts` and the client `Surface` type.
**Check before assuming**; that assumption is the one that produced finding 16.

---

## 3. Attribution coverage as it stands

| Surface | Session carried to outcome? | Notes |
|---|---|---|
| `ExploreTodaySection` → event | **yes** | `0e4fe0038` |
| `FitsCard` → event | **yes** | `75c11d5db` |
| `PulseFeedCard` → SaveButton | **yes** | pre-existing |
| `PulseLiveCarousel` / `LivePulseCard` → event | **no** | blocked: `/api/pulse/live` never calls `logImpression`, so there is no impression to attribute to. Server fix queued. |
| `MapCarousel` → event | **no** | no session in scope |
| Deep link / notification / search → event | **no**, by design | records unattributed rather than wrongly attributed |
| Buddy booking | **no** | finding 2 |

---

## Not verified here

- **The live constraints.** That is the entire point of finding 1 — it is
  unresolved until someone runs the script against production.
- **Whether `living_page` / `compass` rows exist.** Same script, same run.
- No typecheck or test run on the script: built against a clone with no
  `node_modules`. It follows the same Management API pattern as
  `checkMissingLiveColumns.ts`, but that is structural similarity, not proof.

---

## 4. The entity type lives in TWO mutually exclusive columns (2026-08-09, measured live)

Found while auditing the fallout of a seed-account deletion. **No code was
changed and no row was touched** — `rank_events` is mid-flight work elsewhere.
This is recorded here rather than only in the cleanup notes because it is a
join hazard for anyone querying the ranking corpus.

`rank_events` carries both `item_kind` and `content_type`. Every row has
**exactly one** of them set and the other NULL — two writers, two conventions,
one table:

| Entity | `item_kind` set | `content_type` set | total |
|---|---:|---:|---:|
| post | 35,884 | 94,469 | **130,353** |
| buddy | 12,299 | 33,061 | **45,360** |
| event | 8,598 | 17,575 | **26,173** |
| place | 84 | 408 | **492** |
| neither | — | — | 1 |
| | | | **202,379** |

**Any analysis that filters on only one of these columns silently drops the
other convention's rows** — 28% or 72% of the corpus depending which you pick.
Nothing errors; the query just returns a confident subset. Use
`coalesce(item_kind, content_type)`.

Two further join hazards in the same column:

- **`place` item_ids are prefixed strings**, `place:<uuid>`, not bare UUIDs.
  They match no `id` column anywhere as-is, and a `~ '^[0-9a-f]{8}-'` UUID
  filter excludes them entirely.
- **`buddy` item_ids are `profiles.id` values**, not `rent_buddy_profiles.id`.
  All 8 distinct buddy ids resolve against `profiles`; zero resolve against
  `rent_buddy_profiles.id`.

### A correction, because the wrong number was briefly recorded

An earlier note claimed `rank_events` held **~71,169 orphaned rows predating**
the seed deletion — i.e. a large standing orphan population in the ranking
corpus. **That was wrong and is retracted.** It came from comparing every
UUID-shaped `item_id` against `posts` alone, which counts every buddy and event
row as an orphan. The arithmetic of the error, exactly:

```
145,985 "orphans"  =  74,452 real  +  45,360 buddy rows  +  26,173 event rows
```

Measured properly, against the 100 known-deleted post ids:

| | rows |
|---|---:|
| post-referencing rows | 130,353 |
| …orphaned (no such post) | 74,452 |
| …of those, traceable to the seed deletion | **74,452** |
| …standing orphans predating it | **0** |
| buddy rows orphaned | 0 |
| event rows orphaned | 0 |
| place rows | unresolved — the `place:` prefix means they cannot be joined naively; not asserted either way |

**There is no standing orphan population.** Every orphaned post reference in
`rank_events` came from the 2026-08-09 seed deletion.

### What is actually true, and does matter for ranking

**74,452 rows — 37% of the whole table, and 57% of all post-referencing rows —
now point at posts that no longer exist.** They came from 17 distinct seed posts
served to 4 viewers, fanned out across five event types
(`ranking_item_eligible`, `_scored`, `_selected`, `_exploration_selected`, and
`item_kind='post'` impressions).

That skew is worth knowing before the corpus is used for training, evaluation or
backfill: a small number of seed items generated a large share of the logged
ranking events, and those items are now undereferenceable. Whether to sweep,
tombstone, or leave them is a ranking decision, not a cleanup one — hence this
note rather than a deletion.

Re-measure with:

```sql
select coalesce(item_kind, content_type) as kind,
       count(*) as rows,
       count(*) filter (
         where coalesce(item_kind, content_type) = 'post'
           and not exists (select 1 from posts p where p.id::text = re.item_id)
       ) as orphaned_posts
  from rank_events re group by 1 order by rows desc;
```

### 2026-08-10 — a second deletion added 18,404 more orphans

Migration `0207` deleted the 21 `source='seed_script'` posts on account
`92602b6c` (owner-approved; they rendered as broken images because their
`media_urls` pointed at objects that were never uploaded). `rank_events` was
deliberately **not** touched — no row was deleted or modified — but those 21
posts were referenced by 18,404 rows, every one of which is now orphaned.

Measured with the query above, immediately before and after:

| | before | after | change |
|---|---:|---:|---:|
| post-referencing rows | 131,577 | 131,577 | 0 |
| …orphaned (no such post) | 74,452 | **92,856** | **+18,404** |
| …as share of post-referencing | 56.6% | **70.6%** | +14.0 pt |

**Roughly seven in ten post-referencing ranking events now point at a post that
does not exist.** The concentration noted above is now worse, not better: 38
seed posts across two deletions (17 from 2026-08-09, 21 from 2026-08-10) account
for essentially the entire orphan population, and both batches were
machine-generated content served to a handful of viewers.

What this means for the feed work, stated plainly:

- **Training or evaluating on this corpus without filtering will over-weight
  seed content.** The orphaned rows are not uniformly distributed; they come
  from a tiny number of items that were served heavily.
- **A join to `posts` now drops 70.6% of post-referencing rows.** Any pipeline
  that inner-joins will silently lose most of its data and look like it is
  working.
- **The standing-orphan figure is still 0.** Every orphan here is traceable to
  one of the two deliberate seed deletions. There is no mystery population.

Still a ranking decision, not a cleanup one: sweep, tombstone, or leave. This
note records the number so the decision is made against the real one.
