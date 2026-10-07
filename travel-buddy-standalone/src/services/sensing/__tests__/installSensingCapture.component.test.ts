/**
 * installSensingCapture, driven — OD-MAP-6's three consents as the device obeys
 * them (census-sensing §34 owed this: §33.1's "the device obeys it" rested on
 * the pure decision and source tripwires only).
 *
 * The installer runs for real. Around it: a fake consent reader (and its change
 * channel), a fake capture loop that records the `submit` the installer hands
 * it, and a fake transport that records every send and reset. Nothing reaches a
 * sensor or the network.
 *
 * WHAT IS PINNED.
 *   - capture not in effect, or an UNREADABLE consent → no loop starts;
 *   - capture without upload → the loop runs, and every submit is DROPPED
 *     before the transport;
 *   - capture + upload → a submit reaches the transport;
 *   - withdrawing upload in Settings (the change channel) → the next submit is
 *     dropped and the transport's session is reset;
 *   - withdrawing capture → the loop is stopped and the zone hint cleared;
 *   - dispose() stops the loop and unsubscribes.
 *
 * Run with: pnpm test:component
 */

type Consent = { capture: boolean; upload: boolean; surface: boolean } | 'unreadable';

let mockConsent: Consent = { capture: false, upload: false, surface: false };
const mockListeners = new Set<() => void>();
const mockTransportSubmit = jest.fn(async () => ({ status: 'sent' }));
const mockTransportReset = jest.fn();
const mockStop = jest.fn();
let mockCaptureDeps: { submit: (p: unknown) => void | Promise<void> } | null = null;
let mockStarts = 0;
const mockZoneSources: Array<unknown> = [];

// NOTE: exhaustive-by-design — the real module reads the server over the network.
jest.mock('../../sensingConsent.ts', () => ({
  readSensingConsent: async () => {
    if (mockConsent === 'unreadable') return { status: 'unreadable', reason: 'network' };
    const c = mockConsent;
    const entry = (on: boolean) => ({ granted: on, effective: on, version: 'v', serverVersion: 'v' });
    return { status: 'ok', state: { available: true, consents: { capture: entry(c.capture), upload: entry(c.upload), surface: entry(c.surface) } } };
  },
  onSensingConsentChange: (fn: () => void) => { mockListeners.add(fn); return () => mockListeners.delete(fn); },
}));
// NOTE: exhaustive-by-design — the real loop reads device sensors; this one records what the installer gives it.
jest.mock('../sensingCapture.ts', () => ({
  startSensingCapture: (deps: { submit: (p: unknown) => void | Promise<void> }) => {
    mockStarts++;
    mockCaptureDeps = deps;
    return { flush: async () => {}, stop: mockStop, currentZone: () => 'zone-1' };
  },
}));
// NOTE: exhaustive-by-design — the real transport issues sessions over the network.
jest.mock('../sensingTransport.ts', () => ({
  createSensingTransport: () => ({ submit: mockTransportSubmit, reset: mockTransportReset }),
}));
// NOTE: exhaustive-by-design — expo-sensors / expo-location / the microphone are not available under jest.
jest.mock('../deviceSensorSources.ts', () => ({
  createDeviceMotionSource: () => null,
  createDeviceLocationSource: () => null,
}));
// NOTE: exhaustive-by-design — no microphone under jest.
jest.mock('../acousticMeterSource.ts', () => ({ createAcousticMeterSource: () => null }));
// NOTE: exhaustive-by-design — the permission store is native.
jest.mock('../acousticSensingPermission.ts', () => ({
  readAcousticSensingPermission: async () => ({ granted: false, osGranted: false }),
}));
// NOTE: exhaustive-by-design — records what the installer registers.
jest.mock('../sensingZoneHint.ts', () => ({
  registerSensingZoneSource: (fn: unknown) => { mockZoneSources.push(fn); },
}));
// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../../apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import { installSensingCapture } from '../installSensingCapture.ts';

const PAYLOAD = { features: { dwellMs: 1 } };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const changeConsent = async (c: Consent) => { mockConsent = c; for (const fn of [...mockListeners]) fn(); await flush(); };

let disposeAll: Array<() => void> = [];
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
  mockConsent = { capture: false, upload: false, surface: false };
  mockListeners.clear();
  mockTransportSubmit.mockClear();
  mockTransportReset.mockClear();
  mockStop.mockClear();
  mockCaptureDeps = null;
  mockStarts = 0;
  mockZoneSources.length = 0;
});
afterEach(() => { for (const d of disposeAll) d(); disposeAll = []; });

async function install() {
  const h = installSensingCapture();
  disposeAll.push(() => h.dispose());
  await flush();
  return h;
}

describe('installSensingCapture obeys OD-MAP-6 on the device', () => {
  it('capture not granted: no loop starts', async () => {
    await install();
    expect(mockStarts).toBe(0);
    expect(mockCaptureDeps).toBeNull();
  });

  it('an UNREADABLE consent starts nothing — never "probably still on"', async () => {
    mockConsent = 'unreadable';
    await install();
    expect(mockStarts).toBe(0);
  });

  it('capture without upload: the loop runs on the device, and every submit is dropped before the transport', async () => {
    mockConsent = { capture: true, upload: false, surface: false };
    await install();
    expect(mockStarts).toBe(1);
    await mockCaptureDeps!.submit(PAYLOAD);
    await mockCaptureDeps!.submit(PAYLOAD);
    expect(mockTransportSubmit).not.toHaveBeenCalled();
  });

  it('capture + upload: a submit reaches the transport', async () => {
    mockConsent = { capture: true, upload: true, surface: false };
    await install();
    await mockCaptureDeps!.submit(PAYLOAD);
    expect(mockTransportSubmit).toHaveBeenCalledTimes(1);
    expect(mockTransportSubmit).toHaveBeenCalledWith(PAYLOAD);
  });

  it('withdrawing UPLOAD in Settings: the next submit is dropped and the transport session is reset; the loop keeps running', async () => {
    mockConsent = { capture: true, upload: true, surface: false };
    await install();
    await mockCaptureDeps!.submit(PAYLOAD);
    expect(mockTransportSubmit).toHaveBeenCalledTimes(1);
    await changeConsent({ capture: true, upload: false, surface: false });
    expect(mockTransportReset).toHaveBeenCalled();
    await mockCaptureDeps!.submit(PAYLOAD);
    expect(mockTransportSubmit).toHaveBeenCalledTimes(1);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('withdrawing CAPTURE in Settings: the loop is stopped and the zone hint is cleared', async () => {
    mockConsent = { capture: true, upload: true, surface: false };
    await install();
    await changeConsent({ capture: false, upload: false, surface: false });
    expect(mockStop).toHaveBeenCalled();
    expect(mockZoneSources[mockZoneSources.length - 1]).toBeNull();
  });

  it('a consent that becomes unreadable on re-check stops the loop and sends nothing', async () => {
    mockConsent = { capture: true, upload: true, surface: false };
    await install();
    await changeConsent('unreadable');
    expect(mockStop).toHaveBeenCalled();
    await mockCaptureDeps!.submit(PAYLOAD);
    expect(mockTransportSubmit).not.toHaveBeenCalled();
  });

  it('dispose() stops the loop and stops listening for consent changes', async () => {
    mockConsent = { capture: true, upload: true, surface: false };
    const h = await install();
    expect(mockListeners.size).toBe(1);
    h.dispose();
    expect(mockStop).toHaveBeenCalled();
    expect(mockListeners.size).toBe(0);
  });
});
