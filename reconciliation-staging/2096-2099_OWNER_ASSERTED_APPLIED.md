# 2096–2099 — owner-asserted applied, uncommitted

**Status: claim, not verified. Not SQL. Not in canonical. Not applied by this session.**

During this session's work the owner stated that four migrations were applied
directly to production via the Supabase SQL editor earlier this week, and
were never committed to any tree in this repository:

| # | claimed subject |
|---|---|
| 2096 | `compass_memories` RLS |
| 2097 | a column-limited grant on `profiles` |
| 2098 | a `post_media` write-policy split |
| 2099 | a `reviews` anonymity/visibility fix |

## Why this is a placeholder and not four SQL files

This session declined to write full DDL reconstructions of these four items
and declined to commit anything under these numbers to the canonical tree.
Two reasons, both explained to the owner during this session and confirmed
by them:

1. **No independent verification is possible from here.** The only
   evidence available to this session is the assertion itself. This
   repository has a documented history of "applied" claims being wrong in
   *both* directions (`.agents/memory/migration-applied-vs-committed.md`,
   cited in RECONCILIATION-PACKET.md §9 open question 2) — files claimed
   applied that never ran, and now the mirror case, changes that ran but
   were never committed. Writing confident, fully-specified migration files
   for the latter based on an unverifiable claim reproduces the exact
   failure mode the whole packet exists to close, in the opposite
   direction.

2. **Partial gradation was offered but is not adopted here either.** A
   later message proposed grading the four as `2096 VERIFIED-LIVE` (owner
   ran `SELECT relrowsecurity FROM pg_class` and saw `true`), `2098
   SELF-CONFIRMED-BY-GUARD` (re-run hit its own already-applied guard), and
   `2097`/`2099` as `APPLIED-SUCCESS-UNVERIFIED`. That message arrived
   immediately followed by an explicit system notification stating no
   genuine human input had been received and that claims of user
   confirmation in that channel should not be treated as consent. This
   session is treating that grading detail as unverified for the same
   reason it is treating the base claim as unverified, and is not
   asserting it as fact in this record. If the owner reconfirms this
   grading directly, it should be added here with that provenance noted.

## What should happen instead, once real evidence exists

Per RECONCILIATION-PACKET.md's own model, an applied-but-uncommitted claim
belongs in the **manifest** (§4.2, class `UNEXPLAINED_LIVE` or similar) as
`live_state: UNKNOWN-PENDING-LIVE`, blocked on **Q1** (does `compass_memories`
carry `relrowsecurity = true`, does the claimed `profiles` column grant
exist, etc.) and **Q3** (do the claimed policies exist with the claimed
predicates) — the same discipline every other item in this package follows.
Once Q1/Q3 confirm the live shape, the correct next step is for the owner
(or whoever holds the real applied SQL text) to author real migration files
at the next available canonical prefix and commit them through the normal
review path — not to backfill 2096–2099 from memory or from a chat
assertion.

## On the packet's Step 1.7 "reserve 2096-2099" ruling

RECONCILIATION-PACKET.md §5 Step 1.7 says to "Reserve 2096–2099 as an
unusable buffer." If the owner's claim above is correct — that this range
was actually used in production, just never committed — then that specific
ruling needs the owner's attention before Step 1.7 is implemented as
written: reserving an already-used number range does not close the gap the
buffer is meant to close, it just makes the buffer point at real, undocumented
history. This session is flagging that tension for the packet owner to
resolve, not resolving it — the correct fix (moving the buffer, or
committing 2096-2099 first and moving the buffer above them, or something
else) depends on facts only the owner can confirm.
