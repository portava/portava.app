/**
 * Component test: Live For You is bounded (≤4) and ignorable (Wall spec §4/§40 #2).
 *
 * With more than 4 items it renders at most 4; with no items it renders nothing
 * at all, so normal scrolling is entirely unaffected.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — LiveForYouStrip pulls wallAnalytics →
// wallApi, whose real module loads the supabase/apiToken chain at import and
// crashes the suite. Stub only the exports the strip's dependencies touch.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

import { LiveForYouStrip } from '../LiveForYouStrip.tsx';
import type { LiveForYouItem } from '../../types/liveForYou.ts';

function liveItem(n: number): LiveForYouItem {
  return {
    id: `live-${n}`,
    liveObjectType: 'place_state',
    subjectId: `place-${n}`,
    subject: { placeId: `place-${n}`, name: `Place ${n}` },
    label: `Getting busier ${n}`,
    freshness: 'live',
    state: 'live',
    observedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('LiveForYouStrip', () => {
  it('renders at most 4 items even when given more', async () => {
    const six = [1, 2, 3, 4, 5, 6].map(liveItem);
    await render(<LiveForYouStrip items={six} />);

    expect(screen.getByTestId('wall-live-strip')).toBeTruthy();
    expect(screen.getByTestId('wall-live-item-live-1')).toBeTruthy();
    expect(screen.getByTestId('wall-live-item-live-4')).toBeTruthy();
    // Bounded: the 5th and 6th are never shown.
    expect(screen.queryByTestId('wall-live-item-live-5')).toBeNull();
    expect(screen.queryByTestId('wall-live-item-live-6')).toBeNull();
  });

  it('renders nothing when there is nothing fresh (ignorable)', async () => {
    await render(<LiveForYouStrip items={[]} />);
    expect(screen.queryByTestId('wall-live-strip')).toBeNull();
  });
});
