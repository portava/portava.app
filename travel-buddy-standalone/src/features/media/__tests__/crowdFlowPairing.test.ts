/**
 * features/media — "WHERE THE NIGHT IS MOVING" (spec §22; census-media MD162
 * §51; lead ruling D-26d).
 *
 * MD162's "turns red when": a Media surface pairs a served flow's
 * `endpoints.*.placeIds` with perspectives whose canonical place is in that
 * list. These cases prove the pairing and every refusal around it:
 *   A. which served flows Media may render at all (the gateway's endpoint
 *      contract, the Map renderer's own aggregate gates, freshness);
 *   B. the pairing — by place id, never by name; recent perspectives only;
 *   C. the two reads — every failure is "no card", never "nothing is moving",
 *      and the counts are not even read when no flow could pair;
 *   D. what the card's model can carry (no geometry, no cohort, no zone id),
 *      the client floor pinned to the gateway's, and where the card mounts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MapObject } from '../../../types/mapObjects.ts';
import { MIN_FLOW_COHORT } from '../../../components/map/CrowdFlowLine.tsx';
import {
  MAX_NIGHT_FLOWS,
  MIN_FLOW_ENDPOINT_PLACES,
  liveNightFlowCards,
  movementSentence,
  pairNightFlows,
  readServedNightFlow,
  readServedNightFlows,
  type ServedNightFlow,
} from '../state/crowdFlowPairing.ts';
import { loadNightFlowCards, type NightFlowSources } from '../services/mediaCrowdFlow.ts';
import type { MediaMapCluster } from '../state/mediaMapStore.ts';

const NOW = Date.parse('2026-10-14T21:00:00.000Z');
const A = ['a1111111-0000-0000-0000-000000000001', 'a1111111-0000-0000-0000-000000000002', 'a1111111-0000-0000-0000-000000000003'];
const B = [
  'b2222222-0000-0000-0000-000000000001',
  'b2222222-0000-0000-0000-000000000002',
  'b2222222-0000-0000-0000-000000000003',
  'b2222222-0000-0000-0000-000000000004',
];
const OUTSIDE = 'c3333333-0000-0000-0000-000000000009';
const COORDS: [number, number][] = [
  [108.24117, 16.06023],
  [108.24561, 16.04398],
];
const COHORT = 23;

type EndOverrides = Partial<{ zoneId: unknown; name: unknown; placeIds: unknown; placesStatus: unknown; placesPartial: unknown }>;

/** A `crowd_flow` object exactly as the gateway serves it after attachFlowEndpoints. */
function servedFlow(
  opts: {
    id?: string;
    from?: EndOverrides;
    to?: EndOverrides;
    object?: Partial<MapObject>;
    observedAgoMs?: number;
  } = {},
): MapObject {
  const observedAt = new Date(NOW - (opts.observedAgoMs ?? 2 * 60_000)).toISOString();
  return {
    id: opts.id ?? 'flow:zone-beach:zone-anthuong',
    kind: 'crowd_flow',
    geometry: { type: 'LineString', coordinates: COORDS },
    title: 'Moderate movement',
    subtitle: `${COHORT} travelers moving`,
    observedAt,
    freshness: 'live',
    confidence: 'likely',
    privacyClass: 'aggregate_only',
    renderingPriority: 60,
    count: COHORT,
    payload: {
      observed: {
        flowState: 'moderate_movement',
        fromZoneId: 'zone-beach',
        toZoneId: 'zone-anthuong',
        cohortSize: COHORT,
        signalFamilies: ['next_stop', 'route_plan'],
        windowMinutes: 30,
        observedAt,
      },
      inferred: null,
      endpoints: {
        from: { zoneId: 'zone-beach', name: 'Beachfront', placeIds: [...A], placesStatus: 'listed', placesPartial: false, ...opts.from },
        to: { zoneId: 'zone-anthuong', name: 'An Thuong', placeIds: [...B], placesStatus: 'listed', placesPartial: false, ...opts.to },
      },
    },
    ...opts.object,
  } as MapObject;
}

function cluster(placeId: string, perspectiveCount: number, freshness: MediaMapCluster['freshness'] = 'fresh', label = 'A place'): MediaMapCluster {
  return { placeId, label, perspectiveCount, freshness };
}

function read(obj: MapObject): ServedNightFlow | null {
  return readServedNightFlow(obj, NOW);
}

// ── A. Which served flows Media may render ────────────────────────────────────

