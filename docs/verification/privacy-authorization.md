# Verification lane V1 — privacy, authorization and data-access boundaries

Base: `claude/portava-continuation-uqta94` @ `f224ae67e`. Branch:
`claude/verify-privacy-authz`. Measurements dated 2026-09-16.

Scope: `artifacts/api-server`. Databases: **portava-ci** (`hwokxgbmezheskbzskfr`)
was written to only inside transactions that ended in a deliberate `RAISE`;
**production** (`ajrurzioarfkagpuxfnb`) was read only, and every statement issued
against it in this lane was a `SELECT` over `pg_catalog` / `pg_policies`.

Everything below is either a number this lane measured or a defect it found. Where
something could not be measured, it says so and says why.

---

## 1. The reachability census, re-derived

The question: how many application (non-extension) `SECURITY DEFINER` functions in
`public` can a client role — `anon` or `authenticated` — execute, and how many of
those are VOLATILE, i.e. carry PostgreSQL's own marker for "may write"?

Method: catalog query, no probe needed for the count.
`pg_proc.prosecdef`, `provolatile`, `prorettype <> trigger`, no `pg_depend`
`deptype='e'`, not named by any `pg_policies` `qual`/`with_check` in any schema,
and `has_function_privilege('anon'|'authenticated', oid, 'EXECUTE')`.

| reachable by a client role | production | portava-ci |
|---|---|---|
| policy-referenced STABLE boolean | 12 | 11 |
| `event_is_in_state` (STABLE, unused) | 1 | 1 |
| trigger-returning | 5 | 5 |
| **VOLATILE WRITERS** | **3** | **23** |
| total | 21 | 40 |

**Unchanged from the figure 2973 was written against: 3 on production, 23 on CI.**
No function is newly reachable. The surrounding population DID grow — application
`SECURITY DEFINER` functions went 90 → 94 on production and 73 → 77 on CI, and the
2973 sweep predicate went 48 → 52 matches on CI — so the four integrated lanes
added `SECURITY DEFINER` functions, and none of them is a client-reachable
volatile writer. That is the useful reading: population up, defect flat.

Production's three, all reachable by `authenticated` and not by `anon`:
`increment_distribution_stats`, `purge_old_ranking_debug_samples`,
`upsert_hashtag_usage_and_increment`. Same three names 2973 records.

**An authenticated administrator is a client user too.** The three above are
reachable by any logged-in account, admin or not; and separately, the admin-gated
write surfaces in the API are not "no client writes" — they are writes an
authenticated client makes, which the api-server authorizes and then performs as
`service_role`. `admin_set_profile_role` is the worked example: its own predicate
admits `service_role`/`postgres`/`supabase_admin` and rejects `authenticated` by
name, so an administrator's JWT was never what made that call legal.

---

## 2. Migration 2973 — rehearsed, green, and three header claims corrected

### Rehearsal

The whole file (sweep + checks A/B/C + postconditions 1-4) run as one statement
against portava-ci, ending in a `RAISE` so the implicit transaction aborted:

```
ERROR:  P0001: REHEARSAL-2973-ROLLBACK :: A pass (swept=52); B pass; C pass;
        P1 pass (examined=77); P2 pass; P3 pass; P4 pass;
```

Rollback verified immediately afterwards — CI still measured **23** reachable
volatile writers, i.e. nothing landed.

**All six assertions hold at the current schema.** The file is correct as written
and is ready to apply.

### Three header claims that were not true, now fixed in the file

1. **A named guard that does not exist.** The header said the drift this file
   cannot prevent "is caught instead by `checkSecurityDefinerExposure.ts`, which
   fails the build the day a new volatile SECURITY DEFINER function becomes
   client-reachable." `grep -rn checkSecurityDefinerExposure` over the whole
   repository matches that line and nothing else. No such script exists, and no
   script does that job — `checkSecurityDefinerOracles.ts` is offline, asks "does
   anything reference this function", never reads a live `EXECUTE` grant, and its
   own header concludes that for the referenced case "there is nothing to remedy
   at this layer".
2. **"Every certify run re-asserts…"** overstated STAGE 4's reach.
   `certifyMigrations.ts` scopes stages 2-4 to *the migrations that run applied*
   (by ledger run id), or to a `--files` set. A CI run that applies nothing
   re-runs nothing here.
3. **Stale counts.** `73`/`90`/`48` are now `77`/`94`/`52`; postcondition 1's
   message was repointed. The 40-function floor was deliberately NOT raised — it
   exists to catch an empty population, and a floor that must be edited whenever a
   migration adds a function is a floor somebody eventually raises past a real
   regression.

