/**
 * Component tests for the temporary event Passport surfaces (spec §25/§31,
 * Phase 8).
 *
 * The behaviours pinned here are the ones a future edit could quietly break:
 *
 *   1. The owner's card renders NOTHING when the capability is off, when the
 *      server refuses to mint, or before the first read has answered — there is
 *      never an affordance that cannot work.
 *   2. Every viewer-side refusal renders the SAME neutral copy, so the screen
 *      cannot be used to tell an expired share from a revoked one from "you are
 *      not at this event".
 *   3. The resolved passport renders only what the server sent: first name (not
 *      a family name), the broad at-event city, and only the Follow/Connect
 *      actions the server flagged.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react-native';
import { EventPassportShareCard } from '../EventPassportShareCard.tsx';
import EventPassportScreen, { type ScreenState } from '../EventPassportScreen.tsx';
import {
  getMyEventPassportShare,
  createEventPassportShare,
  revokeEventPassportShare,
} from '../eventPassport.ts';

// NOTE: intentionally exhaustive — expo-router needs Expo native navigation
// modules unavailable in jest-expo; stub the members these screens use.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
}));

// NOTE: react-native-safe-area-context needs a provider that isn't mounted in
// these unit renders — return fixed insets so the screen lays out.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — the network module reaches Supabase + fetch; the
// server's own suite covers the rules. Here it is a seam so each server answer
// can be replayed. The pure helpers are NOT stubbed: the card's staleness read
// must run for real.
jest.mock('../eventPassport', () => {
  const actual = jest.requireActual('../eventPassportShareUtils.ts');
  return {
    ...actual,
    getMyEventPassportShare: jest.fn(),
    createEventPassportShare: jest.fn(),
    revokeEventPassportShare: jest.fn(),
    resolveEventPassport: jest.fn(),
  };
});

const mockGetMine = getMyEventPassportShare as unknown as jest.Mock;
const mockCreate = createEventPassportShare as unknown as jest.Mock;
const mockRevoke = revokeEventPassportShare as unknown as jest.Mock;

const EVENT = 'eeeeeeee-0000-0000-0000-000000000001';
const IN_TWO_HOURS = () => new Date(Date.now() + 2 * 3_600_000).toISOString();

function liveShare() {
  return { token: 'a'.repeat(48), eventId: EVENT, expiresAt: IN_TWO_HOURS() };
}

describe('EventPassportShareCard (owner side)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing while the capability is OFF', async () => {
    mockGetMine.mockResolvedValue({ ok: true, enabled: false, data: null });
    await render(<EventPassportShareCard eventId={EVENT} />);
    await waitFor(() => expect(mockGetMine).toHaveBeenCalled());
    expect(screen.queryByTestId('event-passport-share-card')).toBeNull();
  });

  it('renders nothing before the first read answers', async () => {
    mockGetMine.mockReturnValue(new Promise(() => {})); // never settles
    await render(<EventPassportShareCard eventId={EVENT} />);
    expect(screen.queryByTestId('event-passport-share-card')).toBeNull();
  });

  it('offers the share when the capability is on and nothing is live yet', async () => {
    mockGetMine.mockResolvedValue({ ok: true, enabled: true, data: null });
    await render(<EventPassportShareCard eventId={EVENT} />);
    await waitFor(() => expect(screen.getByTestId('event-passport-share-card')).toBeTruthy());
    expect(screen.getByLabelText('Share my Passport at this event')).toBeTruthy();
    expect(screen.queryByLabelText('Stop sharing my event Passport')).toBeNull();
  });

  it('shows the remaining time and a revoke action once a share is live', async () => {
    mockGetMine.mockResolvedValue({ ok: true, enabled: true, data: liveShare() });
    await render(<EventPassportShareCard eventId={EVENT} />);
    await waitFor(() => expect(screen.getByLabelText('Stop sharing my event Passport')).toBeTruthy());
    // The remaining-time label is computed by the real (unmocked) helper.
    expect(screen.getByText(/left$/)).toBeTruthy();
  });

  it('treats a lapsed share as no share at all (§31)', async () => {
    mockGetMine.mockResolvedValue({
      ok: true,
      enabled: true,
      data: { token: 'a'.repeat(48), eventId: EVENT, expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    await render(<EventPassportShareCard eventId={EVENT} />);
    await waitFor(() => expect(screen.getByTestId('event-passport-share-card')).toBeTruthy());
    expect(screen.queryByLabelText('Stop sharing my event Passport')).toBeNull();
    expect(screen.getByLabelText('Share my Passport at this event')).toBeTruthy();
  });

  it('withdraws the affordance when the server refuses to mint', async () => {
    mockGetMine.mockResolvedValue({ ok: true, enabled: true, data: null });
    mockCreate.mockResolvedValue({ ok: false, enabled: true, data: null, message: 'API 403' });
    await render(<EventPassportShareCard eventId={EVENT} />);
    const btn = await screen.findByLabelText('Share my Passport at this event');
    fireEvent.press(btn);
    await waitFor(() => expect(screen.queryByTestId('event-passport-share-card')).toBeNull());
  });

  it('revoking clears the live share', async () => {
    mockGetMine.mockResolvedValue({ ok: true, enabled: true, data: liveShare() });
    mockRevoke.mockResolvedValue({ ok: true, enabled: true, data: { revoked: true } });
    await render(<EventPassportShareCard eventId={EVENT} />);
    const btn = await screen.findByLabelText('Stop sharing my event Passport');
    fireEvent.press(btn);
    await waitFor(() =>
      expect(screen.getByLabelText('Share my Passport at this event')).toBeTruthy(),
    );
  });
});

describe('EventPassportScreen (viewer side)', () => {
  const READY: ScreenState = {
    kind: 'ready',
    expiresAt: IN_TWO_HOURS(),
    passport: {
      variant: 'event',
      userId: 'owner-1',
      viewerContext: 'event_group',
      identity: {
        userId: 'owner-1',
        firstName: 'Mai',
        handle: 'wanderer',
        avatarUrl: null,
        verified: true,
        verificationLevel: 'id_verified',
        homeCountry: 'Vietnam',
      },
      atEventCity: 'Da Nang',
      intents: ['Nightlife'],
      actions: { can_follow: true, can_message: false },
    },
  };

  it('renders first name, broad city, intent and only the flagged actions', async () => {
    await render(<EventPassportScreen initialState={READY} />);
    expect(screen.getByText('Mai')).toBeTruthy();
    expect(screen.getByText('@wanderer')).toBeTruthy();
    expect(screen.getByText('At this event · Da Nang')).toBeTruthy();
    expect(screen.getByText('Nightlife')).toBeTruthy();
    expect(screen.getByText('Follow')).toBeTruthy();
    // can_message was false — the action is absent, not disabled.
    expect(screen.queryByText('Message')).toBeNull();
  });

  it('states that the share is temporary', async () => {
    await render(<EventPassportScreen initialState={READY} />);
    expect(screen.getByText(/Shared for this event ·/)).toBeTruthy();
  });

  it('renders one neutral refusal — never why', async () => {
    await render(<EventPassportScreen initialState={{ kind: 'unavailable', message: 'This event Passport is not available.' }} />);
    expect(screen.getByText('This event Passport is not available.')).toBeTruthy();
    for (const leak of [/expired/i, /revoked/i, /not attending/i, /unknown/i]) {
      expect(screen.queryByText(leak)).toBeNull();
    }
  });

  it('shows nothing about the traveler when the relationship is restricted (§24)', async () => {
    await render(
      <EventPassportScreen
        initialState={{
          ...READY,
          passport: {
            ...READY.passport,
            atEventCity: null,
            intents: [],
            identity: { ...READY.passport.identity, homeCountry: null },
            actions: { can_follow: false, can_message: false },
            restricted: { reason: 'blocked' },
          },
        } as ScreenState}
      />,
    );
    expect(screen.queryByText('Follow')).toBeNull();
    expect(screen.queryByText(/At this event/)).toBeNull();
    expect(screen.queryByText('Vietnam')).toBeNull();
  });
});
