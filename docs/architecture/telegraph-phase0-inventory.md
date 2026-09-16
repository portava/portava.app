# Telegraph Phase 0 — mandatory inventory

**Generated. Do not edit by hand.**
`node --import tsx/esm artifacts/api-server/src/scripts/generateTelegraphInventory.ts`
rewrites this file; `--check` fails when it no longer matches the tree, and that
check runs in `check:all`.

This is the deliverable Telegraph §25.1 calls the mandatory Phase 0 inventory and
Appendix B calls PR T0 — "Inventory report only: current schema, paths, RLS, enums,
realtime, media, direct writes, source-domain bridges". It is generated rather than
written because an inventory written by hand is stale the next day, and a stale
inventory is worse than none: it is a document people quote.

It carries no `file:line` citations on purpose — a generated line number is
invalidated by any edit above it, in files this report does not own. What it names
are files, tables, routes, event types and literals, each re-derived on every run.

---

### 1. Messaging schema

| table | in production table list | columns in baseline | RLS disposition |
| --- | --- | --- | --- |
| `message_reports` | yes | 5 | RLS_REQUIRED |
| `message_requests` | yes | 8 | RLS_REQUIRED |
| `message_thread_members` | yes | 8 | RLS_REQUIRED |
| `message_threads` | yes | 11 | RLS_REQUIRED |
| `message_translations` | yes | 11 | RLS_REQUIRED |
| `messages` | yes | 19 | RLS_REQUIRED |
| `thread_reports` | yes | 5 | RLS_REQUIRED |
| `saved_messages` | yes | 4 | RLS_REQUIRED |

### 2. Migrations that touch a messaging table

31 of 554 migration files reference at least one messaging table.

- `src/migrations/0011_message_type.sql`
- `src/migrations/0016_thread_reads.sql`
- `src/migrations/0022_availability_nudges.sql`
- `src/migrations/0057_reply_to_messages.sql`
- `src/migrations/0063_interaction_foundation.sql`
- `src/migrations/0117_beta_feature_flags.sql`
- `src/migrations/0152_messages_media.sql`
- `src/migrations/0161_friend_requests_responded_at.sql`
- `src/migrations/0164_write_path_drift_columns_2.sql`
- `src/migrations/0201_pin_search_path_authz_functions.sql`
- `src/migrations/20260724_compass_memories.sql`
- `src/migrations/20260803_messages_ciphertext.sql`
- `src/migrations/20260805_events_core_flags.sql`
- `src/migrations/2027_media_private_buckets_prep.sql`
- `src/migrations/2070_rls_hardening.sql`
- `src/migrations/2136_profiles_auth_users_convergence.sql`
- `src/migrations/2139_shared_content_tombstones.sql`
- `src/migrations/2140_deletion_receipt.sql`
- `src/migrations/2182_close_authz_rpc_oracle.sql`
- `src/migrations/2199_call_participants_rls_recursion.sql`
- `src/migrations/2325_telegraph_unsend_before_seen.sql`
- `src/migrations/2338_memory_location_precision.sql`
- `src/migrations/2400_telegraph_history_bound.sql`
- `src/migrations/2401_telegraph_messages_rls_latent_disclosure.sql`
- `src/migrations/2402_telegraph_membership_rls_recursion.sql`
- `src/migrations/2460_meetup_invites_self_invite_latent_disclosure.sql`
- `src/migrations/2802_telegraph_live_references_flag.sql`
- `src/migrations/2810_telegraph_message_kernel.sql`
- `src/migrations/2811_telegraph_message_side_tables.sql`
- `src/migrations/2812_telegraph_report_evidence.sql`
- `src/migrations/2813_telegraph_request_origin.sql`

### 3. Server routes that read or write a messaging table

