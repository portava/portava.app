/**
 * services/locateFriends.ts — the client half of §12.
 *
 * Every test here injects `fetch`. Nothing opens a socket, nothing reads an
 * env var, and no test depends on wall-clock time: the sync takes its clock and
 * its timers as options for exactly that reason.
 *
 * The four properties under test are the four the module exists to hold:
 *   1. the ladder never ASKS for more than §23 permits for this purpose,
 *   2. the poll stops on unmount — and cannot publish after it,
 *   3. a failed read does not empty the group,
 *   4. `unavailable` is ONE state, and no read outcome distinguishes its causes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDLE_LIVE_STATE,
  LOCATE_FRIENDS_PUBLISH_INTERVAL_MS,
  LOCATE_FRIENDS_READ_INTERVAL_MS,
  OBSERVATION_HORIZON_MS,
  REQUESTED_PRECISION_FOR_CLASS,
  createLocateFriendsSync,
  leaveLocateFriendsSession,
  memberSnapshotToState,
  precisionToPublish,
  publishEventCachedLocation,
  publishLocateFriendsPosition,
  publishManualCheckpoint,
  readLocateFriendsSession,
  sharePermittedLocation,
  startLocateFriendsSession,
  toLocateSession,
  type LocateFriendsMemberSnapshot,
  type LocateFriendsTransport,
} from '../../../../services/locateFriends.ts';
import { cacheEventCheckInLocation } from '../eventCachedLocation.ts';
import {
  LOCATE_SIGNAL_RUNGS,
  RUNG_POLICY,
  describeMember,
  type LocateSignalRung,
} from '../locateFriends.ts';
import {
  CURRENT_STACK_CAPABILITIES,
  DECAY_BOUNDARIES_MS,
  PRIVACY_CLASSES,
  ceilingForPurpose,
  precisionRank,
  serverPrecisionRank,
  type PrecisionGrant,
  type PresenceCapabilities,
} from '../presenceLadder.ts';

// ── Harness ───────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface Recorded {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

/** A `fetch` that replays scripted answers and records every request. */
function stubFetch(answers: Array<{ status?: number; body: any } | Error>) {
  const calls: Recorded[] = [];
  let i = 0;
  const impl = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const answer = answers[Math.min(i, answers.length - 1)];
    i += 1;
    if (answer instanceof Error) throw answer;
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: async () => answer.body,
    } as any;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function transportFor(fetchImpl: typeof fetch): LocateFriendsTransport {
  return { fetch: fetchImpl, token: async () => 'test-token', baseUrl: 'https://api.test' };
}

const ALL_CAPABILITIES: PresenceCapabilities = {
  ...CURRENT_STACK_CAPABILITIES,
  backgroundLocation: true,
  bleScan: true,
  localPeer: true,
};

function liveGrant(scopeId: string): PrecisionGrant {
  return {
    purpose: 'locate_my_friends',
    optedIn: true,
    scopeId,
    grantedClass: 'precise_temporary',
    expiresAt: NOW + 60 * 60_000,
  };
}

function okReadBody(members: any[] = [], secondsRemaining = 1800) {
  return {
    enabled: true,
    status: 'ok',
    session: {
      id: SESSION_ID,
      groupScopeKind: 'trip',
      groupScopeId: 'trip-1',
      expiresAt: new Date(NOW + secondsRemaining * 1000).toISOString(),
      secondsRemaining,
      ceiling: 'approximate',
      label: 'Night out',
    },
    members,
    generatedAt: new Date(NOW).toISOString(),
  };
}

function memberBody(over: Partial<any> = {}) {
  return {
    memberId: 'friend-1',
    displayName: 'Ava',
    precision: 'approximate',
    estimateState: 'nearby',
    decayStage: 'precise',
    rung: 'device_proximity',
    degraded: true,
    live: true,
    position: null,
    ring: { center: { lat: 16.05, lng: 108.2 }, radiusMeters: 500 },
    proximityBucket: 'within_area',
    checkpointLabel: null,
    ageSeconds: 30,
    ...over,
  };
}

