/**
 * Telegraph §17.4 — census-telegraph T239: the degradation ladder is driven by
 * a MEASURED connection, not only by a person's setting.
 *
 * "Low bandwidth → deprioritize typing, reactions, media preview and AI before
 *  text or safety coordination." The ladder and its order already existed
 * (useDataSaver); what did not was a signal. These cases pin, end to end:
 *   - the transport TIMES its answers and hands the duration to the monitor;
 *   - the monitor derives `constrained` from slow answers or an unreliable
 *     connection, and says nothing from too few samples;
 *   - the ladder then sheds media and AI — never text or safety — WITHOUT the
 *     setting being touched, and stops when the connection recovers;
 *   - the setting row says why it is shedding.
 */
import React from 'react';
import { render, renderHook, screen, act, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// NOTE: intentionally exhaustive — lib/supabase builds a client at import time,
// which fails outside an Expo runtime. The transport reads only these names.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: {},
  isSupabaseConfigured: true,
}));
// NOTE: intentionally exhaustive — the transport reads one function from it.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: async () => 'tok-1',
}));
// NOTE: intentionally exhaustive — the E2EE modules load native crypto; no call here touches them.
jest.mock('../../../lib/e2ee/threadCrypto.ts', () => ({
  buildOutgoingPayload: jest.fn(),
  establishE2ee: jest.fn(),
  decryptIncoming: jest.fn(),
  joinFromWelcomeIfNeeded: jest.fn(),
  E2EE_WELCOME_SUBTYPE: 'e2ee_welcome',
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../../lib/e2ee/realPort.ts', () => ({ realCryptoPort: {} }));

import {
  deriveBandwidthSignal,
  LATENCY_WINDOW,
  MIN_SAMPLES,
  SLOW_REQUEST_MS,
} from '../connection/bandwidthSignal.ts';
import {
  _resetConnectionMonitor,
  currentBandwidth,
  noteTelegraphRequest,
} from '../connection/connectionMonitor.ts';
import { effectiveDataSaverLevel, useDataSaver } from '../hooks/useDataSaver.ts';
import { DataSaverRow } from '../components/DataSaverRow.tsx';
import { getMyThreads } from '../../../services/messaging.ts';

const SLOW = SLOW_REQUEST_MS + 1500;
const FAST = 120;

function noteSlow(n: number) {
  for (let i = 0; i < n; i++) noteTelegraphRequest('ok', SLOW);
}
function noteFast(n: number) {
  for (let i = 0; i < n; i++) noteTelegraphRequest('ok', FAST);
}

beforeEach(async () => {
  _resetConnectionMonitor();
  await AsyncStorage.clear();
});

describe('deriveBandwidthSignal — the rule, pure', () => {
  it('normal by default', () => {
    expect(deriveBandwidthSignal({ connection: 'ONLINE', durationsMs: [] })).toEqual({ signal: 'normal', cause: null });
  });

  it('an unreliable connection is constrained, whatever the latency says', () => {
    for (const c of ['POOR_CONNECTION', 'RECONNECTING', 'OFFLINE'] as const) {
      expect(deriveBandwidthSignal({ connection: c, durationsMs: [FAST, FAST, FAST] })).toEqual({
        signal: 'constrained',
        cause: 'unreliable_connection',
      });
    }
  });

  it('a median answer slower than the threshold is constrained', () => {
    expect(deriveBandwidthSignal({ connection: 'ONLINE', durationsMs: [SLOW, SLOW, SLOW] }).cause).toBe('slow_responses');
  });

  it('too few answers are not a measurement', () => {
    expect(deriveBandwidthSignal({ connection: 'ONLINE', durationsMs: Array(MIN_SAMPLES - 1).fill(SLOW) }).signal).toBe('normal');
  });

  it('one slow outlier among fast answers is not a slow connection (median, not max)', () => {
    expect(deriveBandwidthSignal({ connection: 'ONLINE', durationsMs: [FAST, SLOW, FAST, FAST] }).signal).toBe('normal');
  });

  it('only the most recent window counts — a connection that recovered is normal again', () => {
    const durations = [...Array(LATENCY_WINDOW).fill(SLOW), ...Array(LATENCY_WINDOW).fill(FAST)];
    expect(deriveBandwidthSignal({ connection: 'ONLINE', durationsMs: durations }).signal).toBe('normal');
  });

  it('a nonsense duration is ignored rather than counted', () => {
    expect(
      deriveBandwidthSignal({ connection: 'ONLINE', durationsMs: [Number.NaN, -5, Number.POSITIVE_INFINITY, SLOW] }).signal,
    ).toBe('normal');
  });
});

describe('the monitor folds what the transport measured', () => {
  it('slow ANSWERED requests make the signal constrained; fast ones bring it back', () => {
    noteSlow(MIN_SAMPLES);
    expect(currentBandwidth()).toEqual({ signal: 'constrained', cause: 'slow_responses' });
    noteFast(LATENCY_WINDOW);
    expect(currentBandwidth().signal).toBe('normal');
  });

  it('a run of failed requests is an unreliable connection, whatever latency was seen', () => {
    noteTelegraphRequest('ok', FAST);
    for (let i = 0; i < 5; i++) noteTelegraphRequest('server');
    expect(currentBandwidth().cause).toBe('unreliable_connection');
  });
});

describe('the transport times its answers', () => {
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });

  it('apiGet hands the monitor how long the API took to answer', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ threads: [] }) }) as Response) as typeof fetch;
    let clock = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      clock += SLOW; // consecutive reads are SLOW apart, so each answer took at least SLOW
      return clock;
    });
    try {
      for (let i = 0; i < MIN_SAMPLES; i++) await getMyThreads();
    } finally {
      nowSpy.mockRestore();
    }
    expect(currentBandwidth()).toEqual({ signal: 'constrained', cause: 'slow_responses' });
  });
});

describe('the ladder sheds on the MEASURED signal without touching the setting', () => {
  it('effective level: the setting, raised to on while constrained', () => {
    expect(effectiveDataSaverLevel('off', false)).toBe('off');
    expect(effectiveDataSaverLevel('off', true)).toBe('on');
    expect(effectiveDataSaverLevel('on', false)).toBe('on');
  });

  it('setting off + slow connection → media and AI held back, text and safety kept; setting stays off', async () => {
    const { result } = await renderHook(() => useDataSaver());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.mayLoad('media')).toBe(true);

    await act(async () => { noteSlow(MIN_SAMPLES); });
    expect(result.current.level).toBe('off');
    expect(result.current.effectiveLevel).toBe('on');
    expect(result.current.automaticCause).toBe('slow_responses');
    expect(result.current.mayLoad('media')).toBe(false);
    expect(result.current.mayLoad('ai')).toBe(false);
    expect(result.current.mayLoad('text')).toBe(true);
    expect(result.current.mayLoad('safety')).toBe(true);
    expect(await AsyncStorage.getItem('telegraph:dataSaver:v1')).toBeNull();

    await act(async () => { noteFast(LATENCY_WINDOW); });
    expect(result.current.mayLoad('media')).toBe(true);
    expect(result.current.automaticCause).toBeNull();
  });

  it('the data-saver row says it is on automatically, and why', async () => {
    noteSlow(MIN_SAMPLES);
    await render(<DataSaverRow />);
    expect(await screen.findByTestId('data-saver-automatic')).toBeTruthy();
    expect(screen.getByText('On automatically while your connection is slow.')).toBeTruthy();
  });
});
