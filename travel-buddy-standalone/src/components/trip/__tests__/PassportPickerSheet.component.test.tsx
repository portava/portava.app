/**
 * PassportPickerSheet — RNTL component tests (embedded in TripEntrySection).
 *
 * Run with:
 *   npx jest --forceExit --testPathPattern=PassportPickerSheet.component
 *
 * ## Coverage
 * 1. Non-empty list — renders each passport's label/country in the sheet.
 * 2. "Add passport" press — calls closeThenNavigate with the correct route.
 * 3. Empty list — only "Add passport" shown, no crash on empty passport list.
 *
 * ## What we actually test
 * PassportPickerSheet is a private component inside TripEntrySection.tsx.
 * We render it via its public surface: TripEntrySection with a mock payload
 * that puts the current user into the no-passport state (passportSelected=false,
 * self=true), which causes the section to open PassportPickerSheet.
 *
 * The test explicitly presses "Choose passport" to open the sheet, then
 * asserts passport rows / "Add passport" inside the sheet.
 *
 * ## Mock strategy
 * - Modal replaced by a synchronous View proxy (no animation lifecycle).
 * - closeThenNavigate replaced by a jest.fn() capturing the nav target.
 * - listMyPassports replaced by a jest.fn() returning controlled fixtures.
 * - fetchTripEntryRequirements replaced to return a minimal payload.
 * - setTripPassport stubbed to avoid real network calls.
 *
 * NOTE comments on exhaustive mocks explain why requireActual is not used.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

// ── Module mocks (hoisted by babel-jest before imports) ───────────────────────

// NOTE: intentional stub — Modal's native animation lifecycle corrupts
// actScopeDepth under jest-expo; Proxy replaces only 'Modal' and
// 'ActivityIndicator', all other RN exports fall through untouched.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react') as typeof import('react');
        // Render children synchronously when visible; unmount when not visible.
        return ({
          children,
          visible,
        }: {
          children: R.ReactNode;
          visible?: boolean;
        }) =>
          visible
            ? R.createElement(target.View as React.ComponentType, null, children)
            : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

// NOTE: intentional stub — expo-router requires native modules not available
// under jest-expo; spreading requireActual pulls those modules and crashes.
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: {
      push:     jest.fn(),
      back:     jest.fn(),
      replace:  jest.fn(),
      navigate: jest.fn(),
    },
    useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: jest.fn(() => ({})),
    usePathname:          () => '/',
    useSegments:          () => [],
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    useNavigation: () => ({
      navigate:    jest.fn(),
      goBack:      jest.fn(),
      setOptions:  jest.fn(),
      addListener: (_e: unknown, _cb: unknown) => () => {},
    }),
    Link:     ({ children }: { children: React.ReactNode }) => children as any,
    Redirect: () => null,
    Stack:    { Screen: () => null },
    Tabs:     { Screen: () => null },
  };
});

// NOTE: intentional stub — closeThenNavigate imports expo-router directly;
// replacing the whole module lets us capture navigation calls synchronously
// and without the 320ms setTimeout delay.
const mockCloseThenNavigate = jest.fn();
jest.mock('../../../lib/deferredNavigate', () => ({
  closeThenNavigate: (...args: unknown[]) => mockCloseThenNavigate(...args),
}));

// NOTE: intentional stub — entryRequirements reaches the network (Supabase +
// custom API).  Mocking the whole module keeps tests offline.
jest.mock('../../../services/entryRequirements', () => ({
  fetchTripEntryRequirements: jest.fn(),
  listMyPassports:            jest.fn(),
  setTripPassport:            jest.fn(),
  addPassport:                jest.fn(),
  updatePassport:             jest.fn(),
  deletePassport:             jest.fn(),
}));

// ── Typed mock refs ───────────────────────────────────────────────────────────

import {
  fetchTripEntryRequirements,
  listMyPassports,
  setTripPassport,
} from '../../../services/entryRequirements.ts';

const mockFetchEntry   = fetchTripEntryRequirements as jest.Mock;
const mockListPassports = listMyPassports            as jest.Mock;
const mockSetPassport  = setTripPassport             as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

// The component under test
import { TripEntrySection } from '../../trip/TripEntrySection.tsx';

/** Minimal entry payload that puts the self-traveler into no-passport state. */
const noPassportPayload = {
  destinationCountry: 'JP',
  disclaimer: '',
  travelers: [
    {
      userId: 'user-1',
      self: true,
      passportSelected: false,
      status: 'UNKNOWN',
      requirement: null,
    },
  ],
};