test('A1. a served flow is read with both curated zone names and their listed place ids', () => {
  const f = read(servedFlow());
  assert.ok(f);
  assert.equal(f.from.name, 'Beachfront');
  assert.deepEqual([...f.from.placeIds].sort(), [...A].sort());
  assert.equal(f.to.name, 'An Thuong');
  assert.deepEqual([...f.to.placeIds].sort(), [...B].sort());
});

test('A2. an UNREAD end (the gateway could not read places, protected zones or gems) refuses the whole flow', () => {
  assert.equal(read(servedFlow({ from: { placesStatus: 'unread', placeIds: [] } })), null);
  assert.equal(read(servedFlow({ to: { placesStatus: 'unread', placeIds: [] } })), null);
  assert.equal(read(servedFlow({ to: { placesStatus: 'listed?' } })), null, 'a status the gateway does not define');
});

test('A3. a PARTIAL end (the list is a sample of the zone) refuses the whole flow — and so does a missing flag', () => {
  assert.equal(read(servedFlow({ from: { placesPartial: true } })), null);
  assert.equal(read(servedFlow({ to: { placesPartial: true } })), null);
  assert.equal(read(servedFlow({ to: { placesPartial: undefined } })), null, 'absent is not false');
  assert.equal(read(servedFlow({ to: { placesPartial: 'false' } })), null);
});

test('A4. a too_few end is a complete answer: named, kept, paired with nothing', () => {
  const f = read(servedFlow({ from: { placesStatus: 'too_few', placeIds: [] } }));
  assert.ok(f);
  assert.equal(f.from.name, 'Beachfront');
  assert.deepEqual(f.from.placeIds, []);
  // A too_few end that nonetheless carries ids is not trusted to list them.
  const g = read(servedFlow({ from: { placesStatus: 'too_few', placeIds: [...A] } }));
  assert.ok(g);
  assert.deepEqual(g.from.placeIds, []);
});

test('A5. a "listed" end with fewer than the gateway\'s floor of places pairs with nothing (it would point at the cohort\'s place)', () => {
  const f = read(servedFlow({ from: { placeIds: A.slice(0, MIN_FLOW_ENDPOINT_PLACES - 1) } }));
  assert.ok(f);
  assert.deepEqual(f.from.placeIds, []);
  // Duplicates do not make up the count.
  const g = read(servedFlow({ from: { placeIds: [A[0], A[0], A[1]] } }));
  assert.ok(g);
  assert.deepEqual(g.from.placeIds, []);
  const h = read(servedFlow({ from: { placeIds: A.slice(0, MIN_FLOW_ENDPOINT_PLACES) } }));
  assert.equal(h?.from.placeIds.length, MIN_FLOW_ENDPOINT_PLACES);
});

test('A6. an end must name the zone the observed flow names, and the zone must have a curated name', () => {
  assert.equal(read(servedFlow({ to: { zoneId: 'zone-elsewhere' } })), null);
  assert.equal(read(servedFlow({ from: { name: null } })), null);
  assert.equal(read(servedFlow({ to: { name: '   ' } })), null);
  const noEndpoints = servedFlow();
  delete (noEndpoints.payload as Record<string, unknown>).endpoints;
  assert.equal(read(noEndpoints), null, 'a flow from before the gateway named its ends');
});

test('A7. a place listed at BOTH ends is a malformed object and refuses the flow', () => {
  assert.equal(read(servedFlow({ to: { placeIds: [...B, A[0]] } })), null);
});

test('A8. the Map renderer\'s own aggregate gates apply: the cohort floor and the aggregate_only rung', () => {
  assert.equal(read(servedFlow({ object: { count: MIN_FLOW_COHORT - 1 } })), null);
  assert.equal(read(servedFlow({ object: { count: undefined } })), null);
  assert.ok(read(servedFlow({ object: { count: MIN_FLOW_COHORT } })));
  assert.equal(read(servedFlow({ object: { privacyClass: 'approximate' } })), null);
  assert.equal(read(servedFlow({ object: { privacyClass: 'none' } })), null);
  assert.equal(read(servedFlow({ object: { kind: 'activity_zone' } })), null);
  assert.equal(read(servedFlow({ object: { title: '' } })), null);
});

