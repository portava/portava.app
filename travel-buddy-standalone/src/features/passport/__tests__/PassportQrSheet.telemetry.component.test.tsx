/**
 * Telemetry tests for the Share-Passport sheet (§32 passport_shared, §25).
 *
 * Each share action emits passport_shared with a METHOD enum only — never the
 * link, the handle or any profile field:
 *   • Copy Link  → { method: 'copy' }
 *   • Share Link → { method: 'share_sheet' }
 *   • Bump (only after the affirmative confirmation, §25) → { method: 'bump' }
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PassportQrSheet } from '../PassportQrSheet.tsx';
import { buildQrProjection, type MinimalQrProjection } from '../passportQrProjection.ts';
import {
  setPassportTelemetrySink,
  resetPassportTelemetrySink,
  type PassportTelemetryEvent,
} from '../passportTelemetry.ts';

// NOTE: react-native-svg needs native modules unavailable under jest-expo; a
// Proxy stand-in returns a View for every element so the sheet + QR render.
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Any = (props: any) => React.createElement(View, props, props.children);
  return new Proxy(
    { __esModule: true, default: Any },
    { get: (target: any, key: string) => (key in target ? target[key] : Any) },
  );
});

// NOTE: exhaustive stub — expo-clipboard is native; setStringAsync is the only
// member the sheet calls.
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(true),
}));

// NOTE: exhaustive stub — usePassportShare opens the native share sheet; the
// test only asserts the telemetry emitted when Share Link is pressed.
jest.mock('../../../hooks/usePassportShare', () => ({
  usePassportShare: () => ({ cardRef: { current: null }, share: jest.fn(), sharing: false, error: null }),
}));

// NOTE: exhaustive stub — PassportShareCard reaches native view-shot code.
jest.mock('../../../components/PassportShareCard', () => {
  const React = require('react');
  return { PassportShareCard: React.forwardRef(() => null) };
});
// NOTE: exhaustive stub — CachedImage reaches native image caching; only mounted.
jest.mock('../../../components/CachedImage', () => ({ CachedImage: () => null }));
// NOTE: exhaustive stub — VerifiedStamp draws with react-native-svg; not tested.
jest.mock('../../../components/ui/VerifiedStamp', () => ({ VerifiedStamp: () => null }));

// NOTE: safe-area provider isn't mounted in unit renders.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const MINIMAL: MinimalQrProjection = buildQrProjection({
  name: 'Ada Lovelace',
  handle: 'ada',
  avatarUrl: null,
  verified: true,
  verificationLevel: 'trusted_traveler',
  homeCountry: 'United Kingdom',
  interests: ['Food'],
});

let events: PassportTelemetryEvent[];
beforeEach(() => {
  events = [];
  setPassportTelemetrySink((e) => events.push(e));
});
afterEach(() => {
  resetPassportTelemetrySink();
});

function methods(): string[] {
  return events.filter((e) => e.type === 'passport_shared').map((e) => (e.payload as { method: string }).method);
}

describe('PassportQrSheet — §32 passport_shared telemetry', () => {
  it('emits passport_shared { method: "copy" } on Copy Link', async () => {
    await render(<PassportQrSheet visible onClose={() => {}} username="ada" projection={MINIMAL} />);

    fireEvent.press(screen.getByLabelText('Copy Link'));
    await waitFor(() => expect(methods()).toContain('copy'));

    // Ids/enum only — the handle / deep link never travel with the event.
    expect(JSON.stringify(events)).not.toContain('ada');
  });

  it('emits passport_shared { method: "share_sheet" } on Share Link', async () => {
    await render(<PassportQrSheet visible onClose={() => {}} username="ada" projection={MINIMAL} />);

    fireEvent.press(screen.getByLabelText('Share Link'));
    expect(methods()).toEqual(['share_sheet']);
  });

  it('emits passport_shared { method: "bump" } only after the affirmative confirm', async () => {
    await render(
      <PassportQrSheet visible onClose={() => {}} username="ada" projection={MINIMAL} initialPanel="bump" />,
    );

    // Arming the exchange must NOT emit — only the confirm does (§25).
    fireEvent.press(screen.getByLabelText('Start Bump'));
    await waitFor(() => expect(screen.getByLabelText('Confirm exchange')).toBeTruthy());
    expect(methods()).not.toContain('bump');

    fireEvent.press(screen.getByLabelText('Confirm exchange'));
    await waitFor(() => expect(methods()).toContain('bump'));
  });
});
