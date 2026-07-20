/**
 * callAnalytics — unit tests for emitCallAnalytics durationMs (task: call
 * health tracking without recording content).
 *
 * Covers:
 *  - Normal ended call: connectedAt + endedAt → positive durationMs
 *  - Missed call: no connectedAt → null durationMs
 *  - Declined call: no connectedAt → null durationMs
 *  - Sweeper-forced end: connectedAt + endedAt → positive durationMs
 *  - computeCallDurationMs edge cases (inverted timestamps, missing fields)
 *
 * Run: node --import tsx/esm --test src/test/callAnalytics.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { emitCallAnalytics, computeCallDurationMs } from '../lib/calls/callSignaling.ts';
import { logger } from '../lib/logger.ts';

// ── Logger capture ────────────────────────────────────────────────────────────

type CapturedLog = { bindings: Record<string, unknown>; msg: string };
let captured: CapturedLog[] = [];
let originalInfo: typeof logger.info;

beforeEach(() => {
  captured = [];
  originalInfo = logger.info.bind(logger);
  // Intercept pino logger.info calls
  (logger as any).info = (bindings: Record<string, unknown>, msg: string) => {
    captured.push({ bindings, msg });
  };
});

afterEach(() => {
  (logger as any).info = originalInfo;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const T0 = '2026-07-18T12:00:00.000Z'; // connectedAt
const T1 = '2026-07-18T12:04:30.000Z'; // endedAt (270 000 ms later)
const DURATION_MS = Date.parse(T1) - Date.parse(T0); // 270_000

function makeSession(overrides: {
  connectedAt?: string | null;
  endedAt?: string | null;
} = {}) {
  return {
    id: 'sess-001',
    callType: 'voice' as const,
    contextType: 'telegraph_dm' as const,
    connectedAt: 'connectedAt' in overrides ? overrides.connectedAt ?? null : T0,
    endedAt: 'endedAt' in overrides ? overrides.endedAt ?? null : T1,
  };
}

function lastLog(): CapturedLog {
  assert.ok(captured.length > 0, 'no log was captured');
  return captured[captured.length - 1];
}

// ── computeCallDurationMs ─────────────────────────────────────────────────────

describe('computeCallDurationMs', () => {
  it('returns ms between connectedAt and endedAt for a normal call', () => {
    const ms = computeCallDurationMs({ connectedAt: T0, endedAt: T1 });
    assert.equal(ms, DURATION_MS);
  });

  it('returns null when connectedAt is null (missed / declined / canceled)', () => {
    assert.equal(computeCallDurationMs({ connectedAt: null, endedAt: T1 }), null);
  });

  it('returns null when endedAt is null (still active or not yet terminated)', () => {
    assert.equal(computeCallDurationMs({ connectedAt: T0, endedAt: null }), null);
  });

  it('returns null when both timestamps are null', () => {
    assert.equal(computeCallDurationMs({ connectedAt: null, endedAt: null }), null);
  });

  it('returns null for inverted timestamps (endedAt before connectedAt — data anomaly)', () => {
    // Should not produce a negative duration
    assert.equal(computeCallDurationMs({ connectedAt: T1, endedAt: T0 }), null);
  });

  it('returns 0 for identical connectedAt and endedAt (instant termination)', () => {
    assert.equal(computeCallDurationMs({ connectedAt: T0, endedAt: T0 }), 0);
  });
});

// ── emitCallAnalytics: normal ended call ─────────────────────────────────────

describe('emitCallAnalytics — normal ended call', () => {
  it('logs call_analytics with correct durationMs', () => {
    emitCallAnalytics('ended', makeSession());
    const { bindings } = lastLog();
    assert.equal(bindings.event, 'call_analytics');
    assert.equal(bindings.analyticsType, 'ended');
    assert.equal(bindings.callId, 'sess-001');
    assert.equal(bindings.callType, 'voice');
    assert.equal(bindings.contextType, 'telegraph_dm');
    assert.equal(bindings.durationMs, DURATION_MS);
  });

  it('includes durationMs in the log binding (not only in the message)', () => {
    emitCallAnalytics('ended', makeSession());
    assert.ok('durationMs' in lastLog().bindings, 'durationMs must be a structured binding');
  });
});

// ── emitCallAnalytics: missed call (no connect) ───────────────────────────────

describe('emitCallAnalytics — missed call (no connectedAt)', () => {
  it('logs null durationMs for a missed call', () => {
    emitCallAnalytics('missed', makeSession({ connectedAt: null, endedAt: T1 }));
    const { bindings } = lastLog();
    assert.equal(bindings.analyticsType, 'missed');
    assert.equal(bindings.durationMs, null);
  });

  it('logs null durationMs when both timestamps are absent', () => {
    emitCallAnalytics('missed', makeSession({ connectedAt: null, endedAt: null }));
    assert.equal(lastLog().bindings.durationMs, null);
  });
});

// ── emitCallAnalytics: declined call (no connect) ────────────────────────────

describe('emitCallAnalytics — declined call (no connectedAt)', () => {
  it('logs null durationMs for a declined call', () => {
    emitCallAnalytics('declined', makeSession({ connectedAt: null, endedAt: T1 }));
    const { bindings } = lastLog();
    assert.equal(bindings.analyticsType, 'declined');
    assert.equal(bindings.durationMs, null);
  });
});

// ── emitCallAnalytics: sweeper-forced end ────────────────────────────────────

describe('emitCallAnalytics — sweeper-forced end', () => {
  it('logs positive durationMs when sweeper ends a connected call', () => {
    // Sweeper ends calls that hit the 4-hour cap; session has connectedAt + endedAt
    const connectedAt = '2026-07-18T08:00:00.000Z';
    const endedAt = '2026-07-18T12:00:00.000Z'; // 4 h later
    const expectedMs = Date.parse(endedAt) - Date.parse(connectedAt); // 14_400_000

    emitCallAnalytics('ended', makeSession({ connectedAt, endedAt }));
    const { bindings } = lastLog();
    assert.equal(bindings.analyticsType, 'ended');
    assert.equal(bindings.durationMs, expectedMs);
  });

  it('logs null durationMs when sweeper expires a ringing (never-connected) call as missed', () => {
    // Ring-timeout sweep: call never connected, sweeper flips to "missed"
    emitCallAnalytics('missed', makeSession({ connectedAt: null, endedAt: T1 }));
    assert.equal(lastLog().bindings.durationMs, null);
  });
});

// ── forceEndDirectCallsBetween: duration reaches analytics ───────────────────
//
// We drive the real forceEndDirectCallsBetween → makeCallStore pipeline by
// providing a fake SupabaseClient whose fluent builder returns pre-canned
// responses in table-call order. This avoids ES-module patching (read-only)
// while exercising the real code path that builds the `ended` session object
// with endedAt populated.

/**
 * Minimal fluent Supabase query builder. Each `.from(table)` call dequeues
 * the next response registered for that table. All chainable methods return
 * `this`; terminal methods (`select` at the end, `then`) resolve the queued
 * response so `await builder` works.
 */
