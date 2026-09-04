/**
 * Unit tests for passportTelemetryTransport — the real §32 transport.
 *
 * Covers the policy the module exists to guarantee:
 *   1. Queued events are POSTed as one authenticated batch to the passport
 *      telemetry ingest with the documented wire shape.
 *   2. Reaching maxBatch sends immediately; otherwise the idle timer sends.
 *   3. A transient failure (5xx / network throw) re-queues IN ORDER and backs
 *      off exponentially — no duplicates, no hot loop.
 *   4. 401/403 drops the batch; 404/410 drops it and pins the backoff at cap.
 *   5. No token keeps events queued; no base URL drops as 'unconfigured'.
 *   6. The bounded queue drops the OLDEST events past maxQueue.
 *   7. Backgrounding flushes; sink/flush never throw.
 *
 * Pure-logic tests (timers + clock injected) that live in a
 * *.component.test.tsx so the jest component runner — the one `check:all`
 * gates on — executes them.
 */
import {
  createPassportTelemetryTransport,
  backoffMs,
  BACKOFF_MAX_MS,
  DEFAULT_PASSPORT_TELEMETRY_PATH,
  type PassportTelemetryBatch,
  type PassportTelemetryScheduler,
} from '../passportTelemetryTransport.ts';
import type { PassportTelemetryEvent } from '../passportTelemetry.ts';

// ── Harness ───────────────────────────────────────────────────────────────────

interface FakeTimer { fn: () => void; ms: number; id: number; cleared: boolean }

function makeScheduler() {
  const timers: FakeTimer[] = [];
  let nextId = 1;
  const scheduler: PassportTelemetryScheduler = {
    set: (fn, ms) => {
      const t: FakeTimer = { fn, ms, id: nextId++, cleared: false };
      timers.push(t);
      return t.id;
    },
    clear: (handle) => {
      const t = timers.find((x) => x.id === handle);
      if (t) t.cleared = true;
    },
  };
  /** Fire the most recent un-cleared timer. */
  async function fireLast(): Promise<void> {
    const live = timers.filter((t) => !t.cleared);
    const t = live[live.length - 1];
    if (!t) throw new Error('no live timer to fire');
    t.cleared = true;
    t.fn();
    await flushMicrotasks();
  }
  const live = () => timers.filter((t) => !t.cleared);
  return { scheduler, timers, fireLast, live };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

type FetchCall = { url: string; init: RequestInit; body: PassportTelemetryBatch };

function makeFetch(responder: (call: FetchCall, n: number) => Response | Error) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: FetchCall = {
      url,
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? '{}')) as PassportTelemetryBatch,
    };
    calls.push(call);
    const out = responder(call, calls.length);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function res(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

function ev(type: PassportTelemetryEvent['type'], payload: Record<string, unknown> = {}): PassportTelemetryEvent {
  return { type, payload } as PassportTelemetryEvent;
}

function build(overrides: Partial<Parameters<typeof createPassportTelemetryTransport>[0]> = {}) {
  const sched = makeScheduler();
  let clock = 1_000_000;
  const transport = createPassportTelemetryTransport({
    baseUrl: 'https://api.example.test/',
    getToken: async () => 'tok-1',
    scheduler: sched.scheduler,
    now: () => clock,
    flushIntervalMs: 4_000,
    maxBatch: 3,
    maxQueue: 5,
    ...overrides,
  });
  return { transport, sched, tick: (ms: number) => { clock += ms; } };
}

// ── 1. Wire shape ─────────────────────────────────────────────────────────────

describe('passportTelemetryTransport — wire shape', () => {
  it('POSTs queued events as one authenticated batch to the passport ingest', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport, tick } = build({ fetchImpl });

    transport.sink(ev('passport_viewed', { subjectId: 'them', viewerContext: 'follower' }));
    tick(10);
    transport.sink(ev('follow_from_passport', { subjectId: 'them' }));
    await transport.flush();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(`https://api.example.test${DEFAULT_PASSPORT_TELEMETRY_PATH}`);
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(call.body.schemaVersion).toBe('1');
    expect(call.body.events).toEqual([
      { name: 'passport_viewed', ts: 1_000_000, seq: 0, payload: { subjectId: 'them', viewerContext: 'follower' } },
      { name: 'follow_from_passport', ts: 1_000_010, seq: 1, payload: { subjectId: 'them' } },
    ]);
    expect(call.body.meta).toEqual({ dropped: 0 });

    const d = transport.diagnostics();
    expect(d.queueDepth).toBe(0);
    expect(d.sentTotal).toBe(2);
    expect(d.consecutiveFailures).toBe(0);
  });

  it('never sends a client-supplied actor: the body carries no user id key', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport } = build({ fetchImpl });
    transport.sink(ev('message_from_passport', { subjectId: 'them' }));
    await transport.flush();
    const json = JSON.stringify(calls[0].body);
    expect(json).not.toMatch(/viewer_id|viewerId|user_id|userId|actor/);
  });
});