/** A manual timer wheel: nothing fires unless a test fires it. */
function fakeTimers() {
  const handles = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  let cleared = 0;
  return {
    set: (fn: () => void, ms: number) => {
      const id = next++;
      handles.set(id, { fn, ms });
      return id;
    },
    clear: (id: number) => {
      if (handles.delete(id)) cleared += 1;
    },
    /** Fire every live timer whose period is `ms`. */
    tick(ms: number) {
      for (const [, h] of [...handles]) if (h.ms === ms) h.fn();
    },
    live: () => handles.size,
    clearedCount: () => cleared,
    periods: () => [...handles.values()].map((h) => h.ms).sort((a, b) => a - b),
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

// ── 1. The ladder decides what is asked for ───────────────────────────────────

describe('§23: the client never ASKS above the purpose ceiling', () => {
  test('with no grant, every rung asks at most `approximate`', () => {
    const ungranted = ceilingForPurpose('locate_my_friends', null, NOW);
    assert.equal(ungranted, 'approximate');

    for (const rung of LOCATE_SIGNAL_RUNGS) {
      const d = precisionToPublish({
        rung,
        observedAt: NOW,
        position: { lat: 16.05, lng: 108.2 },
        proximity: 'very_close',
        capabilities: ALL_CAPABILITIES,
        now: NOW,
      });
      assert.ok(d.publish, `${rung} should be publishable`);
      if (!d.publish) return;
      assert.ok(
        precisionRank(d.privacyClass) <= precisionRank(ungranted),
        `${rung} asked for ${d.privacyClass}, above the ungranted ceiling`,
      );
      assert.ok(
        serverPrecisionRank(d.precision) <=
          serverPrecisionRank(REQUESTED_PRECISION_FOR_CLASS[ungranted]),
        `${rung} asked the server for ${d.precision}`,
      );
      assert.equal(d.lat, null, `${rung} must not carry a coordinate at ${d.privacyClass}`);
      assert.equal(d.lng, null);
    }
  });

  test('a coordinate leaves ONLY at precise_temporary, and only from rung 1', () => {
    const grant = liveGrant('trip-1');
    const withCoord: LocateSignalRung[] = [];
    for (const rung of LOCATE_SIGNAL_RUNGS) {
      const d = precisionToPublish({
        rung,
        observedAt: NOW,
        position: { lat: 16.05, lng: 108.2 },
        sessionCeiling: 'precise_temporary',
        grant,
        capabilities: ALL_CAPABILITIES,
        now: NOW,
      });
      if (d.publish && d.lat !== null) {
        withCoord.push(rung);
        assert.equal(d.privacyClass, 'precise_temporary');
        assert.equal(d.precision, 'precise');
      }
    }
    assert.deepEqual(withCoord, ['network_location']);
  });

  test('the session ceiling tightens further and never widens', () => {
    const grant = liveGrant('trip-1');
    const d = precisionToPublish({
      rung: 'network_location',
      observedAt: NOW,
      position: { lat: 16.05, lng: 108.2 },
      // The group only agreed to approximate, even though the grant allows more.
      sessionCeiling: 'approximate',
      grant,
      capabilities: ALL_CAPABILITIES,
      now: NOW,
    });
    assert.ok(d.publish);
    if (!d.publish) return;
    assert.equal(d.privacyClass, 'approximate');
    assert.equal(d.lat, null);
  });

  test('PROPERTY: no session ceiling can raise what a rung asks for', () => {
    const grant = liveGrant('trip-1');
    for (const rung of LOCATE_SIGNAL_RUNGS) {
      const openest = precisionToPublish({
        rung,
        observedAt: NOW,
        position: { lat: 1, lng: 2 },
        sessionCeiling: 'precise_temporary',
        grant,
        capabilities: ALL_CAPABILITIES,
        now: NOW,
      });
      for (const ceiling of PRIVACY_CLASSES) {
        const d = precisionToPublish({
          rung,
          observedAt: NOW,
          position: { lat: 1, lng: 2 },
          sessionCeiling: ceiling,
          grant,
          capabilities: ALL_CAPABILITIES,
          now: NOW,
        });
        if (!d.publish) continue;
        assert.ok(openest.publish);
        if (!openest.publish) return;
        assert.ok(
          precisionRank(d.privacyClass) <= precisionRank(openest.privacyClass),
          `${rung} @ ${ceiling} widened to ${d.privacyClass}`,
        );
        // And never above the rung's own §12 ceiling, whatever else is in force.
        assert.ok(
          precisionRank(d.privacyClass) <= precisionRank(RUNG_POLICY[rung].ceiling),
          `${rung} @ ${ceiling} exceeded its own rung ceiling`,
        );
      }
    }
  });

  test('§23 decay tightens the ask as the observation ages', () => {
    const grant = liveGrant('trip-1');
    const fresh = precisionToPublish({
      rung: 'network_location',
      observedAt: NOW,
      position: { lat: 1, lng: 2 },
      sessionCeiling: 'precise_temporary',
      grant,
      capabilities: ALL_CAPABILITIES,
      now: NOW,
    });
    const aged = precisionToPublish({
      rung: 'network_location',
      observedAt: NOW - DECAY_BOUNDARIES_MS.precise - 1,
      position: { lat: 1, lng: 2 },
      sessionCeiling: 'precise_temporary',
      grant,
      capabilities: ALL_CAPABILITIES,
      now: NOW,
    });
    assert.ok(fresh.publish && aged.publish);
    if (!fresh.publish || !aged.publish) return;
    assert.equal(fresh.privacyClass, 'precise_temporary');
    assert.equal(aged.privacyClass, 'approximate');
    assert.equal(aged.lat, null);
  });

  test('an unsupported rung is refused, not silently downgraded', () => {
    // The verified stack has no BLE, so rungs 3 and 4 are unreachable.
    const d = precisionToPublish({
      rung: 'device_proximity',
      observedAt: NOW,
      proximity: 'nearby',
      capabilities: CURRENT_STACK_CAPABILITIES,
      now: NOW,
    });
    assert.deepEqual(d, { publish: false, reason: 'rung_unavailable' });
  });

  test('a future or over-horizon observation is never sent', () => {
    assert.equal(
      (precisionToPublish({
        rung: 'last_known',
        observedAt: NOW + 1,
        capabilities: ALL_CAPABILITIES,
        now: NOW,
      }) as any).reason,
      'observation_in_future',
    );
    assert.equal(
      (precisionToPublish({
        rung: 'last_known',
        observedAt: NOW - OBSERVATION_HORIZON_MS,
        capabilities: ALL_CAPABILITIES,
        now: NOW,
      }) as any).reason,
      'observation_too_old',
    );
  });

  test('a distance bucket is dropped below `approximate`', () => {
    const d = precisionToPublish({
      rung: 'last_known',
      observedAt: NOW,
      proximity: 'very_close',
      sessionCeiling: 'aggregate_only',
      capabilities: ALL_CAPABILITIES,
      now: NOW,
    });
    assert.ok(d.publish);
    if (!d.publish) return;
    assert.equal(d.privacyClass, 'aggregate_only');
    assert.equal(d.proximityBucket, null);
  });

  test('what goes on the wire is exactly what the decision said', async () => {
    const { impl, calls } = stubFetch([
      { body: { enabled: true, stored: true, storedPrecision: 'zone', rung: 'last_known' } },
    ]);
    const res = await publishLocateFriendsPosition(
      {
        sessionId: SESSION_ID,
        rung: 'last_known',
        observedAt: NOW - 1000,
        position: { lat: 16.05, lng: 108.2 },
        proximity: 'nearby',
        capabilities: ALL_CAPABILITIES,
        now: NOW,
      },
      transportFor(impl),
    );
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.stored, true);
    assert.equal(res.data.storedPrecision, 'zone');
    const sent = calls[0].body;
    assert.equal(sent.rung, 'last_known');
    assert.equal(sent.precision, 'zone'); // narrowed by the rung's server ceiling
    assert.equal(sent.lat, null, 'a raw coordinate must not be sent at this rung');
    assert.equal(sent.lng, null);
    assert.equal(sent.proximityBucket, 'nearby');
    assert.equal(sent.observedAt, NOW - 1000);
    assert.match(calls[0].url, /\/api\/locate-friends\/sessions\/.+\/position$/);
  });

  test('a refusal makes no request at all and is not an error', async () => {
    const { impl, calls } = stubFetch([{ body: {} }]);
    const res = await publishLocateFriendsPosition(
      {
        sessionId: SESSION_ID,
        rung: 'peer_relay',
        observedAt: NOW,
        capabilities: CURRENT_STACK_CAPABILITIES, // no localPeer
        now: NOW,
      },
      transportFor(impl),
    );
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.stored, false);
    assert.equal(res.data.refusal, 'rung_unavailable');
    assert.equal(calls.length, 0);
  });

  test('start narrows the requested ceiling to the purpose ceiling', async () => {
    const { impl, calls } = stubFetch([
      { body: { enabled: true, joined: false, session: okReadBody().session } },
    ]);
    // The caller asks for the most revealing rung there is, with no grant.
    const res = await startLocateFriendsSession(
      {
        groupScopeKind: 'trip',
        groupScopeId: 'trip-1',
        ttlMinutes: 90,
        requestedCeiling: 'precise_temporary',
        now: NOW,
      },
      transportFor(impl),
    );
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.requestedClass, 'approximate');
    assert.equal(calls[0].body.ceiling, 'approximate');
    assert.equal(calls[0].body.ttlMinutes, 90);
  });
});

