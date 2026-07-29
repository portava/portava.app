---
name: Event drafts response shape
description: event_drafts DB rows are {data: jsonb, last_saved_at} but the client EventDraft type expects flattened top-level fields + updatedAt.
---

The `event_drafts` table stores autosaved fields inside a `data` jsonb column plus `last_saved_at`, `host_id`. The mobile client's `EventDraft` type (src/services/events.ts) expects `title`, `startsAt`, etc. flattened to the top level, plus `updatedAt`.

**Why:** returning the raw DB row directly (as all four drafts endpoints originally did) silently produced `undefined` title/updatedAt on the client, showing "Untitled draft" / "Saved Invalid Date" with no error anywhere — it typechecked fine because both sides used loosely-typed `any`/`Partial<EventDraft>` at the boundary.

**How to apply:** any endpoint that returns an `event_drafts` row must run it through a mapper that spreads `data` fields to the top level and renames `last_saved_at` → `updatedAt` before sending to the client. Applies to POST create, GET list, GET single, and PATCH update.
