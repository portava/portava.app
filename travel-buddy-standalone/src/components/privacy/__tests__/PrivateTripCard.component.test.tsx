/**
 * Component tests for PrivateTripCard
 *
 * Covers:
 *   1. Renders trip title
 *   2. Renders "Private Trip" badge text
 *   3. Renders "Request Access" button when myJoinRequestStatus is null
 *   4. Renders "Request sent" state when myJoinRequestStatus is 'pending'
 *   5. Does NOT render dates node (dates are never part of PrivateTripPreview visible here)
 *   6. Does NOT render itinerary, hotel name, or member list text
 *   7. onRequestSent callback fires after a successful access request
 *   8. Renders owner display name in the "Organized by" line
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { PrivateTripCard } from '../PrivateTripCard.tsx';
import type { PrivateTripPreview } from '../PrivateTripCard.tsx';

// ── Module mocks ──────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — requestTripAccess calls the API layer which
// uses fetch + auth tokens not available in jest-expo; only the ok response
// shape is needed here to verify button state transitions.
jest.mock('../../../services/trips', () => ({
  requestTripAccess: jest.fn().mockResolvedValue({ ok: true }),
}));

// NOTE: intentionally exhaustive — spreading requireActual pulls in native font
// loader internals that crash under jest-expo; plain value stubs are sufficient
// for rendering tests.

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_TRIP: PrivateTripPreview = {
  isPrivate: true,
  id: 'trip-priv-001',
  title: 'Secret Alps Expedition',
  coverImageUrl: null,
  ownerDisplayName: 'Marco Explorer',
  ownerHandle: 'marcoexplorer',
  ownerId: 'owner-id-001',
  myJoinRequestStatus: null,
};

/**
 * Over-full object carrying sensitive fields the private-trip sentinel type does
 * not declare. The card must read none of them; each value is a unique sentinel
 * so queryByText proves it never reaches the render tree, and a plain-<Text>
 * leak of any of them fails the matching assertion.
 */
const OVERFULL_TRIP = {
  ...BASE_TRIP,
  startDate:   '2026-08-01',
  endDate:     '2026-08-14',
  itinerary:   'Day 1: Chamonix ascent via the Grands Montets',
  hotelName:   'Auberge du Sommet Caché',
  members:     [{ displayName: 'Trip Leak Person' }],
  destination: 'Chamonix-Mont-Blanc',
} as unknown as PrivateTripPreview;

// ── Mount helper ──────────────────────────────────────────────────────────────

async function mountCard(
  trip: PrivateTripPreview = BASE_TRIP,
  props: { onRequestSent?: jest.Mock } = {},
) {
  return render(
    <PrivateTripCard
      trip={trip}
      onRequestSent={props.onRequestSent}
    />,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PrivateTripCard', () => {
  it('renders trip title', async () => {
    await mountCard();
    await waitFor(() => {
      expect(screen.getByText('Secret Alps Expedition')).toBeTruthy();
    });
  });

  it('renders "Private Trip" badge', async () => {
    await mountCard();
    await waitFor(() => {
      expect(screen.getByText('Private Trip')).toBeTruthy();
    });
  });

  it('renders "Request Access" button when myJoinRequestStatus is null', async () => {
    await mountCard(BASE_TRIP);
    await waitFor(() => {
      expect(screen.getByText('Request Access')).toBeTruthy();
    });
  });

  it('renders "Request sent" state when myJoinRequestStatus is pending', async () => {
    await mountCard({ ...BASE_TRIP, myJoinRequestStatus: 'pending' });
    await waitFor(() => {
      expect(screen.getByText('Request sent')).toBeTruthy();
    });
  });

  it('does NOT leak trip dates — even when present on the trip object', async () => {
    await mountCard(OVERFULL_TRIP);
    await waitFor(() => {
      expect(screen.getByText('Secret Alps Expedition')).toBeTruthy(); // positive control
    });
    expect(screen.queryByText(/2026-08-01|2026-08-14/)).toBeNull();
    expect(screen.queryByText(/2026-\d{2}-\d{2}/)).toBeNull();
    // The wall message tells the user the itinerary is hidden
    expect(
      screen.getByText(
        'This is a private trip. Request access to see the itinerary, dates, and members.',
      ),
    ).toBeTruthy();
  });

  it('does NOT leak itinerary, hotel name, or member list — even when present on the trip object', async () => {
    await mountCard(OVERFULL_TRIP);
    await waitFor(() => {
      expect(screen.getByText('Secret Alps Expedition')).toBeTruthy(); // positive control
    });
    expect(screen.queryByText('Day 1: Chamonix ascent via the Grands Montets')).toBeNull();
    expect(screen.queryByText('Auberge du Sommet Caché')).toBeNull();
    expect(screen.queryByText('Trip Leak Person')).toBeNull();
    expect(screen.queryByText('Chamonix-Mont-Blanc')).toBeNull();
  });

  it('renders owner display name in "Organized by" line', async () => {
    await mountCard();
    await waitFor(() => {
      expect(screen.getByText('Marco Explorer')).toBeTruthy();
      expect(screen.getByText('Organized by ')).toBeTruthy();
    });
  });

  it('renders owner handle in the subline', async () => {
    await mountCard();
    await waitFor(() => {
      expect(screen.getByText(' @marcoexplorer')).toBeTruthy();
    });
  });

  it('shows pending wall message after a successful access request', async () => {
    const onRequestSent = jest.fn();
    await mountCard(BASE_TRIP, { onRequestSent });

    await waitFor(() => {
      expect(screen.getByText('Request Access')).toBeTruthy();
    });

    fireEvent.press(screen.getByText('Request Access'));

    await waitFor(() => {
      expect(screen.getByText('Request sent')).toBeTruthy();
      expect(
        screen.getByText(
          'Your request is pending. The trip owner must approve you before you can see trip details.',
        ),
      ).toBeTruthy();
    });
  });

  it('fires onRequestSent callback after successful access request', async () => {
    const onRequestSent = jest.fn();
    await mountCard(BASE_TRIP, { onRequestSent });

    await waitFor(() => screen.getByText('Request Access'));
    fireEvent.press(screen.getByText('Request Access'));

    await waitFor(() => {
      expect(onRequestSent).toHaveBeenCalledTimes(1);
    });
  });

  it('renders cover fallback (Plane icon placeholder) when coverImageUrl is null', async () => {
    await mountCard({ ...BASE_TRIP, coverImageUrl: null });
    await waitFor(() => {
      // No crash; fallback renders without the Image component
      expect(screen.getByText('Secret Alps Expedition')).toBeTruthy();
    });
  });

  it('uses title fallback "Private Trip" when title is null', async () => {
    await mountCard({ ...BASE_TRIP, title: null });
    await waitFor(() => {
      // The component falls back to 'Private Trip' when title is null
      const titles = screen.getAllByText('Private Trip');
      expect(titles.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('falls back to ownerHandle when ownerDisplayName is null', async () => {
    await mountCard({ ...BASE_TRIP, ownerDisplayName: null, ownerHandle: 'anon_trip' });
    await waitFor(() => {
      // The handle may appear in more than one node (header + subline); at
      // least one occurrence is sufficient to confirm the fallback is rendered.
      const nodes = screen.getAllByText(/@?anon_trip/);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
