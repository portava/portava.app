/**
 * Telemetry tests for the Availability editor (§32 + §7).
 *
 * Pressing the EXPLICIT "Set Availability" CTA (§7) emits:
 *   • availability_set — with the flag, the intent COUNT, and whether a live
 *     window exists (never the window times or the intent labels), and
 *   • open_to_plans_enabled — only on an actual off→on transition.
 *
 * The editor is fabricated so the save path is deterministic; a telemetry spy
 * sink captures the emitted events and proves no PII travels.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AvailabilityView } from '../AvailabilityScreen.tsx';
import {
  defaultTonightWindow,
  type UseAvailabilityEditorResult,
} from '../useAvailabilityEditor.ts';
import {
  setPassportTelemetrySink,
  resetPassportTelemetrySink,
  type PassportTelemetryEvent,
} from '../passportTelemetry.ts';

// NOTE: intentional exhaustive stub — AvailabilityScreen imports
// useAvailabilityEditor, which imports the availability service that reaches
// Supabase auth + the API server. The editor is injected in these renders, so
// none of these functions are called; the stub only keeps module import inert.
jest.mock('../../../services/availability', () => ({
  getMyAvailability: jest.fn(),
  patchMyAvailability: jest.fn(),
  getMyAvailabilityWindows: jest.fn(),
  createMyAvailabilityWindow: jest.fn(),
  patchMyAvailabilityWindow: jest.fn(),
  deleteMyAvailabilityWindow: jest.fn(),
}));

// NOTE: react-native-safe-area-context needs a provider not mounted here.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

function makeEditor(over: Partial<UseAvailabilityEditorResult> = {}): UseAvailabilityEditorResult {
  const { startAt, endAt } = defaultTonightWindow(Date.now());
  return {
    loading: false,
    error: null,
    saving: false,
    windowsEnabled: true,
    currentWindow: null,
    inferredPrompt: null,
    draft: {
      openToPlans: true,
      intents: ['Food', 'Nightlife'],
      groupPreference: 'small_group',
      maxTravelMinutes: 20,
      socialAvailability: 'maybe',
      startAt,
      endAt,
      visibility: 'followers',
    },
    weeklyDays: {},
    setOpenToPlans: jest.fn(),
    toggleIntent: jest.fn(),
    setGroupPreference: jest.fn(),
    setMaxTravelMinutes: jest.fn(),
    setSocialAvailability: jest.fn(),
    toggleWeeklyBlock: jest.fn(),
    save: jest.fn().mockResolvedValue({ ok: true, enabled: true }),
    clearWindow: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

let events: PassportTelemetryEvent[];
beforeEach(() => {
  events = [];
  setPassportTelemetrySink((e) => events.push(e));
});
afterEach(() => {
  resetPassportTelemetrySink();
});

describe('AvailabilityView — §32 telemetry', () => {
  it('emits availability_set + open_to_plans_enabled on an explicit save (off→on)', async () => {
    await render(<AvailabilityView editor={makeEditor()} />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Set Availability'));
    });

    const set = events.find((e) => e.type === 'availability_set');
    expect(set?.payload).toEqual({ openToPlans: true, intentCount: 2, hasWindow: true });

    const enabled = events.find((e) => e.type === 'open_to_plans_enabled');
    expect(enabled?.payload).toEqual({ intentCount: 2 });

    // Ids/enums/counts only — no window time and no intent labels leak.
    const json = JSON.stringify(events);
    expect(json).not.toContain('Food');
    expect(json).not.toContain('Nightlife');
  });

  it('does NOT emit open_to_plans_enabled when it was already on', async () => {
    // A live window already open-to-plans → no off→on transition.
    const editor = makeEditor({
      currentWindow: {
        id: 'w1',
        userId: 'u1',
        type: 'one_time',
        startAt: new Date(Date.now() - 3_600_000).toISOString(),
        endAt: new Date(Date.now() + 3_600_000).toISOString(),
        tripId: null,
        openToPlans: true,
        intents: ['Food'],
        groupPreference: 'small_group',
        maxTravelMinutes: 20,
        visibility: 'followers',
        source: 'explicit',
        socialAvailability: 'maybe',
        expiresAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as UseAvailabilityEditorResult['currentWindow'],
    });

    await render(<AvailabilityView editor={editor} />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Set Availability'));
    });

    expect(events.some((e) => e.type === 'availability_set')).toBe(true);
    expect(events.some((e) => e.type === 'open_to_plans_enabled')).toBe(false);
  });

  it('emits nothing when the save fails', async () => {
    const editor = makeEditor({ save: jest.fn().mockResolvedValue({ ok: false, enabled: true, message: 'nope' }) });
    await render(<AvailabilityView editor={editor} />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Set Availability'));
    });

    expect(events).toHaveLength(0);
  });
});
