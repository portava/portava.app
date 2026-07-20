/**
 * AgeGate component tests
 *
 * Run with: pnpm test:component
 *
 * ## What's covered
 *
 * 1. When ageGateRequired is true the blocking gate screen is rendered.
 * 2. When ageGateRequired is false children are rendered.
 * 3. When the user is not authenticated, children are rendered without a gate.
 * 4. When getMyProfile fails (network/API error) the gate fails CLOSED — children
 *    are NOT rendered, the retry screen is shown instead.
 *
 * ## Mock strategy
 *
 * - SessionContext is stubbed to control isAuthed / userId.
 * - getMyProfile is stubbed to return a controlled profile fixture.
 * - updateMyProfile is stubbed for the save path.
 * - DatePickerField, SafeAreaView, Alert, and native modules are stubbed to
 *   avoid native bridge dependencies under Jest.
 */

import React from 'react';
import { render, waitFor, screen } from '@testing-library/react-native';
import { AgeGate } from '../../src/components/AgeGate';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// NOTE: intentionally exhaustive — SessionContext pulls in Supabase, AppState,
// and several async service calls at module load; a partial mock would crash.
jest.mock('../../src/context/SessionContext', () => ({
  useSession: jest.fn(),
}));

// NOTE: intentionally exhaustive — profile service imports the Supabase client
// and makes real HTTP calls; we only need the two functions AgeGate calls.
jest.mock('../../src/services/profile', () => ({
  getMyProfile:    jest.fn(),
  updateMyProfile: jest.fn(),
}));

// DatePickerField uses @react-native-community/datetimepicker — stub it.
jest.mock('../../src/components/DatePickerField', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    DatePickerField: ({ value }: { value: string }) =>
      React.createElement(View, { testID: 'date-picker-field', accessibilityLabel: value }),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ...jest.requireActual('react-native-safe-area-context'),
    SafeAreaView: ({ children, style }: any) =>
      React.createElement(View, { style }, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

import { useSession } from '../../src/context/SessionContext';
import { getMyProfile } from '../../src/services/profile';

const mockUseSession = useSession as jest.Mock;
const mockGetMyProfile = getMyProfile as jest.Mock;

function authedSession() {
  mockUseSession.mockReturnValue({
    userId:  'user-abc',
    isAuthed: true,
    loading:  false,
    signOut:  jest.fn(),
  });
}

function unauthSession() {
  mockUseSession.mockReturnValue({
    userId:  null,
    isAuthed: false,
    loading:  false,
    signOut:  jest.fn(),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe("AgeGate — blocks when ageGateRequired is true", () => {
  it("renders the age-gate screen when ageGateRequired is true", async () => {
    authedSession();
    mockGetMyProfile.mockResolvedValue({
      ok:   true,
      data: { ageGateRequired: true },
    });

    await render(
      <AgeGate>
        <></>
      </AgeGate>
    );

    await waitFor(() => {
      expect(screen.getByText('Age verification required')).toBeTruthy();
    });
  });

  it("renders the gate when ageGateRequired is missing (undefined) — fail closed", async () => {
    authedSession();
    mockGetMyProfile.mockResolvedValue({
      ok:   true,
      data: {},
    });

    await render(
      <AgeGate>
        <></>
      </AgeGate>
    );

    // Only explicit `false` clears the gate; a missing field (undefined) is treated
    // as requiring the gate (fail-closed) to guard against old-schema responses.
    await waitFor(() => {
      expect(screen.getByText('Age verification required')).toBeTruthy();
    });
  });
});

describe("AgeGate — passes through when ageGateRequired is false", () => {
  it("renders children when ageGateRequired is false", async () => {
    authedSession();
    mockGetMyProfile.mockResolvedValue({
      ok:   true,
      data: { ageGateRequired: false },
    });

    await render(
      <AgeGate>
        <>
          {(() => { const { Text } = require('react-native'); return <Text testID="child-content">Inside the app</Text>; })()}
        </>
      </AgeGate>
    );

    await waitFor(() => {
      expect(screen.getByTestId('child-content')).toBeTruthy();
    });
    expect(screen.queryByText('Age verification required')).toBeNull();
  });
});

describe("AgeGate — unauthenticated user passes through", () => {
  it("renders children without checking profile when not authed", async () => {
    unauthSession();

    await render(
      <AgeGate>
        <>
          {(() => { const { Text } = require('react-native'); return <Text testID="unauthed-child">Not signed in</Text>; })()}
        </>
      </AgeGate>
    );

    await waitFor(() => {
      expect(screen.getByTestId('unauthed-child')).toBeTruthy();
    });
    expect(mockGetMyProfile).not.toHaveBeenCalled();
  });
});

describe("AgeGate — fails CLOSED when profile fetch errors", () => {
  it("shows the retry screen (not children) when getMyProfile returns ok:false", async () => {
    authedSession();
    mockGetMyProfile.mockResolvedValue({ ok: false });

    await render(
      <AgeGate>
        <>
          {(() => { const { Text } = require('react-native'); return <Text testID="protected-child">Secret content</Text>; })()}
        </>
      </AgeGate>
    );

    await waitFor(() => {
      expect(screen.getByText('Verification check failed')).toBeTruthy();
    });
    expect(screen.queryByTestId('protected-child')).toBeNull();
    expect(screen.queryByText('Age verification required')).toBeNull();
  });

  it("shows the retry screen (not children) when getMyProfile rejects", async () => {
    authedSession();
    mockGetMyProfile.mockRejectedValue(new Error('Network error'));

    await render(
      <AgeGate>
        <>
          {(() => { const { Text } = require('react-native'); return <Text testID="protected-child-2">Secret content</Text>; })()}
        </>
      </AgeGate>
    );

    await waitFor(() => {
      expect(screen.getByText('Verification check failed')).toBeTruthy();
    });
    expect(screen.queryByTestId('protected-child-2')).toBeNull();
  });
});
