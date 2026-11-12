# Chat and comment activity — November 12, 2026

This records the bounded implementation and local verification for the chat/media acceptance follow-up. It is not a new architecture census, production deployment receipt, or multi-device acceptance result. Historical census grades and totals remain unchanged.

## Conversations

- Typing shows only another person in the exact current thread. Idle, blur, background, account changes and revoked access clear transient state. The existing data-saver controls apply on both chat screens. Coalesced writes keep the final stop behind a pending start; transport is bound to the initiating account and has a deadline. Existing server membership and block policy is preserved; this release introduces no new app-wide online/typing preference.
- Both chat lists supply actual visible message IDs to the seen writer. A loaded history row, background screen, or realtime notification is not seen evidence. Read events trigger the authoritative receipt read, which retains membership-window and blocked-reader eligibility. A timestamp alone cannot upgrade a message to Seen.
- New arrivals keep the reader's position when they are reading history and expose a count with a jump action. The count clears when those rows become visible. Readers near the end continue following the conversation.
- Group chats retain foreground refresh while realtime is unavailable. Older read answers cannot overwrite a later accepted edit. A confirmed edit replaces body, original and display text together; subsequent translation updates can refresh that display.
- Shared cards and direct media show lightweight time/edited/receipt metadata outside the media presentation. Unknown receipt state is not replaced with a fabricated Sent, Delivered or Seen indicator. Shared post media uses its source attribution and existing source-access checks.

Implementation: `travel-buddy-standalone/src/features/telegraph/lifecycle/useConversationTyping.ts`, `useConversationViewport.ts`, `useThreadReadState.ts`, `OwnMessageStatusRow.tsx`; the thread and group screens; `useMessaging.ts`, `useGroupChat.ts`, `SessionContext.tsx`, `messaging.ts` and `telegraphRealtimeService.ts`.

## Comments and replies

The focused inline section and open comments sheet refresh comments and expanded replies while foreground. New arrivals expose a notice; edited comments and replies show an Edited label. Account, post, open/close, focus, background and request revisions fence old answers. Local mutations retire older reads; a refresh failure remains an error rather than an empty conversation. A denied source withdraws cached private content.

Comment typing carries only a transient boolean, never the draft text. The endpoint checks current post/comment eligibility, audience, moderation, blocks, restrictions and the existing explicit privacy opt-out. A missing settings row uses the existing schema default; unreadable settings fail closed. Hints expire after eight seconds, and signed relay messages do not become permanent content. Request ordering prevents a late start from reviving a newer stop. Closing/backgrounding clears the local indicator and announces a final stop when the initiating account still owns the request.

Implementation: `travel-buddy-standalone/src/hooks/useLiveComments.ts`, `useCommentTyping.ts`, `src/services/commentActivity.ts`, `commentTyping.ts`, `postEngagement.ts`, and `src/components/CommentsSheet.tsx`; API `src/lib/commentTyping.ts` and the comments-typing endpoints in `src/routes/posts.ts`.

## Local evidence and limits

- Chat activity, receipts, shared metadata, account ownership and screen wiring: 135 passing cases across 12 focused suites.
- Existing Telegraph membership, typing fanout and block contracts: 16 passing HTTP/domain cases, using synthetic local accounts.
- Comments, replies and typing UI: 53 passing cases across five suites, as reported by the client lane; this includes the five typing cases and is not additive to them.
- Comment typing API/store/relay/ordering/privacy eligibility: 21 passing cases, plus one auth-client structural guard, as reported by the root lane.
- Production TypeScript passes. API test diagnostics remain at the unchanged 860/113 baseline. The mobile test baseline remains separately checked by the client lane.

No migrations, feature-flag activation, customer messages or production content mutations were required for these changes. Native installation, two-device acceptance and the exact server publication identity belong to the release owner's deployment evidence.