| route file | route declarations in file | messaging tables touched |
| --- | --- | --- |
| `src/routes/airport.ts` | 37 | message_threads |
| `src/routes/blocks.ts` | 5 | message_requests |
| `src/routes/circle.ts` | 24 | message_threads, messages |
| `src/routes/compass.ts` | 42 | message_thread_members, message_threads |
| `src/routes/events.ts` | 92 | message_thread_members, message_threads, messages |
| `src/routes/follows.ts` | 12 | message_thread_members |
| `src/routes/groupChat.ts` | 6 | message_thread_members, message_threads, message_translations, messages |
| `src/routes/hiddenGems.ts` | 27 | message_thread_members, messages |
| `src/routes/highlights.ts` | 22 | message_thread_members, message_threads, messages |
| `src/routes/meetups.ts` | 12 | message_threads, messages |
| `src/routes/messaging.ts` | 31 | message_requests, message_thread_members, message_threads, message_translations, messages, saved_messages |
| `src/routes/rentABuddy.ts` | 116 | message_thread_members, message_threads, messages |
| `src/routes/telegraphChat.ts` | 7 | message_thread_members, message_threads, messages |
| `src/routes/telegraphCoordination.ts` | 8 | message_thread_members, message_threads, messages |
| `src/routes/telegraphKinds.ts` | 4 | message_thread_members, message_threads, messages |
| `src/routes/telegraphLifecycle.ts` | 3 | message_thread_members, messages |
| `src/routes/telegraphMemory.ts` | 2 | message_thread_members, messages, saved_messages |
| `src/routes/telegraphShare.ts` | 2 | message_thread_members, message_threads, messages |
| `src/routes/telegraphSharedContext.ts` | 3 | message_thread_members, message_threads |
| `src/routes/telegraphStream.ts` | 2 | message_thread_members, messages |

### 4. Direct client reads of a messaging table (§24's closing rule)

Enforced shrink-only by `check:telegraph-slos`; declared in
`src/domain/telegraph/projections/projectionRegistry.ts`.

| client file | table |
| --- | --- |
| `travel-buddy-standalone/app/messages/[id].tsx` | message_thread_members |
| `travel-buddy-standalone/app/messages/[id].tsx` | message_threads |
| `travel-buddy-standalone/src/components/GroupChatScreen.tsx` | message_thread_members |

### 5. Realtime subscriptions

Transport: server-sent events. Endpoints in `src/routes/telegraphStream.ts`: `GET /telegraph/stream`, `POST /threads/:threadId/typing`.

Bus: `src/lib/telegraphEvents.ts`, in-memory, lossy by design, with a cross-instance
hook in `src/lib/telegraphBroadcast.ts`.

7 event types:

- `gone`
- `message.created`
- `message.deleted`
- `message.translated`
- `message.unsent`
- `message.updated`
- `thread.updated`

### 6. Push and notification flow

- `src/services/notifications/NotificationDeduplicationService.ts`
- `src/services/notifications/NotificationDigestService.ts`
- `src/services/notifications/NotificationPreferenceService.ts`
- `src/services/notifications/NotificationPrivacyGuard.ts`
- `src/services/notifications/NotificationRouter.ts`
- `src/services/notifications/NotificationService.ts`
- `src/services/notifications/NotificationTemplateService.ts`
- `src/services/notifications/RealtimeActivityService.ts`

`NotificationRouter` writes a `msg_type: 'system'` message into a thread, with the notification's own event type as the `subtype` — so the Telegraph subtype vocabulary is, in practice, the notification event vocabulary.

### 7. Media upload paths

`POST /api/threads/:threadId/media` in `src/routes/messaging.ts`.
Accepted media kinds referenced on that path: image, video.

Processing and EXIF policy: `src/lib/mediaProcessing.ts`. Access: `src/lib/mediaAccess.ts`.

### 8. Translation paths

`src/services/messageTranslation.ts` — per-recipient rows in `message_translations`.

- `buildDisplayFields()`
- `markTranslationsPending()`
- `retranslateForUser()`
- `senderLanguageFrom()`
- `translateMessageForThread()`

### 9. Current enum literals

`msg_type`: `booking_card`, `card`, `circle_status_card`, `highlight_reply`, `media`, `system`, `text`