// ── §25 "Create checkpoint" — §12's rung 6 ────────────────────────────────────

describe('a manual checkpoint publishes the label and never the pressed point', () => {
  test('it goes out at rung 6, carrying the name and nothing that locates a device', () => {
    const { impl, calls } = stubFetch([
      { body: { enabled: true, stored: true, storedPrecision: 'venue', rung: 'manual_checkpoint' } },
    ]);
    return publishManualCheckpoint(
      { sessionId: SESSION_ID, label: 'Food Court', now: NOW },
      transportFor(impl),
    ).then((res) => {
      assert.ok(res.ok);
      if (!res.ok) return;
      assert.equal(res.data.stored, true);
      const sent = calls[0].body;
      assert.equal(calls[0].method, 'POST');
      assert.match(calls[0].url, /\/sessions\/[^/]+\/position$/);
      assert.equal(sent.rung, 'manual_checkpoint');
      assert.equal(sent.checkpointLabel, 'Food Court');
      // The whole point: a long-press can land anywhere, so the point under the
      // finger is not evidence of where this device is and never travels as one.
      assert.equal(sent.lat, null);
      assert.equal(sent.lng, null);
      assert.equal(sent.proximityBucket, null);
      assert.equal(sent.observedAt, NOW);
    });
  });

  test('the rung is available on this stack — it needs no radio', () => {
    // `manual_checkpoint` requires nothing (RUNG_POLICY), unlike rungs 3 and 4.
    // If that ever changed, the action would silently stop publishing.
    assert.equal(RUNG_POLICY.manual_checkpoint.requires, null);
    const decision = precisionToPublish({
      rung: 'manual_checkpoint',
      observedAt: NOW,
      checkpointLabel: 'Food Court',
      capabilities: CURRENT_STACK_CAPABILITIES,
      now: NOW,
    });
    assert.equal(decision.publish, true);
  });

  test('a ladder or server refusal is reported, never reported as a drop', () => {
    const { impl } = stubFetch([{ body: { enabled: false, stored: false } }]);
    return publishManualCheckpoint(
      { sessionId: SESSION_ID, label: 'Food Court', now: NOW },
      transportFor(impl),
    ).then((res) => {
      assert.ok(res.ok);
      if (!res.ok) return;
      assert.equal(res.data.stored, false);
    });
  });

  test('an empty label is dropped rather than sent as a nameless checkpoint', () => {
    const { impl, calls } = stubFetch([{ body: { enabled: true, stored: true } }]);
    return publishManualCheckpoint(
      { sessionId: SESSION_ID, label: '   ', now: NOW },
      transportFor(impl),
    ).then(() => {
      assert.equal(calls[0].body.checkpointLabel, null);
    });
  });
});

