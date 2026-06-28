/**
 * Calendar service — adds meetup events to the device calendar via expo-calendar.
 *
 * Web: expo-calendar has no web support; all calls are no-ops on web.
 *
 * Testability: both react-native and expo-calendar are loaded via dynamic
 * import so this module can be imported in a Node.js test environment.
 * Call _setTestCalendarDeps() before calling addMeetupToCalendar in tests
 * to inject mock native implementations (same test-slot pattern as the
 * api-server's _setTestClient slot).  Pass null to restore production behaviour.
 *
 * Date arithmetic is co-located with calendarUtils.ts (deriveMeetupDates) —
 * both implement the same logic.  calendarUtils.ts is the dependency-free
 * module imported directly by unit tests; this file uses the same rules inline
 * so the integration tests cover them end-to-end via addMeetupToCalendar.
 */
import type { MeetupDetail } from './meetups';

export type CalendarResult =
  | { ok: true; eventId: string }
  | { ok: false; reason: 'denied' | 'error'; message?: string };

// ── Test-slot ──────────────────────────────────────────────────────────────────

export interface CalendarTestDeps {
  /** Overrides Platform.OS detection ('ios' | 'android' | 'web'). */
  platform: string;
  /** Replaces the expo-calendar module with a mock. */
  calendarModule: {
    EntityTypes: { EVENT: string };
    requestCalendarPermissionsAsync: () => Promise<{ status: string }>;
    getCalendarsAsync: (entityType: any) => Promise<Array<{
      id: string;
      allowsModifications: boolean;
      isPrimary?: boolean;
    }>>;
    createEventAsync: (calendarId: string, event: any) => Promise<string>;
  };
}

let _testDeps: CalendarTestDeps | null = null;

/**
 * Override native dependencies in tests.  Call with null to restore production
 * behaviour.  Has zero effect in production because tests never run in the
 * Expo runtime.
 */
export function _setTestCalendarDeps(deps: CalendarTestDeps | null): void {
  _testDeps = deps;
}

// ── Production function ────────────────────────────────────────────────────────

/**
 * Request calendar write permission, then create an event for the given
 * confirmed meetup. Returns a typed result — never throws.
 */
export async function addMeetupToCalendar(meetup: MeetupDetail): Promise<CalendarResult> {
  // Resolve platform — either the test-slot override or the real native value.
  const platform: string = _testDeps
    ? _testDeps.platform
    : (await import('react-native')).Platform.OS;

  if (platform === 'web') {
    return { ok: false, reason: 'error', message: 'Calendar not supported on web' };
  }

  try {
    const Calendar: CalendarTestDeps['calendarModule'] = _testDeps
      ? _testDeps.calendarModule
      : (await import('expo-calendar')) as any;

    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== 'granted') {
      return { ok: false, reason: 'denied' };
    }

    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const defaultCal =
      calendars.find((c) => c.allowsModifications && c.isPrimary) ??
      calendars.find((c) => c.allowsModifications);

    if (!defaultCal) {
      return { ok: false, reason: 'error', message: 'No writable calendar found on this device.' };
    }

    // Date derivation — same rules as calendarUtils.deriveMeetupDates.
    const startDate = meetup.startsAt ? new Date(meetup.startsAt) : null;
    if (!startDate) {
      return { ok: false, reason: 'error', message: 'Meetup has no confirmed start time.' };
    }
    const endDate = meetup.endsAt
      ? new Date(meetup.endsAt)
      : new Date(startDate.getTime() + 60 * 60 * 1000);

    const eventId = await Calendar.createEventAsync(defaultCal.id, {
      title: meetup.title,
      startDate,
      endDate,
      location: meetup.locationName ?? undefined,
      notes: meetup.description ?? undefined,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    return { ok: true, eventId };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'Could not add event to calendar.',
    };
  }
}
