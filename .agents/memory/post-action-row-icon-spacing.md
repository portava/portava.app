---
name: Post action row icon-spacing pattern
description: Where the shared Stamp/Comment/Share/Save/More action row primitives live, and which surfaces were deliberately excluded.
---

`travel-buddy-standalone/src/components/PostActionRow.tsx` (was `artifacts/travel-buddy/...`, archived at `bc1bef404`) (`PostActionGroup` + `PostActionRow` + `actionSlot()`) is the shared primitive for the post action row: fixed 4px icon/counter gap, 44x44 touch target via hitSlop, compact K/M/B counter text with the exact count in the accessibility label (via `src/lib/counterFormat.ts`), and a left-cluster + flexible-spacer + right-cluster layout with a proportional 14-24px gap (`src/lib/actionRowGap.ts`).

`PostEngagementBar.tsx` (used by PulseFeedCard's PostCard variants and QuestionCard) is the only literal Stamp/Comment/Share/Save/More row and is the one built on these primitives; it accepts a `right` prop so callers compose Save/More into the same row instead of a sibling row with an ad hoc spacer.

**Deliberately NOT migrated to these primitives** (different layout pattern or explicitly out of scope, not an oversight):
- `WatchItemOverlay.tsx`'s vertical Reels-style action rail — different layout family, only its counter formatting was aligned to the shared helper.
- PlanCard/GemCard/ItineraryCard/CompassCard/CircleCard custom CTA rows in `PulseFeedCard.tsx` — different actions/business logic (Add to Plan, Join Plan, etc.), not the same row.
- The Share icon stays `TelegraphSendIcon`, not the shared Portava share icon component — see `portava-share-icon-conventions.md`.

**Why:** keeps the shared component's contract narrow (it is literally the engagement-bar row) instead of forcing unrelated CTA rows into a shape that doesn't fit them.

**How to apply:** when adding a new counter/icon-row anywhere in travel-buddy, prefer `actionSlot()` + `PostActionRow` over hand-rolled spacing; when touching one of the excluded surfaces above, don't assume it already uses these primitives.