// ── 2. `unavailable` is one state ─────────────────────────────────────────────

describe('the opaque `unavailable` stays opaque on this side', () => {
  const shapes: Array<[string, any]> = [
    ['server unavailable', { enabled: true, status: 'unavailable', session: null, members: [] }],
    ['flag disabled', { enabled: false, status: 'unavailable', session: null, members: [] }],
    ['ok but no session body', { enabled: true, status: 'ok', session: null, members: [] }],
    ['ok with an unparseable session', { enabled: true, status: 'ok', session: { id: '' }, members: [] }],
    ['garbage body', {}],
  ];

  for (const [name, body] of shapes) {
    test(`${name} → the same single state`, async () => {
      const { impl } = stubFetch([{ body }]);
      const res = await readLocateFriendsSession(SESSION_ID, transportFor(impl));
      assert.ok(res.ok);
      if (!res.ok) return;
      assert.equal(res.data.status, 'unavailable');
      assert.equal(res.data.session, null);
      assert.deepEqual(res.data.members, []);
    });
  }

  test('the read envelope carries no field that separates the causes', async () => {
    const seen = new Set<string>();
    for (const [, body] of shapes) {
      const { impl } = stubFetch([{ body }]);
      const res = await readLocateFriendsSession(SESSION_ID, transportFor(impl));
      assert.ok(res.ok);
      if (!res.ok) return;
      const { enabled, generatedAt, ...rest } = res.data;
      void enabled; // global flag state; says nothing about THIS session
      void generatedAt;
      seen.add(JSON.stringify(rest));
    }
    assert.equal(seen.size, 1, `unavailable resolved to ${seen.size} distinguishable shapes`);
  });

  test('`unavailable` is TERMINAL — the sync stops rather than retrying', async () => {
    const timers = fakeTimers();
    const { impl, calls } = stubFetch([
      { body: { enabled: true, status: 'unavailable', session: null, members: [] } },
    ]);
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: () => {},
      transport: transportFor(impl),
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();

    assert.equal(sync.state().status, 'unavailable');
    assert.equal(sync.isRunning(), false);
    assert.equal(timers.live(), 0, 'a retry timer survived an unavailable answer');

    timers.tick(LOCATE_FRIENDS_READ_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, 1, 'the sync re-probed an unavailable session');
  });

  test('a transport failure is NOT unavailable', async () => {
    const { impl } = stubFetch([new Error('offline')]);
    const res = await readLocateFriendsSession(SESSION_ID, transportFor(impl));
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.error, 'offline');
  });
});

