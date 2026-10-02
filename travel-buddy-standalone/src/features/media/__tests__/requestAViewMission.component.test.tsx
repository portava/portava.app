/**
 * census-media §26, MD153 — §19's "Last visual update Nm ago / Show what's
 * happening?" prompt on the Media place view (the Places lens's §13 Place
 * Current View), with §18's `requestAnotherObservation` routed to it.
 *
 * The prompt existed since #305 but was mounted only on the place detail
 * screen's classic fallback (app/place/[id].tsx), and it asked OTHER people for
 * a view; the §19 mission — the viewer who is there showing what is happening —
 * had no action. These cases prove where it is mounted, when it hides, and
 * what each action does.
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const PLACE_ID = '11111111-1111-4111-8111-111111111111';

let mockFlags: Record<string, boolean> = {};
jest.mock('../../../context/FeatureFlagsContext.tsx', () => ({
  ...jest.requireActual('../../../context/FeatureFlagsContext.tsx'),
  useFeatureFlags: () => ({
    isEnabled: (k: string) => mockFlags[k] === true,
    isLivePlacesEnabled: () => false,
    loading: false,
  }),
}));

let mockCoverage: unknown = null;
const mockFetchCoverage = jest.fn();
jest.mock('../services/viewRequest.ts', () => ({
  ...jest.requireActual('../services/viewRequest.ts'),
  fetchVisualCoverage: (...a: unknown[]) => mockFetchCoverage(...a),
}));

let mockSafeReturn = { active: false, loading: false, refresh: () => {} };
const mockSafeReturnArg = jest.fn();
jest.mock('../../../hooks/useSafeReturnActive.ts', () => ({
  ...jest.requireActual('../../../hooks/useSafeReturnActive.ts'),
  useSafeReturnActive: (enabled: boolean) => {
    mockSafeReturnArg(enabled);
    return mockSafeReturn;
  },
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (href: unknown) => mockPush(href), back: () => {}, replace: () => {} },
}));

let mockView: unknown = null;
jest.mock('../../../services/media/mediaOffline.ts', () => ({
  ...jest.requireActual('../../../services/media/mediaOffline.ts'),
  placeViewOffline: async () => ({ ok: true, data: mockView }),
}));

import { MediaPlacesScreen } from '../screens/MediaPlacesScreen.tsx';
import { RequestAViewPrompt, shouldShowMissionPrompt } from '../components/RequestAViewPrompt.tsx';

const STALE = { lastObservedAt: '2026-09-26T09:32:00.000Z', ageMinutes: 28, lastUpdateLabel: '28m ago', stale: true, noCoverage: false };
const FRESH = { lastObservedAt: '2026-09-26T09:56:00.000Z', ageMinutes: 4, lastUpdateLabel: '4m ago', stale: false, noCoverage: false };
const VOID = { lastObservedAt: null, ageMinutes: null, lastUpdateLabel: null, stale: true, noCoverage: true };

const MIXED = {
  state: 'mixed',
  corroboration: { level: 'corroborated', freshPerspectiveCount: 4, independentSourceCount: 2 },
  contradiction: 'material',
  uncertaintyLabel: 'Mixed reports — conditions may be changing',
  requestAnotherObservation: true,
};

function placeView(over: Record<string, unknown> = {}) {
  return {
    placeId: PLACE_ID,
    placeName: 'An Thuong 2',
    stateLabel: null,
    currentPicture: { strength: 'low', updatedAt: null, ageMinutes: 12, perspectiveCount: 6, contributorCount: 4, sourceCount: 2, trend: 'steady' },
    groups: [],
    heroMedia: [],
    areaName: 'Da Nang',
    consensus: null,
    ...over,
  };
}

const ZONES = [{ id: PLACE_ID, name: 'An Thuong 2', perspectiveCount: 6, state: null, freshness: 'recent' }] as any;

async function openPlace(zones = ZONES, name = 'An Thuong 2') {
  const onContribute = jest.fn();
  const view = await render(<MediaPlacesScreen mode="overview" zones={zones} onContribute={onContribute} />);
  fireEvent.press(view.getByText(name));
  return { view, onContribute };
}

beforeEach(() => {
  mockFlags = {};
  mockCoverage = STALE;
  mockView = placeView();
  mockSafeReturn = { active: false, loading: false, refresh: () => {} };
  mockFetchCoverage.mockReset();
  mockFetchCoverage.mockImplementation(async () =>
    mockCoverage ? { ok: true, data: mockCoverage } : { ok: false, errorKind: 'network' },
  );
  mockSafeReturnArg.mockReset();
  mockPush.mockReset();
});

describe('MD153 — the §19 prompt on the Media place view', () => {
  it('flag on and coverage stale: the place view shows "Last visual update 28m ago" / "Show what’s happening?", and Take a photo opens this place’s contribution', async () => {
    mockFlags = { media_request_a_view_enabled: true };
    const { view, onContribute } = await openPlace();
    await waitFor(() => expect(view.getByText('Last visual update 28m ago')).toBeTruthy());
    expect(view.getByText('Show what’s happening?')).toBeTruthy();
    expect(mockFetchCoverage).toHaveBeenCalledWith(PLACE_ID, expect.objectContaining({ city: null }));
    fireEvent.press(view.getByTestId('mission-take-photo'));
    expect(onContribute).toHaveBeenCalledWith(PLACE_ID);
    // The capture flag is off, so there is no answer chip and the Safe Return
    // read stays inert.
    expect(view.queryByTestId('mission-answer-now')).toBeNull();
    expect(mockSafeReturnArg).not.toHaveBeenCalledWith(true);
  });

  it('flag off: nothing renders and coverage is never read', async () => {
    const { view } = await openPlace();
    await waitFor(() => expect(view.getByText('Da Nang')).toBeTruthy());
    expect(view.queryByTestId('request-a-view-prompt')).toBeNull();
    expect(mockFetchCoverage).not.toHaveBeenCalled();
  });

  it('flag on, coverage fresh and nothing disputed: hidden', async () => {
    mockFlags = { media_request_a_view_enabled: true };
    mockCoverage = FRESH;
    const { view } = await openPlace();
    await waitFor(() => expect(mockFetchCoverage).toHaveBeenCalled());
    await waitFor(() => expect(view.getByText('Da Nang')).toBeTruthy());
    expect(view.queryByTestId('request-a-view-prompt')).toBeNull();
  });

  it('flag on, coverage fresh, but §18 asks for another observation: shown under the Mixed reports line', async () => {
    mockFlags = { media_request_a_view_enabled: true };
    mockCoverage = FRESH;
    mockView = placeView({ consensus: MIXED });
    const { view } = await openPlace();
    await waitFor(() => expect(view.getByText('Last visual update 4m ago')).toBeTruthy());
    expect(view.getByText('Mixed reports — conditions may be changing')).toBeTruthy();
  });

  it('coverage that could not be read never prompts, even on a dispute', async () => {
    mockFlags = { media_request_a_view_enabled: true };
    mockCoverage = null;
    mockView = placeView({ consensus: MIXED });
    const { view } = await openPlace();
    await waitFor(() => expect(mockFetchCoverage).toHaveBeenCalled());
    await waitFor(() => expect(view.getByText('Da Nang')).toBeTruthy());
    expect(view.queryByTestId('request-a-view-prompt')).toBeNull();
  });

  it('"Say how busy it is" appears only with the capture flag on and no Safe Return, and opens the Quick Signal composer for this place', async () => {
    mockFlags = { media_request_a_view_enabled: true, intel_capture_quick_signal: true };
    const { view } = await openPlace();
    await waitFor(() => expect(view.getByTestId('mission-answer-now')).toBeTruthy());
    expect(mockSafeReturnArg).toHaveBeenCalledWith(true);
    fireEvent.press(view.getByTestId('mission-answer-now'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/intel/quick-signal',
      params: { subjectId: PLACE_ID, subjectName: 'An Thuong 2', context: 'arrival' },
    });
  });

  it('no answer chip during Safe Return', async () => {
    mockFlags = { media_request_a_view_enabled: true, intel_capture_quick_signal: true };
    mockSafeReturn = { active: true, loading: false, refresh: () => {} };
    const { view } = await openPlace();
    await waitFor(() => expect(view.getByTestId('mission-take-photo')).toBeTruthy());
    expect(view.queryByTestId('mission-answer-now')).toBeNull();
  });

  it('no answer chip while the Safe Return read is still in flight', async () => {
    mockFlags = { media_request_a_view_enabled: true, intel_capture_quick_signal: true };
    mockSafeReturn = { active: false, loading: true, refresh: () => {} };
    const { view } = await openPlace();
    await waitFor(() => expect(view.getByTestId('mission-take-photo')).toBeTruthy());
    expect(view.queryByTestId('mission-answer-now')).toBeNull();
  });

  it('a place with no current picture yet is the plainest gap: "No recent visual update"', async () => {
    mockFlags = { media_request_a_view_enabled: true };
    mockCoverage = VOID;
    mockView = placeView({ currentPicture: { strength: 'low', updatedAt: null, ageMinutes: null, perspectiveCount: 0, contributorCount: 0, sourceCount: 0, trend: 'steady' } });
    const { view } = await openPlace();
    await waitFor(() => expect(view.getByText('No recent visual update')).toBeTruthy());
    expect(view.getByText('No current picture yet')).toBeTruthy();
    expect(view.getByTestId('mission-take-photo')).toBeTruthy();
  });

  it('a label-only zone (no canonical place id) never asks', async () => {
    mockFlags = { media_request_a_view_enabled: true };
    const { view } = await openPlace([{ id: 'label:Beachfront', name: 'Beachfront', perspectiveCount: 2, state: null, freshness: 'recent' }] as any, 'Beachfront');
    await waitFor(() => expect(view.getByText('No current picture yet')).toBeTruthy());
    expect(view.queryByTestId('request-a-view-prompt')).toBeNull();
    expect(mockFetchCoverage).not.toHaveBeenCalled();
  });

  it('the place detail mount is unchanged: with no host actions the prompt is the Request-a-View half only', async () => {
    mockFlags = { media_request_a_view_enabled: true, intel_capture_quick_signal: true };
    const view = await render(<RequestAViewPrompt placeId={PLACE_ID} />);
    await waitFor(() => expect(view.getByText('Last visual update 28m ago')).toBeTruthy());
    expect(view.getByText('Want a current perspective? Ask nearby contributors for a fresh view.')).toBeTruthy();
    expect(view.queryByText('Show what’s happening?')).toBeNull();
    expect(view.queryByTestId('mission-take-photo')).toBeNull();
    expect(view.queryByTestId('mission-answer-now')).toBeNull();
    expect(mockSafeReturnArg).not.toHaveBeenCalledWith(true);
  });

  it('shouldShowMissionPrompt: an unread coverage never prompts; a dispute prompts a fresh place; the flag gates both', () => {
    expect(shouldShowMissionPrompt(null, true, true)).toBe(false);
    expect(shouldShowMissionPrompt(FRESH, true, false)).toBe(false);
    expect(shouldShowMissionPrompt(FRESH, true, true)).toBe(true);
    expect(shouldShowMissionPrompt(STALE, true, false)).toBe(true);
    expect(shouldShowMissionPrompt(STALE, false, true)).toBe(false);
  });
});
