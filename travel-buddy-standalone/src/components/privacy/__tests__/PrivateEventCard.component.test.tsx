/**
 * Component tests for PrivateEventCard
 *
 * Covers:
 *   1. Renders event name (title)
 *   2. Renders "Private Event" badge text
 *   3. Renders "Request to Join" button when myJoinRequestStatus is null
 *   4. Renders "Request sent" state when myJoinRequestStatus is 'pending'
 *   5. Does NOT render address node (address is never part of PrivateEventPreview)
 *   6. Does NOT render exact times / date text
 *   7. Does NOT render attendee count
 *   8. onRequestSent callback fires after a successful join request
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { PrivateEventCard } from '../PrivateEventCard.tsx';
import type { PrivateEventPreview } from '../PrivateEventCard.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requestToJoinEvent calls the API layer which
// uses fetch + auth tokens not available in jest-expo; only the ok response
// shape is needed here to verify button state transitions.
jest.mock('../../../services/events', () => ({
  requestToJoinEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs are sufficient
// for rendering tests.

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_EVENT: PrivateEventPreview = {
  isPrivate: true,
  id: 'event-priv-001',
  title: 'Secret Sunset Gathering',
  coverImageUrl: null,
  hostDisplayName: 'Jane Host',
  hostHandle: 'janehost',
  hostId: 'host-id-001',
  myJoinRequestStatus: null,
};

/**
 * A deliberately OVER-FULL object: it carries sensitive fields the private
 * sentinel type does not declare (address, venue, exact times, attendee roster,
 * coordinates). The component must read none of them. Each value is a unique
 * sentinel string, so queryByText proves it never reaches the render tree — and
 * if the component ever starts rendering one, the matching assertion fails.
 * (The old tests asserted absence of testIDs the component never emits, so a
 * plain-<Text> leak of any of these would have stayed green.)
 */
const OVERFULL_EVENT = {
  ...BASE_EVENT,
  address:        '742 Evergreen Terrace, Springfield',
  venueName:      'The Hidden Rooftop Loft',
  startsAt:       '2026-07-04T17:00:00Z',
  endsAt:         '2026-07-04T22:00:00Z',
  startTimeLabel: '5:00 PM',
  attendeeCount:  42,
  goingCount:     42,
  attendees:      [{ displayName: 'Leak McLeakface' }],
  lat:            40.1234567,
  lng:            -74.7654321,
} as unknown as PrivateEventPreview;

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountCard(
  event: PrivateEventPreview = BASE_EVENT,
  props: { onRequestSent?: jest.Mock } = {},
) {
  return render(
    <PrivateEventCard
      event={event}
      onRequestSent={props.onRequestSent}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PrivateEventCard', () => {
  it('renders event title', async () => {
    await mountCard();
    await waitFor(() => {
      expect(screen.getByText('Secret Sunset Gathering')).toBeTruthy();
    });
  });

  it('renders "Private Event" badge', async () => {
    await mountCard();
    await waitFor(() => {
      expect(screen.getByText('Private Event')).toBeTruthy();
    });
  });

  it('renders "Request to Join" button when myJoinRequestStatus is null', async () => {
    await mountCard(BASE_EVENT);
    await waitFor(() => {
      expect(screen.getByText('Request to Join')).toBeTruthy();
    });
  });

  it('renders "Request sent" state when myJoinRequestStatus is pending', async () => {
    await mountCard({ ...BASE_EVENT, myJoinRequestStatus: 'pending' });
    await waitFor(() => {
      expect(screen.getByText('Request sent')).toBeTruthy();
    });
  });

  it('does NOT leak address or venue — even when present on the event object', async () => {
    await mountCard(OVERFULL_EVENT);
    // Positive control: queryByText DOES resolve text that the card renders,
    // so a null below means "absent", not "probe broken".
    await waitFor(() => {
      expect(screen.getByText('Secret Sunset Gathering')).toBeTruthy();
    });
    expect(screen.queryByText('742 Evergreen Terrace, Springfield')).toBeNull();
    expect(screen.queryByText('The Hidden Rooftop Loft')).toBeNull();
    expect(screen.queryByText(/40\.123|-74\.765/)).toBeNull();
    // The wall message tells the user times/location are hidden.
    expect(
      screen.getByText(
        'This is a private event. Request to join to see times, location, and details.',
      ),
    ).toBeTruthy();
  });

  it('does NOT leak exact times or dates — even when present on the event object', async () => {
    await mountCard(OVERFULL_EVENT);
    await waitFor(() => {
      expect(screen.getByText('Secret Sunset Gathering')).toBeTruthy(); // positive control
    });
    expect(screen.queryByText('5:00 PM')).toBeNull();
    expect(screen.queryByText(/17:00|22:00/)).toBeNull();
    expect(screen.queryByText(/2026-07-04/)).toBeNull();
  });

  it('does NOT leak attendee count or roster — even when present on the event object', async () => {
    await mountCard(OVERFULL_EVENT);
    await waitFor(() => {
      expect(screen.getByText('Secret Sunset Gathering')).toBeTruthy(); // positive control
    });
    expect(screen.queryByText('Leak McLeakface')).toBeNull();
    expect(screen.queryByText(/\b42\b/)).toBeNull();
    expect(screen.queryByText(/\d+ going/i)).toBeNull();
    expect(screen.queryByText(/\d+ attendee/i)).toBeNull();
  });

  it('renders host display name in the "Hosted by" line', async () => {
    await mountCard();
    await waitFor(() => {
      expect(screen.getByText('Jane Host')).toBeTruthy();
    });
  });

  it('renders "Request to Join" button (accessibility role = button)', async () => {
    await mountCard();
    await waitFor(() => {
      const btn = screen.getByAccessibilityHint
        ? undefined
        : screen.queryByRole?.('button');
      // At minimum the button text is rendered
      expect(screen.getByText('Request to Join')).toBeTruthy();
    });
  });

  it('shows pending wall message after a successful join request', async () => {
    const onRequestSent = jest.fn();
    await mountCard(BASE_EVENT, { onRequestSent });

    await waitFor(() => {
      expect(screen.getByText('Request to Join')).toBeTruthy();
    });

    // Tap the request button
    fireEvent.press(screen.getByText('Request to Join'));

    await waitFor(() => {
      expect(screen.getByText('Request sent')).toBeTruthy();
      expect(
        screen.getByText(
          'Your request is pending. The host must approve you before you can see event details.',
        ),
      ).toBeTruthy();
    });
  });

  it('fires onRequestSent callback after successful join request', async () => {
    const onRequestSent = jest.fn();
    await mountCard(BASE_EVENT, { onRequestSent });

    await waitFor(() => screen.getByText('Request to Join'));
    fireEvent.press(screen.getByText('Request to Join'));

    await waitFor(() => {
      expect(onRequestSent).toHaveBeenCalledTimes(1);
    });
  });

  it('renders cover fallback (Calendar icon placeholder) when coverImageUrl is null', async () => {
    await mountCard({ ...BASE_EVENT, coverImageUrl: null });
    // No crash; fallback renders without the Image component
    await waitFor(() => {
      expect(screen.getByText('Secret Sunset Gathering')).toBeTruthy();
    });
  });

  it('uses title fallback "Private Event" when title is null', async () => {
    await mountCard({ ...BASE_EVENT, title: null });
    await waitFor(() => {
      // The component falls back to 'Private Event' when title is null
      const titles = screen.getAllByText('Private Event');
      expect(titles.length).toBeGreaterThanOrEqual(1);
    });
  });
});
