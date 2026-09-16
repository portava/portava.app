/**
 * PlaceCard — "Not interested", and the three ways it could have been a lie.
 *
 * WHAT THIS IS
 * ============
 * `rank_events.outcome` has admitted `'dismiss'` since migration 2297, and
 * `POST /api/rank-events/outcome` has accepted it against `surface: 'discovery'`
 * ever since. census-discovery §12.6 measured what that was worth:
 *
 *   "`dismiss` is ONE token where `04` §4 names six distinct types, and
 *    `grep -rn "dismiss" travel-buddy-standalone/src` finds no client that
 *    sends one — so the leg is genuinely unsatisfied. What is wrong is 'has no
 *    writer'; the writer exists and is unexercised."
 *
 * This is the sender. The suppression it feeds lives server-side in
 * `lib/discoveryDismissed.ts` and is applied on all four `GET /discovery` serve
 * paths by `dismissGatedPlaces` — proved separately in
 * `artifacts/api-server/src/test/discoveryCuratedSourceRefusal.test.ts`.
 *
 * THE THREE FAILURES THIS FILE EXISTS TO FORBID
 * =============================================
 *  (1) A CONTROL THAT CANNOT WORK. The dismissal is recorded against an
 *      impression row on a named surface. Rendered without a `rankSurface`,
 *      or without an owner willing to act on the result, the button would post
 *      nothing or change nothing. It must not be drawn at all in those cases.
 *
 *  (2) AN OPTIMISTIC HIDE. The card must not disappear until the SERVER has
 *      accepted the dismissal. Hiding first makes the interface state a fact —
 *      "this is gone" — that the next refresh contradicts, on the one control
 *      whose entire meaning is that it sticks. That is worse than no control,
 *      because it also teaches the person their input is ignored.
 *
 *  (3) SILENCE ON FAILURE. If the post failed, the card stays AND says so.
 *      A card that silently stays looks like a missed tap and invites a retry
 *      that will fail the same way.
 *
 * Run with: pnpm test:component
 *
 * RNTL v14: render() is async — always await the mount helper.
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react-native';

// ── Module mocks ──────────────────────────────────────────────────────────────
// Same seam as PlaceCard.candidateProjection.component.test.tsx.

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo; only the live-status function is
// reached by this card and its value is irrelevant here.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatusCached: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules
// that are not safe under jest-expo; only these three stubs are needed.
jest.mock('../../../services/collections', () => ({
  checkSaved: jest.fn().mockResolvedValue({ saved: false }),
  saveItem: jest.fn().mockResolvedValue(true),
  unsaveItem: jest.fn().mockResolvedValue(true),
}));

// NOTE: intentionally exhaustive — discoveryBookmarks imports AsyncStorage and
// Supabase; the Set return is all that matters.
jest.mock('../../../services/discoveryBookmarks', () => ({
  getSavedListIds: jest.fn().mockResolvedValue(new Set()),
}));

// NOTE: intentionally exhaustive — the real PlanPickerController renders the
// full picker UI tree; only isAdded is read by this card.
jest.mock('../../PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker pulls in its own service
// chain and Modal; stubbing to null prevents a dependency cascade.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — expo-image pulls in native modules that crash
// under jest-expo; the card only needs something that renders children.
jest.mock('../../ui/DisplayMediaImage.tsx', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    DisplayMediaImage: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement(View, { testID: testID ?? 'display-media-image' }, children ?? null),
    MediaFallback: () => null,
  };
});

// NOTE: intentionally exhaustive — the FSQ photo hook performs network lookups;
// imagery is unrelated to the control under test.
jest.mock('../../../hooks/useFsqPhoto.ts', () => ({ useFsqPhoto: () => null }));

/**
 * The outcome hook is mocked at its MODULE boundary rather than by stubbing
 * `fetch`, so these cases assert what the card DOES with the answer — which is
 * the whole subject — instead of re-testing the transport. `reportDismiss`'s own
 * contract (awaited, true only on a 2xx, never deduped) is a property of
 * `hooks/useRankOutcome.ts`.
 */
const mockReportDismiss = jest.fn();
jest.mock('../../../hooks/useRankOutcome.ts', () => ({
  ...jest.requireActual('../../../hooks/useRankOutcome.ts'),
  useRankOutcome: () => ({
    reportTap: jest.fn(),
    reportSave: jest.fn(),
    reportJoin: jest.fn(),
    reportRsvp: jest.fn(),
    reportTripAdd: jest.fn(),
    reportDismiss: (...args: unknown[]) => mockReportDismiss(...args),
  }),
}));

import { PlaceCard } from '../PlaceCard.tsx';
import type { DiscoveryPlace } from '../../../services/discovery.ts';

const PLACE: DiscoveryPlace = {
  id: 'node/1',
  name: 'Sirao Flower Garden',
  category: 'nature',
  type: 'Garden',
  description: 'Terraced flower rows above the city.',
  distanceKm: 3.2,
  lat: 10.4,
  lng: 123.8,
  tags: [],
  address: 'Sirao',
  website: null,
  phone: null,
  openingHours: null,
  rating: null,
  isOpenNow: null,
} as DiscoveryPlace;

const noop = () => {};
const DISMISS_TESTID = `place-card-dismiss-${PLACE.id}`;

