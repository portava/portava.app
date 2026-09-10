/**
 * ActiveSafeReturnCard — "Share Location" when the contact list is unreadable.
 *
 * ## The defect
 *
 * `getSessionContacts` resolved `data?.contacts ?? []` on every path, so a
 * failed read looked exactly like "this session has no contacts". Tapping
 * "Share Location" during a running Safe Return timer then produced:
 *
 *     No contacts — No contacts in this session have location sharing enabled.
 *
 * telling someone inside a personal-safety flow that their alert list is empty
 * when it may be full.
 *
 * ## What's covered
 *
 * 1. Unreadable (`null`) → the card says it could not load the contacts, and
 *    NOT that there are none.
 * 2. A genuinely empty list → the original "No contacts" message is unchanged.
 * 3. A real contact → the share still starts, so the fix cannot break the
 *    working path.
 *
 * Run with: pnpm test:component
 */

// NOTE: Modal Proxy — must be hoisted above all react-native imports so the
// card's nested modals render synchronously instead of overlapping act scopes.
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
import { Alert } from 'react-native';
import { render, act, waitFor, fireEvent, cleanup, screen } from '@testing-library/react-native';
import { ActiveSafeReturnCard } from '../safeReturn/ActiveSafeReturnCard.tsx';
import { getSessionContacts, startLiveShare } from '../../services/safeReturn.ts';

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

// ── safe-return service ───────────────────────────────────────────────────────

jest.mock('../../services/safeReturn', () => ({
  ...jest.requireActual('../../services/safeReturn'),
  getSessionContacts: jest.fn(),
  startLiveShare: jest.fn(),
  confirmSafe: jest.fn(),
  cancelSession: jest.fn(),
  extendTimer: jest.fn(),
  stopLiveShare: jest.fn(),
}));

const mockGetSessionContacts = getSessionContacts as jest.Mock;
const mockStartLiveShare = startLiveShare as jest.Mock;

function activeSession() {
  return {
    id: 'sess-1',
    status: 'active' as const,
    escalationLevel: 1,
    timerStartAt: new Date(Date.now() - 60_000).toISOString(),
    timerEndAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    trustedCircleEnabled: true,
    liveShareEnabled: true,
    notifyHostEnabled: false,
    notifyTripCrewEnabled: false,
    planItemId: null,
    tripId: null,
    triggerReason: null,
    emergencyNote: null,
    closedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  alertSpy.mockRestore();
  cleanup();
  jest.clearAllMocks();
});

async function tapShare() {
  await act(async () => {
    render(<ActiveSafeReturnCard session={activeSession() as never} />);
  });
  await waitFor(() => expect(screen.getByText('Share Location')).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByText('Share Location'));
  });
}

describe('ActiveSafeReturnCard — unreadable session contacts', () => {
  it('says the contacts could not be loaded, not that there are none', async () => {
    mockGetSessionContacts.mockResolvedValue(null);

    await tapShare();

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [title, body] = alertSpy.mock.calls[0] as [string, string];
    expect(title).toBe('Error');
    expect(body).toBe("Could not load this session's contacts. Please try again.");
    expect(body).not.toMatch(/No contacts/);
    expect(mockStartLiveShare).not.toHaveBeenCalled();
  });

  it('keeps the original message when the session genuinely has no eligible contacts', async () => {
    mockGetSessionContacts.mockResolvedValue([
      { id: 'c1', contactUserId: 'u1', contactName: 'Ana', canReceiveLiveLocation: false },
    ]);

    await tapShare();

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [title, body] = alertSpy.mock.calls[0] as [string, string];
    expect(title).toBe('No contacts');
    expect(body).toBe('No contacts in this session have location sharing enabled.');
  });

  it('still starts the share when there is exactly one eligible contact', async () => {
    mockGetSessionContacts.mockResolvedValue([
      { id: 'c1', contactUserId: 'u1', contactName: 'Ana', canReceiveLiveLocation: true },
    ]);
    mockStartLiveShare.mockResolvedValue({ ok: true });

    await tapShare();

    await waitFor(() =>
      expect(mockStartLiveShare).toHaveBeenCalledWith('sess-1', { recipientContactId: 'c1' }),
    );
  });
});
