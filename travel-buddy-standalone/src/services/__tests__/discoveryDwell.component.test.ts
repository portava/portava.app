// SDK boundary only; real observed owner, token binding and owned HTTP transport run.
jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners,
    onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; },
  } } };
});
/**
 * discoveryDwell — `04` §7's three dwell kinds, classified from real signals,
 * and the sender's gates (census-discovery DV-41, §55).
 *
 *   K1  the ACTIVE / PASSIVE boundary sits exactly `windowMs` after the last touch
 *   K2  a touch re-arms the window; a drain hands back what accumulated and resets
 *   K3  BACKGROUNDING MID-DWELL: time out of the foreground is idle, and
 *       returning is not a touch
 *   K4  idle is never active, however recent the last touch; a touch while
 *       backgrounded does not count
 *   K5  a clock that steps backwards never produces negative or invented time
 *   K6  the emission: only non-zero kinds, only with a bound exposure id
 *   K7  the sender: flag off ⇒ nothing (not even a token read); signed out ⇒
 *       nothing; one retry with the SAME body on a network failure or a 5xx;
 *       a 4xx is not retried
 *   K8  the interaction window is a named, UNRATIFIED placeholder
 *
 * Run with: pnpm test:component
 */
import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken, emitObservedAuthEvent, observedOwnerSession } from './observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../discoveryViewerScope.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// NOTE: intentionally exhaustive — apiToken imports the Supabase client; only
// freshToken is needed and a controllable token is all these tests require.
const mockFreshToken = jest.fn<Promise<string | null>, []>();
jest.mock('../apiToken.ts', () => ({ freshToken: () => mockFreshToken() }));

import {
  classifyInterval,
  createDwellTracker,
  dwellEmissionFor,
  sendDwellEmission,
  DWELL_INTERACTION_WINDOW_MS,
  type DwellEmission,
} from '../discoveryDwell.ts';

const W = 10_000;
const RID = 'Ab3_-x9QzW7kLmN2pR4tUv';
const CEID = '0f0f0f0f-1111-4222-8333-444444444444';

const fetchMock = jest.fn((_url: string, _init?: RequestInit) => Promise.resolve({ ok: true, status: 200 } as Response));
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  setDiscoveryViewerFromSession('dwell-owner-a'); seedObservedOwnerSession('dwell-owner-a','dwell-session-a');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  fetchMock.mockImplementation((_url, init) => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, recorded: JSON.parse(String(init?.body)).dwell.length, duplicates: 0 }) } as Response));
  mockFreshToken.mockReset();
  mockFreshToken.mockImplementation(async () => observedOwnerAccessToken('dwell-owner-a','dwell-session-a'));
});
afterEach(() => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); });
afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_BASE;
});

describe('K1 — the active / passive boundary', () => {
  it('is exactly windowMs after the last touch', () => {
    const s = { foreground: true, lastInteractionMs: 0, windowMs: W };
    expect(classifyInterval(0, W - 1, s)).toEqual({ active: W - 1, passive_foreground: 0, idle: 0 });
    expect(classifyInterval(0, W, s)).toEqual({ active: W, passive_foreground: 0, idle: 0 });
    expect(classifyInterval(0, W + 1, s)).toEqual({ active: W, passive_foreground: 1, idle: 0 });
    expect(classifyInterval(W, W + 500, s)).toEqual({ active: 0, passive_foreground: 500, idle: 0 });
    expect(classifyInterval(W - 1, W + 1, s)).toEqual({ active: 1, passive_foreground: 1, idle: 0 });
  });
});

describe('K2 — touches and drains', () => {
  it('a touch re-arms the window; a drain hands back what accumulated and resets', () => {
    const t = createDwellTracker(0, { windowMs: W });
    t.noteInteraction(8_000);
    expect(t.drain(20_000)).toEqual({ active: 18_000, passive_foreground: 2_000, idle: 0 });
    expect(t.drain(21_000)).toEqual({ active: 0, passive_foreground: 1_000, idle: 0 });
  });
});

describe('K3 — backgrounding mid-dwell', () => {
  it('splits the view at the background: foreground part, then idle, then passive until touched', () => {
    const t = createDwellTracker(0, { windowMs: W });
    t.noteInteraction(2_000);
    t.noteBackground(5_000);
    expect(t.drain(5_000)).toEqual({ active: 5_000, passive_foreground: 0, idle: 0 });
    t.noteForeground(65_000);
    expect(t.foreground).toBe(true);
    expect(t.drain(70_000)).toEqual({ active: 0, passive_foreground: 5_000, idle: 60_000 });
    t.noteInteraction(71_000);
    expect(t.drain(72_000)).toEqual({ active: 1_000, passive_foreground: 1_000, idle: 0 });
  });
});