function makeFakeSc(responses: Record<string, Array<{ data: unknown; error: null }>>) {
  const queues: Record<string, Array<{ data: unknown; error: null }>> = {};
  for (const [k, v] of Object.entries(responses)) queues[k] = [...v];

  const sc: any = {
    from(table: string) {
      // Grab the next queued response for this table (cycle through if exhausted).
      const queue = queues[table] ?? [];
      const response = queue.shift() ?? { data: [], error: null };

      let settled = false;
      let resolvedWith = response;

      // Build a chainable object. Every method (select, in, eq, update, …)
      // returns `this`. The builder is also a thenable so `await chain`
      // resolves to the queued response.
      const chain: any = {
        select() { return chain; },
        in() { return chain; },
        eq() { return chain; },
        update() { return chain; },
        not() { return chain; },
        maybeSingle() { return Promise.resolve(resolvedWith); },
        single()      { return Promise.resolve(resolvedWith); },
        // Make the chain itself awaitable (thenable).
        then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
          Promise.resolve(resolvedWith).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return sc as any;
}

/**
 * Session DB row (snake_case) for a connected, active direct call.
 * mapSessionRow() in callStoreAdapter maps these to camelCase.
 */
function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-force-001',
    call_type: 'voice',
    context_type: 'telegraph_dm',
    context_id: 'ctx-1',
    thread_id: 'thread-1',
    room_name: 'pcall_test',
    started_by: 'userA',
    status: 'active',
    started_at: '2026-07-18T11:00:00.000Z',
    connected_at: '2026-07-18T11:00:00.000Z',
    ended_at: null,
    ...overrides,
  };
}

const CONNECTED_AT = '2026-07-18T11:00:00.000Z';
const ENDED_AT     = '2026-07-18T12:00:00.000Z';
const FORCE_END_DURATION_MS = Date.parse(ENDED_AT) - Date.parse(CONNECTED_AT); // 3_600_000

describe('forceEndDirectCallsBetween — durationMs in analytics', () => {
  it('logs non-null durationMs for a connected call force-ended by a block', async () => {
    const { forceEndDirectCallsBetween } = await import('../lib/calls/callSignaling.ts');

    const row = sessionRow(); // connected_at set, ended_at null

    // SC response sequence for findOpenDirectSessionsBetween + applyTransition:
    //   1. call_sessions.select().in().in()      → the open session
    //   2. call_participants.select().in().in()  → both participants present
    //   3. call_sessions.update().eq().eq().select("id")  → CAS success
    const fakeSc = makeFakeSc({
      call_sessions: [
        { data: [row], error: null },              // findOpenDirectSessionsBetween
        { data: [{ id: row.id }], error: null },   // applyTransition select("id")
      ],
      call_participants: [
        { data: [                                   // findOpenDirectSessionsBetween participants
          { call_id: row.id, user_id: 'userA' },
          { call_id: row.id, user_id: 'userB' },
        ], error: null },
      ],
    });

    // Override Date so `new Date().toISOString()` in forceEndDirectCallsBetween
    // returns our deterministic ENDED_AT.
    const OrigDate = global.Date;
    (global as any).Date = class extends OrigDate {
      constructor(...args: any[]) {
        if (args.length === 0) super(ENDED_AT);
        else super(...(args as []));
      }
      static parse = OrigDate.parse;
      static now = () => OrigDate.parse(ENDED_AT);
    };

    const fakeAdmin: any = { endRoom: async () => {}, listRoomNames: async () => new Set() };

    try {
      await forceEndDirectCallsBetween(fakeSc, fakeAdmin, 'userA', 'userB');
    } finally {
      global.Date = OrigDate;
    }

    const analyticsLog = captured.find(
      (c) => c.bindings.event === 'call_analytics' && c.bindings.analyticsType === 'ended',
    );
    assert.ok(analyticsLog, 'expected call_analytics/ended log from forceEndDirectCallsBetween');
    assert.equal(
      analyticsLog!.bindings.durationMs,
      FORCE_END_DURATION_MS,
      'durationMs must use post-transition endedAt; pre-transition session.endedAt was null',
    );
  });

  it('logs null durationMs when a ringing (never-connected) call is force-ended', async () => {
    const { forceEndDirectCallsBetween } = await import('../lib/calls/callSignaling.ts');

    // Ringing session: connectedAt is null, so duration must be null even though
    // the session gets an endedAt when force-ended.
    const row = sessionRow({ connected_at: null, status: 'ringing' });

    const fakeSc = makeFakeSc({
      call_sessions: [
        { data: [row], error: null },
        { data: [{ id: row.id }], error: null },
      ],
      call_participants: [
        { data: [
          { call_id: row.id, user_id: 'userA' },
          { call_id: row.id, user_id: 'userB' },
        ], error: null },
      ],
    });

    const OrigDate = global.Date;
    (global as any).Date = class extends OrigDate {
      constructor(...args: any[]) {
        if (args.length === 0) super(ENDED_AT);
        else super(...(args as []));
      }
      static parse = OrigDate.parse;
      static now = () => OrigDate.parse(ENDED_AT);
    };

    const fakeAdmin: any = { endRoom: async () => {}, listRoomNames: async () => new Set() };

    try {
      await forceEndDirectCallsBetween(fakeSc, fakeAdmin, 'userA', 'userB');
    } finally {
      global.Date = OrigDate;
    }

    const analyticsLog = captured.find(
      (c) => c.bindings.event === 'call_analytics' && c.bindings.analyticsType === 'ended',
    );
    assert.ok(analyticsLog, 'expected call_analytics/ended log');
    assert.equal(analyticsLog!.bindings.durationMs, null,
      'never-connected call must log null durationMs regardless of endedAt');
  });
});

// ── No content / no identity leaked ──────────────────────────────────────────

describe('emitCallAnalytics — privacy contract', () => {
  it('does not log participantIds, free text, or content fields', () => {
    emitCallAnalytics('ended', makeSession());
    const keys = Object.keys(lastLog().bindings);
    const banned = ['participantId', 'userId', 'content', 'transcript', 'body', 'name'];
    for (const k of banned) {
      assert.ok(!keys.includes(k), `unexpected field "${k}" in analytics log`);
    }
  });

  it('only logs the allowed structural fields', () => {
    emitCallAnalytics('ended', makeSession());
    const keys = new Set(Object.keys(lastLog().bindings));
    const allowed = new Set(['event', 'analyticsType', 'callId', 'callType', 'contextType', 'durationMs']);
    for (const k of keys) {
      assert.ok(allowed.has(k), `unexpected field "${k}" leaked into analytics log`);
    }
  });
});
