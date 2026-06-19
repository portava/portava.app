# AVAILABILITY_EDITOR_REPORT.md

Full Availability editor at /availability (was a status placeholder). Weekly toggle grid +
trip windows + quick status, on a session store that Pulse + chips read live.

## What's built
1. Current status card — resolved status (Open tonight / Usually free / Flexible this week /
   Trip window active / Not available / Open to meet / Not set) + an "Open to meet" toggle.
2. Weekly rhythm — day × time-block TOGGLE GRID (Mon–Sun × Morning/Afternoon/Evening/Late).
   Tap a cell to toggle; selected cells use the signal accent. Presets: Weeknights / Weekends /
   Evenings / Late nights / Flexible / Clear. Live summary ("Usually free Tue/Thu evenings.").
   Block legend shows the time mapping (Morning 08–12, Afternoon 12–17, Evening 17–22, Late 22–02).
3. Trip windows — list of trip-specific windows (city + date range + blocks) with remove;
   Add routes to /trip/new. Empty state with example. Overrides weekly while on that trip.
4. Save / Cancel — Save shows a "Saved" confirmation; honest note that it's session-only and
   already shapes Pulse.

## Time-block contract (existing types, reused)
TimeBlock = morning | afternoon | evening | late. Mapped windows:
  morning 08:00–12:00 · afternoon 12:00–17:00 · evening 17:00–22:00 · late 22:00–02:00
  (late crosses midnight — handled by the resolver, not faked as a same-day range).
WeeklyAvailability.days: Partial<Record<Weekday, TimeBlock[]>>. TripWindow: city/dates/blocks.

## Session store (src/context/AvailabilityStore.tsx)
AvailabilityProvider + useAvailabilityStore(): toggleBlock, applyWeekly, clearWeekly,
setOpenToMeet, addTripWindow, removeTripWindow, save. Seeded from mockAvailability; edits
live in memory for the session (NOT backend-persisted). Safe read-only fallback if provider
missing. save() is a no-op persist (honest) — TODO PUT /me/availability.

## Live wiring (the important part)
src/hooks/useCityPulse.ts → useAvailability() now reads from the store instead of static
mock. So editing the grid immediately changes:
- Pulse "Fits your time" / "When you're flexible" bucketing + ordering
- The availability status chip on Pulse header and Passport
One source of truth, app-wide.

## Providers
app/_layout.tsx: SafeAreaProvider > AvailabilityProvider > AttachmentProvider >
AttachControllerProvider > Stack.

## Data truth
- Session-only persistence, labeled in UI ("Saved for this session") and code. No "saved
  permanently" claim, no fake API success.
- Approximate availability by design (broad blocks), not exact appointment scheduling — stated
  in the UI.

## Backend gap
GET/PUT /me/availability not wired. To migrate: seed the store from GET, make save() PUT.
Trip-window precise time-range pickers = future "Need exact times?" advanced option (noted).

## Quality / static checks (this env)
- Escaped-backtick scan: CLEAN
- Whole-project missing-import audit: 0
- Brace balance on new/changed files: OK
- ScreenHeader dependency present.

## On-device (run on Mac)
    npx tsc --noEmit
    npx expo start --clear
Open Passport → tap the availability chip / Plans info-bar, or navigate to /availability.
Toggle some evening cells, then open Pulse — "Fits your time" should reflect the change.

## Files changed
NEW:  src/context/AvailabilityStore.tsx
EDIT: app/availability.tsx (placeholder -> full editor), src/hooks/useCityPulse.ts
      (reads store), app/_layout.tsx (AvailabilityProvider)
DOC:  AVAILABILITY_EDITOR_REPORT.md

## Summary
/availability is now a real editor: a fast mobile-first weekly toggle grid with presets, a
trip-windows list, and a status card with an Open-to-meet switch. Edits flow through a session
store that Pulse and the status chips read live, so changing your rhythm immediately reshapes
suggestions. Honest about session-only persistence; backend is a clean GET/PUT swap.
