/**
 * Telemetry tests for SharedContextScreen (§32 + §17/§18).
 *
 * Proves the two events this surface emits carry ids / enums / counts ONLY:
 *   • shared_context_viewed — fired once the overlap is shown: the other
 *     traveler's id, the fact COUNT and the qualitative label; never the fact
 *     text (a coarse city / neighbourhood is still someone's location) and never
 *     a numeric score.
 *   • make_plan_started — fired when the "See What You Could Do" CTA is pressed:
 *     the subject id and the origin enum only.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SharedContextScreen from '../SharedContextScreen.tsx';
import { getSharedContext } from '../../../services/passportSharedContext.ts';
import { getPassportProjection } from '../../../services/passportProjection.ts';
import {
  setPassportTelemetrySink,
  resetPassportTelemetrySink,
  type PassportTelemetryEvent,
} from '../passportTelemetry.ts';

// NOTE: intentional stub — getSharedContext reaches Supabase auth + the API
// server. It is the seam under test; _setTestAuthToken is a no-op.
jest.mock('../../../services/passportSharedContext', () => ({
  getSharedContext: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentional stub — useSharedContext also reads the passport projection
// for the server-owned can_make_plan capability. getPassportProjection is the
// only member the hook touches; this exhaustive factory is complete.
jest.mock('../../../services/passportProjection', () => ({
  getPassportProjection: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: expo-router requires Expo native navigation modules unavailable here.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: react-native-safe-area-context needs a provider not mounted here.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockGetSharedContext = getSharedContext as jest.Mock;
const mockGetPassportProjection = getPassportProjection as jest.Mock;

function overlapPayload() {
  return {
    sharedContext: {
      viewerId: 'me',
      ownerId: 'them',
      summaryLabel: 'Strong travel overlap',
      facts: [
        { key: 'both_in_city', label: 'Both in the same city', detail: 'Da Nang', magnitude: null },
        { key: 'mutual_follows', label: '3 mutual follows', detail: null, magnitude: 3 },
        { key: 'intent_overlap', label: 'Shared interests', detail: 'Nightlife · Food', magnitude: 2 },
      ],
      compassHandoff: {
        eligible: true,
        city: 'Da Nang',
        overlapWindow: { status: 'open', expiresAt: null },
        sharedIntents: ['nightlife', 'food'],
        reasons: ['shared_context_present'],
      },
    },
  };
}

let events: PassportTelemetryEvent[];
beforeEach(() => {
  events = [];
  setPassportTelemetrySink((e) => events.push(e));
  mockGetSharedContext.mockReset();
  mockGetPassportProjection.mockReset();
  mockGetPassportProjection.mockResolvedValue({ ok: true, data: { actions: { can_make_plan: true } } });
});
afterEach(() => {
  resetPassportTelemetrySink();
});

describe('SharedContextScreen — §32 telemetry', () => {
  it('emits shared_context_viewed with ids/enum/count only — no fact text, no score', async () => {
    mockGetSharedContext.mockResolvedValue({ ok: true, data: overlapPayload() });

    await render(<SharedContextScreen userId="them" otherName="Mai" />);
    await waitFor(() => expect(screen.getByText('Strong travel overlap')).toBeTruthy());

    const viewed = events.find((e) => e.type === 'shared_context_viewed');
    expect(viewed?.payload).toEqual({
      subjectId: 'them',
      factCount: 3,
      summary: 'Strong travel overlap',
    });

    // No fact detail (a coarse city is still a location) and no name leaks.
    const json = JSON.stringify(events);
    expect(json).not.toContain('Da Nang');
    expect(json).not.toContain('Nightlife');
    expect(json).not.toContain('Mai');
    // …and never a numeric match score.
    expect(json).not.toMatch(/\d+\s*%/);
  });

  it('emits make_plan_started when the "See What You Could Do" CTA is pressed', async () => {
    mockGetSharedContext.mockResolvedValue({ ok: true, data: overlapPayload() });

    await render(<SharedContextScreen userId="them" otherName="Mai" />);
    const cta = await waitFor(() => screen.getByText('See What You Could Do'));
    fireEvent.press(cta);

    const started = events.find((e) => e.type === 'make_plan_started');
    expect(started?.payload).toEqual({ subjectId: 'them', from: 'shared_context' });
  });

  it('does not fire make_plan_started when the server withholds can_make_plan', async () => {
    mockGetSharedContext.mockResolvedValue({ ok: true, data: overlapPayload() });
    mockGetPassportProjection.mockResolvedValue({ ok: true, data: { actions: { can_make_plan: false } } });

    await render(<SharedContextScreen userId="them" otherName="Mai" />);
    await waitFor(() => expect(screen.getByText('Strong travel overlap')).toBeTruthy());

    // The CTA is withheld, so it can never be pressed → no make_plan_started.
    expect(screen.queryByText('See What You Could Do')).toBeNull();
    expect(events.some((e) => e.type === 'make_plan_started')).toBe(false);
    // The view event still fires.
    expect(events.some((e) => e.type === 'shared_context_viewed')).toBe(true);
  });
});
