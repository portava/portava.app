---
name: Events API field names
description: formatEvent() returns camelCase — mobile mapApiEvent must read camelCase, not snake_case
---

`formatEvent()` in `artifacts/api-server/src/routes/events.ts` returns **camelCase** field names.
The mobile `mapApiEvent()` in `cityPulseUtils.ts` must read the camelCase forms.

| DB column      | formatEvent key | Wrong guess (snake_case) |
|----------------|-----------------|--------------------------|
| `starts_at`    | `startsAt`      | `start_time`             |
| `going_count`  | `goingCount`    | `attendee_count`         |
| `max_attendees`| `maxAttendees`  | `max_capacity`           |

**Why:** The `start_time` vs `startsAt` mismatch caused `new Date('').getTime()` → NaN on
every event, so the carousel filter (`startAt <= now < startAt + 2h`) rejected them all.
The Pulse header showed "Nothing live right now" even with real DB events.

**How to apply:** Whenever adding a new field to `mapApiEvent`, check `formatEvent` first
for the exact camelCase key. Accept both forms as a fallback for forward-compatibility:
`e.startsAt ?? e.start_time ?? e.starts_at`.

**Events schema note:** There is no `source` column on the `events` table.
Use `tags: ["demo_seed"]` to identify and clean up demo data instead.
