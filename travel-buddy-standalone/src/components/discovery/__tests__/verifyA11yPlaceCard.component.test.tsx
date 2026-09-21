/**
 * VERIFICATION LANE V4 — ACCESSIBILITY on the Discovery card's controls.
 *
 * The lane that built "Not interested" wrote the control carefully: it is not
 * drawn where it cannot work, it never hides the card optimistically, and it
 * says so in words when the server refused. Everything it got right is about
 * what the card DOES. Nothing in it is about who can hear the result.
 *
 * The four questions, and where this card answered them:
 *   1. LABEL AND ROLE — "Not interested" has both. The two icon buttons beside
 *      it, which shipped earlier and were never swept, have NEITHER.
 *   2. STATE ANNOUNCED — the in-flight dismissal and the failed one were drawn
 *      and never spoken.
 *   3. COLOUR ALONE — the failure tints the thumb icon `color.signal` and adds
 *      a sentence. The sentence was already there; it was unreachable.
 *   4. GESTURE-ONLY — nothing here. Every control is a Pressable with onPress.
 *
 * ── RED-FIRST RECORD (measured 2026-09-16, `pnpm test:component`) ───────────
 * Against the unmodified code: 5 of 7 RED.
 *
 *   ✕ D1  the control announces BUSY while the dismissal is in flight
 *   ✕ D2  a REFUSED dismissal is ANNOUNCED, not only drawn
 *   ✕ D4  the bookmark is named, and its TOGGLE state is not the fill colour
 *   ✕ D5  the trip-wishlist button is named — it writes to a trip
 *   ✕ D7  every pressable on the card carries a ROLE and a NAME
 *   ✓ D3, D6 passed unmodified — see PROVEN BY MUTATION below.
 *
 * DEFECT B1 — SIX OF THE SEVEN PRESSABLES HAD NO ROLE; TWO HAD NO NAME EITHER.
 *   RED: ✕ D4  expect(received).toBe("button")  Received: undefined
 *        ✕ D5  Unable to find an element with testID: place-card-wishlist-node/1
 *              (the control had no testID and no label — it was not addressable
 *              by ANY accessibility-facing property)
 *        ✕ D7  Received: 0 — the sweep found no named, roled pressables at all
 *   `place-card-save-*` (a bookmark) and the trip-wishlist button were bare
 *   `<Pressable>`s wrapping a lucide glyph: an unnamed button with no way to
 *   learn what it does short of pressing it, and one of the two writes to a
 *   trip. Worse for the bookmark — it is a TOGGLE whose only state signal is the
 *   glyph's fill colour, so saved and unsaved announced identically. That is
 *   question 3 as well as question 1. Plan / Route / Directions carry their own
 *   text so they had a NAME, but no role, so none announced as actionable; the
 *   card root, which opens the place, was the same.
 *   FIXED: role everywhere, a label naming the place on the two icon-only
 *   controls, and `accessibilityState.selected` on the two toggles — the shape
 *   the stamp button on the image header already had, which is why the omission
 *   reads as an oversight rather than a decision. The card root deliberately
 *   takes NO label: `accessible` already derives its name from its own text, and
 *   a hand-written label would replace all of it with just the place name.
 *
 * DEFECT B2 — A FAILED DISMISSAL WAS DRAWN AND NEVER ANNOUNCED.
 *   RED: ✕ D2  Unable to find an element with testID: place-card-dismiss-failed
 *              (no alert role, no live region, and nothing addressable)
 *   The card deliberately stays put when the server refuses, and explains why in
 *   one line. Nothing sends a reader to that line: focus is on the button, the
 *   button has not changed, and the only other signal is the icon turning red.
 *   The outcome a sighted user reads as "it failed, tap again" is, for a
 *   screen-reader user, indistinguishable from a tap that did nothing — which is
 *   the "silently stays looks like a missed tap" failure the build lane's own
 *   header set out to forbid, surviving in the one channel it did not check.
 *   FIXED: `accessibilityRole="alert"` + `accessibilityLiveRegion="assertive"`.
 *
 * DEFECT B3 — THE IN-FLIGHT DISMISSAL ANNOUNCED AS IDLE.
 *   RED: ✕ D1  expect(received).toBe(true)  Received: undefined
 *   `disabled={dismissing}` stops the second press and tells nobody. The control
 *   still announced "Not interested in Sirao Flower Garden, button", enabled, so
 *   a reader is invited to press a button that is deliberately inert.
 *   FIXED: `accessibilityState={{ disabled, busy }}`.
 *
 * PROVEN BY MUTATION (already correct — mutate, red, revert):
 *   M1  dismiss label
 *       MUTATION: `Not interested in ${place.name}` → `Not interested`
 *       RED: ✕ D6. the dismiss control names the PLACE it acts on (1 failed)
 *       Reverted. In a list of identical cards "Not interested" names nothing;
 *       the label was already right.
 *   M2  the failure copy
 *       MUTATION: the whole `{dismissFailed ? <Text…> : null}` block removed
 *       RED: ✕ D2. a REFUSED dismissal is ANNOUNCED, not only drawn
 *            ✕ D3. a refused dismissal is a SENTENCE, not a red icon (2 failed)
 *       Reverted; `git diff --stat` confirmed only the V4 additions remain.
 *
 * RNTL v14: render() is async — always await the mount helper.
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react-native';

// The mock set below is lifted from `PlaceCard.notInterested.component.test.tsx`
// deliberately: a different seam would be testing a different card.

// NOTE: intentionally exhaustive — the real discovery module imports Supabase
// native internals that crash under jest-expo, so `jest.requireActual` cannot be
// spread in. Only the live-status function is reached by this card.
jest.mock('../../../services/discovery', () => ({
  getPlaceLiveStatusCached: jest.fn().mockResolvedValue(null),
}));

// NOTE: intentionally exhaustive — collections imports Supabase native modules;
// only these three stubs are reached.
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

// NOTE: intentionally exhaustive — the real controller renders the whole picker
// tree; only isAdded is read by this card.
jest.mock('../../PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: () => false }),
}));

// NOTE: intentionally exhaustive — TripWishlistPicker pulls its own service
// chain and a Modal; stubbing to null prevents a dependency cascade.
jest.mock('../TripWishlistPicker', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — expo-image pulls native modules that crash
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

// NOTE: intentionally exhaustive — the FSQ photo hook performs network lookups.
jest.mock('../../../hooks/useFsqPhoto.ts', () => ({ useFsqPhoto: () => null }));

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
const DISMISS = `place-card-dismiss-${PLACE.id}`;
const SAVE = `place-card-save-${PLACE.id}`;
const WISHLIST = `place-card-wishlist-${PLACE.id}`;

async function mount(props: { onDismissed?: (id: string) => void } = {}) {
  const r = await render(
    <PlaceCard
      place={PLACE}
      onPress={noop}
      onAddToPlan={noop}
      rankSurface="discovery"
      onDismissed={props.onDismissed ?? noop}
    />,
  );
  await waitFor(() => expect(screen.getByTestId(DISMISS)).toBeTruthy());
  return r;
}

beforeEach(() => {
  mockReportDismiss.mockReset();
});

describe('PlaceCard — "Not interested", heard as well as seen', () => {
  it('D1. the control announces BUSY while the dismissal is in flight', async () => {
    // `disabled={dismissing}` already stops the second press. Without the state
    // on the node, a reader still offers the button as pressable and says
    // nothing about the request already running.
    let settle: (v: boolean) => void = () => {};
    mockReportDismiss.mockReturnValue(new Promise<boolean>((r) => { settle = r; }));
    await mount();

    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS));
    });
    const inflight = screen.getByTestId(DISMISS);
    expect(inflight.props.accessibilityState.busy).toBe(true);
    expect(inflight.props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      settle(true);
    });
  });

  it('D2. a REFUSED dismissal is ANNOUNCED, not only drawn', async () => {
    mockReportDismiss.mockResolvedValue(false);
    await mount();
    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS));
    });
    const notice = screen.getByTestId('place-card-dismiss-failed');
    expect(notice.props.accessibilityRole).toBe('alert');
    expect(notice.props.accessibilityLiveRegion).toBe('assertive');
  });

  it('D3. a refused dismissal is a SENTENCE, not a red icon', async () => {
    // Question 3. The icon tints `color.signal` on failure, which is the entire
    // visual difference; a person who cannot see that difference gets the same
    // card back with no explanation unless the words are there.
    mockReportDismiss.mockResolvedValue(false);
    await mount();
    await act(async () => {
      fireEvent.press(screen.getByTestId(DISMISS));
    });
    expect(screen.getByText(/Couldn’t hide this just now/)).toBeTruthy();
    // The card is still here, which is the deliberate choice — and the reason
    // the sentence has to carry the outcome on its own.
    expect(screen.getByTestId(DISMISS)).toBeTruthy();
  });

  it('D6. the dismiss control names the PLACE it acts on', async () => {
    await mount();
    expect(screen.getByTestId(DISMISS).props.accessibilityLabel).toBe(
      `Not interested in ${PLACE.name}`,
    );
    expect(screen.getByTestId(DISMISS).props.accessibilityRole).toBe('button');
  });
});

describe('PlaceCard — the two icon buttons that were never swept', () => {
  it('D4. the bookmark is named, and its TOGGLE state is not the fill colour alone', async () => {
    await mount();
    const save = screen.getByTestId(SAVE);
    expect(save.props.accessibilityRole).toBe('button');
    expect(String(save.props.accessibilityLabel)).toContain(PLACE.name);
    // Unsaved → saved is drawn ONLY as the glyph's fill turning `color.signal`.
    // Without this, both states announce identically.
    expect(save.props.accessibilityState.selected).toBe(false);
    // Copied, not held: an RNTL node's `props` follow the live fiber, so
    // comparing the node after the press would compare it with itself.
    const before = String(save.props.accessibilityLabel);

    await act(async () => {
      fireEvent.press(screen.getByTestId(SAVE));
    });
    await waitFor(() =>
      expect(screen.getByTestId(SAVE).props.accessibilityState.selected).toBe(true),
    );
    expect(String(screen.getByTestId(SAVE).props.accessibilityLabel)).not.toBe(before);
  });

  it('D5. the trip-wishlist button is named — it writes to a trip', async () => {
    await mount();
    const wl = screen.getByTestId(WISHLIST);
    expect(wl.props.accessibilityRole).toBe('button');
    expect(String(wl.props.accessibilityLabel)).toContain(PLACE.name);
  });

  it('D7. every pressable on the card carries a ROLE and a NAME', async () => {
    // The sweep itself, rather than a list of the buttons that happened to be
    // checked above: a control added later must not be able to ship unnamed
    // just because nobody wrote a case for it.
    //
    // Walked over the rendered HOST tree rather than queried by role, ON
    // PURPOSE — `getAllByRole('button')` finds only the controls that already
    // declare a role, so a role-less Pressable would be invisible to exactly
    // the sweep meant to catch it. A Pressable renders a View carrying the
    // responder handlers, which is what identifies one here.
    await mount();
    const pressables = (screen.container as any).queryAll(
      (n: any) =>
        typeof n.props?.onResponderRelease === 'function' && n.props?.accessible !== false,
    );
    expect(pressables.length).toBeGreaterThan(4);

    const textOf = (n: any): string => {
      if (typeof n === 'string') return n;
      const kids = n?.children ?? [];
      return kids.map(textOf).join(' ');
    };

    for (const n of pressables) {
      const id = String(n.props.testID ?? '(no testID)');
      // A NAME is an explicit label OR the control's own visible text. Either
      // gives a reader something to say; neither is the defect.
      const label = typeof n.props.accessibilityLabel === 'string'
        ? n.props.accessibilityLabel.trim()
        : '';
      const named = label.length > 0 || textOf(n).trim().length > 0;
      expect({ id, named }).toEqual({ id, named: true });
      // A ROLE is what makes it announce as actionable at all.
      expect({ id, role: n.props.accessibilityRole }).toEqual({ id, role: 'button' });
    }
  });
});
