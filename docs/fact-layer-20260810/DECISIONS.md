# Decision log — 2026-08-10

What the fact layer does not record: **why** things were decided, and **what each held
decision is waiting on**. Commit messages capture what changed; `00_VERIFIED_STATE.md`
captures what is true. This captures what was chosen.

Owner decisions are marked **[OWNER]**. Where a decision reverses or corrects an earlier one,
the earlier one is kept and struck rather than deleted.

---

## DECIDED

**Restore the CI project from a production schema dump, never from replaying migrations.**
Replay would make `audit:schema` compare migration files against a database built from those
same files — passing by construction. Later confirmed mechanically: `0026_highlights.sql`
references `deleted_at` and `user_id`, and the live table has neither, so a replay would error
partway and leave the project half-built.

**Two front doors, not one.** Read-only audits reach declared production outside CI on a
deliberate request; write-capable scripts and the RLS suites cannot, by any route. Rationale:
auditing production is those scripts' purpose, and a uniform guard removed a capability while
buying no safety. The read-only door refuses whenever any CI marker is present, so it cannot
function inside Actions.

**Enumerate populations; do not pattern-match risky shapes.** Applied three times, and each
time the population was larger than estimated: 52 Supabase-reaching files, 4021 schema claims,
103 flags. Pattern-matching would have missed `invite_only_beta` (no `disable_` in the name),
`GRANT EXECUTE` (invisible to `role_table_grants`), and `post_event_links` (a skipped
conditional wrapping an untracked statement type).

**Retire `media_assets_public_select` and `media_attachments_public_select`.** Every reader
uses the service client, so RLS is bypassed; neither mobile app references those tables; the
existing owner-select policies are already unexercised. Applying them would widen access with
no consumer. Recorded as allowlist entries with reasons — explained drift, not skip-listing.
**[OWNER]**

**Apply `post_event_links` rather than retire it.** The API accepts `eventId`, returns 200,
and discards it. Applying three lines of DDL is a smaller change than removing three code
sites, a PUT route with a live ownership check, `2070`'s conditional RLS block, and a
`checkWritePathColumns` baseline entry. **[OWNER]**

**~~Emergency stops failing open on DB error is a defect.~~ SUPERSEDED 2026-08-10.**
`0065_phase7_safety.sql:39-41` documents the fail-open as deliberate: *"so a DB outage never
silently locks users out of the app."* The honest account is that we **reversed a documented
design decision**, accepting "users locked out during a DB outage" in exchange for "the stop
actually stops." The reasoning holds — a stop that disengages during an outage is not a stop —
but it was a trade-off, not a bug.

**`CODEOWNERS` scoped narrowly, and honest about what one maintainer can enforce.** A `*`
default rule would put every PR behind a requirement that adds no protection and would make
the bypass routine. With a single maintainer, required Code Owner review means the change is
*flagged*, not that a second person reviewed it. Stated in the file itself. **[OWNER]**

**No P1 architecture work may use an unverified factual claim as a prerequisite.** **[OWNER]**
The rule that governs everything below.

---

## HELD — and what unblocks each

**`content_stamps` reaper — held pending an explicit retention window.** **[OWNER]**
`0207`'s `MANIFEST.md` states the restore path depends on the orphans resolving again: the 21
deleted post ids are deterministic UUIDv5, so re-inserting them re-attaches ~18,756 rows. A
reaper destroys that property. The table is polymorphic (`entity_type` + `entity_id`), so an FK
is not available and cleanup would be trigger or application logic.
→ **Unblocks when:** you name a retention duration longer than the restore window. Then the
reaper is implementable with a boundary test either side of it.

**`post_media_storage_public_read` — held pending two questions, not one.** **[OWNER]**
The read-path audit found live paths that depend on anonymous SELECT: three components read
`mediaUrl` / `avatarUrl` / `thumbnailUrl` straight onto `<Image>` without hydration. So the
change is a migration of those paths, not an RLS cleanup.
→ **Unblocks when:** (a) the policy is confirmed live — only its *declaration* in `0103` is
verified — and (b) what `SELECT TO public` grants on a bucket with `public = false` is probed
rather than inferred. If (b) resolves the other way, the OG path is not already broken and the
policy is load-bearing, which flips the urgency back.

**Account-scoping flag — held until reads and writes are both proven end-to-end.** **[OWNER]**
Nine fixes sit behind it, shipping off, with inertness proven by test including that a live
scheduled notification survives.

**Blocker 4 / populating `creatorId` — held, owner scoping call.** **[OWNER]**
Populating it alone simultaneously activates `relationshipRelevance`, `activityBoost`,
`fatiguePenalty` and the creator cap — four behaviours that have never executed against real
values. The question is whether that gets its own arm and its own measurement, or is treated as
prerequisite plumbing.

**Discovery feature flag — held on design, not permission.**
A flag around the ranker guards a branch most traffic never reaches. Worse, `compass/flags.ts`
queries `.like("flag", "COMPASS_%")`, so a `DISCOVERY_*` flag read through that loader returns
false forever with no error. The boundary must sit above the cache fork, and shadow mode must
not perturb Cache A — there is no in-flight dedup on the places path, so a shadow computation
can trigger a second Overpass round-trip and race to write L2.

---

## CLAIMS I MADE THAT TURNED OUT WRONG

Recorded because the corrections are load-bearing and the errors were mine.

**"Management API tokens cannot be project-scoped."** Stated as fact and used to justify why
the allowlist guard checks the target. `docs/eas-runbook.md:314` describes
`SUPABASE_PROJECT_TOKEN` as "Project-scoped, read-only … Preferred" with a creation path.
Unresolved — needs a token inspected and tested against a second project. The guard is still
worth having; the *justification* was built on an unverified vendor claim.

**"`content_stamps` is still minting orphans."** A unit mismatch in the diagnostic: it counted
across all 13 entity types while the backup counted `entity_type='post'` only. 18,756 is fixed,
not a floor. Every orphan came from a deletion, not a bad write.

**"Three pre-armed traps in `2033` §13."** `saved_posts`, `saved_trips` and `trip_expenses` are
declared by no migration; they were speculative probe names that I amplified into a plan item
and then built a discrimination test on.

**"Add `CONCURRENTLY` on anything large."** Nothing is large — production row counts are 104,
17, 6 and 4. `CONCURRENTLY` would also have made the `BEGIN … ROLLBACK` rehearsal impossible,
which was worth more than the lock duration.

**"Model `GRANT` against `role_table_grants`."** 18 of 19 GRANTs are `GRANT EXECUTE ON
FUNCTION`, invisible to that view. Following the instruction literally would have covered 1 of
19 while reporting `GRANT` as a covered claim type.

**"Any mode flag must be part of every cache key."** True for `_compassCandidateCache`, which
holds post-ranking output. Wrong for L1/L2, which hold only the raw pre-rank array and are
arm-independent.

**"The surface CHECK admits 14 values."** Twelve is the widest any committed migration
declares.

---

## THE PATTERN, IF ONLY ONE THING IS CARRIED FORWARD

Every failure this session had the same shape: **something reported success while executing
nothing.** A skipped job read as a pass. A migration committed but never applied. An insert
rejected by a CHECK and discarded. A test asserting behaviour indistinguishable from its
absence. A doc claiming a state the code contradicted. An emergency stop that disengaged
exactly when needed. Four stops with no reader at all.

The fix was never a better pattern-match. It was: enumerate the population, require each member
to be accounted for in writing, and prove the check goes red before trusting that it is green.
