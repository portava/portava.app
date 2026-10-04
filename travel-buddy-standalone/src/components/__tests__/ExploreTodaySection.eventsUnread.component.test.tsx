/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): Explore Today never says a failed or partial read of
 * today's events as "Nothing on the calendar", nor a count GET /events could not recount as measured.
 *
 * useCityPulse now says `eventsUnread` ('failed': the read failed; 'partial': GET /events said it is not whole), and
 * marks an event whose going count was not recounted (`attendeeCountUnread`, cityPulseUtils). The section said "Nothing
 * on the calendar in <city> yet" over both, and drew every count as measured.
 *
 *   XT1  the read failed, no events → "Couldn't load today's events in Lisbon", never "Nothing on the calendar"
 *   XT2  the read partial, no events → the same
 *   XT3  the read partial, events → "Some of today's events couldn't be loaded" above them
 *   XT4  an event whose count was not recounted → "3 going (last known) · 8 max" (the Full Day row)
 *   XT5  the same event on a FitsCard (the band row and Pulse's "Fits your time") → "3 going (last known)"
 *   XT6  the same event happening now → its Happening Now chip ends "· 3 going (last known)"
 *   XT0  CONTROL: the read whole, no events → "Nothing on the calendar in Lisbon yet"
 *   XT0b CONTROL: the read whole, an event → "3 going", no note
 */
import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
}));

import { ExploreTodaySection } from '../ExploreTodaySection.tsx';
import { FitsCard } from '../PulseFits.tsx';
import type { CityEvent } from '../../types/models.ts';

const later = new Date(Date.now() + 3 * 3600_000).toISOString();
const ev = (over: Partial<CityEvent> & Record<string, unknown> = {}): CityEvent => ({
  id: 'e1', kind: 'event', title: 'Rooftop quiz', city: 'Lisbon', citySlug: 'lisbon', startAt: later,
  block: 'evening', category: 'social', attendeeCount: 3, ...over,
} as CityEvent);

async function shown(events: CityEvent[], eventsUnread: 'failed' | 'partial' | null) {
  return render(<ExploreTodaySection events={events} city="Lisbon" eventsUnread={eventsUnread} />);
}

describe('census-discovery §117 (SW17): Explore Today says what it could not read', () => {
  it('XT1 the read failed, no events → "Couldn\'t load today\'s events in Lisbon"', async () => {
    const r = await shown([], 'failed');
    expect(r.getByText("Couldn't load today's events in Lisbon")).toBeTruthy();
    expect(r.queryByText(/Nothing on the calendar/)).toBeNull();
  });
  it('XT2 the read partial, no events → the same', async () => {
    const r = await shown([], 'partial');
    expect(r.getByText("Couldn't load today's events in Lisbon")).toBeTruthy();
    expect(r.queryByText(/Nothing on the calendar/)).toBeNull();
  });
  it('XT3 the read partial, events → "Some of today\'s events couldn\'t be loaded"', async () => {
    const r = await shown([ev()], 'partial');
    expect(r.getByText("Some of today's events couldn't be loaded")).toBeTruthy();
  });
  it('XT4 a count not recounted → "3 going (last known)"', async () => {
    const r = await shown([ev({ attendeeCountUnread: true, capacity: 8 })], null);
    expect(r.getByText('3 going (last known) · 8 max')).toBeTruthy();
  });
  it('XT5 a FitsCard whose count was not recounted → "3 going (last known)"', async () => {
    const r = await render(<FitsCard ev={ev({ attendeeCountUnread: true })} />);
    expect(r.getByText('3 going (last known)')).toBeTruthy();
    expect(r.queryByText('3 going')).toBeNull();
  });
  it('XT6 a Happening Now chip whose count was not recounted → "… · 3 going (last known)"', async () => {
    const r = await shown([ev({ startAt: new Date().toISOString(), attendeeCountUnread: true })], null);
    expect(r.getByText(/· 3 going \(last known\)$/)).toBeTruthy();
  });
  it('XT0 CONTROL: the read whole, no events → "Nothing on the calendar in Lisbon yet"', async () => {
    const r = await shown([], null);
    expect(r.getByText('Nothing on the calendar in Lisbon yet')).toBeTruthy();
  });
  it('XT0b CONTROL: the read whole, an event → "3 going", no note', async () => {
    const r = await shown([ev()], null);
    expect(r.getAllByText('3 going').length).toBeGreaterThan(0);
    expect(r.queryByText(/last known|couldn't be loaded/)).toBeNull();
  });
});