describe('K4 — idle is never interest', () => {
  it('no time out of the foreground is active, however recent the touch, and a touch while away does not count', () => {
    const t = createDwellTracker(0, { windowMs: W });
    t.noteInteraction(1_000);
    t.noteBackground(1_000);
    t.noteInteraction(1_500);                    // cannot happen on a device; must not count if it does
    t.noteForeground(4_000);
    const d = t.drain(4_000);
    expect(d).toEqual({ active: 1_000, passive_foreground: 0, idle: 3_000 });
    // Back in the foreground inside the old touch's window: still NOT active until touched again.
    expect(t.drain(6_000)).toEqual({ active: 0, passive_foreground: 2_000, idle: 0 });
    t.noteInteraction(6_000);
    expect(t.drain(7_000)).toEqual({ active: 1_000, passive_foreground: 0, idle: 0 });
    expect(classifyInterval(0, 5_000, { foreground: false, lastInteractionMs: 0, windowMs: W })).toEqual({ active: 0, passive_foreground: 0, idle: 5_000 });
  });

  it('a surface opened while the app is not foreground is idle from its first millisecond', () => {
    const t = createDwellTracker(0, { windowMs: W, foreground: false });
    expect(t.drain(3_000)).toEqual({ active: 0, passive_foreground: 0, idle: 3_000 });
  });
});

describe('K5 — a clock that steps backwards', () => {
  it('never produces negative time and invents none', () => {
    const t = createDwellTracker(10_000, { windowMs: W });
    expect(t.drain(5_000)).toEqual({ active: 0, passive_foreground: 0, idle: 0 });
    expect(t.drain(12_000)).toEqual({ active: 2_000, passive_foreground: 0, idle: 0 });
    expect(classifyInterval(5, 1, { foreground: true, lastInteractionMs: 0, windowMs: W })).toEqual({ active: 0, passive_foreground: 0, idle: 0 });
  });
});

describe('K6 — the emission', () => {
  it('carries only non-zero kinds, in §7 order, and only with a bound exposure id', () => {
    const e = dwellEmissionFor('db/p1', RID, { active: 1200.4, passive_foreground: 0, idle: 0.4 }, CEID);
    expect(e).toEqual({ item_id: 'db/p1', surface: 'discovery', recommendation_id: RID, client_event_id: CEID, dwell: [{ kind: 'active', ms: 1200 }] });
    expect(dwellEmissionFor('db/p1', RID, { active: 0, passive_foreground: 0, idle: 0 }, CEID)).toBeNull();
    expect(dwellEmissionFor('db/p1', 'not-an-id', { active: 5, passive_foreground: 0, idle: 0 }, CEID)).toBeNull();
    expect(dwellEmissionFor('db/p1', undefined, { active: 5, passive_foreground: 0, idle: 0 }, CEID)).toBeNull();
    expect(dwellEmissionFor(null, RID, { active: 5, passive_foreground: 0, idle: 0 }, CEID)).toBeNull();
    const all = dwellEmissionFor('db/p1', RID, { idle: 3, active: 1, passive_foreground: 2 }, CEID)!;
    expect(all.dwell.map((d) => d.kind)).toEqual(['active', 'passive_foreground', 'idle']);
  });
});

