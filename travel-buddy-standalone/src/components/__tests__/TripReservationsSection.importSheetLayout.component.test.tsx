/**
 * TripReservationsSection — "Paste a confirmation": both bodies of the sheet must have a height of their own.
 *
 * The sheet is content-sized (only `maxHeight: '85%'`) at the bottom of a `flex: 1, justifyContent: 'flex-end'`
 * overlay, and both of its bodies were `flex: 1` — the paste body a View, the review list a ScrollView. In React
 * Native `flex: 1` means flexBasis 0: inside a parent with no definite height Yoga lays such a child out to 0pt.
 * Reproduced with yoga-layout 3.2.1, errata ALL (RN 0.81 Fabric), at 440×956: paste step sheet 99pt / body 0pt (no text
 * box, no Extract button) → sheet 389pt / body 290pt; review step sheet 99pt / list 0pt → sheet 783pt / list 684pt
 * (three rows stop at the 85% cap and scroll). reservation_import_enabled is off in production; fixed anyway.
 *
 * Jest computes no layout, so this pins the styles that decide it, together with what each body exists for.
 */
import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

// NOTE: spreading requireActual so the mock never drifts behind new exports.
jest.mock('../../services/tripIntel.ts', () => ({
  ...jest.requireActual('../../services/tripIntel.ts'),
  importReservations: jest.fn(),
}));

// NOTE: intentional stub — TESTING.md Rule 6. Only `Modal` is intercepted; every other export falls through.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { ImportSheet } from '../trip/TripReservationsSection.tsx';

function hostScrollViews(): any[] {
  const found: any[] = [];
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'RCTScrollView') found.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit((screen as any).root);
  return found;
}

/** A body that sizes to its content: no positive flex, no 0 basis, no growth. */
function expectContentSized(style: any) {
  expect(style.flex).toBeUndefined();
  expect(style.flexBasis).toBeUndefined();
  expect(style.flexGrow ?? 0).toBe(0);
}

describe('ImportSheet layout', () => {
  it('paste step: the body is content-sized and holds the text box and the Extract button', async () => {
    await render(<ImportSheet tripId="trip-1" visible onDismiss={() => {}} onImported={() => {}} />);

    // The paste body is the text box's parent.
    const body = (screen.getByTestId('confirmation-text-input') as any).parent;
    expectContentSized(StyleSheet.flatten(body.props.style) ?? {});
    expect(screen.getByTestId('confirmation-text-input')).toBeTruthy();
    expect(screen.getByTestId('extract-button')).toBeTruthy();
  });

  it('review step: the list is content-sized, shrinks past the cap, and shows the extracted rows', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const svc = require('../../services/tripIntel.ts');
    (svc.importReservations as jest.Mock).mockResolvedValue({
      reservations: [{
        id: 'r1', type: 'flight', title: 'TAP 1234 to Lisbon', startsAt: '2026-11-01T06:00:00Z', endsAt: null,
        locationName: null, confirmationRef: 'ABC123', cancellationDeadlineAt: null, status: 'pending_confirm',
        extractionConfidence: 0.9,
      }],
    });
    await render(<ImportSheet tripId="trip-1" visible onDismiss={() => {}} onImported={() => {}} />);
    await fireEvent.changeText(screen.getByTestId('confirmation-text-input'), 'Booking ABC123 TAP 1234');
    await fireEvent.press(screen.getByTestId('extract-button'));
    await screen.findByText('Review extracted reservations');

    // The review list is the one vertical scroll view (each row carries a horizontal type-chip strip).
    const lists = hostScrollViews().filter((sv) => !sv.props.horizontal);
    expect(lists).toHaveLength(1);
    const style = StyleSheet.flatten(lists[0].props.style) ?? {};
    expectContentSized(style);
    expect(style.flexShrink).toBe(1);
    expect(screen.getByDisplayValue('TAP 1234 to Lisbon')).toBeTruthy();
  });
});
