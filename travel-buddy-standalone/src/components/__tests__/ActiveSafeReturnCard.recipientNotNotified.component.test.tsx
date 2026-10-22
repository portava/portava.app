/**
 * ActiveSafeReturnCard — "Share Location" tells the traveller when the person
 * they are sharing with was NOT notified.
 *
 * ## The defect
 *
 * POST /me/safe-return/sessions/:id/live-share/start answers
 * `recipientNotified: false` (artifacts/api-server/src/routes/safeReturn.ts)
 * when the share exists but no notice reached the recipient. The card ignored
 * it and said only "Your approximate area is now visible to Ana for 1 hour", so
 * a traveller relying on Ana to watch over them believed Ana had been told. In
 * the multi-contact branch nothing at all was said on success.
 *
 * ## What's covered
 * 1. `recipientNotified: false` → the traveller is told the contact was NOT
 *    notified, in the house copy (liveShareNoticeCopy) the rent-a-buddy screen
 *    already uses — which never discloses a block.
 * 2. `recipientNotified: true` → the confirmation is unchanged (no false alarm).
 *
 * RED on the tree before this change: 1 failed / 1 passed (case 2 is the
 * unchanged path, green on both).
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

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

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
    id: 'sess-1', status: 'active' as const, escalationLevel: 1,
    timerStartAt: new Date(Date.now() - 60_000).toISOString(),
    timerEndAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    trustedCircleEnabled: true, liveShareEnabled: true, notifyHostEnabled: false, notifyTripCrewEnabled: false,
    planItemId: null, tripId: null, triggerReason: null, emergencyNote: null, closedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockGetSessionContacts.mockResolvedValue([
    { id: 'c1', contactUserId: null, contactName: 'Ana', canReceiveLiveLocation: true },
  ]);
});
afterEach(() => {
  alertSpy.mockRestore();
  cleanup();
  jest.clearAllMocks();
});

async function tapShare() {
  await act(async () => { render(<ActiveSafeReturnCard session={activeSession() as never} />); });
  await waitFor(() => expect(screen.getByText('Share Location')).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByText('Share Location')); });
}

describe('ActiveSafeReturnCard — was the recipient told?', () => {
  it('says the contact was NOT notified when the server says so', async () => {
    mockStartLiveShare.mockResolvedValue({ ok: true, share: { id: 'sh1', expiresAt: null }, recipientNotified: false, recipientNoticeReason: 'notice_failed' });
    await tapShare();
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [title, body] = alertSpy.mock.calls[0] as [string, string];
    // The house copy (src/lib/liveShareRecipient.ts liveShareNoticeCopy), shared with the rent-a-buddy screen.
    expect(title).toBe('Contact not notified');
    expect(body).toBe("Sharing started, but Ana wasn't notified in the app. Let them know another way.");
  });

  it('adds nothing when the contact WAS notified', async () => {
    mockStartLiveShare.mockResolvedValue({ ok: true, share: { id: 'sh1', expiresAt: null }, recipientNotified: true });
    await tapShare();
    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [, body] = alertSpy.mock.calls[0] as [string, string];
    expect(body).toBe('Your approximate area is now visible to Ana for 1 hour.');
  });
});
