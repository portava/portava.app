---
name: messages ciphertext schema drift
description: Root cause of a global "message send fails" bug — live DB missing a column the insert code always sends
---

# messages.ciphertext / message_threads.is_e2ee schema drift

The E-2 (E2EE) migration `20260803_messages_ciphertext.sql` (adds `messages.ciphertext`
and `message_threads.is_e2ee`) existed in the migrations dir but was never applied to
the live Supabase DB. The message-send route always includes `ciphertext` in the
insert payload (null for non-E2EE messages), so PostgREST rejected **every** message
send project-wide with `db_error: Could not find the 'ciphertext' column of 'messages'
in the schema cache` — surfaced by users as "can't send in event chat" even though the
real cause had nothing to do with event-chat membership logic.

**Why:** `docs/migrations.md` / migration files are not proof a migration ran — the only
reliable signal is querying live `information_schema.columns` (see
`supabase-migration-access.md`). A column any route unconditionally writes is a single
point of failure for that entire feature area if the migration silently didn't apply.

**How to apply:** when a "send/save fails" report doesn't match the suspected business
logic (e.g. membership, permissions), check for `db_error` / schema-cache messages first
and diff the touched table's live columns against its migration file before chasing
application-layer theories.