const US_PASSPORT = {
  id: 'pp-us',
  issuingCountry: 'US',
  label: 'Main',
  expiryDate: '2030-06-15',
  isPrimary: true,
};

const PH_PASSPORT = {
  id: 'pp-ph',
  issuingCountry: 'PH',
  label: '',
  expiryDate: null,
  isPrimary: false,
};

// ── Helper ────────────────────────────────────────────────────────────────────

/** Render TripEntrySection and wait for the section to appear. */
async function mountSection() {
  const utils = render(<TripEntrySection tripId="trip-1" />);
  // Wait for the async load to settle and the "Choose passport" button to appear.
  await waitFor(() => expect(screen.getByText('Choose passport')).toBeTruthy());
  return utils;
}

/** Open the passport picker sheet by pressing "Choose passport". */
async function openSheet() {
  await act(async () => {
    fireEvent.press(screen.getByText('Choose passport'));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PassportPickerSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default entry payload — self user has no passport selected.
    mockFetchEntry.mockResolvedValue(noPassportPayload);
    mockSetPassport.mockResolvedValue(undefined);
  });

  // ── 1. Non-empty list ───────────────────────────────────────────────────────

  it('lists each passport in the sheet when passports exist', async () => {
    mockListPassports.mockResolvedValue([US_PASSPORT, PH_PASSPORT]);

    await mountSection();
    await openSheet();

    // The sheet title
    await waitFor(() => expect(screen.getByText('Choose a passport')).toBeTruthy());

    // US passport — has a label so the row shows the label
    expect(screen.getByText('Main')).toBeTruthy();
    // Issuing country always shown in the sub-line
    expect(screen.getAllByText('US').length).toBeGreaterThanOrEqual(1);

    // PH passport — no label, so the row label shows the issuingCountry (appears at
    // least twice: once as rowLabel and once as rowSub, since label === issuingCountry).
    expect(screen.getAllByText('PH').length).toBeGreaterThanOrEqual(1);

    // Primary badge on US passport
    expect(screen.getByText('Primary')).toBeTruthy();
  });

  // ── 2. "Add passport" navigates correctly ──────────────────────────────────

  it('pressing "Add passport" calls closeThenNavigate with the passports route', async () => {
    mockListPassports.mockResolvedValue([US_PASSPORT]);

    await mountSection();
    await openSheet();

    await waitFor(() => expect(screen.getByText('Add passport')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByText('Add passport'));
    });

    // closeThenNavigate must have been called; first arg is the close callback,
    // second is the navigation path.
    expect(mockCloseThenNavigate).toHaveBeenCalledTimes(1);
    const [_closeFn, navPath] = mockCloseThenNavigate.mock.calls[0] as [unknown, string];
    expect(navPath).toBe('/profile/edit/passports');
  });

  // ── 3. Empty list — no crash, only "Add passport" shown ───────────────────

  it('renders only "Add passport" when the passport list is empty, without crashing', async () => {
    mockListPassports.mockResolvedValue([]);

    await mountSection();
    await openSheet();

    // Empty-state text
    await waitFor(() => expect(screen.getByText('No passports on file yet.')).toBeTruthy());

    // "Add passport" row is still present
    expect(screen.getByText('Add passport')).toBeTruthy();

    // No passport rows rendered (no 'Primary' badge)
    expect(screen.queryByText('Primary')).toBeNull();
  });
});
