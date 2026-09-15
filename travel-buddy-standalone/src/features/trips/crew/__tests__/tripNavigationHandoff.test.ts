/**
 * Trips spec §10.3 — navigation callbacks (census-trips TR169).
 *
 * Driven against the real module with two seams: the URL opener (React
 * Native's Linking in production) and the key-value store (AsyncStorage).
 * The presence write is the real `setMyPresence`, so what reaches the wire is
 * the kernel command §19.3 requires — the fetch beneath it is stubbed.
 *
 * Run: node --import tsx/esm --test src/features/trips/crew/__tests__/tripNavigationHandoff.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startNavigation, resolveNavigationReturn, pendingHandoff, cancelNavigationHandoff,
  navigationUrl, HANDOFF_TTL_SECONDS, _setStore, _setOpener, type PresenceWriter,
} from '../tripNavigationHandoff.ts';

const TRIP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ITEM = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const NOW = Date.parse('2026-09-13T12:00:00.000Z');

function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    store: { async getItem(k: string) { return m.get(k) ?? null; }, async setItem(k: string, v: string) { m.set(k, v); }, async removeItem(k: string) { m.delete(k); } },
  };
}

let opened: string[] = [];
/** Every call the handoff makes to the presence writer — the arguments `setMyPresence` turns into a SET_PRESENCE command. */
let commands: Array<{ tripId: string; args: Parameters<PresenceWriter>[1] }> = [];
const setPresence: PresenceWriter = (async (tripId, args) => {
  commands.push({ tripId, args });
  return { ok: true, kind: 'applied', version: 9, applied: true } as any;
}) as PresenceWriter;

beforeEach(() => {
  opened = []; commands = [];
  _setOpener(async (u: string) => { opened.push(u); });
});
afterEach(() => { _setOpener(null); _setStore(null); });

describe('TR169 — the link', () => {
  it('prefers coordinates, falls back to the place name, and is null when the plan names neither', () => {
    assert.match(navigationUrl({ planItemId: ITEM, lat: 48.8566, lng: 2.3522, locationName: 'Louvre' })!, /destination=48\.8566,2\.3522/);
    assert.match(navigationUrl({ planItemId: ITEM, locationName: 'Musée du Louvre' })!, /destination=Mus%C3%A9e%20du%20Louvre/);
    assert.equal(navigationUrl({ planItemId: ITEM, lat: null, lng: null, locationName: '   ' }), null);
    assert.equal(navigationUrl({ planItemId: ITEM, lat: Number.NaN, lng: 2 }), null, 'a non-finite coordinate is not a destination');
  });
});

describe('TR169 — the handoff', () => {
  it('opens the destination, reports §10.1 transiting from source navigation with a TTL, and remembers the journey', async () => {
    const s = memStore(); _setStore(s.store);
    const r = await startNavigation(TRIP, { planItemId: ITEM, title: 'Louvre', lat: 48.8566, lng: 2.3522, startsAt: '2026-09-13T14:00:00.000Z' }, { now: () => NOW, setPresence });
    assert.equal(r.state, 'started');
    assert.equal(opened.length, 1);
    assert.match(opened[0]!, /48\.8566,2\.3522/);
    assert.equal(commands.length, 1, 'exactly one presence write');
    assert.equal(commands[0]!.tripId, TRIP);
    const args = commands[0]!.args;
    assert.equal(args.state, 'transiting');
    assert.equal(args.source, 'navigation');
    assert.equal(args.ttlSeconds, HANDOFF_TTL_SECONDS, 'a presence row without a TTL never goes stale');
    assert.equal(args.observedAt, '2026-09-13T12:00:00.000Z');
    assert.ok(args.idempotencyKey.includes(ITEM), 'the key names the journey, so a retry is not a second one');
    const p = await pendingHandoff(TRIP);
    assert.equal(p?.planItemId, ITEM);
    assert.equal(p?.startsAt, '2026-09-13T14:00:00.000Z');
  });

  it('a plan with nowhere to go opens nothing and reports nothing', async () => {
    const s = memStore(); _setStore(s.store);
    const r = await startNavigation(TRIP, { planItemId: ITEM, title: 'Somewhere' }, { now: () => NOW, setPresence });
    assert.equal(r.state, 'refused');
    assert.equal(r.state === 'refused' ? r.reason : null, 'NO_DESTINATION');
    assert.deepEqual(opened, []);
    assert.deepEqual(commands, [], 'no journey is claimed');
    assert.equal(await pendingHandoff(TRIP), null);
  });

  it('a maps app that will not open is refused, and no presence is written for a journey that did not start', async () => {
    const s = memStore(); _setStore(s.store);
    _setOpener(async () => { throw new Error('no handler for this url'); });
    const r = await startNavigation(TRIP, { planItemId: ITEM, lat: 1, lng: 2 }, { now: () => NOW, setPresence });
    assert.equal(r.state, 'refused');
    assert.equal(r.state === 'refused' ? r.reason : null, 'LINK_UNAVAILABLE');
    assert.deepEqual(commands, []);
    assert.equal(await pendingHandoff(TRIP), null);
  });
});