// ── 3. The poll stops, and cannot outlive the screen ──────────────────────────

describe('the poll has a lifecycle', () => {
  test('start schedules exactly one read timer and one publish timer', async () => {
    const timers = fakeTimers();
    const { impl } = stubFetch([{ body: okReadBody([memberBody()]) }]);
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: () => {},
      sampleSignal: () => ({ rung: 'last_known', observedAt: NOW, proximity: 'nearby' }),
      transport: transportFor(impl),
      capabilities: ALL_CAPABILITIES,
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();
    assert.deepEqual(timers.periods(), [
      LOCATE_FRIENDS_READ_INTERVAL_MS,
      LOCATE_FRIENDS_PUBLISH_INTERVAL_MS,
    ]);
    sync.stop();
  });

  test('stop clears BOTH timers and nothing publishes afterwards', async () => {
    const timers = fakeTimers();
    const { impl, calls } = stubFetch([
      { body: okReadBody([memberBody()]) },
      { body: { enabled: true, stored: true, storedPrecision: 'zone' } },
      { body: okReadBody([memberBody()]) },
      { body: { enabled: true, stored: true, storedPrecision: 'zone' } },
    ]);
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: () => {},
      sampleSignal: () => ({ rung: 'last_known', observedAt: NOW, proximity: 'nearby' }),
      transport: transportFor(impl),
      capabilities: ALL_CAPABILITIES,
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();
    const afterStart = calls.length;
    assert.ok(afterStart >= 2, 'start should read and publish once immediately');

    // The panel unmounts.
    sync.stop();
    assert.equal(timers.live(), 0);
    assert.equal(timers.clearedCount(), 2);
    assert.equal(sync.isRunning(), false);

    // Anything that was already queued must be inert.
    timers.tick(LOCATE_FRIENDS_READ_INTERVAL_MS);
    timers.tick(LOCATE_FRIENDS_PUBLISH_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, afterStart, 'a request escaped after stop()');

    // And stop is idempotent.
    sync.stop();
    assert.equal(timers.clearedCount(), 2);
  });

  test('a sampler that resolves after stop() does not publish', async () => {
    const timers = fakeTimers();
    const { impl, calls } = stubFetch([{ body: okReadBody() }]);
    let release: (v: any) => void = () => {};
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: () => {},
      sampleSignal: () =>
        new Promise((r) => {
          release = r;
        }),
      transport: transportFor(impl),
      capabilities: ALL_CAPABILITIES,
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();
    const before = calls.length;

    sync.stop();
    // The GPS fix arrives a moment too late — after the screen went away.
    release({ rung: 'last_known', observedAt: NOW, proximity: 'nearby' });
    await flush();
    await flush();
    assert.equal(calls.length, before, 'a late fix published after the panel unmounted');
  });

  test('an expired session stops the poll without any further call', async () => {
    const timers = fakeTimers();
    const { impl, calls } = stubFetch([{ body: okReadBody([memberBody()], 0) }]);
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: () => {},
      transport: transportFor(impl),
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();
    assert.equal(sync.isRunning(), false);
    timers.tick(LOCATE_FRIENDS_READ_INTERVAL_MS);
    await flush();
    assert.equal(calls.length, 1);
  });

  test('the cadence sits inside §23 decay and the server rate limits', () => {
    // Ten publishes fit inside the 5-minute precise stage, so one dropped write
    // is never visible to the group.
    assert.ok(LOCATE_FRIENDS_PUBLISH_INTERVAL_MS * 10 <= DECAY_BOUNDARIES_MS.precise);
    // 2 writes/min against a 30/min cap; 3 reads/min against a 120/min cap.
    assert.ok(60_000 / LOCATE_FRIENDS_PUBLISH_INTERVAL_MS <= 30);
    assert.ok(60_000 / LOCATE_FRIENDS_READ_INTERVAL_MS <= 120);
    // The read must be at least as frequent as the publish, or the viewer sees
    // their own group lagging behind what they are telling it.
    assert.ok(LOCATE_FRIENDS_READ_INTERVAL_MS <= LOCATE_FRIENDS_PUBLISH_INTERVAL_MS);
  });
});