// ── 2. Batching + timer ───────────────────────────────────────────────────────

describe('passportTelemetryTransport — batching', () => {
  it('sends immediately once maxBatch events are queued, without waiting for the timer', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport, sched } = build({ fetchImpl, maxBatch: 3 });

    transport.sink(ev('stamp_viewed', { stampId: 's1', kind: 'city', verification: 'verified' }));
    transport.sink(ev('stamp_viewed', { stampId: 's2', kind: 'city', verification: 'verified' }));
    expect(calls).toHaveLength(0);
    expect(sched.live()).toHaveLength(1); // idle timer armed

    transport.sink(ev('stamp_viewed', { stampId: 's3', kind: 'city', verification: 'verified' }));
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0].body.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(sched.live()).toHaveLength(0); // timer cancelled by the flush
  });

  it('sends a sub-batch when the idle timer fires', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport, sched } = build({ fetchImpl });

    transport.sink(ev('my_world_opened', { countryCount: 1, cityCount: 2, stampCount: 3 }));
    expect(calls).toHaveLength(0);
    expect(sched.live()[0].ms).toBe(4_000);
    expect(transport.diagnostics().nextFlushInMs).toBe(4_000);

    await sched.fireLast();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.events[0].name).toBe('my_world_opened');
  });
});

// ── 3. Transient failure → ordered re-queue + backoff ─────────────────────────

describe('passportTelemetryTransport — transient failure', () => {
  it('re-queues a 5xx batch in order, backs off, then drains without duplicates', async () => {
    const { fetchImpl, calls } = makeFetch((_c, n) => (n === 1 ? res(503) : res(202)));
    const { transport, sched } = build({ fetchImpl });

    transport.sink(ev('journey_viewed', { journeyCount: 1, hasFeatured: false }));
    transport.sink(ev('memory_viewed', { memoryId: 'm1' }));
    await transport.flush();

    // First attempt failed: both events are back, in order, and a backoff timer is armed.
    expect(calls).toHaveLength(1);
    let d = transport.diagnostics();
    expect(d.queueDepth).toBe(2);
    expect(d.consecutiveFailures).toBe(1);
    expect(d.sentTotal).toBe(0);
    expect(sched.live()).toHaveLength(1);
    expect(sched.live()[0].ms).toBe(backoffMs(1, 4_000));
    expect(sched.live()[0].ms).toBeGreaterThan(4_000);

    await sched.fireLast();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.events.map((e) => [e.name, e.seq])).toEqual([
      ['journey_viewed', 0],
      ['memory_viewed', 1],
    ]);
    d = transport.diagnostics();
    expect(d.queueDepth).toBe(0);
    expect(d.consecutiveFailures).toBe(0);
    expect(d.sentTotal).toBe(2);
  });

  it('a network throw is swallowed, keeps the events, and backs off', async () => {
    const { fetchImpl, calls } = makeFetch((_c, n) => (n === 1 ? new Error('offline') : res(202)));
    const { transport, sched } = build({ fetchImpl });

    transport.sink(ev('trust_summary_viewed', { hasScore: true }));
    await expect(transport.flush()).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(transport.diagnostics().queueDepth).toBe(1);
    expect(transport.diagnostics().consecutiveFailures).toBe(1);
    expect(sched.live()).toHaveLength(1);
  });

  it('backoff grows exponentially and is capped', () => {
    expect(backoffMs(1, 4_000)).toBe(8_000);
    expect(backoffMs(2, 4_000)).toBe(16_000);
    expect(backoffMs(3, 4_000)).toBe(32_000);
    expect(backoffMs(20, 4_000)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(0, 4_000)).toBe(4_000);
  });

  it('does NOT auto-send on reaching maxBatch while backing off (no hot loop)', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(503));
    const { transport, sched } = build({ fetchImpl, maxBatch: 2, maxQueue: 10 });

    transport.sink(ev('passport_shared', { method: 'qr' }));
    await transport.flush(); // fails → consecutiveFailures 1
    expect(calls).toHaveLength(1);

    transport.sink(ev('passport_shared', { method: 'copy' }));
    transport.sink(ev('passport_shared', { method: 'link' }));
    await flushMicrotasks();

    // Three events now exceed maxBatch, but the transport must wait for the backoff timer.
    expect(calls).toHaveLength(1);
    expect(transport.diagnostics().queueDepth).toBe(3);
    expect(sched.live()).toHaveLength(1);
  });
});

