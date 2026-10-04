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
  resolveEventPassport,
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
const mockResolve = resolveEventPassport as unknown as jest.Mock;

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

// ── An outage is not a refusal (passport lane, 2026-10-03) ───────────────────
// The server now answers a failed read/write as a retryable 500, and the client
// result carries `outage`. These pin that the SURFACES act on it: an outage is
// never "nothing shared" (a Share button over a share that may be live), never a
// hidden card, and never the "only for people at the event" refusal.

const OUTAGE = { ok: false, enabled: true, data: null, message: 'API 500', outage: true };
const REFUSED = { ok: false, enabled: true, data: null, message: 'API 403', outage: false };

describe('EventPassportShareCard — outage vs refusal', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('an unreadable own share says so and offers a retry — not a Share button', async () => {
    mockGetMine.mockResolvedValueOnce(OUTAGE).mockResolvedValueOnce({ ok: true, enabled: true, data: liveShare() });
    await render(<EventPassportShareCard eventId={EVENT} />);
    await waitFor(() => expect(screen.getByText("Couldn't check your event Passport.")).toBeTruthy());
    expect(screen.queryByLabelText('Share my Passport at this event')).toBeNull();
    fireEvent.press(screen.getByLabelText('Try checking my event Passport again'));
    await waitFor(() => expect(screen.getByLabelText('Stop sharing my event Passport')).toBeTruthy());
    expect(mockGetMine).toHaveBeenCalledTimes(2);
  });

  it('a refused own-share read renders nothing, as a refusal always has', async () => {
    mockGetMine.mockResolvedValue(REFUSED);
    await render(<EventPassportShareCard eventId={EVENT} />);
    await waitFor(() => expect(mockGetMine).toHaveBeenCalled());
    expect(screen.queryByTestId('event-passport-share-card')).toBeNull();
  });

  it('a mint that fails as an outage keeps the card and says try again', async () => {
    mockGetMine.mockResolvedValue({ ok: true, enabled: true, data: null });
    mockCreate.mockResolvedValue(OUTAGE);
    await render(<EventPassportShareCard eventId={EVENT} />);
    fireEvent.press(await screen.findByLabelText('Share my Passport at this event'));
    await waitFor(() => expect(screen.getByText('Could not share right now. Try again.')).toBeTruthy());
    expect(screen.getByTestId('event-passport-share-card')).toBeTruthy();
  });
});

describe('EventPassportScreen — outage vs refusal', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('an outage is "couldn\'t load", never the at-the-event refusal, and retries', async () => {
    mockResolve.mockResolvedValueOnce(OUTAGE).mockResolvedValueOnce(REFUSED);
    await render(<EventPassportScreen token={'a'.repeat(48)} />);
    await waitFor(() => expect(screen.getByText("Couldn't load this event Passport.")).toBeTruthy());
    expect(screen.queryByText('This event Passport is not available.')).toBeNull();
    fireEvent.press(screen.getByLabelText('Try loading this event Passport again'));
    await waitFor(() => expect(screen.getByText('This event Passport is not available.')).toBeTruthy());
    expect(mockResolve).toHaveBeenCalledTimes(2);
  });
});