// ── 4. A failed read never empties the group ──────────────────────────────────

describe('fail soft', () => {
  test('a failed poll keeps the members and raises `stale`', async () => {
    const timers = fakeTimers();
    const { impl } = stubFetch([
      { body: okReadBody([memberBody(), memberBody({ memberId: 'friend-2' })]) },
      new Error('Network request failed'),
    ]);
    const states: any[] = [];
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: (s) => states.push(s),
      transport: transportFor(impl),
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();
    assert.equal(sync.state().members.length, 2);
    assert.equal(sync.state().stale, false);
    assert.equal(sync.state().status, 'ok');

    timers.tick(LOCATE_FRIENDS_READ_INTERVAL_MS);
    await flush();

    const s = sync.state();
    assert.equal(s.members.length, 2, 'a dropped poll made everyone vanish');
    assert.equal(s.status, 'ok', 'a dropped poll must not become `unavailable`');
    assert.equal(s.stale, true);
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastError, 'Network request failed');
    assert.equal(s.lastReadAt, NOW, 'staleness is measured from the last GOOD read');
    assert.equal(sync.isRunning(), true, 'a dropped poll must not stop the sync');
    sync.stop();
  });

  test('a later success clears the staleness', async () => {
    const timers = fakeTimers();
    const { impl } = stubFetch([
      { body: okReadBody([memberBody()]) },
      new Error('flap'),
      { body: okReadBody([memberBody(), memberBody({ memberId: 'friend-3' })]) },
    ]);
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: () => {},
      transport: transportFor(impl),
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();
    timers.tick(LOCATE_FRIENDS_READ_INTERVAL_MS);
    await flush();
    assert.equal(sync.state().stale, true);
    timers.tick(LOCATE_FRIENDS_READ_INTERVAL_MS);
    await flush();
    assert.equal(sync.state().stale, false);
    assert.equal(sync.state().consecutiveFailures, 0);
    assert.equal(sync.state().members.length, 2);
    sync.stop();
  });

  test('the idle state is empty but not stale', () => {
    assert.equal(IDLE_LIVE_STATE.status, 'idle');
    assert.equal(IDLE_LIVE_STATE.stale, false);
    assert.deepEqual(IDLE_LIVE_STATE.members, []);
  });
});

// ── Leaving ───────────────────────────────────────────────────────────────────

describe('leaving is unconditional', () => {
  test('DELETE goes out with no flag, status or capability consulted', async () => {
    const { impl, calls } = stubFetch([{ body: { ok: true, left: true } }]);
    const res = await leaveLocateFriendsSession(SESSION_ID, transportFor(impl));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.left, true);
    assert.equal(calls[0].method, 'DELETE');
    assert.match(calls[0].url, /\/sessions\/.+\/membership$/);
  });

  test('leave works from an `unavailable` sync — nobody gets stranded', async () => {
    const timers = fakeTimers();
    const { impl, calls } = stubFetch([
      { body: { enabled: false, status: 'unavailable', session: null, members: [] } },
      { body: { ok: true, left: true } },
    ]);
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: () => {},
      transport: transportFor(impl),
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();
    assert.equal(sync.state().status, 'unavailable');
    assert.equal(sync.state().enabled, false);

    const res = await sync.leave();
    assert.ok(res.ok);
    assert.equal(calls[1].method, 'DELETE');
  });

  test('leave stops the sync before the DELETE lands', async () => {
    const timers = fakeTimers();
    const { impl } = stubFetch([
      { body: okReadBody([memberBody()]) },
      { body: { enabled: true, stored: true, storedPrecision: 'zone' } },
      { body: { ok: true, left: true } },
    ]);
    const sync = createLocateFriendsSync({
      sessionId: SESSION_ID,
      onChange: () => {},
      sampleSignal: () => ({ rung: 'last_known', observedAt: NOW, proximity: 'nearby' }),
      transport: transportFor(impl),
      capabilities: ALL_CAPABILITIES,
      now: () => NOW,
      setIntervalImpl: timers.set,
      clearIntervalImpl: timers.clear,
    });
    sync.start();
    await flush();
    await sync.leave();
    assert.equal(sync.isRunning(), false);
    assert.equal(timers.live(), 0);
    assert.equal(sync.state().members.length, 0);
  });
});

