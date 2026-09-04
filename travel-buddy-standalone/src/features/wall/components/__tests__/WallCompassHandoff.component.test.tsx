/**
 * Component test: the Wall → Compass handoff (Wall spec §21).
 *
 * Compass appears as an ACTION, not a permanent panel. This proves the two
 * entry points hand the CANONICAL object to the app's existing Compass ask
 * surface (`/(tabs)/ai`) as a `prefillMessage`:
 *   1. The "Ask Compass" affordance on a place-linked post.
 *   2. The `compass`-kind Context Thread beneath an object.
 * It also proves the handoff is recorded in analytics by ids + surface ONLY —
 * never the prompt text (spec §32).
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

// NOTE: expo-router requires native navigation modules unavailable in jest-expo
// — exhaustive stub of the single member the handoff touches.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

import { router } from 'expo-router';
import * as wallApi from '../../services/wallApi.ts';
import { WallScreen } from '../WallScreen.tsx';
import {
  setWallAnalyticsSink,
  resetWallAnalyticsSink,
  type WallAnalyticsEvent,
} from '../../services/wallAnalytics.ts';
import type { WallProjection, WallResponse } from '../../types/wallProjection.ts';

const mockFetchWall = wallApi.fetchWall as unknown as jest.Mock;
const mockFetchLive = wallApi.fetchLiveForYou as unknown as jest.Mock;
const mockPush = router.push as jest.Mock;

const NOW = new Date().toISOString();

const items: WallProjection[] = [
  {
    projectionId: 'p1',
    canonicalObjectId: 'c-p1',
    objectType: 'social_post',
    publishedAt: NOW,
    visibility: 'public',
    text: 'Sunset from the rooftop',
    place: { placeId: 'pl-1', name: 'Sky Bar', city: 'Da Nang' },
    // The server only issues `ask_compass` when wall_compass_handoff_enabled is
    // on (WallProjectionService.buildActions); the chip is gated on it (§21).
    actions: [{ type: 'ask_compass', label: 'Ask Compass', targetType: 'place', targetId: 'pl-1' }],
  },
  {
    projectionId: 'p2',
    canonicalObjectId: 'c-p2',
    objectType: 'social_post',
    publishedAt: NOW,
    visibility: 'public',
    text: 'What a night',
    actions: [],
    contextThread: {
      kind: 'compass',
      label: 'Curious about this spot?',
      reason: 'Compass can interpret what you saw',
    },
  },
  {
    // A place-linked post WITHOUT the server-issued ask_compass action: the
    // handoff flag is off, so no chip may appear (server-authoritative, §7/§21).
    projectionId: 'p3',
    canonicalObjectId: 'c-p3',
    objectType: 'social_post',
    publishedAt: NOW,
    visibility: 'public',
    text: 'Quiet morning',
    place: { placeId: 'pl-3', name: 'An Bang Beach', city: 'Da Nang' },
    actions: [],
  },
];

function response(): WallResponse {
  return { mode: 'for_you', liveForYou: [], items, generatedAt: NOW };
}

let events: WallAnalyticsEvent[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  setWallAnalyticsSink((e) => events.push(e));
  mockFetchLive.mockResolvedValue({ ok: true, liveForYou: [], degraded: false });
  mockFetchWall.mockResolvedValue({ ok: true, degraded: false, data: response() });
});

afterEach(() => {
  resetWallAnalyticsSink();
});

describe('Wall → Compass handoff (§21)', () => {
  it('Ask Compass on a place-linked post hands the object to /(tabs)/ai with a grounded prefill', async () => {
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-ask-compass-p1')).toBeTruthy());

    fireEvent.press(screen.getByTestId('wall-ask-compass-p1'));

    // Routed to the canonical Compass ask surface with a prefillMessage.
    expect(mockPush).toHaveBeenCalledTimes(1);
    const arg = mockPush.mock.calls[0][0];
    expect(arg.pathname).toBe('/(tabs)/ai');
    expect(typeof arg.params.prefillMessage).toBe('string');
    // Prompt references the canonical place (grounding, §21) and is a question,
    // never an asserted fact.
    expect(arg.params.prefillMessage).toContain('Sky Bar');
    expect(arg.params.prefillMessage).toContain('Da Nang');

    // Handoff recorded by ids + surface only — the prompt text is NEVER logged.
    const handoff = events.find(
      (e): e is Extract<WallAnalyticsEvent, { type: 'wall_handoff' }> =>
        e.type === 'wall_handoff',
    );
    expect(handoff).toBeDefined();
    expect(handoff?.surface).toBe('compass');
    expect(handoff?.objectId).toBe('c-p1');
    expect(JSON.stringify(handoff)).not.toContain('Sky Bar');
  });

  it('a compass-kind Context Thread hands the object to Compass and records acted + handoff', async () => {
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-context-compass')).toBeTruthy());

    fireEvent.press(screen.getByTestId('wall-context-compass'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0][0].pathname).toBe('/(tabs)/ai');

    expect(events.some((e) => e.type === 'wall_context_acted' && e.kind === 'compass')).toBe(true);
    expect(events.some((e) => e.type === 'wall_handoff' && e.surface === 'compass')).toBe(true);
  });

  it('renders the Ask Compass chip ONLY on the post the server gave the ask_compass action', async () => {
    await render(<WallScreen />);
    // p1 carries the server-issued ask_compass action → chip present.
    await waitFor(() => expect(screen.getByTestId('wall-ask-compass-p1')).toBeTruthy());
    // p3 is place-linked but the server withheld the action (flag off) → no chip,
    // even though it has a place line. Client never surfaces Compass server-side gated off.
    expect(screen.queryByTestId('wall-ask-compass-p3')).toBeNull();
  });
});
