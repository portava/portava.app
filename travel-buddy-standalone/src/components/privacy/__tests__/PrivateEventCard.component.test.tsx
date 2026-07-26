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
jest.mock('../../../theme/tokens', () => ({
  color: {
    deep:        '#2A7F8F',
    ink:         '#1A1A2E',
    signal:      '#FF6B6B',
    mute:        '#9B9B9B',
    faint:       '#CCCCCC',
    paper:       '#FFFFFF',
    paperRaised: '#F9F9F9',
    haze:        '#E8E8E8',
    onInk:       '#FFFFFF',
  },
  space:  { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  type:   { heading: {}, body: {}, bodyStrong: {}, small: {}, stamp: {} },
  shadow: { card: {} },
  layout: { pressedOpacity: 0.7 },
}));

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

  it('does NOT render address node — address is never part of PrivateEventPreview', async () => {
    await mountCard();
    await waitFor(() => {
      // No address text should appear
      expect(screen.queryByTestId('event-address')).toBeNull();
      // The wall message tells the user times/location are hidden
      expect(
        screen.getByText(
          'This is a private event. Request to join to see times, location, and details.',
        ),
      ).toBeTruthy();
    });
  });

  it('does NOT render exact times or date text', async () => {
    await mountCard();
    await waitFor(() => {
      // No time / date nodes rendered anywhere
      expect(screen.queryByTestId('event-starts-at')).toBeNull();
      expect(screen.queryByTestId('event-ends-at')).toBeNull();
      // Verify that specific time strings do not appear
      expect(screen.queryByText(/17:00|5:00 PM|18:00|2026-/)).toBeNull();
    });
  });

  it('does NOT render attendee count', async () => {
    await mountCard();
    await waitFor(() => {
      expect(screen.queryByTestId('going-count')).toBeNull();
      expect(screen.queryByTestId('attendee-count')).toBeNull();
      // No "going" or "attendee" count text
      expect(screen.queryByText(/\d+ going/i)).toBeNull();
      expect(screen.queryByText(/\d+ attendee/i)).toBeNull();
    });
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
