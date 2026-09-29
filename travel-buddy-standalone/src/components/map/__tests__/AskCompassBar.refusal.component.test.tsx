/**
 * census-discovery §104 (DV-83, D-W11X2-55) — the map's Ask Compass bar reads
 * GET /compass/recommendations, whose failure arms it shares with Discovery's search
 * rail. A refused read is said as a failure, never handed up as zero results (which
 * the map's carousel draws as its empty state); a partial answer is handed up with
 * its rows and said to be incomplete.
 *
 *   A1  refused `nothing` → the failure line; onResults is NOT called (markers kept)
 *   A2  partial with rows → onResults with the rows, and the incomplete line
 *   Ac  CONTROL an answered empty list → onResults([]), no line (the empty state, as before)
 */
// NOTE: a stand-in on purpose — each test fixes what the Compass read answers; the refusal predicate is its own module and stays real.
jest.mock('../../../services/compass.ts', () => ({ fetchCompassRecommendations: jest.fn() }));

import React from 'react';
import { render, act, fireEvent } from '@testing-library/react-native';
import { AskCompassBar } from '../AskCompassBar.tsx';
import { fetchCompassRecommendations } from '../../../services/compass.ts';

const mockFetch = fetchCompassRecommendations as jest.Mock;
const REC = { id: 'place:1', type: 'place', category: 'food', title: 'Le Place', city: 'Paris', data: { lat: 48.85, lng: 2.35 } };

async function ask(answer: unknown) {
  mockFetch.mockResolvedValue(answer);
  const onResults = jest.fn();
  const r = await render(<AskCompassBar onResults={onResults} onClear={jest.fn()} city="Paris" />);
  const input = r.getByPlaceholderText('Ask Compass…');
  await act(async () => { fireEvent.changeText(input, 'coffee'); });
  await act(async () => { fireEvent(input, 'submitEditing'); });
  await act(async () => {});
  return { r, onResults };
}

describe('§104 AskCompassBar — the route\'s refusal envelope', () => {
  afterEach(() => { jest.clearAllMocks(); });

  it('A1 refused `nothing` → the failure line, and the markers are kept (onResults not called)', async () => {
    const { r, onResults } = await ask({ ok: true, data: { recommendations: [], surface: 'map', refusal: { coverage: 'nothing', code: 'compass_sources_unread', failedSources: ['posts'] } } });
    expect(mockFetch).toHaveBeenCalled();
    expect(onResults).not.toHaveBeenCalled();
    expect(r.queryByText("Couldn't reach Compass — check connection")).not.toBeNull();
  });

  it('A2 partial with rows → the rows are handed up, and the incomplete line shows', async () => {
    const { r, onResults } = await ask({ ok: true, data: { recommendations: [REC], surface: 'map', refusal: { coverage: 'partial', code: 'compass_sources_unread', failedSources: ['events'] } } });
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults.mock.calls[0][0].length).toBe(1);
    expect(r.queryByText("Some Compass suggestions couldn't load")).not.toBeNull();
  });

  it('Ac CONTROL an answered empty list → onResults([]), no line', async () => {
    const { r, onResults } = await ask({ ok: true, data: { recommendations: [], surface: 'map' } });
    expect(onResults).toHaveBeenCalledWith([], 'coffee');
    expect(r.queryByText("Couldn't reach Compass — check connection")).toBeNull();
    expect(r.queryByText("Some Compass suggestions couldn't load")).toBeNull();
  });
});