test('A9. only a current flow: live/recent freshness, a readable observation time, not past its expiry', () => {
  assert.equal(read(servedFlow({ object: { freshness: 'aging' } })), null);
  assert.equal(read(servedFlow({ object: { freshness: undefined } })), null);
  assert.equal(read(servedFlow({ object: { observedAt: undefined } })), null);
  assert.equal(read(servedFlow({ object: { observedAt: 'yesterday' } })), null);
  assert.equal(read(servedFlow({ observedAgoMs: 31 * 60_000 })), null, 'past the recent bucket');
  assert.equal(read(servedFlow({ object: { expiresAt: new Date(NOW - 1).toISOString() } })), null);
  assert.equal(read(servedFlow({ object: { expiresAt: 'soon' } })), null, 'an unreadable expiry is not "no expiry"');
  const f = read(servedFlow({ object: { expiresAt: new Date(NOW + 60_000).toISOString() } }));
  assert.equal(f?.liveUntilMs, NOW + 60_000);
  const g = read(servedFlow({ observedAgoMs: 10 * 60_000 }));
  assert.equal(g?.liveUntilMs, NOW - 10 * 60_000 + 30 * 60_000, 'the end of the recent bucket');
});

test('A10. a page of objects: other kinds ignored, a repeated flow read once, the gateway\'s order kept', () => {
  const place = { id: 'place:x', kind: 'place', geometry: { type: 'Point', coordinates: [108.2, 16.0] }, title: 'X', privacyClass: 'place_level', renderingPriority: 1 } as MapObject;
  const second = servedFlow({ id: 'flow:zone-anthuong:zone-beach' });
  const flows = readServedNightFlows([place, servedFlow(), second, servedFlow()], NOW);
  assert.deepEqual(flows.map((f) => f.key), ['flow:zone-beach:zone-anthuong', 'flow:zone-anthuong:zone-beach']);
});

// ── B. The pairing ────────────────────────────────────────────────────────────

const FLOW = () => read(servedFlow())!;

test('B1. each end is paired with the recent perspectives at ITS listed places: summed, freshest, busiest place on top', () => {
  const [card] = pairNightFlows([FLOW()], [
    cluster(A[0], 3, 'recent'),
    cluster(A[2], 2, 'fresh'),
    cluster(B[1], 6, 'recent'),
    cluster(B[3], 3, 'recent'),
  ]);
  assert.ok(card);
  assert.equal(card.from.name, 'Beachfront');
  assert.equal(card.from.perspectiveCount, 5);
  assert.equal(card.from.freshness, 'fresh');
  assert.equal(card.from.top?.placeId, A[0]);
  assert.equal(card.to.name, 'An Thuong');
  assert.equal(card.to.perspectiveCount, 9);
  assert.equal(card.to.freshness, 'recent');
  assert.equal(card.to.top?.placeId, B[1]);
  assert.equal(card.sentence, 'Activity appears to be moving toward An Thuong');
});

test('B2. a perspective whose place is NOT in a list is not paired — not even when its label is the zone\'s name', () => {
  const [card] = pairNightFlows([FLOW()], [
    cluster(B[0], 4, 'fresh'),
    cluster(OUTSIDE, 40, 'fresh', 'An Thuong'),
    cluster('zone-anthuong', 40, 'fresh', 'An Thuong'),
  ]);
  assert.ok(card);
  assert.equal(card.to.perspectiveCount, 4);
  assert.equal(card.to.top?.placeId, B[0]);
  assert.equal(card.from.perspectiveCount, 0, 'nothing at Beachfront\'s listed places');
  assert.equal(card.from.top, null);
});

test('B3. only RECENT perspectives pair; a flow neither of whose ends has one is not shown', () => {
  assert.deepEqual(pairNightFlows([FLOW()], [cluster(A[0], 9, 'historical'), cluster(B[0], 9, null)]), []);
  assert.deepEqual(pairNightFlows([FLOW()], []), []);
  assert.deepEqual(pairNightFlows([FLOW()], [cluster(B[0], 0, 'fresh')]), [], 'a zero count is no perspective');
  const [card] = pairNightFlows([FLOW()], [cluster(A[0], 9, 'historical'), cluster(B[0], 2, 'recent')]);
  assert.equal(card.from.perspectiveCount, 0);
  assert.equal(card.to.perspectiveCount, 2);
});

test('B4. a too_few end is shown by name with nothing paired; the other end carries the card', () => {
  const f = read(servedFlow({ from: { placesStatus: 'too_few', placeIds: [] } }))!;
  const [card] = pairNightFlows([f], [cluster(A[0], 5, 'fresh'), cluster(B[2], 1, 'fresh')]);
  assert.equal(card.from.name, 'Beachfront');
  assert.equal(card.from.perspectiveCount, 0, 'A[0] is not LISTED for a too_few zone, so it is not paired');
  assert.equal(card.to.perspectiveCount, 1);
});