describe('TR169 — the callback', () => {
  it('coming back after the plan has started is an arrival: at_plan, source navigation, and the journey is finished', async () => {
    const s = memStore(); _setStore(s.store);
    await startNavigation(TRIP, { planItemId: ITEM, lat: 1, lng: 2, startsAt: '2026-09-13T14:00:00.000Z' }, { now: () => NOW, setPresence });
    commands = [];
    const r = await resolveNavigationReturn(TRIP, { now: () => Date.parse('2026-09-13T14:05:00.000Z'), setPresence });
    assert.equal(r.state, 'arrived');
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.args.state, 'at_plan');
    assert.equal(commands[0]!.args.source, 'navigation');
    assert.equal(commands[0]!.args.ttlSeconds, HANDOFF_TTL_SECONDS);
    assert.equal(await pendingHandoff(TRIP), null, 'the journey is not reported twice');
  });

  it('coming back BEFORE the plan starts claims no arrival and keeps the journey open', async () => {
    const s = memStore(); _setStore(s.store);
    await startNavigation(TRIP, { planItemId: ITEM, lat: 1, lng: 2, startsAt: '2026-09-13T14:00:00.000Z' }, { now: () => NOW, setPresence });
    commands = [];
    const r = await resolveNavigationReturn(TRIP, { now: () => Date.parse('2026-09-13T13:00:00.000Z'), setPresence });
    assert.equal(r.state, 'still_transiting');
    assert.deepEqual(commands, [], 'looking at your phone is not arriving');
    assert.ok(await pendingHandoff(TRIP));
  });

  it('a plan with no start time: coming back at all is the only signal there is, and it is taken', async () => {
    const s = memStore(); _setStore(s.store);
    await startNavigation(TRIP, { planItemId: ITEM, lat: 1, lng: 2 }, { now: () => NOW, setPresence });
    commands = [];
    const r = await resolveNavigationReturn(TRIP, { now: () => NOW + 60_000, setPresence });
    assert.equal(r.state, 'arrived');
    assert.equal(commands[0]!.args.state, 'at_plan');
  });

  it('with no journey pending the callback says nothing and writes nothing — including after a cancel', async () => {
    const s = memStore(); _setStore(s.store);
    assert.deepEqual(await resolveNavigationReturn(TRIP, { now: () => NOW, setPresence }), { state: 'nothing_pending' });
    await startNavigation(TRIP, { planItemId: ITEM, lat: 1, lng: 2 }, { now: () => NOW, setPresence });
    await cancelNavigationHandoff(TRIP);
    commands = [];
    assert.deepEqual(await resolveNavigationReturn(TRIP, { now: () => NOW + 60_000, setPresence }), { state: 'nothing_pending' });
    assert.deepEqual(commands, [], 'a cancelled journey never becomes an arrival');
  });

  it('another trip’s return does not steal this trip’s journey', async () => {
    const s = memStore(); _setStore(s.store);
    await startNavigation(TRIP, { planItemId: ITEM, lat: 1, lng: 2 }, { now: () => NOW, setPresence });
    commands = [];
    const other = await resolveNavigationReturn('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', { now: () => NOW + 60_000, setPresence });
    assert.deepEqual(other, { state: 'nothing_pending' });
    assert.deepEqual(commands, []);
    assert.ok(await pendingHandoff(TRIP), 'the original journey is still open');
  });
});
