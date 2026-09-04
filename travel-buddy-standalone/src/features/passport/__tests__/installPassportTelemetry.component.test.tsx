/**
 * Boot-wiring test for installPassportTelemetry — proves the §32 seam is bound
 * to the real transport end to end:
 *
 *   track helper → passportTelemetry.emit (scrub) → transport sink → batched
 *   authenticated POST with the event name + scrubbed payload.
 *
 * Also proves the lifecycle contract the root layout relies on: install is
 * idempotent, AppState backgrounding flushes, and dispose restores the default
 * (dev-log) sink so later tracks no longer reach the network.
 */
import {
  installPassportTelemetry,
  currentPassportTelemetry,
  type AppStateLike,
} from '../installPassportTelemetry.ts';
import {
  trackFollowFromPassport,
  trackMessageFromPassport,
  trackPassportViewed,
  trackPassportQrScanned,
  trackAvailabilityExpired,
  trackMemoryViewed,
  trackTripInviteFromPassport,
  emit,
} from '../passportTelemetry.ts';
import type { PassportTelemetryBatch } from '../passportTelemetryTransport.ts';

function makeAppState() {
  const handlers: Array<(state: string) => void> = [];
  const appState: AppStateLike = {
    addEventListener: (_type, handler) => {
      handlers.push(handler);
      return { remove: () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1); } };
    },
  };
  return { appState, handlers, fire: (s: string) => handlers.forEach((h) => h(s)) };
}

function makeFetch() {
  const bodies: PassportTelemetryBatch[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as PassportTelemetryBatch);
    return { ok: true, status: 202 } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  currentPassportTelemetry()?.dispose();
});

describe('installPassportTelemetry — the seam reaches the wire', () => {
  it('every previously-unwired §32 event flows through the track helpers to one POST', async () => {
    const { fetchImpl, bodies } = makeFetch();
    const { appState } = makeAppState();
    const handle = installPassportTelemetry({
      baseUrl: 'https://api.example.test',
      getToken: async () => 'tok',
      fetchImpl,
      appState,
      maxBatch: 100,
    });

    trackPassportViewed('them-1', 'follower');
    trackPassportQrScanned();
    trackAvailabilityExpired();
    trackMemoryViewed('mem-9');
    trackFollowFromPassport('them-1');
    trackMessageFromPassport('them-1');
    trackTripInviteFromPassport('them-1');

    await handle.transport.flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0].events.map((e) => [e.name, e.payload])).toEqual([
      ['passport_viewed', { subjectId: 'them-1', viewerContext: 'follower' }],
      ['passport_qr_scanned', {}],
      ['availability_expired', {}],
      ['memory_viewed', { memoryId: 'mem-9' }],
      ['follow_from_passport', { subjectId: 'them-1' }],
      ['message_from_passport', { subjectId: 'them-1' }],
      ['trip_invite_from_passport', { subjectId: 'them-1' }],
    ]);
  });

  it('the privacy scrubber still runs in front of the transport', async () => {
    const { fetchImpl, bodies } = makeFetch();
    const handle = installPassportTelemetry({
      baseUrl: 'https://api.example.test',
      getToken: async () => 'tok',
      fetchImpl,
    });
    emit('follow_from_passport', {
      subjectId: 'them-1',
      // @ts-expect-error — proving an off-contract PII key never reaches the wire.
      displayName: 'Mai Nguyen',
    });
    await handle.transport.flush();
    expect(JSON.stringify(bodies[0])).not.toContain('Mai');
    expect(bodies[0].events[0].payload).toEqual({ subjectId: 'them-1' });
  });
});

describe('installPassportTelemetry — lifecycle', () => {
  it('is idempotent: a second install returns the live handle', () => {
    const { fetchImpl } = makeFetch();
    const a = installPassportTelemetry({ baseUrl: 'https://x', getToken: async () => 't', fetchImpl });
    const b = installPassportTelemetry({ baseUrl: 'https://y', getToken: async () => 't', fetchImpl });
    expect(b).toBe(a);
    expect(currentPassportTelemetry()).toBe(a);
  });

  it('backgrounding via AppState flushes the queue', async () => {
    const { fetchImpl, bodies } = makeFetch();
    const { appState, fire, handlers } = makeAppState();
    installPassportTelemetry({ baseUrl: 'https://api.example.test', getToken: async () => 't', fetchImpl, appState });
    expect(handlers).toHaveLength(1);

    trackFollowFromPassport('them-2');
    expect(bodies).toHaveLength(0);
    fire('background');
    await settle();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].events[0]).toMatchObject({ name: 'follow_from_passport', payload: { subjectId: 'them-2' } });
  });

  it('dispose unsubscribes AppState, flushes, and restores the default sink', async () => {
    const { fetchImpl, bodies } = makeFetch();
    const { appState, handlers } = makeAppState();
    const handle = installPassportTelemetry({ baseUrl: 'https://api.example.test', getToken: async () => 't', fetchImpl, appState });

    trackMessageFromPassport('them-3');
    handle.dispose();
    await settle();

    expect(handlers).toHaveLength(0);
    expect(currentPassportTelemetry()).toBeNull();
    expect(bodies).toHaveLength(1); // the pending event was flushed on dispose

    // After dispose the seam is back on the default sink: nothing reaches fetch.
    trackMessageFromPassport('them-4');
    await settle();
    expect(bodies).toHaveLength(1);
  });
});
