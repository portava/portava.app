/**
 * Location & Availability — the "Pause sharing" switch says what it now does (census-telegraph T29 /
 * T421, lead ruling P-T1).
 *
 * Pausing location sharing (or choosing location mode Off) engages invisible mode on the server, and
 * under P-T1 invisible mode withholds the person's availability from EVERYONE, crew included. The
 * switch used to say only "Temporarily stop all location sharing". These cases render the REAL screen
 * (the same harness as location.prefsUnreadable) and pin:
 *   - the switch's own line names the availability consequence, crew included, BEFORE it is pressed;
 *   - while invisible mode is engaged (paused, or mode Off) a notice says what is hidden and that the
 *     person's own map keeps working; when it is not engaged, no notice;
 *   - pressing the switch saves sharingPaused and the notice appears with it;
 *   - the device's rule is the server's rule (lib/invisibleMode.ts read and compared).
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import {
  render, act, waitFor, fireEvent, cleanup, screen,
} from '@testing-library/react-native';
import LocationAvailabilityScreen from '../location.tsx';
import { getMyLocationPrivacy } from '../../../../src/services/map.ts';
import { getCircleSettings } from '../../../../src/services/circle.ts';
import { updateMyLocationPrivacy } from '../../../../src/services/map.ts';
import {
  INVISIBLE_DISCOVERY_VALUES, INVISIBLE_MODE_NOTICE, PAUSE_SHARING_SUBTITLE, engagesInvisibleMode,
} from '../../../../src/features/telegraph/presence/invisibleMode.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── expo-router ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useNavigation: () => ({ addListener: jest.fn(() => jest.fn()) }),
}));

// ── react-native-safe-area-context ────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ── map service (the unit under test) ─────────────────────────────────────────

jest.mock('../../../../src/services/map', () => ({
  ...jest.requireActual('../../../../src/services/map'),
  getMyLocationPrivacy: jest.fn(),
  updateMyLocationPrivacy: jest.fn(),
}));

// ── circle service — the other half of this screen, held successful so the
//    single "Failed to load settings." string can only come from the Location
//    half we are asserting on. ────────────────────────────────────────────────

jest.mock('../../../../src/services/circle', () => ({
  ...jest.requireActual('../../../../src/services/circle'),
  getCircleSettings: jest.fn(),
  patchCircleSettings: jest.fn(),
  pauseAllCircleSharing: jest.fn(),
}));

// ── session ───────────────────────────────────────────────────────────────────

jest.mock('../../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../../src/context/SessionContext'),
  useSession: () => ({ isAuthed: true, configured: true, userId: 'user-1' }),
}));

// ── useBottomInset — not under test ──────────────────────────────────────────

// NOTE: intentionally exhaustive — useBottomInset imports native inset hooks
// unavailable in the jest-expo environment; only these three are referenced by
// SettingsUI and their stubs are safe to hard-code.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

// ── KeyboardSafeView — not under test ────────────────────────────────────────

jest.mock('../../../../src/components/ui/KeyboardSafeView', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeView: ({ children }: { children: React.ReactNode }) =>
      R.createElement(View, null, children),
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) =>
      R.createElement(View, null, children),
  };
});

const mockGetPrivacy = getMyLocationPrivacy as jest.Mock;
const mockGetCircleSettings = getCircleSettings as jest.Mock;

function circleSettings() {
  return {
    ok: true,
    data: {
      globalEnabled: false,
      visibilityMode: 'status_only',
      tripSharingDefault: 'off',
      eventSharingDefault: 'off',
      isPaused: false,
      pausedUntil: null,
      consentVersion: null,
      consentedAt: null,
      currentConsentVersion: 'v1',
      updatedAt: null,
    },
  };
}


function prefs(over: Record<string, unknown> = {}) {
  return {
    locationMode: 'city_only' as const,
    sharingPaused: false,
    pulseVisibility: null,
    discoveryVisibility: null,
    safeReturnEnabled: false,
    trustedCircleShare: false,
    hotelBlurEnabled: true,
    ...over,
  };
}

beforeEach(() => {
  mockGetCircleSettings.mockResolvedValue(circleSettings());
  (updateMyLocationPrivacy as jest.Mock).mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

async function openScreen() {
  await act(async () => {
    render(<LocationAvailabilityScreen />);
  });
  await waitFor(() => expect(screen.getByText('Pause sharing')).toBeTruthy());
}

describe('T29 / P-T1 — the Pause sharing switch says it hides your availability, crew included', () => {
  it('the switch line names the consequence before it is pressed', async () => {
    mockGetPrivacy.mockResolvedValue(prefs());
    await openScreen();
    expect(screen.getByText(PAUSE_SHARING_SUBTITLE)).toBeTruthy();
    expect(PAUSE_SHARING_SUBTITLE).toMatch(/availability is hidden from everyone, crew included/);
    expect(screen.queryByText('Temporarily stop all location sharing')).toBeNull();
  });

  it('visible person: no invisible notice', async () => {
    mockGetPrivacy.mockResolvedValue(prefs());
    await openScreen();
    expect(screen.queryByTestId('location-invisible-mode-notice')).toBeNull();
  });

  it('paused: the notice says what is hidden and that their own map keeps working', async () => {
    mockGetPrivacy.mockResolvedValue(prefs({ sharingPaused: true }));
    await openScreen();
    const notice = screen.getByTestId('location-invisible-mode-notice');
    expect(notice.props.children).toBe(INVISIBLE_MODE_NOTICE);
    expect(INVISIBLE_MODE_NOTICE).toMatch(/hidden from everyone, crew included/);
    expect(INVISIBLE_MODE_NOTICE).toMatch(/Your own map keeps working/);
  });

  it('location mode Off engages it too, so the notice shows there as well', async () => {
    mockGetPrivacy.mockResolvedValue(prefs({ locationMode: 'off' }));
    await openScreen();
    expect(screen.getByTestId('location-invisible-mode-notice')).toBeTruthy();
  });

  it('pressing the switch saves sharingPaused and the notice appears with it', async () => {
    mockGetPrivacy.mockResolvedValue(prefs());
    await openScreen();
    const sw = screen.getByTestId('location-pause-sharing-switch');
    expect(sw.props.value).toBe(false);
    await act(async () => { fireEvent(sw, 'valueChange', true); });
    await waitFor(() => expect(updateMyLocationPrivacy).toHaveBeenCalledWith({ sharingPaused: true }));
    expect(screen.getByTestId('location-invisible-mode-notice')).toBeTruthy();
  });
});

describe('T29 / P-T1 — the device rule is the server rule', () => {
  const server = readFileSync(join(__dirname, '../../../../../artifacts/api-server/src/lib/invisibleMode.ts'), 'utf8');

  it('the hidden discovery values match the server set exactly', () => {
    const m = /const HIDDEN_DISCOVERY_VALUES = new Set<string>\(\[([^\]]*)\]\)/.exec(server);
    expect(m).toBeTruthy();
    const serverValues = m![1]!.split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter(Boolean);
    expect([...INVISIBLE_DISCOVERY_VALUES].sort()).toEqual(serverValues.sort());
  });

  it('the server still engages it on mode Off and on a pause (the two this screen controls)', () => {
    expect(server).toContain('if (mode === "off") reasons.push("location_mode_off");');
    expect(server).toContain('if (prefs?.sharing_paused === true) reasons.push("sharing_paused");');
  });

  it('engagesInvisibleMode: the truth table', () => {
    expect(engagesInvisibleMode({ locationMode: 'city_only', sharingPaused: false, discoveryVisibility: null })).toBe(false);
    expect(engagesInvisibleMode({ locationMode: 'off', sharingPaused: false, discoveryVisibility: null })).toBe(true);
    expect(engagesInvisibleMode({ locationMode: 'nearby', sharingPaused: true, discoveryVisibility: null })).toBe(true);
    expect(engagesInvisibleMode({ locationMode: 'nearby', sharingPaused: false, discoveryVisibility: 'no_location' })).toBe(true);
    expect(engagesInvisibleMode({ locationMode: 'nearby', sharingPaused: false, discoveryVisibility: 'city_only' })).toBe(false);
  });
});