// ── 4. Permanent conditions ───────────────────────────────────────────────────

describe('passportTelemetryTransport — permanent conditions', () => {
  it('401 drops the batch (signed-out events are not retried)', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(401));
    const { transport } = build({ fetchImpl });

    transport.sink(ev('passport_qr_scanned', {}));
    await transport.flush();

    expect(calls).toHaveLength(1);
    const d = transport.diagnostics();
    expect(d.queueDepth).toBe(0);
    expect(d.droppedByReason.unauthenticated).toBe(1);
    expect(d.sentTotal).toBe(0);
  });

  it('404 drops the batch and pins the backoff at its cap (ingest not deployed)', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(404));
    const { transport, sched } = build({ fetchImpl });

    transport.sink(ev('availability_expired', {}));
    await transport.flush();
    expect(calls).toHaveLength(1);
    expect(transport.diagnostics().queueDepth).toBe(0);
    expect(transport.diagnostics().droppedByReason.unavailable).toBe(1);

    // The next event waits a full BACKOFF_MAX_MS before another probe.
    transport.sink(ev('availability_expired', {}));
    expect(sched.live()).toHaveLength(1);
    expect(sched.live()[0].ms).toBe(BACKOFF_MAX_MS);
  });

  it('no token keeps the events queued and does not call fetch', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport } = build({ fetchImpl, getToken: async () => null });

    transport.sink(ev('open_to_plans_enabled', { intentCount: 2 }));
    await transport.flush();

    expect(calls).toHaveLength(0);
    expect(transport.diagnostics().queueDepth).toBe(1);
    expect(transport.diagnostics().consecutiveFailures).toBe(1);
  });

  it('a throwing getToken is treated as no token (never propagates)', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport } = build({ fetchImpl, getToken: async () => { throw new Error('auth boom'); } });
    transport.sink(ev('open_to_plans_enabled', { intentCount: 1 }));
    await expect(transport.flush()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(transport.diagnostics().queueDepth).toBe(1);
  });

  it('no base URL drops as unconfigured without touching fetch', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport } = build({ fetchImpl, baseUrl: '' });

    transport.sink(ev('make_plan_started', { subjectId: 'them', from: 'shared_context' }));
    await transport.flush();

    expect(calls).toHaveLength(0);
    expect(transport.diagnostics().droppedByReason.unconfigured).toBe(1);
    expect(transport.diagnostics().queueDepth).toBe(0);
  });
});

// ── 5. Bounded queue ──────────────────────────────────────────────────────────

