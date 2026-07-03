# Date & Time Input Completion Pass — Final Audit Report

**Task:** Replace all freeform text date/time inputs with design-system pickers across the Travel Buddy app.  
**Date completed:** 2026-07-03

---

## Executive Summary

A codebase-wide audit of every date/time entry point and timestamp display in the Travel Buddy standalone app. Six screens/components were audited. Two needed picker wiring changes (Rent-a-Buddy checkout and the Meetup web add-to-calendar gap). Three duplicate inline relative-time helpers were removed and consolidated into a single exported function in `formatters.ts`. All other surfaces were already using the correct picker components before this task began.

**No freeform `TextInput` for dates or times remains in the app.**

---

## Date / Time Input Matrix

| Screen / Component | Date input | Time input | Duration input | Status |
|---|---|---|---|---|
| `app/trip/new.tsx` | `GlobalCalendarPicker` (range) | — | — | ✅ Pass |
| `app/trip/edit.tsx` | `GlobalCalendarPicker` (range) | — | — | ✅ Pass |
| `src/components/EventComposerSheet.tsx` | `GlobalCalendarPicker` (single) × 2 | `GlobalTimePicker` × 2 | — | ✅ Pass |
| `src/components/MeetupCreationSheet.tsx` | `DatePickerField` | `DatePickerField` (time) | — | ✅ Pass |
| `app/meetup/[id].tsx` (edit banner) | `DatePickerField` | `DatePickerField` (time) | — | ✅ Pass |
| `app/(rent-a-buddy)/checkout.tsx` | `GlobalCalendarPicker` (single) | `GlobalTimePicker` | `DurationPicker` (chips) | ✅ Fixed ↑ |
| `src/components/AddToPlanSheet.tsx` | `DatePickerField` | `DatePickerField` (time, optional) | — | ✅ Pass |
| `src/components/itinerary/PlanItemSheet.tsx` | `DatePickerField` | `DatePickerField` (time, optional) | — | ✅ Pass |
| `src/components/safeReturn/SafeReturnSetupSheet.tsx` | — | — | Custom duration chips | ✅ Pass |
| `app/availability.tsx` (trip windows) | Read-only display only — input is in `trip/new` | — | — | ✅ Pass |

---

## Calendar Integration Matrix

| Screen | Platform | Action | Status |
|---|---|---|---|
| `app/meetup/[id].tsx` — confirmed-time banner | Native (iOS/Android) | Calls `addMeetupToCalendar()` → `expo-calendar` | ✅ Wired |
| `app/meetup/[id].tsx` — confirmed-time banner | Web | Shows disabled state "Not available on web" | ✅ Fixed ↑ |

### Honest-disabled items

| Item | Reason | Copy shown |
|---|---|---|
| "Add to Calendar" on web meetup banner | `expo-calendar` is a no-op on web; iOS/Android only | "Not available on web" (greyed icon + text) |

---

## Timestamp Display Standardisation

### Relative-time consolidation

Three duplicate inline relative-time helpers existed across three components. All replaced with a single exported function `formatRelativeTime(iso)` from `src/lib/dateTime/formatters.ts`.

| File | Old helper | Replaced with |
|---|---|---|
| `src/components/RealPostsList.tsx` | `timeAgo()` (local, inline) | `formatRelativeTime()` (import) |
| `src/components/NotificationBell.tsx` | `relativeTime()` (local, inline) | `formatRelativeTime()` (import) |
| `src/components/StoryViewer.tsx` | `formatRelative()` (local, inline) | `formatRelativeTime as formatRelative` (import) |

Canonical rule applied: **relative time** (`formatRelativeTime`) in feeds and message lists; **absolute time** (`formatDisplayDate`/`formatDisplayTime`) in detail screens.

### Remaining `toLocaleDateString` usages

These are absolute-date display-only usages (trip dates, postcards, stamps, host check-in windows) — they are correct by the rule above (detail/profile screens, not feed timestamps). No changes needed.

---

## Screens Changed

| File (standalone + artifact) | Change |
|---|---|
| `app/(rent-a-buddy)/checkout.tsx` | `TextInput` date → `GlobalCalendarPicker`; `TextInput` time → `GlobalTimePicker`; stepper → `DurationPicker` (chips, 1 h–12 h); duration state: hours → seconds |
| `app/meetup/[id].tsx` | "Add to Calendar" hidden-on-web → honest-disabled state |
| `src/lib/dateTime/formatters.ts` | Added `formatRelativeTime(iso): string` export |
| `src/components/RealPostsList.tsx` | Removed inline `timeAgo`; import + use `formatRelativeTime` |
| `src/components/NotificationBell.tsx` | Removed inline `relativeTime`; import + use `formatRelativeTime` |
| `src/components/StoryViewer.tsx` | Removed inline `formatRelative`; import + use `formatRelativeTime as formatRelative` |

---

## End-Before-Start Validation

| Screen | Validated | How |
|---|---|---|
| `EventComposerSheet` | ✅ Yes | `buildISODateTime` compare → `setError('End date must be after start date')` |
| Rent-a-Buddy checkout | N/A | Single date + start time + duration (no end date field) |
| Trip new/edit | N/A | Trip dates are a range picker (end ≥ start enforced by `minDate={startDate}`) |
| Meetup create | N/A | Single date + time only |

---

## Discovery Date Range Filter

**Not added.** The discovery service (`src/services/discovery.ts`) does not expose a `starts_at` or `event date` filter parameter in its current API contract. Adding a `DateRangeFilterRow` without backend support would be dead UI. This item is a blocker for a future backend-first task, not an in-scope UI fix.

---

## Reusable Components Added

| Component / Export | Location | Purpose |
|---|---|---|
| `formatRelativeTime(iso)` | `src/lib/dateTime/formatters.ts` | Canonical short relative-time label for feeds ("just now", "5m", "3h", "2d") |

---

## Remaining Blockers (out of scope)

| Item | Reason deferred |
|---|---|
| Discovery date-range filter | No backend `starts_at` filter param in discovery service |
| `TimezoneLabel` inline component | EventComposerSheet city field is optional freetext; no reliable city→timezone resolution available without new backend lookup |
| Full calendar account OAuth sync | Explicitly out of scope per task definition |

---

## Validation Table

| Check | Result |
|---|---|
| `pnpm --filter @workspace/api-server run typecheck` | ✅ PASS |
| `cd travel-buddy-standalone && pnpm typecheck` | ✅ PASS |
| `bash scripts/sync-standalone.sh --check-source` | ✅ PASS (0 drifted files) |
| `bash scripts/sync-standalone.sh --check-deps` | ✅ PASS |
