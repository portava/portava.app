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
import { render, fireEvent, waitFor } from '@testing-library/react-native';
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

// NOTE: exhaustive stand-in is intentional. The real intelCapture service does
// an authed network fetch + token acquisition (apiToken pulls native modules
// under jest-expo); these tests assert only the REQUEST SHAPE the UI builds, and
// this covers every export PromptBlock imports (submitQuickSignal/submitWalkIn/key).
jest.mock('../../../services/intelCapture.ts', () => ({
  submitQuickSignal: jest.fn().mockResolvedValue({ ok: true }),
  submitWalkIn: jest.fn().mockResolvedValue({ ok: true }),
  makeIdempotencyKey: () => 'test-idem-key',
}));

import { OptionPills } from '../OptionPills.tsx';
import { VisibilityPicker } from '../VisibilityPicker.tsx';
import { ClaimConfirmBar } from '../ClaimConfirmBar.tsx';
import { SuppressedNotice } from '../IntelBits.tsx';
import { DecisionExposureChips } from '../DecisionExposureChips.tsx';
import { PromptBlock } from '../PromptBlock.tsx';
import { submitQuickSignal, submitWalkIn } from '../../../services/intelCapture.ts';
import { PARTY_SIZE_BUCKETS, PARTY_SIZE_LABELS, type PartySizeBucket, type PromptQuestion } from '../../../lib/intel/contracts.ts';

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

describe('Party-size pills (independent-group signal)', () => {
  it('renders every bucket by its label and reports the raw bucket value', async () => {
    const onSelect = jest.fn();
    const { getByTestId, getByText } = await render(
      <OptionPills
        options={PARTY_SIZE_BUCKETS}
        onSelect={onSelect}
        labelFor={(v) => PARTY_SIZE_LABELS[v as PartySizeBucket]}
        testIDPrefix="intel-party"
      />,
    );
    expect(getByText('Just me')).toBeTruthy();
    expect(getByTestId('intel-party-just_me')).toBeTruthy();
    fireEvent.press(getByTestId('intel-party-two_to_four'));
    expect(onSelect).toHaveBeenCalledWith('two_to_four');
  });
});

describe('PromptBlock threads the party-size signal into the write', () => {
  const arrivalQ: PromptQuestion = {
    id: 'arrival', topic: 'energy', prompt: 'How is it right now?',
    kind: 'context', context: 'arrival', options: ['dead', 'busy'], phase1: true,
  };

  it('sends the chosen party size alongside the quick signal', async () => {
    (submitQuickSignal as jest.Mock).mockClear();
    const { getByTestId } = await render(
      <PromptBlock subjectId="place-1" question={arrivalQ} visibility="private" partySize="two_to_four" />,
    );
    fireEvent.press(getByTestId('intel-q-arrival-busy'));
    await waitFor(() => expect(submitQuickSignal).toHaveBeenCalled());
    expect(submitQuickSignal).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'arrival', option: 'busy', partySize: 'two_to_four' }),
    );
  });

  it('omits party size entirely when the traveler skipped the question', async () => {
    (submitQuickSignal as jest.Mock).mockClear();
    const { getByTestId } = await render(
      <PromptBlock subjectId="place-1" question={arrivalQ} visibility="private" />,
    );
    fireEvent.press(getByTestId('intel-q-arrival-dead'));
    await waitFor(() => expect(submitQuickSignal).toHaveBeenCalled());
    expect((submitQuickSignal as jest.Mock).mock.calls[0][0].partySize).toBeUndefined();
  });

  it('carries party size on the walk-in access signal too', async () => {
    (submitWalkIn as jest.Mock).mockClear();
    const walkInQ: PromptQuestion = {
      id: 'walkin', topic: 'walk-in', prompt: 'Walking in without a booking?',
      kind: 'walkIn', options: ['accepted', 'turned away'], phase1: true,
    };
    const { getByTestId } = await render(
      <PromptBlock subjectId="place-1" question={walkInQ} visibility="private" partySize="five_plus" />,
    );
    fireEvent.press(getByTestId('intel-q-walkin-accepted'));
    await waitFor(() => expect(submitWalkIn).toHaveBeenCalled());
    expect(submitWalkIn).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: true, partySize: 'five_plus' }),
    );
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
    // CHANGED, and the change is the point. This asserted /Traveler report/i,
    // which is what the synthesised bare-crowdLevel path used to claim — it
    // hardcoded sourceClass: 'firsthand_unverified'.
    //
    // That was a §37 fail-open. api-server's readLiveCrowdLevel takes the first
    // crowd.level claim with NO source-class filter, so a SPONSORED claim can
    // be the one reduced to this bare string. The attribution is dropped
    // upstream, so the honest answer is that we do not have one.
    //
    // The fixture here is `{ crowdLevel: 'busy' }` — the synthesised path
    // exactly. A test asserting the old string would be asserting the
    // violation.
    // The sheet renders inside a Modal; findAllBy* waits for the deferred commit.
    const matches = await findAllByText(/Source not attributed/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders the rich server liveClaims shape (band + value) end-to-end', async () => {
    // Exactly the api-server LiveClaimEnvelope wire shape (#156): a bucketed cohort
    // size, no exact count, and a live/emerging state.
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
          sourceCountBucket: 'several',
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
    // The cohort is rendered as a bucket phrase, never a fabricated exact number.
    expect(getByText(/dozens of travelers/i)).toBeTruthy();
  });

  it('renders an emerging claim as "Observed", never "Live" (#156)', async () => {
    // Cleared the serve floor (likely_current) but below the live band: the server
    // labels this state 'emerging' and the client must not overstate it as Live.
    const emergingLiving = {
      crowdLevel: null,
      generatedAt: new Date().toISOString(),
      liveClaims: [
        {
          id: 'snap-2',
          claimType: 'crowd.level',
          value: { level: 'busy' },
          confidence: 0.6,
          band: 'likely_current',
          sourceClass: 'firsthand_unverified',
          sourceCountBucket: 'few',
          observedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
          validUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
          state: 'emerging',
        },
      ],
    } as any;
    const { getByTestId, getByText, queryByText, findByText } = await render(
      <SafeArea><DecisionExposureChips living={emergingLiving} enabled /></SafeArea>,
    );
    expect(getByTestId('intel-chip-crowd.level')).toBeTruthy();
    expect(getByText('Busy')).toBeTruthy();
    fireEvent.press(getByTestId('intel-chip-crowd.level'));
    expect(await findByText('Observed')).toBeTruthy(); // the emerging pill…
    expect(queryByText('Live')).toBeNull(); // …and never "Live"
    expect(getByText(/more than a dozen travelers/i)).toBeTruthy(); // bucket, not a number
  });
});
