# Telegraph history bound: the production measurement, and the two-step deployment

**Status: MEASURED, NOT DEPLOYED.** This file records what production actually
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
statements. `2402_telegraph_membership_rls_recursion.sql` has **9**. All 11
effects are observed present on production with the exact properties those
files assert as their own postconditions — checked individually, not by object
existence: policy `qual` text compared as text, `permissive` = RESTRICTIVE where
required, policy counts 4 / 2 / 1 across `messages` /
`message_thread_members` / `message_threads`, and for
`authz.is_active_thread_member(uuid)` the SECURITY DEFINER bit, the pinned
`search_path`, the owner, the comment string, the function body
character-for-character, EXECUTE for `anon` / `authenticated` / `service_role`
and USAGE on schema `authz` for the same three.

**Neither 2401 nor 2402 appears in either ledger.** So the honest statement is
"every effect observed present, no ledger evidence of execution" — never
"applied". No ledger row is backfilled here on the strength of a probe: a
statement-complete observation still cannot distinguish the file executing from
its statements being run by hand or reproduced by a later migration. For
`msg_select` it provably cannot, because 2402 recreates the same policy 2401
creates; the one piece of 2401-specific evidence is
`messages_hide_blocked_sender`, which no other migration in the tree creates.

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
