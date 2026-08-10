---
name: resolveInteractionPermissions swallows context-query failures
description: Context queries inside resolveInteractionPermissions are wrapped in .catch(() => false), so a failed query is indistinguishable from a genuine "no relationship" and silently leaves capability flags off.
---

**Reconstructed 2026-08-10.** `MEMORY.md` linked this entry but the file had
never been committed (`git log --all --diff-filter=A` finds no add, and
`.agents/memory` has only 4 commits in total). The index line was the only
surviving copy. It is rebuilt below from the code and the test it refers to —
treat the *shape* of the rule as recovered and the specific line numbers as
re-derived today, not as the original text.

`artifacts/api-server/src/services/interactionPermissions.ts` is deliberately
two-tier about failure, and the two tiers look identical from the outside:

**Fail-closed, by design** — its own header documents this, and it is correct:

> `Block check is FAIL-CLOSED: any DB error on the blocks query is re-thrown.`
> `We never assume "no block" when the query fails.`

**Fail-quiet** — the *context* queries in the same function are not:

```ts
    })().catch(() => false),
    ).then((r: any) => Boolean(r.data)).catch(() => false),
```

Three of these run in one `Promise.all` — shared trip, shared circle, and the
Rent-a-Buddy pre-booking check — feeding `ctx.sharedTrip`, `ctx.sharedCircle`
and `ctx.rabPreBooking`. Grep for them rather than trusting a line number:

```bash
grep -n 'catch(() => false)' \
  artifacts/api-server/src/services/interactionPermissions.ts
```

**Why this bites.** `false` is also the legitimate answer. A missing table, an
RLS denial, a malformed `.or()` filter and "these two users genuinely share no
trip" all arrive at the caller as the same `false`, with nothing logged. The
capability flags derived from that context are then off, and the surface degrades
to its most restrictive rendering — which looks like a working privacy rule, not
a broken query. Nothing fails; the feature is just quietly absent.

This is a different failure mode from the `optQuery()` helper the header
describes, which silences *only* "table does not exist" and propagates everything
else. `.catch(() => false)` silences everything.

**How to apply.** When a permission-derived flag must be right — not merely
safe-by-default — do not read it off `resolveInteractionPermissions`. Query the
underlying table directly and check `error` yourself. The passport
`limited_preview` path is the worked example: it queries `friend_requests`
directly, the same way the search endpoint does. `profilePrivacy.test.ts` records
both the reason and the fix in comments:

> `instead of relying on resolveInteractionPermissions (which could throw silently).`
> `The fix: the passport limited_preview path now queries friend_requests directly`

Conversely, do **not** "fix" these three `.catch`es by re-throwing without
checking the callers: they sit on the permissive side of the priority order
(items 7–9, context/friendship/follow), so swallowing there degrades access
rather than granting it. The bug is the silence, not the default.
