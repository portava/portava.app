/**
 * census-discovery §104 (DV-83, D-W11X2-55) — the Passport tab's "Suggested for You"
 * reads GET /compass/recommendations?surface=passport, whose failure arms (the block
 * list, a candidate source, a failed build) it shares with Discovery. A failed or
 * refused read is said; it is never the section's absence, which is how "nothing to
 * suggest" is drawn. A partial answer shows its rows with the incomplete line.
 *
 *   PS1  transport failure → the failed line
 *   PS2  refused `nothing` (block list unread) → the failed line
 *   PS3  partial with rows → the rows and the incomplete line
 *   PS4  the read rejects → the failed line
 *   PSc  CONTROL an answered empty list → hidden, as before
 */
// NOTE: a stand-in on purpose — each test fixes what the Compass read answers; the refusal predicate is its own module and stays real.
jest.mock('../../../services/compass.ts', () => ({ fetchCompassRecommendations: jest.fn() }));
// NOTE: a stand-in on purpose — no traveler rows are served here, so no follow state is read.
jest.mock('../../../services/follows.ts', () => ({ getFollowStatus: jest.fn(), followUser: jest.fn() }));
// NOTE: a stand-in on purpose — the section only navigates, and no test taps.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { CompassPassportSuggestions } from '../CompassPassportSuggestions.tsx';
import { fetchCompassRecommendations } from '../../../services/compass.ts';

const mockFetch = fetchCompassRecommendations as jest.Mock;
const REC = { id: 'place:1', type: 'place', category: 'food', title: 'Le Place', reason: 'Near you', city: 'Paris' };

async function mount(answer: unknown) {
  mockFetch.mockResolvedValue(answer);
  const r = await render(<CompassPassportSuggestions isOwner />);
  await act(async () => {});
  await act(async () => {});
  return r;
}

describe('§104 CompassPassportSuggestions — a failed read is said', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('PS1 transport failure → the failed line', async () => {
    const r = await mount({ ok: false, error: 'http_503' });
    expect(r.queryByTestId('compass-passport-failed')).not.toBeNull();
  });

  it('PS2 refused `nothing` (the block list unread) → the failed line', async () => {
    const r = await mount({ ok: true, data: { recommendations: [], surface: 'passport', refusal: { coverage: 'nothing', code: 'block_check_failed', failedSources: ['blocks'] } } });
    expect(r.queryByTestId('compass-passport-failed')).not.toBeNull();
  });

  it('PS3 partial with rows → the rows and the incomplete line', async () => {
    const r = await mount({ ok: true, data: { recommendations: [REC], surface: 'passport', refusal: { coverage: 'partial', code: 'compass_sources_unread', failedSources: ['events'] } } });
    expect(r.queryByTestId('compass-passport-partial')).not.toBeNull();
    expect(r.queryByTestId('compass-passport-failed')).toBeNull();
  });

  it('PS4 the read rejects (a fault after the answer, not a transport failure) → the failed line', async () => {
    mockFetch.mockRejectedValue(new Error('handler fault'));
    const r = await render(<CompassPassportSuggestions isOwner />);
    await act(async () => {});
    await act(async () => {});
    expect(r.queryByTestId('compass-passport-failed')).not.toBeNull();
  });

  it('PSc CONTROL an answered empty list → hidden, as before', async () => {
    const r = await mount({ ok: true, data: { recommendations: [], surface: 'passport' } });
    expect(r.toJSON()).toBeNull();
  });
});
