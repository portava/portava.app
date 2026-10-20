import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { ACOUSTIC_PERMISSION_STORAGE_KEY, ACOUSTIC_SENSING_SCOPE, acousticCaptureAllowed } from '../../../src/lib/sensing/acousticPermission';

const mockReadConsent = jest.fn();
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockOsRead = jest.fn();
const mockOsRequest = jest.fn();
const mockStorage = new Map<string, string>();
let mockPermission: typeof import('../../../src/services/sensing/acousticSensingPermission');
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { back: jest.fn(), push: jest.fn(), canGoBack: () => true },
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../src/hooks/useIntelPrompts', () => ({
  ...jest.requireActual('../../../src/hooks/useIntelPrompts'),
  useIntelPrompts: () => ({
    captureEnabled: true, pauseState: { pausedAll: false, pausedCategories: [] }, sessionPaused: false,
    pauseSession: jest.fn(), resumeSession: jest.fn(), pauseAll: jest.fn(), pauseCategory: jest.fn(), resumeEverything: jest.fn(),
  }),
}));
jest.mock('../../../src/services/intelConsent', () => ({
  ...jest.requireActual('../../../src/services/intelConsent'),
  readIntelConsent: () => mockReadConsent(),
}));
jest.mock('../../../src/services/sensingConsent', () => ({
  ...jest.requireActual('../../../src/services/sensingConsent'),
  readSensingConsent: async () => ({ status: 'unreadable', reason: 'not_configured' }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  ...jest.requireActual('@react-native-async-storage/async-storage'),
  getItem: (key: string) => mockGet(key), setItem: (key: string, value: string) => mockSet(key, value),
}));
/** NOTE: Exhaustive native boundary; importing Expo AV requires the unavailable ExponentAV device module. */
jest.mock('expo-av', () => ({
  Audio: { getPermissionsAsync: () => mockOsRead(), requestPermissionsAsync: () => mockOsRequest() },
}));
jest.mock('../../../src/services/sensing/acousticSensingPermission', () => ({
  ...jest.requireActual('../../../src/services/sensing/acousticSensingPermission'),
  readAcousticSensingPermission: () => mockPermission.readAcousticSensingPermission(),
  requestAcousticSensingPermission: () => mockPermission.requestAcousticSensingPermission(),
  withdrawAcousticSensingPermission: () => mockPermission.withdrawAcousticSensingPermission(),
  getAcousticSensingPermissionSnapshot: () => mockPermission.getAcousticSensingPermissionSnapshot(),
  onAcousticSensingPermissionChange: (listener: Parameters<typeof mockPermission.onAcousticSensingPermissionChange>[0]) => mockPermission.onAcousticSensingPermissionChange(listener),
}));
import IntelPromptsSettingsScreen from '../intel-prompts';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function settle() { await act(async () => { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve(); }); }
const grant = { scope: ACOUSTIC_SENSING_SCOPE, granted: true, grantedAt: '2026-10-16T12:00:00.000Z', revokedAt: null, osMicrophoneGranted: true };
const general = { enabled: true, consentVersion: 'intel_contributions_v1', consentedAt: '2026-09-01T00:00:00Z', withdrawnAt: null, currentDisclosureVersion: 'intel_contributions_v1' };
type Screen = Awaited<ReturnType<typeof render>>;
function soundSwitch(screen: Screen) {
  let node = screen.getByText('Use a coarse sound level').parent;
  while (node) {
    const control = within(node).queryByRole('switch');
    if (control) return control;
    node = node.parent;
  }
  throw Error('missing actual sound control');
}
async function mount(saved = true) {
  if (saved) mockStorage.set(ACOUSTIC_PERMISSION_STORAGE_KEY, JSON.stringify(grant));
  const screen = await render(<IntelPromptsSettingsScreen />); await settle(); return screen;
}
beforeEach(() => {
  mockStorage.clear();
  mockGet.mockReset().mockImplementation(async (key) => mockStorage.get(key) ?? null);
  mockSet.mockReset().mockImplementation(async (key, value) => { mockStorage.set(key, value); });
  mockOsRead.mockReset().mockResolvedValue({ granted: true });
  mockOsRequest.mockReset().mockResolvedValue({ granted: true });
  mockReadConsent.mockReset().mockResolvedValue({ status: 'ok', state: general });
  jest.isolateModules(() => { mockPermission = jest.requireActual('../../../src/services/sensing/acousticSensingPermission'); });
});

describe('Mounted sound-level permission truth and lifetime', () => {
  test('healthy explicit grant, saved withdrawal, and passive mount do not add prompts', async () => {
    const screen = await mount(false);
    expect(soundSwitch(screen).props.value).toBe(false);
    expect(mockOsRequest).not.toHaveBeenCalled();
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', true); });
    expect(soundSwitch(screen).props.value).toBe(true);
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', false); });
    expect(soundSwitch(screen).props.value).toBe(false);
    expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!).granted).toBe(false);
    expect(mockOsRequest).toHaveBeenCalledTimes(1);
  });
  test('failed withdrawal shows local off, restart limit, and explicit persistence retry without a prompt', async () => {
    const screen = await mount();
    mockSet.mockRejectedValueOnce(Error('disk'));
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', false); });
    expect(soundSwitch(screen).props.value).toBe(false);
    expect(screen.getByText(/prior saved setting may return after.*restart/i)).toBeTruthy();
    expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!).granted).toBe(true);
    expect(acousticCaptureAllowed(await mockPermission.readAcousticSensingPermission())).toBe(false);
    await act(async () => { fireEvent.press(screen.getByText('Retry saving withdrawal')); });
    expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!).granted).toBe(false);
    expect(screen.queryByText('Retry saving withdrawal')).toBeNull();
    expect(mockOsRequest).not.toHaveBeenCalled();
  });
  test('pending withdrawal immediately displays off, not saved success', async () => {
    const screen = await mount(); const held = deferred<void>();
    mockSet.mockImplementationOnce(() => held.promise);
    await act(async () => { void fireEvent(soundSwitch(screen), 'valueChange', false); });
    expect(soundSwitch(screen).props.value).toBe(false);
    expect(screen.getByText(/Updating sound-level permission/)).toBeTruthy();
    await act(async () => { held.resolve(); });
  });
  test('failed grant stays off and reports failure', async () => {
    const screen = await mount(false); mockSet.mockRejectedValueOnce(Error('disk'));
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', true); });
    expect(soundSwitch(screen).props.value).toBe(false);
    expect(screen.getByText(/Couldn.t save.*sound-level grant/)).toBeTruthy();
    expect(mockOsRequest).toHaveBeenCalledTimes(1);
  });
  test('a failed later grant does not hide the failed-withdrawal restart risk', async () => {
    const screen = await mount(); mockSet.mockRejectedValue(Error('disk'));
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', false); });
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', true); });
    expect(soundSwitch(screen).props.value).toBe(false);
    expect(screen.getByText(/prior saved setting may return after.*restart/i)).toBeTruthy();
    expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!).granted).toBe(true);
    expect(mockOsRequest).toHaveBeenCalledTimes(1);
  });
  test('late initial read cannot repaint a withdrawal from another mounted caller', async () => {
    const held = deferred<string | null>(); mockGet.mockImplementationOnce(() => held.promise);
    const screen = await mount();
    await act(async () => { await mockPermission.withdrawAcousticSensingPermission(); });
    await act(async () => { held.resolve(JSON.stringify(grant)); });
    expect(soundSwitch(screen).props.value).toBe(false);
  });
  test('pending explicit grant can be cancelled; late OS grant cannot repaint on', async () => {
    const held = deferred<{ granted: boolean }>(); mockOsRequest.mockReturnValueOnce(held.promise);
    const screen = await mount(false);
    await act(async () => { void fireEvent(soundSwitch(screen), 'valueChange', true); });
    expect(soundSwitch(screen).props.value).toBe(true);
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', false); });
    await act(async () => { held.resolve({ granted: true }); });
    expect(soundSwitch(screen).props.value).toBe(false);
    expect(JSON.parse(mockStorage.get(ACOUSTIC_PERMISSION_STORAGE_KEY)!).granted).toBe(false);
  });
  test('captured unmounted callback cannot prompt or write', async () => {
    const screen = await mount(false); const callback = soundSwitch(screen).props.onChange;
    await screen.unmount(); await act(async () => { callback({ nativeEvent: { value: true } }); });
    expect(mockOsRequest).not.toHaveBeenCalled(); expect(mockSet).not.toHaveBeenCalled();
  });
  test.each(['off', 'unreadable'] as const)('general consent %s prevents grants but never blocks withdrawing saved purpose', async (status) => {
    mockReadConsent.mockResolvedValue(status === 'off' ? { status: 'ok', state: { ...general, enabled: false } } : { status: 'unreadable', reason: 'network' });
    const screen = await mount(); expect(soundSwitch(screen).props.disabled).toBe(false);
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', false); });
    expect(soundSwitch(screen).props.value).toBe(false);
    expect(soundSwitch(screen).props.disabled).toBe(true);
    const callback = soundSwitch(screen).props.onChange;
    await act(async () => { callback({ nativeEvent: { value: true } }); }); expect(mockOsRequest).not.toHaveBeenCalled();
  });
  test('OS denial does not hide saved purpose intent or prevent withdrawal', async () => {
    mockOsRead.mockResolvedValue({ granted: false });
    const screen = await mount(); expect(soundSwitch(screen).props.value).toBe(true);
    expect(screen.getByText(/microphone permission.*not.*granted/i)).toBeTruthy();
    await act(async () => { fireEvent(soundSwitch(screen), 'valueChange', false); });
    expect(soundSwitch(screen).props.value).toBe(false); expect(mockOsRequest).not.toHaveBeenCalled();
  });
  test('disclosure acknowledges temporary recording and cleanup limits without claiming audio upload', async () => {
    const screen = await mount();
    expect(screen.queryByText(/No audio is recorded, kept or sent/)).toBeNull();
    expect(screen.getByText(/temporary.*recording/i)).toBeTruthy();
    expect(screen.getByText(/files may remain/i)).toBeTruthy();
    expect(screen.getByText(/coarse summaries, not.*recording/i)).toBeTruthy();
  });
});