### Still open, and it is the lead's call

There is no standing live check that fails the build when a new volatile
`SECURITY DEFINER` function becomes client-reachable. 2973's postcondition 2 is
the only thing that asserts it, and only when 2973 is in certify's scope. **A
`check:security-definer-exposure` script is unwritten work, not a thing this
header may claim is done.** It would be roughly the postcondition-2 query against
the live catalog, in the shape `checkSecurityDefinerOracles.ts` already
establishes.

---

## 3. Migration 2974 — its postcondition was vacuous; measured, and repaired

### The finding

Postcondition 2 assumed `anon`, called `toggle_feature_flag_with_audit` with a
flag name that cannot exist, and passed on SQLSTATE `42501`. **Two different
events produce `42501` on that call**, and it could not tell them apart:

- `42501 :: toggle_feature_flag_with_audit: caller is not privileged` — 2974's guard
- `42501 :: permission denied for function toggle_feature_flag_with_audit` — 2973's REVOKE

2973 applies first (lower number; its own header calls itself a PREREQUISITE), so
the second message is the one that comes back. Measured on CI, with 2973's effect
applied and 2974's guard **deliberately not installed**:

```
ORDERING-PROBE-ROLLBACK :: body_actually_has_guard=f ;
  2974_postcondition2_verdict=t ; sqlstate=42501 ;
  msg=permission denied for function toggle_feature_flag_with_audit
```

A postcondition reporting "the caller guard is effective" with no guard present.
And it is the steady state rather than an apply-day quirk: certify STAGE 4 re-runs
`$post$` against the committed database, where 2973 is always already applied. The
day someone `CREATE OR REPLACE`s that body and drops the guard, STAGE 4 would have
gone on reporting green.

### The repair, and its proof

Postcondition 2 now discriminates on the message and records which evidence it
had; two new assertions carry the claim in the world where the end-to-end call can
no longer reach the guard:

- **2b** runs the predicate live, both ways: `false` for `anon`, `true` for the
  server. (A single explicit `GRANT EXECUTE` on the new STABLE predicate was added
  so 2b does not depend on a Supabase default nobody wrote down. It discloses
  nothing — the caller already knows whether it is the server.)
- **2c** requires the body to consult the predicate *before its first write*. This
  is textual and is labelled textual: once `EXECUTE` is revoked there is no client
  role left that can reach the guard, so no runtime probe can observe the order.

Rehearsed on CI in three worlds, one rolled-back transaction:

```
REHEARSAL-2974-ROLLBACK ::
  A(2973 absent)  = PASS [end-to-end: the guard itself refused anon]
                    anon=42501 :: toggle_feature_flag_with_audit: caller is not privileged
  B(2973 applied) = PASS [indirect: EXECUTE is revoked (2973); 2b and 2c are the evidence]
                    anon=42501 :: permission denied for function toggle_feature_flag_with_audit
  C(2973 applied, guard REMOVED)
                  = correctly refused: 2974 postcondition 2c FAILED:
                    the body does not consult caller_is_privileged_service().
```

**World C is the point.** It is the exact scenario the old postcondition passed.
Rollback verified: the helper did not land, the toggle is still unguarded on CI,
`anon` still holds `EXECUTE`.

Both `$post$` blocks were re-checked against certify's own
`isAssertionOnlyDoBlock` rule (`DO` + `RAISE` + zero mutation keywords after
comment/literal/dollar-body masking): **2973 collectible, 2974 collectible.**

---

## 4. Route authorization gates

For each write path: what stops an anonymous caller, an ordinary authenticated
caller who is not a participant, and a participant who should not do this
specific thing.

### `routes/telegraphVoice.ts` — one defect, fixed

| caller | stopped by | verdict |
|---|---|---|
| anonymous | `requireUser` → 401 | held (now pinned) |
| non-member | `guardTelegraphThreadWrite` ACTIVE-membership read → 403 | held, already pinned |
| member who should not do *this* | **nothing** | **DEFECT — fixed** |

**The defect.** `payload.url` was validated with `appStorageUrlInfo()` only. That
answers "is this one of OUR buckets", never "is this YOUR object" —
`lib/intelEvidenceCapture.ts` says so in those words. `post-media` is a **private**
bucket (`SELECT id, public FROM storage.buckets` on portava-ci: `post-media =
false`). And `lib/mediaAccess.ts:416` branch 3c authorises message media on
*"some message references this object AND the viewer is a member of that
message's thread"* — it never asks whether the sender owned it, returning
`Boolean(member)` directly.