test('B5. at most MAX_NIGHT_FLOWS cards, in the gateway\'s order', () => {
  const flows = Array.from({ length: MAX_NIGHT_FLOWS + 2 }, (_, i) => ({ ...FLOW(), key: `flow:${i}` }));
  const cards = pairNightFlows(flows, [cluster(B[0], 1, 'fresh')]);
  assert.equal(cards.length, MAX_NIGHT_FLOWS);
  assert.deepEqual(cards.map((c) => c.key), ['flow:0', 'flow:1', 'flow:2']);
});

test('B6. a card stops being shown when its flow stops being current', () => {
  const f = read(servedFlow({ object: { expiresAt: new Date(NOW + 1000).toISOString() } }))!;
  const cards = pairNightFlows([f], [cluster(B[0], 1, 'fresh')]);
  assert.equal(liveNightFlowCards(cards, NOW).length, 1);
  assert.equal(liveNightFlowCards(cards, NOW + 1000).length, 0);
  assert.equal(movementSentence('My Khe'), 'Activity appears to be moving toward My Khe');
});

// ── C. The two reads ──────────────────────────────────────────────────────────

const CENTER = { lat: 16.06, lng: 108.24 };

/** Fake reads. Each may resolve to anything, or throw: the loader must survive both. */
function sources(flows: () => Promise<unknown>, clusters: () => Promise<unknown>) {
  const calls = { flows: [] as unknown[], clusters: [] as unknown[] };
  const s: NightFlowSources = {
    readFlows: (o) => {
      calls.flows.push(o);
      return flows() as ReturnType<NightFlowSources['readFlows']>;
    },
    readClusters: (o) => {
      calls.clusters.push(o);
      return clusters() as ReturnType<NightFlowSources['readClusters']>;
    },
  };
  return { s, calls };
}

const GOOD_GATEWAY = async () => ({ ok: true as const, enabled: true, sources: ['crowd_flow'], objects: [servedFlow()] });
const GOOD_COUNTS = async () => ({ ok: true as const, clusters: [cluster(A[1], 2, 'fresh'), cluster(B[0], 3, 'recent')] });
const load = (s: NightFlowSources, over: Partial<Parameters<typeof loadNightFlowCards>[0]> = {}) =>
  loadNightFlowCards({ center: CENTER, city: 'Da Nang', nowMs: NOW, signal: new AbortController().signal, ...over }, s);

test('C1. a served flow and the counts at its places become a card; the reads carry the coarse center and the city', async () => {
  const { s, calls } = sources(GOOD_GATEWAY, GOOD_COUNTS);
  const cards = await load(s);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].from.perspectiveCount, 2);
  assert.equal(cards[0].to.perspectiveCount, 3);
  assert.deepEqual((calls.flows[0] as { center: unknown }).center, CENTER);
  assert.equal((calls.clusters[0] as { city: unknown }).city, 'Da Nang');
});

test('C2. no location ⇒ no viewport ⇒ nothing is read', async () => {
  const { s, calls } = sources(GOOD_GATEWAY, GOOD_COUNTS);
  assert.deepEqual(await load(s, { center: null }), []);
  assert.equal(calls.flows.length, 0);
  assert.equal(calls.clusters.length, 0);
});

test('C3. a failed or throwing gateway read is NO card — and the counts are not read', async () => {
  for (const flows of [async () => ({ ok: false }), async () => { throw new Error('offline'); }]) {
    const { s, calls } = sources(flows, GOOD_COUNTS);
    assert.deepEqual(await load(s), []);
    assert.equal(calls.clusters.length, 0);
  }
});

test('C4. a disabled gateway (map_projection_enabled off) or a layer it did not produce (map_crowd_flow_enabled off) is no card', async () => {
  const off = sources(async () => ({ ok: true as const, enabled: false, sources: [], objects: [servedFlow()] }), GOOD_COUNTS);
  assert.deepEqual(await load(off.s), []);
  assert.equal(off.calls.clusters.length, 0);
  // `enabled: false` is the rollback answer even if the rest of the body looks usable.
  const offButListed = sources(async () => ({ ok: true as const, enabled: false, sources: ['crowd_flow'], objects: [servedFlow()] }), GOOD_COUNTS);
  assert.deepEqual(await load(offButListed.s), []);
  assert.equal(offButListed.calls.clusters.length, 0);
  const notProduced = sources(async () => ({ ok: true as const, enabled: true, sources: ['place'], objects: [servedFlow()] }), GOOD_COUNTS);
  assert.deepEqual(await load(notProduced.s), [], 'an object without the layer in `sources` is not trusted');
  assert.equal(notProduced.calls.clusters.length, 0);
});

