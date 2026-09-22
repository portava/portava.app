# Telegraph history bound: the production measurement, and the two-step deployment

**Status: APPLIED 2026-09-22, FLAG STILL OFF, AND THE FLIP IS BLOCKED ON A DEPLOY.**
See §0 for what happened and why the last step waits.

## 0. What was applied, and why the flag is still false

`2400_telegraph_history_bound.sql` (sha256 `e878b280…`) applied to production
`ajrurzioarfkagpuxfnb` at **05:40 UTC**, and
`2966_telegraph_history_bound_close.sql` (sha256 `a865c2f7…`) at **05:42 UTC**,
both by the integrating lead through the Supabase Management API, both ledgered
in `public.schema_migration_ledger` with `applied_by = 'manual'` and a delivery
note recording that the files' leading `--` header comments were not transmitted
while every executable statement was sent verbatim and in file order. 2400's two
`COMMENT ON` payloads were read back afterwards and match the file character for
character.

**2400 ALONE WOULD HAVE CLOSED NOTHING, which is why the package is both.** Every
one of the 18 membership rows predates 2400, so every one would have kept
`visible_from_at = NULL`, and NULL is unbounded by design. The read-side gate was
correct and inert; what was missing was the data it reads. 2966 supplies it.

**The effect was predicted read-only BEFORE the apply and measured after, and the
two agree exactly:**

| | predicted | measured |
|---|---|---|
| rows bounded | 6 (all `trip`) | 6 — `circle 1/0`, `direct 11/0`, `trip 6/6` |
| rows left NULL | 12 | 12 |
| (member, own message) pairs hidden | **0** | **0** |
| (member, other-sender message) pairs now outside the window | 3 | 3 |
| flag `telegraph_history_bound_enabled` | `false` | `false` |
| trigger hardening in `prosrc` | present | present |

Nothing a reader sees has changed, because the flag is still off. That is the
point of splitting the steps: **the apply is the safe half.**

### Why the flip does NOT follow immediately

The flag's own description promises that turning it on bounds a specific list of
surfaces. Four of the doors that list implies — attachments and media bytes
(`lib/mediaAccess.ts`), reconnect/stream replay (`routes/telegraphStream.ts`),
the group-chat thread read (`routes/groupChat.ts`) and Compass retrieval
(`compass/TelegraphConversationTools.ts`) — **do not read the bound on
`origin/main`**, which is what production deploys. Measured: each of those four
files contains zero references to `groupChatHistoryBound` / `visibleFromOf` on
`origin/main`, and three each on this branch.

So flipping the flag before this branch merges and deploys would bind the paths
main already covers while leaving those four open, and would advertise a complete
bound while delivering a partial one. A promise the code does not keep is worse
than an unbounded reader — this document says so about the flag description, and
the rule does not get an exception when the shortfall is ours.

**The flip is therefore ordered after the deploy**, exactly as §3 Step 3 → Step 4
already required, and it is the one step of this package that has NOT been taken.

---

**Original status header, kept for the record: MEASURED, NOT DEPLOYED.** This file records what production actually
holds today and what applying migration `2400_telegraph_history_bound.sql`
would and would not change. It does not record a deployment, because none has
happened. The apply itself waits on the history-privacy lane's rehearsal; see
**Prerequisites** below for the exact list, and **What stays NOT RUN** for the
things no amount of reading can close.

The requirement is Telegraph §14.3 / §30A.4: a member added to a thread must
not gain access to messages sent before their permitted membership window.
The owner authorized that boundary explicitly, with two conditions attached —
preserve legitimate access using reliable membership evidence, and do not
invent timestamps or silently expose older history.

## 1. What production holds, measured rather than assumed

Target database: Supabase project `ajrurzioarfkagpuxfnb`, database `postgres`.
Observation window: **2026-09-22 04:22:25 – 04:24:23 UTC**, by direct catalog
probe through the Management API. Every row below is an observation, not an
inference from a migration file.