Composed, that is a read primitive against a private bucket, not a mislabelled
bubble: send a voice message in a thread you control whose `url` is a victim's
object key, then fetch it — branch 3c finds the message, finds you are a member,
and serves the bytes. A user would see someone else's photograph or recording
rendered inside a conversation of the attacker's choosing.

Branches 3b (posts), 3d (stories) and 3e (highlights) were each hardened against
exactly this composition; 3c was not. The Highlights & Memories lane closed its own
half — `POST /memories/:id/items` refuses `foreign_storage` through
`services/memory/memoryMediaOrigin.ts`. The voice lane did not.

**Fixed** at `routes/telegraphVoice.ts:249` by applying the same shared
classifier, with the same three verdicts: `foreign_storage` refused,
`unattributable_storage` accepted and logged (refusing on an inability to
attribute turns a naming convention into an outage), `external` already refused by
the origin check above it. The refusal names no other user's id.

Red-first evidence in `src/test/verifyAuthzVoiceMediaOwnership.test.ts`: 3 failing
against `f224ae67e` unmodified, 10/10 after the fix, and `telegraphVoice.test.ts`
still 42/42.

### `routes/airport.ts` (layover) — gates hold

All eighteen non-admin write routes reach `requireOwnedSession` →
`ownedSessionOr` → `getSession(sc, id, userId)`, which filters
`.eq("user_id", userId)` and returns a *refusal* rather than `not_found` when the
read errors. The seven `/admin/airport/…` routes go through the single
`lib/requireAdmin.ts`, which itself fails closed on the `profiles` role read.

A stranger gets `404`, not `403` — correct, since `403` would confirm the session
exists. Verified by `src/test/verifyAuthzLayoverCrossTenant.test.ts` (12/12, green
on arrival). Two mutations were run to prove the assertions bite, and the second
one found something worth recording: **the layover surface has two independent
ownership filters, not one.** `DELETE /sessions/:id` does not use
`requireOwnedSession` at all — it calls `endSessionWrite()`, which carries its own
`.eq("user_id", userId)`. Deleting the filter from `getSession` breaks four cases
and leaves DELETE green; a fix applied to only the obvious one would leave the
other open.

### `routes/highlights.ts` — gates hold

Every engagement and mutation route funnels through `resolveViewAccess`, which is
fail-closed at four distinct reads (the highlight row, the two block directions,
circle membership, trip membership) and answers `db_error` rather than
`not_found` when it cannot decide. Owner-only actions (`delete`, `pin`, `archive`,
`viewers`, `projection-policy`) are scoped `.eq("owner_id", user.id)` or check
`owner_id !== user.id` explicitly.

### `routes/memories.ts` — gates hold

Owner-only writes check `owner_id !== user.id`; engagement writes (`like`, `save`)
run `isBlocked` + `canReadMemory` first; `PATCH /:id/tags/:userId` routes through
`authorizeParticipantCommand`, which distinguishes owner from tagged participant
rather than treating "is a participant" as one permission.

### `routes/discovery*.ts` — writes are self-scoped

All four writes are `requireUser` + a `user_id` taken from auth and never from the
body. `discoverySearch.ts` has no write routes.

---

## 5. Fail-closed posture of the privacy reads these routes depend on

| read | posture | evidence |
|---|---|---|
| `isBlockedBetween` (`lib/blockGuard.ts`) | **closed** — returns `true` on error, `.limit(1)` so a mutual block cannot raise | file's own header; used by the voice write guard |
| `isKillSwitchEngaged` (`lib/featureFlags.ts`) | **closed** — `true` on error and on throw | read directly |
| `guardTelegraphThreadWrite` membership/roster/e2ee reads | **closed** — each errors to `degraded_unavailable` | read directly; pinned by `telegraphVoice.test.ts` |
| `resolveViewAccess` (highlights) | **closed** at all four reads | read directly |
| `getSession` / `endSessionWrite` (layover) | **closed** — refuses rather than answering `not_found` | pinned by `layoverUnreadableReads.test.ts` |
| `requireAdmin` role read | **closed**, and says it is not a role denial | `lib/requireAdmin.ts` |

No `catch {}` around a membership check was found on any of the audited write
paths. One **fail-open** read was found, and it is on a read path rather than a
write path:

