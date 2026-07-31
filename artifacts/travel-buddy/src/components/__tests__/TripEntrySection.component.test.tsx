/**
 * TripEntrySection — component tests
 *
 * Covers:
 *  1. null return when fetchTripEntryRequirements returns null (flag off)
 *  2. no-passport prompt when the self traveler has passportSelected = false
 *  3. caller's own status card (VISA-FREE + allowed stay + disclaimer)
 *  4. other-traveler compact rows
 *  5. UNKNOWN corridor shows unknownReason copy
 *
 * Run with: pnpm test:component
 *
 * Modal note: PassportPickerSheet uses <Modal> from react-native. We mock it
 * via a Proxy that intercepts Modal (and ActivityIndicator) while passing
 * everything else through Reflect.get, per the project Modal mock pattern
 * (see .agents/memory/modal-proxy-mock.md).
 */

import React from 'react';
import { render, act, fireEvent, waitFor } from '@testing-library/react-native';
import { TripEntrySection } from '../trip/TripEntrySection.tsx';

// ── react-native Modal proxy ──────────────────────────────────────────────────
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? R.createElement(actual.View, null, children) : null;
  const MockActivityIndicator = () => null;
  return new Proxy(actual, {
    get(target: typeof actual, prop: string | symbol, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      if (prop === 'ActivityIndicator') return MockActivityIndicator;
      return Reflect.get(target, prop, receiver);
    },
  });
});

// ── expo-router mock ──────────────────────────────────────────────────────────
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: { push: jest.fn(), back: jest.fn() },
    useFocusEffect: jest.fn((cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
      }, []);
    }),
  };
});

