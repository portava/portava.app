---
name: Shared Moments pagination and approval
description: Durable correctness rules for Shared Moments feed cursors and contribution approval.
---

Shared Moments feeds are ordered by `created_at DESC, id DESC`, so the cursor must carry both the emitted row's timestamp and UUID. A UUID-only cursor can skip or repeat rows when timestamps differ or UUID order is non-monotonic.

**Why:** The feed's sort key is a tuple, and approval is a state transition rather than an acknowledgement. Auditing a no-op approval creates a false lifecycle record.

**How to apply:** Validate cursors before membership checks, apply the older-timestamp-or-lower-UUID tuple predicate, and use an update with a pending-status filter plus returned-row verification before appending approval audit events.