/**
 * Component render tests for the Intelligence Gathering capture UI leaves.
 * Verifies what a reviewer would check visually: the one-tap option row fires,
 * the visibility picker is private-first, the confirm bar offers three stances,
 * the suppression notice speaks for Safe Return, and the decision-exposure chip
 * renders a live crowd value (and renders nothing when the flag is off).
 *
 * Harness follows ArrivalBoard.component.test.tsx: destructured queries from
 * render(), no global `screen` (the repo's pinned renderer doesn't bind it).
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
// import. The capture leaves only call impactAsync / notificationAsync with
// their two enums, so this stand-in covers every export they touch.
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Error: 'error', Warning: 'warning' },
}));

import { OptionPills } from '../OptionPills.tsx';
import { VisibilityPicker } from '../VisibilityPicker.tsx';
import { ClaimConfirmBar } from '../ClaimConfirmBar.tsx';
import { SuppressedNotice } from '../IntelBits.tsx';
import { DecisionExposureChips } from '../DecisionExposureChips.tsx';

describe('OptionPills', () => {
  it('renders every option and reports the tapped one (no free text)', async () => {
    const onSelect = jest.fn();
    const { getByTestId } = await render(
      <OptionPills options={['dead', 'quiet', 'good energy', 'busy', 'packed']} onSelect={onSelect} />,
    );
    expect(getByTestId('intel-option-dead')).toBeTruthy();
    expect(getByTestId('intel-option-packed')).toBeTruthy();
    fireEvent.press(getByTestId('intel-option-busy'));
    expect(onSelect).toHaveBeenCalledWith('busy');
  });
});

describe('VisibilityPicker', () => {
  it('is private-first and reports a new choice', async () => {
    const onChange = jest.fn();
    const { getByTestId } = await render(<VisibilityPicker value="private" onChange={onChange} />);
    expect(getByTestId('intel-visibility-private')).toBeTruthy();
    expect(getByTestId('intel-visibility-public')).toBeTruthy();
    fireEvent.press(getByTestId('intel-visibility-public'));
    expect(onChange).toHaveBeenCalledWith('public');
  });
});

describe('ClaimConfirmBar', () => {
  it('offers agree / disagree / unsure', async () => {
    const onConfirm = jest.fn();
    const { getByTestId } = await render(<ClaimConfirmBar onConfirm={onConfirm} />);
    expect(getByTestId('intel-confirm-agree')).toBeTruthy();
    expect(getByTestId('intel-confirm-disagree')).toBeTruthy();
    fireEvent.press(getByTestId('intel-confirm-unsure'));
    expect(onConfirm).toHaveBeenCalledWith('unsure');
  });
});

describe('SuppressedNotice', () => {
  it('explains the Safe Return suppression', async () => {
    const { getAllByText } = await render(<SuppressedNotice reason="safe_return" />);
    expect(getAllByText(/Safe Return/i).length).toBeGreaterThan(0);
  });
});

describe('DecisionExposureChips', () => {
  const living = { crowdLevel: 'busy', generatedAt: new Date().toISOString() } as any;

  it('renders a live crowd chip when enabled', async () => {
    const { getByTestId, getByText } = await render(
      <SafeArea><DecisionExposureChips living={living} enabled /></SafeArea>,
    );
    expect(getByTestId('intel-chip-crowd.level')).toBeTruthy();
    expect(getByText('Busy')).toBeTruthy();
  });

  it('renders nothing when the flag is off (inert)', async () => {
    const { queryByTestId } = await render(
      <SafeArea><DecisionExposureChips living={living} enabled={false} /></SafeArea>,
    );
    expect(queryByTestId('intel-chip-crowd.level')).toBeNull();
  });

  it('opens a "why" sheet with the source label on tap', async () => {
    const { getByTestId, findAllByText } = await render(
      <SafeArea><DecisionExposureChips living={living} enabled /></SafeArea>,
    );
    fireEvent.press(getByTestId('intel-chip-crowd.level'));
    // The sheet renders inside a Modal; findAllBy* waits for the deferred commit.
    const matches = await findAllByText(/Traveler report/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders the rich server liveClaims shape (band + value) end-to-end', async () => {
    // Exactly the api-server LiveClaimEnvelope wire shape.
    const richLiving = {
      crowdLevel: null,
      generatedAt: new Date().toISOString(),
      liveClaims: [
        {
          id: 'snap-1',
          claimType: 'queue.wait',
          value: { minMinutes: 10, maxMinutes: 20 },
          confidence: 0.82,
          band: 'live',
          sourceClass: 'firsthand_unverified',
          sourceCount: 4,
          observedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          validUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
          state: 'live',
        },
      ],
    } as any;
    const { getByTestId, getByText, findAllByText } = await render(
      <SafeArea><DecisionExposureChips living={richLiving} enabled /></SafeArea>,
    );
    expect(getByTestId('intel-chip-queue.wait')).toBeTruthy();
    expect(getByText('10–20 min')).toBeTruthy();
    fireEvent.press(getByTestId('intel-chip-queue.wait'));
    // Not synthesized → the confidence band row is shown ("Live" appears both as
    // the live-state pill and the band label), and the source class is real.
    expect((await findAllByText('Live')).length).toBeGreaterThan(0);
    expect(getByText(/Traveler report/i)).toBeTruthy();
  });
});
