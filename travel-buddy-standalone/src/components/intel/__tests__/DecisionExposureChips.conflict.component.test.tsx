/**
 * §10 "Reports differ" on the place card (IG unit I2, AT-07).
 *
 * A live-claim envelope carrying conflictState 'material' must render with the
 * conflict said in TEXT on the chip, never with a Live pill, and its sheet must
 * offer the contradiction-resolution re-ask only when the caller supplies one
 * (the caller — useIntelPrompts.conflictReask — owns the prompt suppression).
 *
 * Jest (not node:test) because DecisionExposureChips is a .tsx that pulls in
 * react-native.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// PortavaSheet (opened by a chip tap) calls useSafeAreaInsets; supply metrics so
// the provider renders children synchronously and insets resolve in jest.
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const SafeArea = ({ children }: { children: React.ReactNode }) => (
  <SafeAreaProvider initialMetrics={METRICS}>{children}</SafeAreaProvider>
);

// NOTE: intentionally exhaustive — requireActual('expo-haptics') pulls the
// native ExpoHaptics module, which is unavailable under jest-expo and throws at
// import. The sheet only calls impactAsync / notificationAsync with their two
// enums, so this stand-in covers every export it touches.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
}));

import { DecisionExposureChips, buildLiveClaims } from '../DecisionExposureChips.tsx';

const FUTURE = new Date(Date.now() + 30 * 60_000).toISOString();
const NOW = new Date().toISOString();

function living(conflictState: 'none' | 'minor' | 'material' | undefined) {
  return {
    placeId: 'p1',
    crowdLevel: null,
    generatedAt: NOW,
    liveClaims: [
      {
        id: 's1',
        claimType: 'crowd.level',
        value: { level: 'packed' },
        confidence: conflictState === 'material' ? 0.74 : 0.92,
        band: conflictState === 'material' ? 'likely_current' : 'strong',
        sourceClass: 'firsthand_unverified',
        sourceCountBucket: 'few',
        observedAt: NOW,
        validUntil: FUTURE,
        state: conflictState === 'material' ? 'emerging' : 'live',
        ...(conflictState
          ? { conflictState, conflict: conflictState === 'none' ? null : { state: conflictState, sidesCount: 2, lastUpdated: NOW } }
          : {}),
      },
    ],
  } as any;
}

describe('§10 — buildLiveClaims carries the conflict state', () => {
  it('maps conflictState from the envelope (absent ⇒ none)', () => {
    expect(buildLiveClaims(living('material'))[0].conflictState).toBe('material');
    expect(buildLiveClaims(living('minor'))[0].conflictState).toBe('minor');
    expect(buildLiveClaims(living(undefined))[0].conflictState).toBe('none');
  });
  it('falls back to the conflict block when only the block is present', () => {
    const l = living('material');
    delete l.liveClaims[0].conflictState;
    expect(buildLiveClaims(l)[0].conflictState).toBe('material');
  });
});

describe('§10 — the chip says "Reports differ" and never shows Live', () => {
  it('a material claim renders the conflict text on the chip and no Live label', async () => {
    const { getByTestId, queryByText, getByText } = await render(
      <SafeArea><DecisionExposureChips living={living('material')} enabled /></SafeArea>,
    );
    expect(getByTestId('intel-chip-crowd.level')).toBeTruthy();
    expect(getByText('Packed')).toBeTruthy(); // the value still shows — labelled, not hidden
    expect(getByTestId('intel-chip-conflict-crowd.level')).toBeTruthy();
    expect(queryByText('Reports differ')).toBeTruthy();
    expect(queryByText('Live')).toBeNull();
  });

  it('a non-conflicted claim renders no conflict text', async () => {
    const { queryByTestId, queryByText } = await render(
      <SafeArea><DecisionExposureChips living={living('none')} enabled /></SafeArea>,
    );
    expect(queryByTestId('intel-chip-conflict-crowd.level')).toBeNull();
    expect(queryByText('Reports differ')).toBeNull();
  });

  it('the sheet explains the conflict and offers the re-ask ONLY when the caller supplies one', async () => {
    const onResolve = jest.fn();
    const withReask = await render(
      <SafeArea><DecisionExposureChips living={living('material')} enabled onResolveConflict={onResolve} /></SafeArea>,
    );
    fireEvent.press(withReask.getByTestId('intel-chip-crowd.level'));
    expect(await withReask.findByTestId('intel-why-conflict')).toBeTruthy();
    const btn = await withReask.findByTestId('intel-conflict-reask');
    fireEvent.press(btn);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0].claimType).toBe('crowd.level');

    // Suppressed (the caller passed nothing — flag off / Safe Return / paused):
    // the explanation still shows, the re-ask does not.
    const suppressed = await render(
      <SafeArea><DecisionExposureChips living={living('material')} enabled /></SafeArea>,
    );
    fireEvent.press(suppressed.getByTestId('intel-chip-crowd.level'));
    expect(await suppressed.findByTestId('intel-why-conflict')).toBeTruthy();
    expect(suppressed.queryByTestId('intel-conflict-reask')).toBeNull();
  });
});