// ── entryRequirements service mock ────────────────────────────────────────────
jest.mock('../../services/entryRequirements.ts', () => ({
  ...jest.requireActual('../../services/entryRequirements.ts'),
  fetchTripEntryRequirements: jest.fn(),
  listMyPassports: jest.fn(),
  setTripPassport: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TRIP_ID = 'trip-entry-test';

const SELF_VISA_FREE: import('../../services/entryRequirements.ts').TripEntryTraveler = {
  userId: 'user-self',
  self: true,
  passportSelected: true,
  passportCountry: 'US',
  status: 'VISA-FREE',
  requirement: { allowedStayDays: 90, sourceUrl: 'https://example.gov/entry' },
  lastVerifiedAt: '2026-01-15T00:00:00Z',
  unknownReason: null,
};

const SELF_NO_PASSPORT: import('../../services/entryRequirements.ts').TripEntryTraveler = {
  userId: 'user-self',
  self: true,
  passportSelected: false,
  status: 'UNKNOWN',
  requirement: null,
  lastVerifiedAt: null,
  unknownReason: null,
};

const SELF_UNKNOWN: import('../../services/entryRequirements.ts').TripEntryTraveler = {
  userId: 'user-self',
  self: true,
  passportSelected: true,
  status: 'UNKNOWN',
  requirement: null,
  lastVerifiedAt: null,
  unknownReason: 'Entry conditions for this corridor are not yet available.',
};

const OTHER_TRAVELER: import('../../services/entryRequirements.ts').TripEntryTraveler = {
  userId: 'user-other-1',
  self: false,
  passportSelected: true,
  status: 'VISA REQUIRED',
  requirement: null,
  lastVerifiedAt: null,
  unknownReason: null,
};

const OTHER_NO_PASSPORT: import('../../services/entryRequirements.ts').TripEntryTraveler = {
  userId: 'user-other-2',
  self: false,
  passportSelected: false,
  status: 'UNKNOWN',
  requirement: null,
  lastVerifiedAt: null,
  unknownReason: null,
};

const DISCLAIMER = 'Entry requirements can change. Always verify with official sources before travel.';

// ── Helper ────────────────────────────────────────────────────────────────────

async function mountSection() {
  return render(<TripEntrySection tripId={TRIP_ID} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripEntrySection', () => {
  let fetchTripEntryRequirements: jest.Mock;
  let listMyPassports: jest.Mock;
  let setTripPassport: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    const svc = require('../../services/entryRequirements.ts');
    fetchTripEntryRequirements = svc.fetchTripEntryRequirements;
    listMyPassports = svc.listMyPassports;
    setTripPassport = svc.setTripPassport;
    listMyPassports.mockResolvedValue([]);
    setTripPassport.mockResolvedValue(true);
  });

  // ── 1. Null response (flag off) ───────────────────────────────────────────

  it('renders nothing when fetchTripEntryRequirements returns null', async () => {
    fetchTripEntryRequirements.mockResolvedValue(null);
    const { queryByText } = await mountSection();
    await act(async () => {});
    expect(queryByText(/Entry & visas/i)).toBeNull();
    expect(queryByText(/Entry &amp; visas/i)).toBeNull();
  });

  // ── 2. No-passport prompt ─────────────────────────────────────────────────

  it('shows passport prompt when self traveler has no passport selected', async () => {
    fetchTripEntryRequirements.mockResolvedValue({
      destinationCountry: 'JP',
      disclaimer: DISCLAIMER,
      travelers: [SELF_NO_PASSPORT],
    });
    const { findByText } = await mountSection();
    await findByText(/Which passport will you be traveling with\?/);
    await findByText(/Choose passport/);
  });

  // ── 2b. Passport picker sheet — lists passports & Add passport navigation ──

  it('lists fetched passports in the picker without crashing', async () => {
    fetchTripEntryRequirements.mockResolvedValue({
      destinationCountry: 'JP',
      disclaimer: DISCLAIMER,
      travelers: [SELF_NO_PASSPORT],
    });
    listMyPassports.mockResolvedValue([
      { id: 'pp-1', label: 'US Passport', issuingCountry: 'US', isPrimary: true },
      { id: 'pp-2', label: 'UK Passport', issuingCountry: 'GB', isPrimary: false },
    ]);
    const { findByText, getByText } = await mountSection();
    await findByText(/Choose passport/);
    fireEvent.press(getByText(/Choose passport/));
    await findByText('US Passport');
    await findByText('UK Passport');
  });

  it('shows the empty-state copy when the picker has no passports on file', async () => {
    fetchTripEntryRequirements.mockResolvedValue({
      destinationCountry: 'JP',
      disclaimer: DISCLAIMER,
      travelers: [SELF_NO_PASSPORT],
    });
    listMyPassports.mockResolvedValue([]);
    const { findByText, getByText } = await mountSection();
    await findByText(/Choose passport/);
    fireEvent.press(getByText(/Choose passport/));
    await findByText(/No passports on file yet\./);
  });

  it('does not crash and clears loading when listMyPassports rejects', async () => {
    fetchTripEntryRequirements.mockResolvedValue({
      destinationCountry: 'JP',
      disclaimer: DISCLAIMER,
      travelers: [SELF_NO_PASSPORT],
    });
    listMyPassports.mockRejectedValue(new Error('network error'));
    const { findByText, getByText } = await mountSection();
    await findByText(/Choose passport/);
    fireEvent.press(getByText(/Choose passport/));

    // The sheet must remain open and stable (no crash) even though the fetch
    // rejected; it settles on the empty passports list rather than hanging
    // in a permanent loading state.
    await findByText(/No passports on file yet\./);
  });

  it('navigates to /profile/edit/passports when Add passport is pressed, without crashing', async () => {
    fetchTripEntryRequirements.mockResolvedValue({
      destinationCountry: 'JP',
      disclaimer: DISCLAIMER,
      travelers: [SELF_NO_PASSPORT],
    });
    listMyPassports.mockResolvedValue([]);
    const { findByText, getByText } = await mountSection();
    await findByText(/Choose passport/);
    fireEvent.press(getByText(/Choose passport/));
    await findByText(/Add passport/);
    const { router } = require('expo-router');
    fireEvent.press(getByText(/Add passport/));
    expect(router.push).toHaveBeenCalledWith('/profile/edit/passports');
  });

  // ── 3. Caller's own status card ───────────────────────────────────────────

  it("shows the caller's status chip, allowed stay, source link, and disclaimer", async () => {
    fetchTripEntryRequirements.mockResolvedValue({
      destinationCountry: 'JP',
      disclaimer: DISCLAIMER,
      travelers: [SELF_VISA_FREE],
    });
    const { findByText, queryByText } = await mountSection();

    // Status chip
    await findByText('VISA-FREE');

    // Allowed stay
    await findByText(/90 days/);

    // Official source link
    await findByText(/Official source/);

    // Last verified date
    await findByText(/Last verified/);

    // Disclaimer verbatim
    await findByText(DISCLAIMER);

    // No prompt card
    expect(queryByText(/Which passport will you be traveling with\?/)).toBeNull();
  });

  // ── 4. Other-traveler compact rows ────────────────────────────────────────

  it('shows compact rows for other travelers with status chip and passport label', async () => {
    fetchTripEntryRequirements.mockResolvedValue({
      destinationCountry: 'JP',
      disclaimer: DISCLAIMER,
      travelers: [SELF_VISA_FREE, OTHER_TRAVELER, OTHER_NO_PASSPORT],
    });
    const { findByText, getAllByText } = await mountSection();

    // "Other travelers" sub-label
    await findByText(/Other travelers/);

    // VISA REQUIRED chip for OTHER_TRAVELER
    await findByText('VISA REQUIRED');

    // Passport-selected labels
    await waitFor(() => {
      const selected = getAllByText('Passport selected');
      expect(selected.length).toBeGreaterThanOrEqual(1);
    });

    // No-passport label for OTHER_NO_PASSPORT
    await findByText('No passport selected');
  });

  // ── 5. Unknown corridor ───────────────────────────────────────────────────

  it('shows the unknownReason copy for an unknown corridor', async () => {
    fetchTripEntryRequirements.mockResolvedValue({
      destinationCountry: 'XX',
      disclaimer: DISCLAIMER,
      travelers: [SELF_UNKNOWN],
    });
    const { findByText } = await mountSection();

    // UNKNOWN chip
    await findByText('UNKNOWN');

    // unknownReason text
    await findByText(SELF_UNKNOWN.unknownReason!);
  });
});
