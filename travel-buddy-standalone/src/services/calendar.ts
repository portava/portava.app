/**
 * Calendar service — adds meetup events to the device calendar via expo-calendar.
 *
 * Web: expo-calendar has no web support; all calls are no-ops on web.
 */
import { Platform } from 'react-native';
import type { MeetupDetail } from './meetups';

export type CalendarResult =
  | { ok: true; eventId: string }
  | { ok: false; reason: 'denied' | 'error'; message?: string };

/**
 * Request calendar write permission, then create an event for the given
 * confirmed meetup. Returns a typed result — never throws.
 */
export async function addMeetupToCalendar(meetup: MeetupDetail): Promise<CalendarResult> {
  if (Platform.OS === 'web') {
    return { ok: false, reason: 'error', message: 'Calendar not supported on web' };
  }

  try {
    const Calendar = await import('expo-calendar');

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