describe('K7 — the sender', () => {
  const emission: DwellEmission = { item_id: 'db/p1', surface: 'discovery', recommendation_id: RID, client_event_id: CEID, dwell: [{ kind: 'idle', ms: 60_000 }] };

  it('flag OFF sends nothing and reads no token', async () => {
    await expect(sendDwellEmission(emission, { enabled: false })).resolves.toBe('skipped_disabled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockFreshToken).not.toHaveBeenCalled();
  });

  it('signed OUT sends nothing', async () => {
    disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null);
    mockFreshToken.mockImplementation(async () => null);
    await expect(sendDwellEmission(emission, { enabled: true })).resolves.toBe('skipped_signed_out');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signed in: one POST to /api/rank-events/dwell, as the viewer, with the emission verbatim', async () => {
    await expect(sendDwellEmission(emission, { enabled: true })).resolves.toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/api/rank-events/dwell');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${observedOwnerAccessToken('dwell-owner-a','dwell-session-a')}`);
    expect(JSON.parse(String(init!.body))).toEqual(emission);
  });

  it('a network failure is retried ONCE with the SAME body — the same client_event_id', async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await expect(sendDwellEmission(emission, { enabled: true })).resolves.toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]!.body).toBe(fetchMock.mock.calls[1]![1]!.body);
  });

  it('a 5xx is retried once; a second 5xx gives up', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 503 } as Response));
    await expect(sendDwellEmission(emission, { enabled: true })).resolves.toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 4xx (flag off on the server, an unbindable exposure) is not retried', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404 } as Response));
    await expect(sendDwellEmission(emission, { enabled: true })).resolves.toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('K8 — the interaction window', () => {
  it('is a named placeholder, marked UNRATIFIED where it is declared', () => {
    const src = readFileSync(join(__dirname, '..', 'discoveryDwell.ts'), 'utf8');
    const decl = src.indexOf('export const DWELL_INTERACTION_WINDOW_MS');
    expect(decl).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, decl - 400), decl)).toMatch(/UNRATIFIED/);
    expect(DWELL_INTERACTION_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe('K9 — owner and live collection boundaries across awaits', () => {
  const emission: DwellEmission = { item_id: 'db/p1', surface: 'discovery', recommendation_id: RID, client_event_id: CEID, dwell: [{kind:'active',ms:5000}] };
  const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
  it('never sends old-view bytes with a token resolved after an account switch', async () => {
    let resolve!: (value:string)=>void;
    mockFreshToken.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const pending=sendDwellEmission(emission,{enabled:true}); await flush();
    setDiscoveryViewerFromSession('dwell-owner-b');
    emitObservedAuthEvent('SIGNED_IN',observedOwnerSession('dwell-owner-b','dwell-session-b'));
    resolve(observedOwnerAccessToken('dwell-owner-b','dwell-session-b'));
    expect(await pending).toBe('refused'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rechecks collection after token work and never retries a withdrawn measurement', async () => {
    let enabled=true,resolve!: (value:string)=>void;
    mockFreshToken.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const pending=sendDwellEmission(emission,{enabled:true,isCurrent:()=>enabled}); await flush();
    enabled=false;resolve(observedOwnerAccessToken('dwell-owner-a','dwell-session-a'));
    expect(await pending).toBe('refused');expect(fetchMock).not.toHaveBeenCalled();
    expect(mockFreshToken).toHaveBeenCalledTimes(1);
  });
  it('does not retry a failed request after the original session ends', async () => {
    fetchMock.mockImplementationOnce(async()=>{
      emitObservedAuthEvent('SIGNED_OUT',null);
      emitObservedAuthEvent('SIGNED_IN',observedOwnerSession('dwell-owner-a','replacement-session'));
      return {ok:false,status:503} as Response;
    });
    expect(await sendDwellEmission(emission,{enabled:true})).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('aborts stalled transport on an owner change without waiting for its deadline', async () => {
    fetchMock.mockImplementationOnce(()=>new Promise(()=>{}));
    const pending=sendDwellEmission(emission,{enabled:true});await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setDiscoveryViewerFromSession('dwell-owner-b');
    expect(await pending).toBe('refused');
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('K10 — confirmed receipts and same-account session replacement', () => {
  const emission: DwellEmission = { item_id: 'db/p1', surface: 'discovery', recommendation_id: RID, client_event_id: CEID, dwell: [{ kind: 'active', ms: 5000 }] };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  it('does not accept malformed or partial success; retries once with the identical body', async () => {
    for (const receipt of [null, [], {}, { ok: true }, { ok: true, recorded: 0, duplicates: 0 },
      { ok: true, recorded: -1, duplicates: 2 }, { ok: true, recorded: 0.5, duplicates: 0.5 }]) {
      fetchMock.mockClear();
      fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => receipt } as Response));
      expect(await sendDwellEmission(emission, { enabled: true })).toBe('failed');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1]!.body).toBe(fetchMock.mock.calls[1][1]!.body);
    }
  });
  it('accepts a confirmed exact duplicate after an ambiguous response, but never an explicit refusal', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async (): Promise<unknown> => { throw new Error('truncated response'); } } as Response));
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, recorded: 0, duplicates: 1 }) } as Response));
    expect(await sendDwellEmission(emission, { enabled: true })).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, recorded: 1, duplicates: 0 }) } as Response));
    expect(await sendDwellEmission(emission, { enabled: true })).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('SDK session replacement aborts a stalled request while Discovery viewer stays the same', async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const pending = sendDwellEmission(emission, { enabled: true }); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('dwell-owner-a', 'replacement-session'));
    await flush();
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(await pending).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('a receipt decoded after the original session ends cannot acknowledge or retry', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: () => new Promise(done => { resolve = done; }) } as Response));
    const pending = sendDwellEmission(emission, { enabled: true }); await flush();
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('dwell-owner-a', 'replacement-session'));
    resolve({ ok: true, recorded: 1, duplicates: 0 });
    expect(await pending).toBe('refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
