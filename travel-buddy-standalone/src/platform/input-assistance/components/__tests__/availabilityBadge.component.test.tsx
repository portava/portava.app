/**
 * census G177 (§28 "Open/closed or availability state where valid", wave 4,
 * 2026-10-17) — the row RENDERS the availability the server projected for an
 * event and reads it to a screen reader; anything this build cannot name
 * renders nothing. Real `EntitySuggestionRow`, which `SmartInput` renders on the
 * Wall's global search.
 *
 * The server states availability only for an event whose `events.state` the
 * RSVP capacity writer keeps current (`full`, `waitlist`); a place has no
 * displayable open/closed source, so a place row carries no key at all
 * (artifacts/api-server/src/lib/inputAssistance/operatingStatus.ts).
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react-native';
import { EntitySuggestionRow } from '../EntitySuggestionRow.tsx';
import { availabilityBadge, suggestionBadges } from '../suggestionBadges.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const event: InputSuggestion = {
  id: 'e1', type: 'entity', context: 'global_search', label: 'Rooftop Jazz Night', subtitle: 'Da Nang',
  entityType: 'event', entityId: 'e1', source: 'canonical', policyVersion: 'v',
};

afterEach(async () => { await cleanup(); });

test('G177: a full event says so on the row and to a screen reader', async () => {
  const r = await render(<EntitySuggestionRow suggestion={{ ...event, availability: 'full' }} onPress={() => {}} />);
  expect(r.getByText('Full')).toBeTruthy();
  expect(r.getByTestId('ia-entity-row-e1').props.accessibilityLabel).toContain('Full');
});

test('G177: a waitlist is stated as a way in', async () => {
  const r = await render(<EntitySuggestionRow suggestion={{ ...event, availability: 'waitlist' }} onPress={() => {}} />);
  expect(r.getByText('Waitlist open')).toBeTruthy();
  expect(r.getByTestId('ia-entity-row-e1').props.accessibilityLabel).toContain('Waitlist open');
});

test('G177: an unknown or absent availability renders nothing — never "Open"', async () => {
  for (const availability of [undefined, 'open', 'closed', 'sold_out']) {
    const r = await render(<EntitySuggestionRow suggestion={{ ...event, availability }} onPress={() => {}} />);
    expect(r.queryByText('Full')).toBeNull();
    expect(r.queryByText('Waitlist open')).toBeNull();
    expect(r.queryByText('Open')).toBeNull();
    expect(r.getByTestId('ia-entity-row-e1').props.accessibilityLabel).not.toMatch(/full|waitlist|open|closed|sold/i);
    await cleanup();
  }
});

test('G177: the words come from one helper, after identity badges and before the relationship', () => {
  expect(availabilityBadge('full')).toEqual({ id: 'full', label: 'Full' });
  expect(availabilityBadge('waitlist')).toEqual({ id: 'waitlist', label: 'Waitlist open' });
  expect(availabilityBadge('open')).toBeNull();
  expect(availabilityBadge(42)).toBeNull();
  expect(suggestionBadges({ verified: true, availability: 'full', relationship: 'saved' }).map((b) => b.id)).toEqual(['verified', 'full', 'saved']);
});