test('C5. flows none of whose ends lists places do not cost a count read', async () => {
  const { s, calls } = sources(
    async () => ({
      ok: true as const,
      enabled: true,
      sources: ['crowd_flow'],
      objects: [servedFlow({ from: { placesStatus: 'too_few', placeIds: [] }, to: { placesStatus: 'too_few', placeIds: [] } })],
    }),
    GOOD_COUNTS,
  );
  assert.deepEqual(await load(s), []);
  assert.equal(calls.clusters.length, 0);
});

test('C6. a failed or throwing count read is NO card — a flow is never shown without its perspectives', async () => {
  for (const counts of [async () => ({ ok: false }), async () => { throw new Error('500'); }]) {
    const { s } = sources(GOOD_GATEWAY, counts);
    assert.deepEqual(await load(s), []);
  }
});

test('C7. a read cancelled between the two calls renders nothing and does not read the counts', async () => {
  const controller = new AbortController();
  const { s, calls } = sources(async () => {
    controller.abort();
    return GOOD_GATEWAY();
  }, GOOD_COUNTS);
  assert.deepEqual(await load(s, { signal: controller.signal }), []);
  assert.equal(calls.clusters.length, 0);
});

// ── D. What the card can carry, the floor, and where it mounts ────────────────

test('D1. the card model carries names, counts, freshness, the busiest place and the sentence — no geometry, cohort or zone id', async () => {
  const { s } = sources(GOOD_GATEWAY, GOOD_COUNTS);
  const [card] = await load(s);
  assert.deepEqual(Object.keys(card).sort(), ['from', 'key', 'liveUntilMs', 'sentence', 'to']);
  for (const end of [card.from, card.to]) assert.deepEqual(Object.keys(end).sort(), ['freshness', 'name', 'perspectiveCount', 'top']);
  const { key: _reactKeyOnly, ...shown } = card;
  const wire = JSON.stringify(shown);
  for (const needle of ['108.24117', '16.06023', '108.24561', '16.04398', 'LineString', 'zone-beach', 'zone-anthuong', `${COHORT} travelers`, 'cohort', 'signalFamilies']) {
    assert.ok(!wire.includes(needle), `the card model carries ${needle}`);
  }
});

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '../../../..');

test('D2. the client endpoint floor is the gateway\'s own (api-server lib/mapProjection.ts MIN_FLOW_ENDPOINT_PLACES)', () => {
  const server = readFileSync(resolve(APP_ROOT, '../artifacts/api-server/src/lib/mapProjection.ts'), 'utf8');
  const m = /export const MIN_FLOW_ENDPOINT_PLACES = (\d+);/.exec(server);
  assert.ok(m, 'the gateway floor moved or was renamed');
  assert.equal(MIN_FLOW_ENDPOINT_PLACES, Number(m[1]));
});

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(APP_ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourcesUnder(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test('D3. the card mounts ONLY in the NOW lens of the World shell — with MEDIA_WORLD_SHELL_ENABLED off nothing renders it', () => {
  const files = [...sourcesUnder('src'), ...sourcesUnder('app')];
  const importers = (needle: RegExp) =>
    files.filter((f) => needle.test(readFileSync(join(APP_ROOT, f), 'utf8'))).sort();
  assert.ok(files.length > 500, `scanned ${files.length} files`);
  assert.deepEqual(importers(/from '[^']*\/CrowdFlowCard\.tsx'/), ['src/features/media/screens/MediaWorldScreen.tsx']);
  assert.deepEqual(importers(/from '[^']*\/useMediaCrowdFlow\.ts'/), ['src/features/media/components/CrowdFlowCard.tsx']);
  assert.deepEqual(importers(/from '[^']*\/MediaWorldScreen\.tsx'/), ['src/features/media/screens/MediaWorldShell.tsx']);
  // The shell's two mounts, each behind the World flags (state/mediaSurfaceFlags.ts, app/(tabs)/media.tsx).
  assert.deepEqual(importers(/from '[^']*\/MediaWorldShell\.tsx'/), ['app/media-world/index.tsx', 'src/features/media/screens/MediaWorldTabSurface.tsx']);
  // And only its overview mode: the Map and Time modes return before the mount.
  const screen = readFileSync(join(APP_ROOT, 'src/features/media/screens/MediaWorldScreen.tsx'), 'utf8');
  assert.ok(screen.indexOf('<NowCrowdFlowSection') > screen.indexOf('// Overview (default dashboard)'));
});
