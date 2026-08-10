---
name: Scope account work by owner id, never by a content attribute
description: posts.source='seed_script' is not an ownership marker — a real active account owns 21 such posts; resolve every account claim to an id and re-read it against live before acting.
---

Documented case — the 2026-08-09 seed-account deletion
(`docs/orphaned-rows-2026-08-09.md`, `docs/admin/moderation-coverage.md`
§"Seed-post deletion and the 7 real-user rows").

**The content attribute did not identify the owner.** Deletion was deliberately
scoped **by account ownership, never by `posts.source`**, because
`source = 'seed_script'` is not an ownership marker: the real, active account
`anroletrading@gmail.com` owns 21 `seed_script` posts, including 14 dangling media
rows that were explicitly out of scope. Deleting by that attribute would have hit a
live user's content.

**A second real account was caught anyway, through the FK graph rather than a
predicate.** The cascade removed 7 rows owned by `highrollsmoke@gmail.com`
(3 `posts_comments`, 2 `post_reactions`, 2 `post_saves`), plus 4 `content_stamps`
that did *not* cascade (no FK — polymorphic `entity_type`/`entity_id`) and are now
dangling. Scoping by owner id is necessary, not sufficient: check what hangs off the
rows you are deleting.

**What a sound identification looked like:** 20 accounts pinned by id, each
independently confirmed never signed in — `last_sign_in_at IS NULL`, **zero
`auth.sessions`, zero `auth.refresh_tokens`** — and the probes themselves proven
capable of detecting a sign-in, since a known-active account returns 81 sessions /
19,418 refresh tokens. A negative probe that has never returned a positive proves
nothing.

**How to apply:** resolve every account claim to a `profiles.id` / `auth.users.id`
and re-read that row directly against live (Management API — see
[live-db-vs-local-postgres.md](live-db-vs-local-postgres.md)) before acting on it or
writing it down. Before any destructive scope, run the identifying predicate and
**count the matches** — if it returns more than the accounts you meant, it is the
wrong predicate. Scope deletions by owner id, never by a content attribute, and
enumerate the FK children (and the tables with *no* FK) first.