async function mount(
  props: { rankSurface?: 'discovery' | null; onDismissed?: (id: string) => void } = {},
) {
  return render(
    <PlaceCard
      place={PLACE}
      onPress={noop}
      onAddToPlan={noop}
      rankSurface={props.rankSurface === undefined ? 'discovery' : props.rankSurface}
      onDismissed={props.onDismissed}
    />,
  );
}

beforeEach(() => {
  mockReportDismiss.mockReset();
});

describe('PlaceCard — "Not interested"', () => {
  it('(1) a card served from a ranked surface offers the control', async () => {
    await mount({ onDismissed: noop });
    await waitFor(() => expect(screen.getByTestId(DISMISS_TESTID)).toBeTruthy());
    // Labelled for a screen reader with the place it acts on, because "not
    // interested" alone is meaningless in a list of identical buttons.
    expect(screen.getByLabelText(`Not interested in ${PLACE.name}`)).toBeTruthy();
  });

  it('(2) NO rankSurface ⇒ no control — a dismissal with nothing to attribute it to', async () => {
    // The card is shared. Rendered somewhere that served no impression, the
    // dismissal has no row to land on and the button would do nothing.
    await mount({ rankSurface: null, onDismissed: noop });
    await waitFor(() => expect(screen.getByText(PLACE.name)).toBeTruthy());
    expect(screen.queryByTestId(DISMISS_TESTID)).toBeNull();
  });

  it('(3) NO onDismissed ⇒ no control — nothing would act on the result', async () => {
    await mount({});
    await waitFor(() => expect(screen.getByText(PLACE.name)).toBeTruthy());
    expect(screen.queryByTestId(DISMISS_TESTID)).toBeNull();
  });

  it('(4) tapping it sends the dismissal for THIS place', async () => {
    mockReportDismiss.mockResolvedValue(true);
    await mount({ onDismissed: noop });
    await waitFor(() => expect(screen.getByTestId(DISMISS_TESTID)).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS_TESTID));
    });

    expect(mockReportDismiss).toHaveBeenCalledTimes(1);
    expect(mockReportDismiss).toHaveBeenCalledWith(PLACE.id);
  });

  it('(5) the owner is told ONLY after the server accepted it', async () => {
    mockReportDismiss.mockResolvedValue(true);
    const onDismissed = jest.fn();
    await mount({ onDismissed });
    await waitFor(() => expect(screen.getByTestId(DISMISS_TESTID)).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS_TESTID));
    });

    await waitFor(() => expect(onDismissed).toHaveBeenCalledWith(PLACE.id));
  });

  it('(6) a REJECTED dismissal does NOT remove the card, and says so', async () => {
    // The case the whole file is about. An optimistic hide would pass (4) and
    // (5) and still be wrong: the place returns on the next refresh, and the
    // person was told something untrue by a control whose only promise is
    // permanence.
    mockReportDismiss.mockResolvedValue(false);
    const onDismissed = jest.fn();
    await mount({ onDismissed });
    await waitFor(() => expect(screen.getByTestId(DISMISS_TESTID)).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS_TESTID));
    });

    await waitFor(() => expect(screen.getByText(/Couldn’t hide this just now/i)).toBeTruthy());
    expect(onDismissed).not.toHaveBeenCalled();
    // The card is still on screen, and the control is still there to retry with.
    expect(screen.getByText(PLACE.name)).toBeTruthy();
    expect(screen.getByTestId(DISMISS_TESTID)).toBeTruthy();
  });

  it('(7) a THROWN dismissal is treated as a failure, not as success', async () => {
    // `reportDismiss` is written not to throw, but a card that only handled the
    // resolved-false arm would hide itself on the day that changes.
    mockReportDismiss.mockRejectedValue(new Error('network'));
    const onDismissed = jest.fn();
    await mount({ onDismissed });
    await waitFor(() => expect(screen.getByTestId(DISMISS_TESTID)).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS_TESTID));
    });

    await waitFor(() => expect(screen.getByText(/Couldn’t hide this just now/i)).toBeTruthy());
    expect(onDismissed).not.toHaveBeenCalled();
  });

  it('(8) a failure can be RETRIED, and a retry that succeeds removes the card', async () => {
    // The dismissal is deliberately NOT deduped client-side, unlike the funnel
    // outcomes: a repeat here means "try again", not "the same information
    // twice", and swallowing it would leave the control permanently dead for
    // this item until the screen remounted.
    mockReportDismiss.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onDismissed = jest.fn();
    await mount({ onDismissed });
    await waitFor(() => expect(screen.getByTestId(DISMISS_TESTID)).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS_TESTID));
    });
    await waitFor(() => expect(screen.getByText(/Couldn’t hide this just now/i)).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS_TESTID));
    });
    await waitFor(() => expect(onDismissed).toHaveBeenCalledWith(PLACE.id));
    expect(mockReportDismiss).toHaveBeenCalledTimes(2);
  });

  it('(9) VACUITY GUARD — an untouched card shows no failure message', async () => {
    // Without this, "(6) shows the failure text" is satisfied by a card that
    // renders it permanently.
    mockReportDismiss.mockResolvedValue(true);
    await mount({ onDismissed: noop });
    await waitFor(() => expect(screen.getByTestId(DISMISS_TESTID)).toBeTruthy());
    expect(screen.queryByText(/Couldn’t hide this just now/i)).toBeNull();
    expect(mockReportDismiss).not.toHaveBeenCalled();
  });
});