| Probe | Observed |
|---|---|
| `public.message_thread_members.visible_from_at` | **ABSENT** |
| `public.message_thread_members.joined_at` | present |
| trigger `telegraph_member_visibility_window` | **ABSENT** |
| function `public.telegraph_member_visibility_window()` | **ABSENT** |
| `feature_flags` row `telegraph_history_bound_enabled` | **ABSENT** — no row at all, not a `false` row |
| `public.message_thread_members` | 18 rows |
| …of which `joined_at IS NULL` | **0** |
| 2400 in `public.schema_migration_ledger` (`filename LIKE '2400%'`) | 0 rows |
| 2400 in `supabase_migrations.schema_migrations` (name/version like `2400`) | 0 rows |

**THE LEAK IS LIVE, AND THE FLAG IS NOT WHAT IS HOLDING IT OPEN.** There is no
flag row, so `isFlagEnabled` reads an absent flag and leaves every reader
unbounded. That is the correct fail-closed behaviour for a CAPABILITY gate — an
unreadable capability flag must not silently start hiding history — but it means
the bound is not merely switched off, it does not exist in this database.
Nothing in production restricts which messages an active member may page back
through.

## 2. What the RLS layer already does, and why it is not this

The two migrations next to 2400 in the chain are in a different state, and the
difference matters enough to state precisely, because it is easy to mistake for
partial coverage of the bound.

`2401_telegraph_messages_rls_latent_disclosure.sql` has exactly **2** executable
statements. `2402_telegraph_membership_rls_recursion.sql` has **9**. Their
coverage is **not** the same, and an earlier version of this section said it was.

**2402: all 9 verify.** Checked individually, not by object existence — policy
`qual` text compared as text, policy counts 4 / 2 / 1 across `messages` /
`message_thread_members` / `message_threads`, and for
`authz.is_active_thread_member(uuid)` the SECURITY DEFINER bit, the pinned
`search_path`, the owner, the comment string, the function body
character-for-character, EXECUTE for `anon` / `authenticated` / `service_role`
and USAGE on schema `authz` for the same three.

**2401: 1 of 2 verifies, so it is NOT fully covered.** Its second statement does
— `messages_hide_blocked_sender` is present, RESTRICTIVE, with a qual requiring a
non-null `auth.uid()`. Its first does not. 2401's own postcondition
(`2401_telegraph_messages_rls_latent_disclosure.sql:139`) requires `msg_select`'s
qual to contain `mtm.thread_id = messages.thread_id`; production's live qual is
`authz.is_active_thread_member(thread_id)`, which is **2402's** form, because 2402
recreates that policy. Run against production today, 2401's postcondition would
RAISE.

*(Corrected 2026-09-22. This section previously read "All 11 effects are observed
present … with the exact properties those files assert as their own
postconditions". That was an overstatement: it was true of 2402 and false of
2401's first statement, and the failure mode it glosses over — a later migration
overwriting an earlier one's object, so the earlier one can never be evidenced
again — is precisely the one this document exists to keep visible.)*

**Neither 2401 nor 2402 appears in either ledger.** So the honest statement is
"every effect observed present, no ledger evidence of execution" — never
"applied". No ledger row is backfilled here on the strength of a probe: a
statement-complete observation still cannot distinguish the file executing from
its statements being run by hand or reproduced by a later migration. For
`msg_select` it provably cannot, because 2402 recreates the same policy 2401
creates — and in this case 2402 demonstrably won, which is why 2401 cannot reach
full coverage at all. The one piece of 2401-specific evidence left is
`messages_hide_blocked_sender`, which no other migration in the tree creates.
**Whether 2401 ever ran in its own form is unknowable from a probe**, and that is
the honest end of the enquiry rather than a gap to be filled by assumption.

What that live policy set does: `authz.is_active_thread_member` filters on
`left_at IS NULL` and takes **no user parameter** — it reads `auth.uid()`
internally, deliberately, so it cannot serve as a membership oracle. RLS
therefore already denies a *departed* member.

**That is the membership gate, not the history bound.** It says nothing about
WHICH messages an active member may read. The two are orthogonal, and a working
membership predicate is not partial credit toward §14.3.

## 3. The two-step deployment, and why it is two

