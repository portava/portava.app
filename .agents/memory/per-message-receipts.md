---
name: Per-message receipts pattern
description: How read receipts are computed per-message in Telegraph (DM + group). Replaces the old lastOwnMsgId/receiptState useMemo pattern.
---

## Pattern

**DM threads (`app/messages/[id].tsx`):**
- `receiptForMsg(msg)` callback using `dmOtherLastRead` timestamp: `>= msg.createdAt` → 'read', else 'delivered'.
- `groupMemberReads` state (fetched via supabase for non-DM threads): `{ userId, lastReadAt, avatarUrl }[]`.
- `readerAvatarsForMsg(msg)` callback: filters `groupMemberReads` where `lastReadAt >= msg.createdAt`, returns up to 3 avatar URIs.
- Both `MessageBubble` and `GroupMessageBubble` accept `readerAvatars?: string[]` — renders small (14×14) circular avatar chips below the message.

**Group threads (`src/components/GroupChatScreen.tsx`):**
- `receiptForMsg(msg)` callback: `ageSecs > 3 → 'delivered'`, else `'sent'` (no DM read timestamp available).
- Same `groupMemberReads` fetch + `readerAvatarsForMsg` + `readerAvatars` prop pattern.

**Why:** The old pattern only applied to `lastOwnMsgId` (the last sent message). Users now see per-message delivery/read status across all their sent messages.

**How to apply:** When adding new message bubble types, accept `readerAvatars?: string[]` and render avatar chips after the receipt row when non-empty.
