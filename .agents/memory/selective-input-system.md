---
name: Selective input system
description: Patterns for GlobalCalendarPicker, GlobalTimePicker, DurationPicker, GlobalPlacePicker — auth/API shape, null guards, and hook conventions
---

## Route / API patterns

- `getServiceClient()` returns `SupabaseClient | null` — always guard: `if (!db) { sendError(res, "server_not_configured"); return; }` before any `.from()` call.
- `sendError(res, code, message?)` takes 2–3 args — no HTTP status number. Codes: `invalid_payload`, `db_error`, `not_found`, `unauthenticated`, `forbidden`, `server_not_configured`.
- `requireUser(req, res)` returns `{ client, user } | null`; pattern: `const auth = await requireUser(req, res); if (!auth) return;`

## Place search

- Nominatim rate limit is 1 req/sec (TOS). Rate-limiter: track `nominatimLastCall` + `await setTimeout(1100 - elapsed)`.
- GET /api/places/search → normalizeNominatim() → `{ places: Place[] }`. Graceful degradation: return `{ places: [] }` instead of 500 on provider error.
- GET /api/places/reverse → delegates to `geocodingService.reverseGeocode(lat, lng)` which already handles Mapbox + Nominatim fallback.
- /api/me/recent-places: upsert by deleting old row where `place_snapshot->>id = place.id` then inserting fresh; trim to 10 rows after insert.

## Component conventions

- All pickers follow the ManualCityPicker modal pattern: `Modal animationType="slide"` + pressable backdrop + `useSafeAreaInsets` bottom padding.
- GlobalCalendarPicker: single/range modes; `CalendarValue = string | { start: string | null; end: string | null }`. Build month grid with `buildGrid(year, month)` returning `(Date | null)[][]`.
- GlobalTimePicker: presets list + native `DateTimePicker` mode="time" for custom; onChange called immediately on preset, after "Done" on iOS spinner.
- DurationPicker: `showChips` prop renders an inline chip row without a modal (used inside ScrollView forms).
- GlobalPlacePicker: `usePlaceSearch` hook (debounced 350ms, AbortController) + `useRecentPlaces` (optimistic local cache + server sync). GPS via `expo-location` with `requestForegroundPermissionsAsync`.

## DB

- `user_recent_places` table: `id uuid PK`, `user_id uuid FK auth.users`, `place_snapshot jsonb`, `used_for text`, `used_at timestamptz`.
- UNIQUE NULLS NOT DISTINCT on `(user_id, (place_snapshot->>'id'))`.
- RLS: users select/insert/delete own rows; service role bypasses.

## Date+time split-state pattern (EventComposerSheet model)

When a form needs both a date and a time separately:
- State: `dateStr: string | null` (ISO YYYY-MM-DD from GlobalCalendarPicker) + `timeHHmm: string | null` (from GlobalTimePicker).
- Combine with `buildISODateTime(dateStr, timeHHmm)`: returns `"${date}T${time}:00"` or `"${date}T00:00:00"` when no time set.
- Display with `formatDateDisplay(iso)` + `formatTimeDisplay(hhmm)`.
- Pickers need `visible` state per slot: `calPickerFor: 'start' | 'end' | null`, `timePickerFor: 'start' | 'end' | null`.
- Render pickers **outside** ScrollView to avoid clipping.
- Validate end-before-start using the combined ISO strings before advancing steps.

## Confirmed freeform-input replacements (task #1419)

- LayoverModeSheet: arrival/departure used `TextInput keyboardType="number-pad"` for hour 0–23 → replaced with GlobalTimePicker tappable triggers (state: `string | null`, `"HH:mm"`).
- EventComposerSheet: used DatePickerField (native combined picker) → replaced with separate GlobalCalendarPicker + GlobalTimePicker.
- All other number-pad TextInputs in the codebase are numeric config values (age, capacity, score) — not time-of-day inputs.

**Why:** Consistent picker surface across all date/time/location fields; avoids raw TextInput YYYY-MM-DD and GPS-only location patterns scattered across forms.