**`routes/discovery.ts:2642` — the event-post feed serves blocked users when the
`blocks` read fails.** The code says so itself: *"event posts keep their
documented fail-OPEN posture: `blockedIds` stays empty and the pipeline below
filters on exactly that set, which means a failed read serves blocked users.
Unchanged, but it must stay observable — hence the warn."* The sibling
`placeBlockedIds` on the same request fails CLOSED. So one request holds two
opposite postures on the same block relationship. It is documented, deliberate and
observable, which is why it is reported rather than changed unilaterally: flipping
it changes feed behaviour, and that is a product decision. It is inconsistent with
`lib/blockGuard.ts`, which is the canonical answer to this exact question.

---

## 6. Open items for the lead — outside this lane's file ownership

1. **`lib/mediaAccess.ts:416` branch 3c does not check object ownership.** This is
   the read half of the finding in §4 and the more complete fix. The remedy is the
   one branches 3b/3d/3e already use: select the message's `sender_id` alongside
   `thread_id` and only decide when `ownerFromPath(path) === sender_id`,
   otherwise fall through. Closing the voice write path alone does **not** close
   the hole, because —
2. **`routes/messaging.ts:3160`, `POST /threads/:threadId/media`, has the same
   gap and is pre-existing.** It validates `appStorageUrlInfo` and does not check
   `ownerFromPath`. `AccountDeletionService.ts:714` already documents this in so
   many words: *"a sender can store a key belonging to somebody else and the row
   is legitimate."* It is the second door into branch 3c.
3. **`routes/discovery.ts:2642`'s fail-open block read**, per §5.
4. **`check:security-definer-exposure` is unwritten**, per §2.

---

## 7. What this lane could NOT verify, and the blocker

- **Neither 2973 nor 2974 was applied anywhere.** Both were rehearsed and rolled
  back, per the task's instruction and because production is read-only to this
  lane. "Rehearsed green" is not "applied"; the ledger is unchanged and certify
  STAGE 4 has never run these blocks for real.
- **`pnpm run certify:migrations` was not run.** It needs a Supabase management
  access token this environment does not carry. STAGE 4 collectibility was
  therefore verified by re-implementing certify's own
  `isAssertionOnlyDoBlock`/`maskForKeywordScan` rules faithfully and applying them
  to the two `$post$` blocks — a strong check, but not the script itself.
- **`pnpm run check:all` was not run**, so no exit-0 / exit-1 / exit-2 verdict is
  claimed for it. The checks that were run, with their exit codes, are in §8.
- **The exfiltration primitive in §4 was reasoned from code, not executed
  end-to-end.** The three facts it composes were each measured (`post-media` is
  private; branch 3c returns `Boolean(member)` without consulting `sender_id`; the
  write path accepted a foreign key, shown red in a test). The composition was not
  demonstrated against a live storage object, because doing so would have meant
  writing a message row and fetching another account's bytes on CI.

---

## 8. Commands run, and their exit codes

From `artifacts/api-server`:

| command | exit |
|---|---|
| `pnpm run typecheck` | 0 |
| `pnpm run check:test-registration` | 0 (1297 registered of 1327 on disk) |
| `pnpm run check:doc-citations` | 0 (`RESULT clean`) |
| `pnpm run check:citation-targets` | 0 (`✓ at the ceiling: 239 / 239`) |
| `node --import tsx/esm --test src/test/verifyAuthzVoiceMediaOwnership.test.ts` | 0 — 10/10 |
| `node --import tsx/esm --test src/test/verifyAuthzLayoverCrossTenant.test.ts` | 0 — 12/12 |
| `node --import tsx/esm --test src/test/telegraphVoice.test.ts` | 0 — 42/42 (regression check) |

Test runner form:
`SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test <file>`

## 9. Files this lane touched

- `artifacts/api-server/src/migrations/2973_security_definer_execute_boundary.sql` — header corrections only; no SQL changed.
- `artifacts/api-server/src/migrations/2974_toggle_feature_flag_caller_guard.sql` — postcondition rewritten, one `GRANT` added on the new predicate, header records the finding.
- `artifacts/api-server/src/routes/telegraphVoice.ts` — the ownership guard (§4).
- `artifacts/api-server/src/test/verifyAuthzVoiceMediaOwnership.test.ts` — new.
- `artifacts/api-server/src/test/verifyAuthzLayoverCrossTenant.test.ts` — new.
- `artifacts/api-server/package.json` — the two new test files appended to the `test` script.
- `docs/verification/privacy-authorization.md` — this file.

`src/services/airport/LayoverSessionService.ts` was mutated twice to gather red
evidence and restored both times; `git status` confirms it is unmodified.