**Step one — apply 2400. Behaviour-neutral by construction.** The migration
adds a nullable column, installs a trigger, and seeds the flag `enabled = false`
with `ON CONFLICT (flag) DO NOTHING`. Nothing reads `visible_from_at` while the
flag is off. The postconditions are self-checking: the file raises if the column
is not `timestamptz`, if the trigger is absent, or if the flag was not seeded.

**Step two — flip the flag. This is the behaviour change, and it is the reviewed
half.** Turning `telegraph_history_bound_enabled` on is what starts excluding
messages from reads. Its own description commits to a specific list of surfaces:
`GET /threads/:id/messages` and its quoted-reply context, `GET /me/threads`
preview and unread, `GET /me/unread-counts`, and `GET /me/saved-messages`. A
flag whose description promises surfaces the code does not bound is worse than
an unbounded reader, because it reports a protection that is not there. The flip
does not happen until every one of those paths is exercised.

Splitting the steps also means the rollback for step two costs nothing: the flag
goes back to `false` and every reader returns to today's behaviour immediately,
with no schema change and no data loss. **2400 itself must not be reverted to
roll back a bad flip** — dropping the column would discard the only record of
each membership's window, and that record cannot be reconstructed for
memberships created after the apply.

## 4. The backfill decision, which 2400 currently makes by omission

As written, `ADD COLUMN IF NOT EXISTS` leaves every existing row at NULL, and
the column comment defines NULL as unbounded. The trigger sets the column only
for INSERTs and for rejoins from the apply forward. So on the current text, the
18 memberships that exist today stay **permanently** unbounded even after the
flag is on; the bound would reach only members added later.

The measurement above removes the usual objection to the alternative. With **0**
rows at `joined_at IS NULL`, a one-time
`UPDATE ... SET visible_from_at = joined_at WHERE visible_from_at IS NULL AND joined_at IS NOT NULL`
invents no timestamp for any row on production. It uses the recorded membership
start — the reliable membership evidence the owner authorized using — and leaves
NULL, meaning unbounded, wherever that evidence is missing rather than guessing.

This is the history-privacy lane's call and it must be made explicitly, in the
migration header, either way:

- **If backfilled**, the `WHERE joined_at IS NOT NULL` clause is not optional
  even though production has no NULLs. CI and future environments may, and a
  missing timestamp must stay unbounded rather than become `now()`.
- **If not backfilled**, the header must say that pre-2400 memberships are
  deliberately grandfathered, and what would change that — so the next reader
  does not take it for an oversight and quietly "fix" it.

## 5. Prerequisites for the apply

The apply is the lead's to perform; the lane does not apply to production. Hand
over:

1. A rehearsal on a non-production database showing 2400 applying cleanly and
   its postconditions passing.
2. Evidence that **legitimate access survives**: a long-standing member still
   reads exactly what they could read before the flag.
3. Evidence that the **leave/rejoin interval is honoured**: a member who left
   and rejoined sees the rejoin window, not the original one.
4. Evidence that a **missing timestamp stays unbounded** rather than being
   invented.
5. The bound reaching **every surface the flag's description names** — including
   pagination past the boundary, search, attachments, quoted messages, and
   reconnects, not only the first page of the main list.
6. The backfill decision from §4, written into the migration header.

## 6. What stays NOT RUN

These cannot be closed by reading code or probing a catalog, and are recorded as
unverified rather than assumed:

- **Behaviour after the flip, on production data.** Until the flag is on, no
  production read has ever consulted `visible_from_at`.
- **Client rendering of a bounded thread.** Whether a thread whose head is now
  hidden renders as a shortened history rather than as an error or an empty
  screen is a device observation.
- **Whether any real membership would lose access it should keep.** With 18
  member rows and no `joined_at` NULLs the risk is small and inspectable, but
  "small and inspectable" is not "inspected".

## 7. One-line summary for a reader in a hurry

The history bound does not exist in production — no column, no trigger, no flag
row — so newly added members can currently page back through everything, and the
fix is an unapplied migration plus a flag flip, in that order, behind a
rehearsal that has not yet been handed over.
