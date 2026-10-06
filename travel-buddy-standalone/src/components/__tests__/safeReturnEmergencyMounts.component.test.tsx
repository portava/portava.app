/**
 * The two Safe Return surfaces that open EmergencyHelpSheet — what they hand it.
 *
 * Every mount used to pass only `visible`/`onClose`, so the sheet dialled 112
 * everywhere and its Trusted Circle / location / host / crew options did
 * nothing. MissedCheckinPrompt also rendered "Alert my Trusted Circle" and
 * "Share my approximate location" with no handler from either parent — a
 * press dismissed the prompt and alerted no one.
 *
 * Pinned here:
 * - both surfaces hand the sheet the session's trip, so the numbers are the
 *   trip's countries' numbers;
 * - ActiveSafeReturnCard hands it the share and message handlers it already
 *   has, so those options render and work;
 * - MissedCheckinPrompt shows an action only when its parent gave a handler.
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports so the
// nested modals render synchronously in the test renderer.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const R = require('react');
  const MockModal = ({ children, visible }: { children: React.ReactNode; visible: boolean }) =>
    (visible ? R.createElement(actual.View, null, children) : null);
  return new Proxy(actual, {
    get(target: typeof actual, prop: string, receiver: unknown) {
      if (prop === 'Modal') return MockModal;
      return Reflect.get(target, prop, receiver);
    },
  });
});

import React from 'react';
import { Alert, Linking } from 'react-native';
import { render, act, waitFor, fireEvent, cleanup, screen } from '@testing-library/react-native';
import { ActiveSafeReturnCard } from '../safeReturn/ActiveSafeReturnCard.tsx';
import { MissedCheckinPrompt } from '../safeReturn/MissedCheckinPrompt.tsx';
import { getTripEssentials } from '../../services/countryEssentials.ts';
import { getSessionContacts } from '../../services/safeReturn.ts';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

jest.mock('../../services/safeReturn', () => ({
  ...jest.requireActual('../../services/safeReturn'),
  getSessionContacts: jest.fn(),
  startLiveShare: jest.fn(),
  confirmSafe: jest.fn(),
  cancelSession: jest.fn(),
  extendTimer: jest.fn(),
}));

jest.mock('../../services/countryEssentials', () => ({
  ...jest.requireActual('../../services/countryEssentials'),
  getCountryEssentials: jest.fn(),
  getTripEssentials: jest.fn(),
}));

const mockTrip = getTripEssentials as jest.Mock;
const mockContacts = getSessionContacts as jest.Mock;

function session(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1', status: 'active' as const, escalationLevel: 1,
    timerStartAt: new Date(Date.now() - 60_000).toISOString(),
    timerEndAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    trustedCircleEnabled: true, liveShareEnabled: true, notifyHostEnabled: false, notifyTripCrewEnabled: false,
    planItemId: null, tripId: 'trip-jp', triggerReason: null, emergencyNote: null, closedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
  };
}
const JP = [{
  country: 'JP',
  essentials: {
    code: 'JP', plugTypes: [], voltage: null, frequency: null, driveSide: null,
    emergency: { police: '110', ambulance: '119', fire: '119' },
    confidence: 'curated', source: 'test', lastVerifiedAt: '2026-07-24',
    disclaimer: 'Confirm emergency numbers locally on arrival — they vary by region and can change.',
  },
}];

let alertSpy: jest.SpyInstance;
let openSpy: jest.SpyInstance;
beforeEach(() => {
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  mockTrip.mockResolvedValue(JP);
});
afterEach(() => {
  alertSpy.mockRestore();
  openSpy.mockRestore();
  cleanup();
  jest.clearAllMocks();
});

async function press(node: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => { await fireEvent.press(node); });
}

describe('ActiveSafeReturnCard → EmergencyHelpSheet', () => {
  it("hands the sheet the session's trip: Japan's numbers, not 112", async () => {
    await act(async () => { render(<ActiveSafeReturnCard session={session() as never} />); });
    await press(screen.getByTestId('safe-return-emergency'));
    await waitFor(() => expect(screen.getByText('Call 110 — police')).toBeTruthy());
    expect(mockTrip).toHaveBeenCalledWith('trip-jp');
    await press(screen.getByText('Call 119 — ambulance, fire'));
    expect(openSpy.mock.calls.map((c) => String(c[0]))).toEqual(['tel:119']);
  });

  it('hands it the share and message handlers it already has; host and crew stay hidden', async () => {
    mockContacts.mockResolvedValue(null);
    await act(async () => { render(<ActiveSafeReturnCard session={session() as never} />); });
    await press(screen.getByTestId('safe-return-emergency'));
    await waitFor(() => expect(screen.getByText('Share your location')).toBeTruthy());
    expect(screen.queryByText('Contact trip host')).toBeNull();
    expect(screen.queryByText('Contact trip crew')).toBeNull();
    await press(screen.getByText('Share your location'));
    await waitFor(() => expect(mockContacts).toHaveBeenCalledWith('sess-1'));
    await press(screen.getByText('Message Trusted Circle'));
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/messages');
  });
});

describe('MissedCheckinPrompt', () => {
  it('with no handlers from the parent: no Trusted Circle alert and no location button', async () => {
    await act(async () => {
      render(<MissedCheckinPrompt visible session={session({ status: 'missed', escalationLevel: 3 }) as never} onDismiss={() => {}} />);
    });
    expect(screen.queryByText('Alert my Trusted Circle')).toBeNull();
    expect(screen.queryByText('Share my approximate location')).toBeNull();
    await press(screen.getByText('Emergency Help'));
    await waitFor(() => expect(screen.getByText('Call 110 — police')).toBeTruthy());
    expect(mockTrip).toHaveBeenCalledWith('trip-jp');
    expect(screen.queryByText('Share your location')).toBeNull();
  });

  it('with handlers: both buttons render and call them, and the sheet offers the location share', async () => {
    const onAlertContacts = jest.fn(), onShareLocation = jest.fn(), onDismiss = jest.fn();
    await act(async () => {
      render(<MissedCheckinPrompt visible session={session({ status: 'missed', escalationLevel: 3 }) as never} onDismiss={onDismiss} onAlertContacts={onAlertContacts} onShareLocation={onShareLocation} />);
    });
    await press(screen.getByText('Alert my Trusted Circle'));
    await press(screen.getByText('Share my approximate location'));
    expect(onAlertContacts).toHaveBeenCalledTimes(1);
    expect(onShareLocation).toHaveBeenCalledTimes(1);
    await press(screen.getByText('Emergency Help'));
    await waitFor(() => expect(screen.getByText('Share your location')).toBeTruthy());
    await press(screen.getByText('Share your location'));
    expect(onShareLocation).toHaveBeenCalledTimes(2);
  });
});
