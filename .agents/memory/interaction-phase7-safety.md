---
name: Interaction Phase 7 — Safety, Moderation & Emergency Controls
description: featureFlags.ts fail-open pattern; 11 emergency flag gates; admin moderation audit log; invite cooldowns; reportContent() service function
---

## Emergency flag helper (`artifacts/api-server/src/lib/featureFlags.ts`)
- `isFlagEnabled(sc, flag)` — queries `feature_flags` where `flag = $1` and `enabled = true`
- **Fail-open contract**: if the DB returns an error or null, function returns `false` (feature NOT blocked)
- Any new route gate must follow this same fail-open pattern — never block on DB error

## Flag gate pattern
```ts
const sc = getServiceClient();
if (sc && await isFlagEnabled(sc, 'disable_my_feature')) {
  sendError(res, 'feature_disabled', 'This feature is temporarily disabled');
  return;
}
```
- Use `sendError(res, 'feature_disabled', ...)` — not a raw `res.json()` — so the mobile error handler can detect it
- `disable_profile_search` is a **soft block** (returns `200 { users: [] }`) not a hard 404

## 11 seeded emergency flags (migration 0065)
`disable_tagging`, `disable_unknown_message_requests`, `disable_new_event_creation`, `disable_location_sharing`, `disable_profile_search`, `disable_rab_bookings`, `disable_media_uploads`, `disable_ai_suggestions`, `disable_payments`, `disable_reporting`, `disable_new_account_creation`

All seeded with `enabled = false`. Toggle via direct DB update (no admin UI yet — see follow-up #809).

## Admin moderation audit log invariant
- `PATCH /admin/users/:userId/moderation-action` — every action **must** insert into `moderation_actions` before returning
- Supported `action_type` values (13): warn, message_limit, invite_limit, hosting_limit, discovery_hidden, rent_a_buddy_frozen, temporary_suspension, permanent_ban, report_resolved, content_removed, event_removed, circle_removed, booking_frozen
- `temporary_suspension` requires `expires_at`; `report_resolved` requires `target_ref_id`
- Test file `src/test/adminModeration.test.ts` proves every action type writes an audit row

## Anti-retaliation cooldowns
- Circle invite decline → 48h `circle_invite` cooldown upserted into `user_interaction_cooldowns` on the **invite owner**
- Trip invite decline → 48h `trip_invite` cooldown on the **trip owner**
- Uses `.then(undefined, () => {})` not `.catch()` on Supabase builders (same pattern as Phase 4)

## Mobile reports service (`src/services/reports.ts`)
- Added `reportContent({ target_type, target_id, reason_code, reason_detail? })` — POSTs to `/api/reports`
- Added `ReasonCode` type alias for `ReportReason`
- Used by `app/messages/[id].tsx` and `src/components/PostCard.tsx`
- **Must mirror changes to `artifacts/travel-buddy/src/services/reports.ts`** (source-drift check enforces this)
