# ATTACHMENTS_REPORT.md — Add-to-Plan / Add-to-Trip selectors

Real session-level attachment system: a shared bottom-sheet selector wired across
Discovery, Pulse, and Trip. Adds persist in-memory for the session (honest — NOT
backend-persisted) and show up immediately where relevant.

## Session store added
- src/context/AttachmentStore.tsx — AttachmentProvider + useAttachments(). In-memory
  store implementing AttachmentService. Duplicate protection built in. Safe no-op
  fallback if provider missing (UI never crashes). Persistence: 'session' (resets on
  full reload — documented, not faked as permanent).
- src/services/attachments.ts — AttachmentService interface = the backend migration
  contract: createAttachment / listAttachmentsByTarget / listAttachmentsBySource /
  deleteAttachment / isAttached, with TODO mapping each to a REST endpoint.

## Data contract (src/types/models.ts)
- Attachment (id, userId, sourceItemId, sourceItemType, sourceTitle/subtitle/image/
  city/category, targetId, targetType, targetTitle, createdAt, notes, persistence:'session')
- AttachSource (what a card passes), AttachTarget (selectable trip/plan w/ group)
- AttachSourceType: place | hidden_gem | post | itinerary | plan | experience | compass_suggestion
- AttachTargetType: trip | plan

## Selector (src/components/AttachController.tsx)
Shared bottom-sheet, opened from anywhere via useAttach().open(source, 'trip'|'plan'):
- Title "Add to Trip" / "Add to Plan"
- Item preview (title + category · city)
- Targets grouped: trips = Active / Upcoming / Planning; plans = Plans on this trip /
  Your plans / Drafts (from src/data/attachTargets.ts)
- Search row when list is long
- Create New Trip / Create New Plan row (closes sheet; quick-create flow = TODO)
- Loading spinner per-row while attaching, error line on failure, duplicate → "Already
  added", success → animated toast "Added to <target>", sheet closes, stays on screen
- Safe-area aware (insets top/bottom). Mobile bottom sheet (Modal slide).

## Surfaces wired
- Discovery: Hidden Gems (Add to Plan), Traveler Picks (Add to Plan), Saved Ideas
  (Add to Trip), Featured Experiences (Add to Plan)
- Pulse: Hidden Gem card (Add to Plan), Itinerary card (Add to Trip), Compass
  Suggestion card (Add to Plan)
- Trip: Saved Ideas (Add to Plan) + surfaces session attachments added to this trip
  (shown with an "Added" badge alongside seed ideas)

## Closed loop (honest persistence)
attachTripTargets' active trip id = mockTripDetail.id ('t1'), which Trip Saved Ideas
reads via listAttachmentsByTarget('t1'). So adding an item to the active trip makes it
appear in the Trip page immediately — real in-memory persistence, not a fake toast.

## Providers
app/_layout.tsx wraps the app: SafeAreaProvider > AttachmentProvider >
AttachControllerProvider > Stack. One store, one sheet, app-wide.

## Data truth
- Persistence is session-only and labeled as such in code + this report. No "saved
  permanently" claims. No fake API success — createAttachment is real local state.
- Targets are mock (existing trips/plans + a couple of sample upcoming/draft) — clearly
  replaceable; swap attachTargets + provider for backend later.

## Backend gap (documented)
- No API/database persistence. To migrate: implement AttachmentService against your API
  and swap AttachmentProvider; callers (useAttach / useAttachments) don't change.
- Create-new quick-create flow routes nowhere yet (closes sheet) — wire to /trip/new or a
  compact create modal next.

## Quality
- Loading (per-row spinner), error line, success toast, duplicate protection — all present.
- Sheet closes cleanly on backdrop, X, and after attach. Safe-area top/bottom handled.
- Static: escaped-backtick scan CLEAN; whole-project missing-import audit 0; new-file
  brace balance OK.

## On-device (run on Mac)
    npx tsc --noEmit
    npx expo start --clear     # add an item from Discovery → pick the active trip →
                               # open that trip → see it under Saved Ideas

## Files changed
NEW: src/context/AttachmentStore.tsx, src/components/AttachController.tsx,
     src/services/attachments.ts, src/data/attachTargets.ts
EDIT: src/types/models.ts (Attachment contracts), app/_layout.tsx (providers),
      src/components/DiscoveryWall2.tsx, src/components/PulseFeedCard.tsx,
      src/components/TripPage.tsx, app/(tabs)/discovery.tsx
DOC: ATTACHMENTS_REPORT.md

## Summary
Add-to-Plan / Add-to-Trip now opens a real shared bottom-sheet selector with item
preview, grouped targets, create-new, search, loading/error/duplicate handling, and a
success toast. Adds save to an in-memory session store and surface immediately in the
Trip page. Honest about session-only persistence; backend migration is a clean interface
swap. Wired across Discovery, Pulse, and Trip.