// ── Snapshot → the model the panel renders ────────────────────────────────────

describe('the server snapshot becomes the model, without re-deriving it', () => {
  test('an approximate member is a ring, never an avatar', () => {
    const state = memberSnapshotToState(memberBody() as LocateFriendsMemberSnapshot);
    assert.equal(state.resolved.privacyClass, 'approximate');
    // §23/§6: the marker draws a ring below place_level. `identityVisible` is
    // the model's own answer and the panel never overrides it.
    assert.equal(state.avatarUrl, null);
    assert.equal(state.resolved.positionCoarsened, true);
    const display = describeMember(state);
    assert.equal(display.kind, 'nearby_range');
    assert.match(display.text, /^Nearby ~/);
    assert.equal(display.degraded, true);
  });

  test('a `venue` precision translates DOWN to approximate, not place_level', () => {
    const state = memberSnapshotToState(
      memberBody({ precision: 'venue', rung: 'manual_checkpoint', checkpointLabel: 'Food Court' }) as any,
    );
    assert.equal(state.resolved.privacyClass, 'approximate');
    assert.equal(describeMember(state).text, 'Checkpoint: Food Court');
  });

  test('a member with nothing renders as "Not sharing"', () => {
    const state = memberSnapshotToState(
      memberBody({
        precision: 'none',
        rung: null,
        displayName: null,
        estimateState: 'unknown',
        decayStage: 'expired',
        ring: null,
        proximityBucket: null,
        ageSeconds: null,
      }) as any,
    );
    assert.equal(state.identityVisible, false);
    assert.equal(state.displayName, null);
    assert.equal(state.resolved.offline, true);
    assert.equal(state.resolved.position, null);
    assert.equal(describeMember(state).kind, 'not_sharing');
  });

  test('an identity the server sent at a forbidding rung is dropped again here', () => {
    const state = memberSnapshotToState(
      memberBody({ precision: 'presence_only', displayName: 'Leaked Name' }) as any,
    );
    assert.equal(state.displayName, null);
    assert.equal(state.identityVisible, false);
    assert.equal(describeMember(state).kind, 'in_area');
  });

  test('an unparseable member is dropped rather than rendered as unknown', async () => {
    const { impl } = stubFetch([
      { body: okReadBody([memberBody(), { memberId: '' }, null, memberBody({ memberId: 'friend-9' })]) },
    ]);
    const res = await readLocateFriendsSession(SESSION_ID, transportFor(impl));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.deepEqual(res.data.members.map((m) => m.memberId), ['friend-1', 'friend-9']);
  });

  test('the session model is built through createLocateSession, expiry and all', async () => {
    const { impl } = stubFetch([{ body: okReadBody([memberBody()]) }]);
    const res = await readLocateFriendsSession(SESSION_ID, transportFor(impl));
    assert.ok(res.ok);
    if (!res.ok) return;
    const built = toLocateSession(res.data, 'me', NOW);
    assert.ok(built.ok);
    if (!built.ok) return;
    assert.equal(built.session.sessionId, SESSION_ID);
    assert.equal(built.session.groupId, 'trip-1');
    assert.equal(built.session.grantedClass, 'approximate');
    assert.deepEqual([...built.session.optedInMemberIds], ['me', 'friend-1']);
    assert.equal(built.session.expiresAt, NOW + 1_800_000);
  });

  test('an already-expired summary cannot become a session', () => {
    const envelope = {
      enabled: true,
      status: 'ok' as const,
      session: {
        id: SESSION_ID,
        groupScopeKind: 'trip',
        groupScopeId: 'trip-1',
        expiresAt: new Date(NOW - 1000).toISOString(),
        secondsRemaining: 0,
        ceiling: 'approximate' as const,
        label: null,
      },
      members: [],
      generatedAt: new Date(NOW).toISOString(),
    };
    const built = toLocateSession(envelope, 'me', NOW);
    assert.equal(built.ok, false);
  });
});

// ── §12 rung 2 · the event_cached_location producer ──────────────────────────