`subtype` (static literals): `call_ended`, `call_started`, `compass_card`, `discovery_card`, `e2ee_welcome`, `event_context_card`, `hidden_gem`, `layover_suggestion`, `meetup`, `meetup_cancelled`, `meetup_confirmed`, `post_card`

19 site(s) COMPUTE a message type rather than writing a literal, so no
fixed enumeration of `subtype` is complete. They are declared in
`src/domain/telegraph/policies/shareAuthorizationPolicy.ts` and re-derived by
`check:telegraph-share-producers`:

- `artifacts/api-server/src/lib/threadMessage.ts` — `` subtype: params.subtype ?? null ``
- `artifacts/api-server/src/routes/telegraphShare.ts` — `` msg_type: msgTypeOf("PORTAVA_OBJECT") | subtype: objectType.toLowerCase() | subtype: m.subtype ``
- `artifacts/api-server/src/routes/telegraphKinds.ts` — `` subtype: (row.subtype as string) ?? null | msg_type: validated.msgType | subtype: validated.subtype | subtype: m.subtype ``
- `artifacts/api-server/src/services/telegraph/messageKinds.ts` — `` subtype: subtypeFor(kind, parsed.data) `` (parser / passthrough, writes no message)
- `artifacts/api-server/src/routes/telegraphCoordination.ts` — `` msg_type: validated.msgType | subtype: validated.subtype | subtype: m.subtype ``
- `artifacts/api-server/src/services/telegraph/coordination.ts` — `` subtype: coordinationSubtype(kind, data) `` (parser / passthrough, writes no message)
- `artifacts/api-server/src/routes/telegraphStream.ts` — `` msgType: r.msg_type ?? "text" | subtype: r.subtype ?? null `` (parser / passthrough, writes no message)
- `artifacts/api-server/src/services/telegraphReportEvidence.ts` — `` msg_type: (msg as any).msg_type ?? null | subtype: (msg as any).subtype ?? null | subtype: m.subtype ?? null `` (parser / passthrough, writes no message)
- `artifacts/api-server/src/lib/liveReferenceMessages.ts` — `` msg_type: LIVE_REFERENCE_MSG_TYPE | subtype: LIVE_REFERENCE_MSG_SUBTYPE ``
- `artifacts/api-server/src/lib/calls/callStoreAdapter.ts` — `` subtype: `call_${session.status}` ``
- `artifacts/api-server/src/routes/messaging.ts` — `` subtype: req.body?.subtype (any string the client sends) ``
- `artifacts/api-server/src/routes/circle.ts` — `` subtype: cardSubtype ``
- `artifacts/api-server/src/routes/highlights.ts` — `` subtype: id ``
- `artifacts/api-server/src/routes/rentABuddy.ts` — `` subtype: `booking_status_${newStatus}` ``
- `artifacts/api-server/src/services/notifications/NotificationRouter.ts` — `` subtype: notification.eventType ``
- `travel-buddy-standalone/src/components/CircleStatusCardMessage.logic.ts` — `` subtype: subtype! `` (parser / passthrough, writes no message)
- `travel-buddy-standalone/src/hooks/useMessaging.ts` — `` subtype: opts?.subtype ?? null | subtype: failed.subtype ?? undefined `` (parser / passthrough, writes no message)
- `travel-buddy-standalone/src/services/messaging.ts` — `` subtype: m.subtype ?? null | subtype: E2EE_WELCOME_SUBTYPE `` (parser / passthrough, writes no message)
- `travel-buddy-standalone/src/lib/e2ee/e2eeThread.ts` — `` subtype: E2EE_WELCOME_SUBTYPE `` (parser / passthrough, writes no message)

---

## What this inventory does NOT establish

- **That any of it is correct.** It records what is there, not whether it is right.
  The verdicts live in `docs/architecture/census-telegraph.md`.
- **That the production schema matches.** The table list column is read from a
  committed snapshot, not from a live database. `check:production-drift` and
  `check:missing-live-columns` are the lanes that compare against the real thing.
- **Completeness of the `subtype` vocabulary.** Several sites compute it; §9 says
  which, and that is a bound on this document rather than a gap in it.