describe('passportTelemetryTransport — bounded queue', () => {
  it('drops the OLDEST events past maxQueue and counts them', async () => {
    // First POST fails (pins the transport in backoff so nothing auto-sends);
    // every later POST succeeds so we can observe exactly which events survived.
    const { fetchImpl, calls } = makeFetch((_c, n) => (n === 1 ? res(503) : res(202)));
    const { transport, sched } = build({ fetchImpl, maxBatch: 2, maxQueue: 3 });

    transport.sink(ev('shared_context_viewed', { subjectId: 'a', factCount: 1, summary: 'Some overlap' }));
    await transport.flush();
    expect(calls).toHaveLength(1);
    expect(sched.live()).toHaveLength(1);

    for (const id of ['b', 'c', 'd', 'e']) {
      transport.sink(ev('shared_context_viewed', { subjectId: id, factCount: 1, summary: 'Some overlap' }));
    }
    const d = transport.diagnostics();
    expect(d.queueDepth).toBe(3);
    expect(d.droppedByReason.queue_overflow).toBe(2);
    expect(d.droppedTotal).toBe(2);

    // Drain: the backoff timer sends [c, d], then the idle timer sends [e].
    await sched.fireLast();
    await sched.fireLast();
    const sent = calls.slice(1).flatMap((c) => c.body.events.map((e) => String(e.payload.subjectId)));
    expect(sent).toEqual(['c', 'd', 'e']);
    expect(transport.diagnostics().queueDepth).toBe(0);
    // The drop counter rides along so the server can see the client lost events.
    expect(calls[1].body.meta.dropped).toBe(2);
  });

  it('clamps maxQueue to at least maxBatch so a batch can always be held', () => {
    const { fetchImpl } = makeFetch(() => res(202));
    const { transport } = build({ fetchImpl, maxBatch: 10, maxQueue: 3, getToken: async () => null });
    for (let i = 0; i < 8; i++) transport.sink(ev('memory_viewed', { memoryId: `m${i}` }));
    expect(transport.diagnostics().queueDepth).toBe(8);
    expect(transport.diagnostics().droppedTotal).toBe(0);
  });
});

// ── 6. Lifecycle ──────────────────────────────────────────────────────────────

describe('passportTelemetryTransport — lifecycle', () => {
  it('backgrounding flushes immediately', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport } = build({ fetchImpl });
    transport.sink(ev('trip_invite_from_passport', { subjectId: 'them' }));
    expect(calls).toHaveLength(0);
    transport.notifyAppStateChange('background');
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.events[0].name).toBe('trip_invite_from_passport');
  });

  it('foregrounding does not flush', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport } = build({ fetchImpl });
    transport.sink(ev('trip_invite_from_passport', { subjectId: 'them' }));
    transport.notifyAppStateChange('active');
    await flushMicrotasks();
    expect(calls).toHaveLength(0);
  });

  it('dispose cancels timers and stops accepting events', async () => {
    const { fetchImpl, calls } = makeFetch(() => res(202));
    const { transport, sched } = build({ fetchImpl });
    transport.sink(ev('passport_viewed', { subjectId: 'x' }));
    expect(sched.live()).toHaveLength(1);
    transport.dispose();
    expect(sched.live()).toHaveLength(0);
    transport.sink(ev('passport_viewed', { subjectId: 'y' }));
    await transport.flush();
    expect(calls).toHaveLength(0);
    expect(transport.diagnostics().queueDepth).toBe(0);
  });

  it('sink never throws even when the scheduler does', () => {
    const { fetchImpl } = makeFetch(() => res(202));
    const transport = createPassportTelemetryTransport({
      baseUrl: 'https://api.example.test',
      getToken: async () => 't',
      fetchImpl,
      scheduler: { set: () => { throw new Error('timer boom'); }, clear: () => {} },
    });
    expect(() => transport.sink(ev('passport_viewed', { subjectId: 'x' }))).not.toThrow();
  });
});