describe('§12 rung 2 · publishEventCachedLocation goes through the model', () => {
  const DA_NANG = { lat: 16.047079, lng: 108.220518 };

  function cache(over: Partial<Parameters<typeof cacheEventCheckInLocation>[0]> = {}) {
    const r = cacheEventCheckInLocation({
      lat: DA_NANG.lat,
      lng: DA_NANG.lng,
      venueLabel: 'Main Stage',
      consent: true,
      now: NOW,
      ...over,
    });
    assert.ok(r.ok);
    return r.cache;
  }

  test('it publishes at the event_cached_location rung and the raw coordinate never leaves the device', async () => {
    const { impl, calls } = stubFetch([
      { body: { enabled: true, stored: true, storedPrecision: 'approximate', rung: 'event_cached_location' } },
    ]);
    const res = await publishEventCachedLocation(
      { sessionId: SESSION_ID, cache: cache(), now: NOW + 60_000 },
      transportFor(impl),
    );
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.stored, true);
    assert.equal(calls.length, 1);
    const sent = calls[0].body;
    assert.equal(sent.rung, 'event_cached_location');
    // "names a venue, not a point": the cached coordinate is coarsened away by
    // the rung's approximate ceiling; only the venue label survives.
    assert.equal(sent.lat, null);
    assert.equal(sent.lng, null);
    assert.equal(sent.checkpointLabel, 'Main Stage');
    assert.notEqual(sent.precision, 'precise');
  });

  test('an expired cache declines without touching the network (not a retry-able error)', async () => {
    const short = cache({ ttlMs: 60_000 });
    const { impl, calls } = stubFetch([{ body: {} }]);
    const res = await publishEventCachedLocation(
      { sessionId: SESSION_ID, cache: short, now: short.expiresAt + 1 },
      transportFor(impl),
    );
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.stored, false);
    assert.equal(calls.length, 0, 'a dead cache must not hit the wire');
  });

  test('a null cache declines the same way', async () => {
    const { impl, calls } = stubFetch([{ body: {} }]);
    const res = await publishEventCachedLocation(
      { sessionId: SESSION_ID, cache: null, now: NOW },
      transportFor(impl),
    );
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.stored, false);
    assert.equal(calls.length, 0);
  });
});

// ── §25/§37 · the bounded permitted-location share channel ───────────────────

describe('§25 · sharePermittedLocation is a bounded, expiring, revocable share', () => {
  const DA_NANG = { lat: 16.047079, lng: 108.220518 };

  test('publishes the pressed point into the session, capped at the §37 bound', async () => {
    const { impl, calls } = stubFetch([
      { body: { enabled: true, stored: true, storedPrecision: 'approximate' } },
    ]);
    const res = await sharePermittedLocation(
      { sessionId: SESSION_ID, point: DA_NANG, bound: { privacyClass: 'place_level' }, now: NOW },
      transportFor(impl),
    );
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.stored, true);
    // The channel is the SESSION — the publish lands on its position endpoint.
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, new RegExp(`/sessions/${SESSION_ID}/position$`));
    // §37: the pressed coordinate is coarsened away below precise_temporary —
    // the bound + purpose narrow it, so no raw point leaves the device.
    assert.equal(calls[0].body.lat, null);
    assert.equal(calls[0].body.lng, null);
    assert.notEqual(calls[0].body.precision, 'precise');
  });

  test('the bound can only tighten — it never widens what the ladder allows', async () => {
    // Asking to share at a WIDER class than §37 permits cannot raise the result:
    // the purpose ceiling and the bound both cap it, and the narrower wins.
    const { impl, calls } = stubFetch([{ body: { enabled: true, stored: true, storedPrecision: 'presence_only' } }]);
    await sharePermittedLocation(
      { sessionId: SESSION_ID, point: DA_NANG, bound: { privacyClass: 'aggregate_only' }, now: NOW },
      transportFor(impl),
    );
    // aggregate_only ⇒ presence_only request, never a coordinate.
    assert.equal(calls[0].body.lat, null);
    assert.equal(calls[0].body.precision, 'presence_only');
  });

  test('the channel is revocable — leaving deletes the share, unconditionally', async () => {
    const { impl, calls } = stubFetch([{ body: { ok: true, left: true } }]);
    const res = await leaveLocateFriendsSession(SESSION_ID, transportFor(impl));
    assert.ok(res.ok);
    assert.equal(res.ok && res.data.left, true);
    assert.equal(calls[0].method, 'DELETE');
    assert.match(calls[0].url, new RegExp(`/sessions/${SESSION_ID}/membership$`));
  });

  test('the channel expires — reading an ended session is the one opaque unavailable', async () => {
    const { impl } = stubFetch([{ body: { enabled: true, status: 'unavailable', session: null, members: [] } }]);
    const res = await readLocateFriendsSession(SESSION_ID, transportFor(impl));
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.data.status, 'unavailable');
    assert.equal(res.data.session, null);
    assert.deepEqual(res.data.members, []);
  });
});
