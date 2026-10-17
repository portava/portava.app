/**
 * census-telegraph T359 / adversarial fixture F-12 — "source object revoked while
 * a cached share card is open". Before this, a mounted card learned its source's
 * state once (the thread read, or its own resolve on mount) and kept it until
 * something re-read the page. Now the thread's bounded poll tells it.
 *
 *   P1–P8  the poller, with injected time, network and foreground state:
 *          cadence, one batched request per thread, failure back-off and its
 *          ceiling, stop on the last unsubscribe, foreground pause/resume,
 *          "cannot tell" stays silent, the route's batch cap, a late answer.
 *   H1–H4  through the REAL PostCardMessage and the REAL useShareRevocation on
 *          jest's fake timers: the open card degrades to the revoked notice
 *          when its post is revoked, stops asking when unmounted, keeps its
 *          state on a failed poll, and a newer thread read outranks an older
 *          poll answer.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

// NOTE: intentional stubs — the real module reaches lib/supabase, which builds a
// client at import time. Everything else here is REAL.
jest.mock('../sharing/shareApi.ts', () => {
  const actual = jest.requireActual('../sharing/shareApi.ts');
  return { ...actual, resolveShareProjections: jest.fn(), shareObjectIntoThread: jest.fn() };
});

import {
  createShareRevocationPoller,
  POLL_BASE_MS,
  POLL_MAX_MS,
  POLL_BATCH_MAX,
  type PollerDeps,
} from '../sharing/shareRevocationPoller.ts';
import { resolveShareProjections, type ResolvedShare, type ShareRef, type SharedCardTruth } from '../sharing/shareApi.ts';
import { PostCardMessage } from '../../../components/PostCardMessage.tsx';

const mockedResolve = resolveShareProjections as jest.MockedFunction<typeof resolveShareProjections>;

const THREAD = 'dddddddd-0000-4000-8000-00000000000d';
const POST = '11110000-0000-4000-8000-000000000001';
const POST2 = '11110000-0000-4000-8000-000000000002';

const live = (objectId: string, messageId: string | null = null): ResolvedShare => ({
  objectType: 'POST', objectId, messageId, available: true, status: 'active',
  projection: { objectType: 'POST', objectId, title: 'Live post', subtitle: '@ana', imageUrl: null, projectionVersion: 'v1', deepLink: `/post/${objectId}` },
  actions: [], deepLink: `/post/${objectId}`,
});
const revoked = (objectId: string, messageId: string | null = null): ResolvedShare => ({
  objectType: 'POST', objectId, messageId, available: false, status: 'private', reason: 'private',
  projection: null, actions: [], deepLink: `/post/${objectId}`,
});

// ── The poller, with every impure piece injected ─────────────────────────────

function harness() {
  let clock = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  let active = true;
  let foreground: ((a: boolean) => void) | null = null;
  const calls: ShareRef[][] = [];
  type Answer = Awaited<ReturnType<PollerDeps['resolve']>>;
  let answer: (refs: ShareRef[]) => Answer | Promise<Answer> = (refs) =>
    ({ ok: true, data: { threadId: THREAD, projections: refs.map((r) => live(r.objectId, r.messageId ?? null)), unsupported: [] } });
  const deps: PollerDeps = {
    resolve: async (_t, refs) => { calls.push(refs); return await answer(refs); },
    now: () => clock,
    random: () => 0.5, // no jitter: exact cadence
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: clock + ms, fn, id }); return id; },
    clearTimer: (h) => { timers = timers.filter((t) => t.id !== h); },
    onAppState: (fn) => { foreground = fn; return () => { foreground = null; }; },
    isActive: () => active,
  };
  const poller = createShareRevocationPoller(deps);
  async function advance(ms: number) {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      clock = due.at;
      due.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    clock = until;
  }
  return {
    poller, calls, advance,
    pending: () => timers.length,
    setAnswer: (f: typeof answer) => { answer = f; },
    setActive: (a: boolean) => { active = a; foreground?.(a); },
    hasForegroundListener: () => foreground !== null,
  };
}

describe('T359 — the poller', () => {
  it('P1 one card: nothing before the interval, one request at it, and the card hears a revocation', async () => {
    const h = harness();
    const heard: string[] = [];
    h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST, messageId: 'm1' }, (r) => heard.push(r.state));
    await h.advance(POLL_BASE_MS - 1);
    expect(h.calls).toHaveLength(0);
    h.setAnswer((refs) => ({ ok: true, data: { threadId: THREAD, projections: refs.map((r) => revoked(r.objectId, r.messageId ?? null)), unsupported: [] } }));
    await h.advance(1);
    expect(h.calls).toEqual([[{ objectType: 'POST', objectId: POST, messageId: 'm1' }]]);
    expect(heard).toEqual(['unavailable']);
  });

  it('P2 two cards in one thread: ONE request carrying both, and each card hears only its own answer', async () => {
    const h = harness();
    const a: string[] = []; const b: string[] = [];
    h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST, messageId: 'm1' }, (r) => a.push(r.state));
    h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST2, messageId: 'm2' }, (r) => b.push(r.state));
    h.setAnswer(() => ({ ok: true, data: { threadId: THREAD, projections: [live(POST, 'm1'), revoked(POST2, 'm2')], unsupported: [] } }));
    await h.advance(POLL_BASE_MS);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toHaveLength(2);
    expect(a).toEqual(['available']);
    expect(b).toEqual(['unavailable']);
  });

  it('P3 a failed poll tells nobody and backs off ×2 up to the ceiling; a success resets the cadence', async () => {
    const h = harness();
    const heard: string[] = [];
    h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST }, (r) => heard.push(r.state));
    h.setAnswer(() => ({ ok: false, error: 'network' }));
    const at: number[] = [];
    let t = 0;
    for (let i = 0; i < 8; i++) {
      const before = h.calls.length;
      while (h.calls.length === before) { await h.advance(1_000); t += 1_000; }
      at.push(t);
    }
    const gaps = at.map((x, i) => (i === 0 ? x : x - at[i - 1]));
    expect(gaps.slice(0, 5)).toEqual([POLL_BASE_MS, 2 * POLL_BASE_MS, 4 * POLL_BASE_MS, 8 * POLL_BASE_MS, POLL_MAX_MS]);
    expect(gaps.slice(5)).toEqual([POLL_MAX_MS, POLL_MAX_MS, POLL_MAX_MS]);
    expect(heard).toEqual([]);
    // A thrown resolve is a failure too, not a crash.
    h.setAnswer(() => { throw new Error('boom'); });
    await h.advance(POLL_MAX_MS);
    expect(heard).toEqual([]);
    h.setAnswer((refs) => ({ ok: true, data: { threadId: THREAD, projections: refs.map((r) => live(r.objectId)), unsupported: [] } }));
    await h.advance(POLL_MAX_MS);
    expect(heard).toEqual(['available']);
    const n = h.calls.length;
    await h.advance(POLL_BASE_MS);
    expect(h.calls.length).toBe(n + 1);
  });

  it('P4 the last card leaving stops the thread: no timer, no request, no foreground listener', async () => {
    const h = harness();
    const off1 = h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST }, () => {});
    const off2 = h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST2 }, () => {});
    expect(h.poller.activeThreads()).toEqual({ [THREAD]: 2 });
    off1();
    expect(h.poller.activeThreads()).toEqual({ [THREAD]: 1 });
    off2();
    expect(h.poller.activeThreads()).toEqual({});
    expect(h.pending()).toBe(0);
    expect(h.hasForegroundListener()).toBe(false);
    await h.advance(10 * POLL_BASE_MS);
    expect(h.calls).toHaveLength(0);
  });

  it('P5 nothing is asked in the background; back in the foreground a stale card is asked soon', async () => {
    const h = harness();
    h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST }, () => {});
    h.setActive(false);
    await h.advance(5 * POLL_BASE_MS);
    expect(h.calls).toHaveLength(0);
    h.setActive(true);
    await h.advance(1_000);
    expect(h.calls).toHaveLength(1);
  });

  it('P6 a ref the server omits or names unsupported is "cannot tell": the card is told nothing', async () => {
    const h = harness();
    const heard: string[] = [];
    h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST }, (r) => heard.push(r.state));
    h.setAnswer(() => ({ ok: true, data: { threadId: THREAD, projections: [], unsupported: [{ objectType: 'POST', objectId: POST }] } }));
    await h.advance(POLL_BASE_MS);
    expect(h.calls).toHaveLength(1);
    expect(heard).toEqual([]);
  });

  it('P7 more cards than the route takes in one call are asked in chunks of its cap', async () => {
    const h = harness();
    for (let i = 0; i < POLL_BATCH_MAX + 5; i++) {
      h.poller.subscribe(THREAD, { objectType: 'POST', objectId: `p${i}` }, () => {});
    }
    await h.advance(POLL_BASE_MS);
    expect(h.calls.map((c) => c.length)).toEqual([POLL_BATCH_MAX, 5]);
  });

  it('P8 an answer that arrives after every card left tells nobody and schedules nothing', async () => {
    const h = harness();
    const heard: string[] = [];
    let release: (v: Awaited<ReturnType<PollerDeps['resolve']>>) => void = () => {};
    h.setAnswer(() => new Promise((r) => { release = r; }));
    const off = h.poller.subscribe(THREAD, { objectType: 'POST', objectId: POST }, (r) => heard.push(r.state));
    await h.advance(POLL_BASE_MS);
    expect(h.calls).toHaveLength(1); // in flight
    off();
    release({ ok: true, data: { threadId: THREAD, projections: [revoked(POST)], unsupported: [] } });
    await h.advance(10 * POLL_BASE_MS);
    expect(heard).toEqual([]);
    expect(h.pending()).toBe(0);
    expect(h.calls).toHaveLength(1);
  });
});

// ── Through the real card and the real hook ──────────────────────────────────

const postBody = JSON.stringify({ postId: POST, caption: 'look' });
function serverLive(objectId: string): SharedCardTruth {
  const l = live(objectId);
  if (!l.available) throw new Error('fixture');
  return { kind: 'post_card', state: 'live', objectType: 'POST', objectId, status: 'active',
    projection: l.projection, actions: [], deepLink: `/post/${objectId}` };
}

async function flush(ms: number) {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}

describe('T359 / F-12 — an OPEN card hears its source revoked', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedResolve.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('H1 a live card (server truth) turns into the revoked notice within one poll, with no re-read of the page', async () => {
    mockedResolve.mockResolvedValue({ ok: true, data: { threadId: THREAD, projections: [revoked(POST, 'm1')], unsupported: [] } });
    await render(<PostCardMessage body={postBody} mine={false} threadId={THREAD} messageId="m1" serverCard={serverLive(POST)} />);
    expect(screen.getByTestId('post-card-live')).toBeTruthy();
    expect(mockedResolve).not.toHaveBeenCalled(); // the page's batch answered: no N+1 on mount
    await flush(POLL_BASE_MS * 1.11);
    expect(mockedResolve).toHaveBeenCalledTimes(1);
    expect(mockedResolve.mock.calls[0][1]).toEqual([{ objectType: 'POST', objectId: POST, messageId: 'm1' }]);
    expect(screen.getByTestId('post-card-revoked')).toBeTruthy();
    expect(screen.queryByTestId('post-card-live')).toBeNull();
  });

  it('H2 an unmounted card asks nothing more', async () => {
    mockedResolve.mockResolvedValue({ ok: true, data: { threadId: THREAD, projections: [live(POST, 'm1')], unsupported: [] } });
    const view = await render(<PostCardMessage body={postBody} mine={false} threadId={THREAD} messageId="m1" serverCard={serverLive(POST)} />);
    await flush(POLL_BASE_MS * 1.11);
    expect(mockedResolve).toHaveBeenCalledTimes(1);
    await act(async () => { view.unmount(); });
    await flush(POLL_BASE_MS * 20);
    expect(mockedResolve).toHaveBeenCalledTimes(1);
  });

  it('H3 a failed poll changes nothing on screen', async () => {
    mockedResolve.mockResolvedValue({ ok: false, error: 'network' });
    await render(<PostCardMessage body={postBody} mine={false} threadId={THREAD} messageId="m1" serverCard={serverLive(POST)} />);
    await flush(POLL_BASE_MS * 1.11);
    expect(mockedResolve).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('post-card-live')).toBeTruthy();
  });

  it('H4 a NEWER thread read outranks an older poll answer', async () => {
    mockedResolve.mockResolvedValue({ ok: true, data: { threadId: THREAD, projections: [revoked(POST, 'm1')], unsupported: [] } });
    const view = await render(<PostCardMessage body={postBody} mine={false} threadId={THREAD} messageId="m1" serverCard={serverLive(POST)} />);
    await flush(POLL_BASE_MS * 1.11);
    expect(screen.getByTestId('post-card-revoked')).toBeTruthy();
    // The page re-reads, and the server's newer answer is a different one (deleted).
    const reread: SharedCardTruth = { kind: 'post_card', state: 'unavailable', objectType: 'POST', objectId: POST, reason: 'deleted', deepLink: `/post/${POST}` };
    await view.rerender(<PostCardMessage body={postBody} mine={false} threadId={THREAD} messageId="m1" serverCard={reread} />);
    expect(screen.getByTestId('post-card-revoked')).toBeTruthy();
    expect(screen.getByText('This content was removed')).toBeTruthy(); // the re-read's reason, not the poll's "private"
  });
});
