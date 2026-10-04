/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B41, probe EC1): an EventCard whose
 * saved state could not be read is DRAWN as unknown, not only labelled.
 *
 * §122 (B35) gave the card `savedUnknown`: the bookmark's accessibility label became "Couldn't check if saved". The
 * drawing did not change. A sighted viewer saw the same outline bookmark that means "not saved": the unread state was
 * presented as a measured "not saved" to everyone but a screen reader. The card now draws a question mark (lucide's
 * CircleHelp, the mark Telegraph already uses for a receipt it could not read) in place of the bookmark.
 *
 * The lucide mock renders every icon as a View with testID `icon-<Name>`, so the drawn icon is observable.
 *
 *   EC1  savedUnknown → the question mark is drawn and NO bookmark is
 *   EC1b savedUnknown beside `isSaved: true` (a stale prop) → still the question mark, never a filled bookmark
 *   EC0  CONTROL: not saved → the bookmark is drawn, no question mark; "Save event"
 *   EC0b CONTROL: saved → the bookmark is drawn, no question mark; "Unsave event"
 *   EC2  no onToggleSave → neither is drawn (the card has no bookmark at all)
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (p: { testID?: string }) => React.createElement(View, { testID: p.testID ?? 'expo-image' }) };
});

import { EventCard } from '../EventCard.tsx';

const base = { id: 'ev-1', title: 'Rooftop quiz', startsAt: '2099-08-01T18:00:00Z', goingCount: 4, state: 'open', onPress: jest.fn() };
const icons = () => ({ bookmark: screen.queryAllByTestId('icon-Bookmark').length, unknown: screen.queryAllByTestId('icon-CircleHelp').length });

describe('census-discovery §123 (B41): EventCard draws an unread saved state as unknown', () => {
  it('EC1 savedUnknown → the question mark is drawn and no bookmark is', async () => {
    await render(<EventCard {...base} savedUnknown onToggleSave={jest.fn()} />);
    expect(icons()).toEqual({ bookmark: 0, unknown: 1 });
    expect(screen.getByLabelText("Couldn't check if saved")).toBeTruthy();
  });
  it('EC1b savedUnknown beside isSaved true → still the question mark', async () => {
    await render(<EventCard {...base} isSaved savedUnknown onToggleSave={jest.fn()} />);
    expect(icons()).toEqual({ bookmark: 0, unknown: 1 });
  });
  it('EC0 CONTROL: not saved → the bookmark, no question mark', async () => {
    await render(<EventCard {...base} isSaved={false} onToggleSave={jest.fn()} />);
    expect(icons()).toEqual({ bookmark: 1, unknown: 0 });
    expect(screen.getByLabelText('Save event')).toBeTruthy();
  });
  it('EC0b CONTROL: saved → the bookmark, no question mark', async () => {
    await render(<EventCard {...base} isSaved onToggleSave={jest.fn()} />);
    expect(icons()).toEqual({ bookmark: 1, unknown: 0 });
    expect(screen.getByLabelText('Unsave event')).toBeTruthy();
  });
  it('EC2 no onToggleSave → no bookmark and no question mark', async () => {
    await render(<EventCard {...base} savedUnknown />);
    expect(icons()).toEqual({ bookmark: 0, unknown: 0 });
  });
});
