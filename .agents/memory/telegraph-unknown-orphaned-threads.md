---
name: Telegraph "Unknown"/"T" avatar false lead
description: When a direct-message thread shows "Unknown" + "T" avatar, check membership row count before touching resolveHandle/name-coalescing code.
---

The client's fallback chain is: no `otherMembers[0]` → literal `'Unknown'` text, and
`primaryIdentityText({})` → `'Traveler'` → first letter `'T'` for the avatar. So
"Unknown" + "T" is the **empty-otherMembers** fallback, not a name-field bug.

`GET /me/threads` builds `otherMembers` by filtering `message_thread_members` rows
for the thread excluding the viewer. A `direct` thread with only 1 (or 0)
membership rows — i.e. missing the counterpart's row — will always produce this
exact symptom, even if `resolveHandle`/`display_name` coalescing is fully correct.

**Why:** stale/orphaned test-seed threads (titles like "QA Test Meetup", "E2E Chat
Test Event", zero messages, 0-1 member rows) have been left in the live Supabase DB
from prior debugging/seeding sessions and get surfaced to whichever real account
happens to match the leftover `user_id`.

**How to apply:** before changing name-resolution code for an "Unknown" report,
query `message_thread_members` for the affected thread ids directly (via the
service-role client) and confirm both parties actually have a row. If not, it's
data cleanup (delete the orphaned thread + membership rows), not a code fix.
