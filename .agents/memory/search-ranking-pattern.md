---
name: Search ranking + upsert fake-client pattern
description: rankCombined design rules, pool-fetch pattern, and upsert fake-client fix for search history tests
---

## Rule
Use `rankCombined(items, q, userCity?, opts?)` for all ranking in search. Do NOT chain a second sort after a city-boost sort — that undoes the boost.

**Why:** Code review rejected three times because rankByMatchTier was applied after DB limit already excluded candidates, and city boost was overwritten by a second sort downstream.

**How to apply:**
- Fetch pool = min(offset + fetchLimit * 3, 100) from DB, rank in Node, slice.
- `rankCombined` covers: matchTier primary → upcomingFirst tiebreak → city tiebreak.
- Pass `{ upcomingFirst: true }` for trips, plans, events.
- DB ordering: use `start_date ASC` for trips (not `created_at DESC`).
- For places with lat/lng: matchTier primary, haversine distance tiebreak (not pure distance).

## Upsert fake-client must be chainable

The fake client's `upsert()` method must return the builder (not `{ error: null }`) so that `.select("id").single()` can be chained:
```ts
upsert(row) { pending = "upsert"; upsertPayload = row; return builder; }, // NOT return { error: null }
single()    { _singleMode = true; return builder; },
```
In the `then` handler, handle `pending === "upsert"` by finding the conflict row (user_id+query+search_type) or inserting a new one, then returning `{ data: row, error: null }` in single mode.

## Search history deletion identity contract

Optimistic UI entries use synthetic `local-${Date.now()}` ids. Deletion by id sends those to the server — the server has no matching row, so deletion is a no-op. Fix:
- Backend POST returns `{ ok: true, id: "real-uuid" }` via `.upsert().select("id").single()`.
- `saveSearchHistory()` returns `Promise<string | null>`.
- UI: optimistic-add with tempId, then patches to real server id when save resolves.
