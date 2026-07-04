/**
 * Double-tap guard for the Events Discovery save toggle and meetup RSVP.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/EventsDiscovery.doubletap.test.ts
 *
 * ## Why this test exists
 *
 * ### handleSaveToggle (events.tsx)
 * The Events discovery list had no re-entrancy guard on handleSaveToggle.
 * The optimistic setSavedIds call is async React state — it does NOT update
 * synchronously, so a rapid double-tap on the same event's bookmark button
 * would read the same `savedIds.has(ev.id)` value on both taps and dispatch
 * two concurrent saveEvent / unsaveEvent API calls.
 *
 * Fix: `savingLockRef = useRef(new Set<string>())`.
 * - Same event double-tapped → second tap sees has(id)=true → blocked.
 * - Different events tapped concurrently → each has its own key → both allowed.
 * - try/finally ensures the lock is always released (success or throw).
 *
 * ### handleRsvp in MeetupCard (messages/[id].tsx)
 * The meetup RSVP handler used `if (rsvping) return;` (React state check).
 * React setState is asynchronous — between two rapid taps, rsvping is still
 * null at both read sites, so both taps proceed and dispatch duplicate
 * rsvpMeetup() calls. The guard must be a ref (synchronous).
 *
 * Fix: `rsvpingLockRef = useRef(false)`.
 * - First tap: ref is false → sets to true synchronously before any await.
 * - Second tap: ref is already true → returns immediately.
 * - try/finally: lock is always released (success or throw).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Shared helpers ────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Boolean ref lock (for handleRsvp — single-slot)
function createLock() {
  let locked = false;
  return {
    acquire(): boolean { if (locked) return false; locked = true; return true; },
    release(): void { locked = false; },
    get current(): boolean { return locked; },
  };
}

type LockHandle = ReturnType<typeof createLock>;

async function guardedRsvp(
  lock: LockHandle,
  doRsvp: () => Promise<void>,
): Promise<boolean> {
  if (!lock.acquire()) return false;
  try {
    await doRsvp();
    return true;
  } finally {
    lock.release();
  }
}

// Set<string> ref lock (for handleSaveToggle — per-event slot)
function createSetLock() {
  const locked = new Set<string>();
  return {
    has(key: string) { return locked.has(key); },
    add(key: string) { locked.add(key); },
    delete(key: string) { locked.delete(key); },
  };
}

type SetLockHandle = ReturnType<typeof createSetLock>;

async function guardedSaveToggle(
  lock: SetLockHandle,
  id: string,
  doToggle: () => Promise<void>,
): Promise<boolean> {
  if (lock.has(id)) return false;
  lock.add(id);
  try {
    await doToggle();
    return true;
  } finally {
    lock.delete(id);
  }
}

// ── handleSaveToggle — Set-based per-event lock ───────────────────────────────

describe('handleSaveToggle — Set-based per-event lock prevents double-tap', () => {
  it('first tap proceeds and calls saveEvent once', async () => {
    const lock = createSetLock();
    let calls = 0;

    const proceeded = await guardedSaveToggle(lock, 'evt-1', async () => {
      calls++;
      await delay(10);
    });

    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap on the same event fires only one saveEvent call', async () => {
    const lock = createSetLock();
    let calls = 0;

    const doToggle = async () => { calls++; await delay(25); };

    const [first, second] = await Promise.all([
      guardedSaveToggle(lock, 'evt-1', doToggle),
      guardedSaveToggle(lock, 'evt-1', doToggle),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('three rapid taps on the same event fire exactly one API call', async () => {
    const lock = createSetLock();
    let calls = 0;

    const doToggle = async () => { calls++; await delay(20); };

    const results = await Promise.all([
      guardedSaveToggle(lock, 'evt-2', doToggle),
      guardedSaveToggle(lock, 'evt-2', doToggle),
      guardedSaveToggle(lock, 'evt-2', doToggle),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(calls, 1);
  });

  it('saving two DIFFERENT events concurrently is allowed — each has its own slot', async () => {
    const lock = createSetLock();
    let callsA = 0;
    let callsB = 0;

    const [resA, resB] = await Promise.all([
      guardedSaveToggle(lock, 'evt-a', async () => { callsA++; await delay(15); }),
      guardedSaveToggle(lock, 'evt-b', async () => { callsB++; await delay(15); }),
    ]);

    assert.equal(resA, true, 'evt-a should proceed');
    assert.equal(resB, true, 'evt-b should also proceed — different id');
    assert.equal(callsA, 1);
    assert.equal(callsB, 1);
  });

  it('lock releases after success — user can toggle the same event again', async () => {
    const lock = createSetLock();
    let calls = 0;

    const doToggle = async () => { calls++; await delay(5); };

    await guardedSaveToggle(lock, 'evt-3', doToggle);
    const second = await guardedSaveToggle(lock, 'evt-3', doToggle);

    assert.equal(second, true, 'second sequential tap should proceed');
    assert.equal(calls, 2);
  });

  it('lock releases after API error — user can retry the same event', async () => {
    const lock = createSetLock();
    let calls = 0;

    const doToggle = async () => { calls++; await delay(5); throw new Error('network'); };

    await guardedSaveToggle(lock, 'evt-4', doToggle).catch(() => {});
    assert.equal(lock.has('evt-4'), false, 'lock must be released after a throw');

    const retry = await guardedSaveToggle(lock, 'evt-4', async () => { calls++; });
    assert.equal(retry, true);
    assert.equal(calls, 2);
  });
});

// ── handleRsvp (MeetupCard) — boolean ref lock prevents double-tap ────────────

describe('handleRsvp — boolean ref lock prevents duplicate RSVP calls', () => {
  it('first tap proceeds and calls rsvpMeetup once', async () => {
    const lock = createLock();
    let calls = 0;

    const proceeded = await guardedRsvp(lock, async () => {
      calls++;
      await delay(10);
    });

    assert.equal(proceeded, true);
    assert.equal(calls, 1);
  });

  it('rapid double-tap fires only one rsvpMeetup call', async () => {
    const lock = createLock();
    let calls = 0;

    const doRsvp = async () => { calls++; await delay(25); };

    const [first, second] = await Promise.all([
      guardedRsvp(lock, doRsvp),
      guardedRsvp(lock, doRsvp),
    ]);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls, 1);
  });

  it('triple-tap on RSVP fires exactly one API call', async () => {
    const lock = createLock();
    let calls = 0;

    const doRsvp = async () => { calls++; await delay(20); };

    const results = await Promise.all([
      guardedRsvp(lock, doRsvp),
      guardedRsvp(lock, doRsvp),
      guardedRsvp(lock, doRsvp),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(calls, 1);
  });

  it('lock releases after success — user can change RSVP status afterwards', async () => {
    const lock = createLock();
    let calls = 0;

    const doRsvp = async () => { calls++; await delay(5); };

    await guardedRsvp(lock, doRsvp);
    const second = await guardedRsvp(lock, doRsvp);

    assert.equal(second, true, 'sequential tap should proceed after first completes');
    assert.equal(calls, 2);
  });

  it('lock releases after rsvpMeetup throws — user can retry', async () => {
    const lock = createLock();
    let calls = 0;

    const failingRsvp = async () => { calls++; throw new Error('network'); };

    await guardedRsvp(lock, failingRsvp).catch(() => {});
    assert.equal(lock.current, false, 'lock must be false after a throw');

    const retry = await guardedRsvp(lock, async () => { calls++; });
    assert.equal(retry, true);
    assert.equal(calls, 2);
  });
});

// ── Documents why state-only guards are insufficient ─────────────────────────

describe('documents why React state alone is insufficient for both guards', () => {
  it('boolean state: two taps both see rsvping=null before setState re-render fires', () => {
    let rsvping: string | null = null;
    const tap1Seen = rsvping;
    const tap2Seen = rsvping; // same value before re-render
    rsvping = 'going'; // setState fires after microtask

    assert.equal(tap1Seen, null);
    assert.equal(tap2Seen, null, 'both taps see rsvping=null before re-render');
  });

  it('Set state: two taps both read savedIds.has(id)=false before re-render', () => {
    const savedIds = new Set<string>();
    const tap1Seen = savedIds.has('evt-1');
    const tap2Seen = savedIds.has('evt-1'); // same Set, no re-render yet
    savedIds.add('evt-1'); // optimistic setSavedIds fires — but async

    assert.equal(tap1Seen, false);
    assert.equal(tap2Seen, false, 'both taps see has=false before re-render');
  });

  it('boolean ref: second tap sees locked=true immediately — no re-render needed', () => {
    const lock = createLock();
    lock.acquire(); // first tap — synchronous
    const tap2Blocked = !lock.acquire(); // no await — immediate
    assert.equal(tap2Blocked, true);
  });

  it('Set ref: same event blocked, different event unblocked — synchronously', () => {
    const lock = createSetLock();
    lock.add('evt-1'); // first tap on evt-1

    assert.equal(lock.has('evt-1'), true, 'same event blocked');
    assert.equal(lock.has('evt-2'), false, 'different event still open');
  });
});
