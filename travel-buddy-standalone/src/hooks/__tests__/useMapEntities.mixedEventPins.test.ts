/**
 * useMapEntities — mixed-event-list pin filtering tests.
 *
 * Task: "Confirm mixed event lists still show pins for only the events that
 * have locations."
 *
 * What we test:
 *   - The fetchEvents pin-building path in useMapEntities.ts skips events
 *     whose locationLat/locationLng are null, undefined, or form an
 *     incomplete pair (one null, one valid).
 *   - Every MapEntity produced from the remaining events carries finite,
 *     non-NaN lat/lng values that exactly match the source event fields.
 *   - The total pin count equals the number of events with a complete
 *     coordinate pair — no phantom/undefined-coordinate pins are emitted.
 *   - Events with TBD/online locations (null lat/lng) are silently skipped
 *     and do not crash the loop.
 *
 * Approach:
 *   fetchEvents is a module-private async function; it calls listEvents()
 *   over the network. We mirror its pin-building loop exactly (as the
 *   existing privacy test does for the visibility guard) so the test runs
 *   without requiring a live API server or React Native modules.
 *
 *   The loop being mirrored lives in useMapEntities.ts, fetchEvents():
 *
 *     for (const ev of result.data.events) {
 *       if (ev.locationLat == null || ev.locationLng == null) continue;
 *       if (ev.visibility === 'invite_only' || ...) continue;
 *       out.push({ id: `event:${ev.id}`, type: 'events',
 *                  lat: ev.locationLat, lng: ev.locationLng, payload: ev, ... });
 *     }
 *
 *   This test is intentionally kept independent of network I/O so it can
 *   run in any environment without live credentials.
 *
 * Red-proof:
 *   To confirm the test is not a tautology, a plausible regressed version
 *   of the guard is exercised inside the test suite. The regression is:
 *   removing the null-coordinate guard (i.e., letting all events through
 *   regardless of coordinates). This causes a pin with lat=null/lng=null
 *   to appear, and the assertions below catch it.
 *
 * Run via:
 *   node --import tsx/esm --test src/hooks/__tests__/useMapEntities.mixedEventPins.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMapVisibleEvent } from '../mapEntityFilters.ts';

// ── Minimal type mirrors ──────────────────────────────────────────────────────
// These mirror the shapes used in useMapEntities.ts and services/events.ts
// so the test is self-contained without importing RN/Expo modules.

type EventVisibility = 'public' | 'friends_only' | 'invite_only' | 'circle' | 'trip';
type MapActionCapability = 'join' | 'share' | 'report';

interface FakeEvent {
  id: string;
  visibility: EventVisibility;
  locationLat: number | null;
  locationLng: number | null;
  title: string;
}

interface FakeMapEntity {
  id: string;
  type: 'events';
  lat: number;
  lng: number;
  payload: FakeEvent;
  actionCapabilities: MapActionCapability[];
  detailRoute: string;
}

// ── Pin builder — exact mirror of fetchEvents() in useMapEntities.ts ──────────
//
// Source: travel-buddy-standalone/src/hooks/useMapEntities.ts  fetchEvents()
// Lines 106-127 (as of the version being tested):
//
//   for (const ev of result.data.events) {
//     if (ev.locationLat == null || ev.locationLng == null) continue;
//     if (ev.visibility === 'invite_only' || ev.visibility === 'circle' || ev.visibility === 'trip') continue;
//     out.push({ id: `event:${ev.id}`, type: 'events',
//                lat: ev.locationLat, lng: ev.locationLng, payload: ev,
//                actionCapabilities: ['join','share','report'],
//                detailRoute: `/event/${ev.id}` });
//   }

const EVENT_CAPABILITIES: MapActionCapability[] = ['join', 'share', 'report'];

function buildEventPins(events: FakeEvent[]): FakeMapEntity[] {
  const out: FakeMapEntity[] = [];
  for (const ev of events) {
    // Coordinate + visibility guard — the SHIPPED predicate from
    // useMapEntities' source (mapEntityFilters.ts), not a local copy. Deleting
    // either guard from the product source turns the pin-count assertions red.
    if (!isMapVisibleEvent(ev)) continue;
    out.push({
      id: `event:${ev.id}`,
      type: 'events',
      lat: ev.locationLat!,
      lng: ev.locationLng!,
      payload: ev,
      actionCapabilities: EVENT_CAPABILITIES,
      detailRoute: `/event/${ev.id}`,
    });
  }
  return out;
}

// ── Regressed version — simulates the bug where the coord guard is missing ────
// This is used in the red-proof section to confirm the assertions are not
// tautologies: removing the null guard allows phantom pins through.

function buildEventPins_REGRESSED(events: FakeEvent[]): FakeMapEntity[] {
  const out: FakeMapEntity[] = [];
  for (const ev of events) {
    // BUG: coord guard removed — all events with valid visibility pass through.
    if (
      ev.visibility === 'invite_only' ||
      ev.visibility === 'circle' ||
      ev.visibility === 'trip'
    ) continue;
    out.push({
      id: `event:${ev.id}`,
      type: 'events',
      // BUG: these casts bypass TypeScript — at runtime lat/lng may be null.
      lat: ev.locationLat as unknown as number,
      lng: ev.locationLng as unknown as number,
      payload: ev,
      actionCapabilities: EVENT_CAPABILITIES,
      detailRoute: `/event/${ev.id}`,
    });
  }
  return out;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

/**
 * A representative mixed list of events:
 *  - e1, e4: have full lat/lng  → should become pins
 *  - e2: both coords null       → TBD/online event, no pin
 *  - e3: lat present, lng null  → incomplete pair, no pin
 *  - e5: lng present, lat null  → incomplete pair, no pin
 *  - e6: invite_only + coords   → filtered by visibility, not coord guard
 */
const MIXED_EVENTS: FakeEvent[] = [
  { id: 'e1', visibility: 'public',       locationLat: 14.5995, locationLng: 120.9842, title: 'Manila meetup' },
  { id: 'e2', visibility: 'public',       locationLat: null,    locationLng: null,     title: 'TBD online mixer' },
  { id: 'e3', visibility: 'public',       locationLat: 10.3157, locationLng: null,     title: 'Half-coord event' },
  { id: 'e4', visibility: 'friends_only', locationLat: 1.3521,  locationLng: 103.8198, title: 'Singapore rooftop' },
  { id: 'e5', visibility: 'public',       locationLat: null,    locationLng: 103.8198, title: 'Other half-pair' },
  { id: 'e6', visibility: 'invite_only',  locationLat: 35.6762, locationLng: 139.6503, title: 'Private Tokyo event' },
];

// ── Test suite ────────────────────────────────────────────────────────────────

describe('buildEventPins — mixed event list only produces pins for events with locations', () => {
  it('only two pins are produced from the mixed list (e1 and e4)', () => {
    const pins = buildEventPins(MIXED_EVENTS);
    assert.equal(
      pins.length,
      2,
      `Expected 2 pins but got ${pins.length}. Only e1 and e4 have complete coordinates and eligible visibility.`,
    );
  });

  it('the two pins correspond to the events that have valid coordinates', () => {
    const pins = buildEventPins(MIXED_EVENTS);
    const ids = pins.map((p) => p.payload.id);
    assert.deepEqual(ids.sort(), ['e1', 'e4'].sort());
  });

  it('no pin has a null, undefined, or NaN coordinate', () => {
    const pins = buildEventPins(MIXED_EVENTS);
    for (const pin of pins) {
      assert.ok(
        typeof pin.lat === 'number' && !Number.isNaN(pin.lat),
        `pin ${pin.id} has invalid lat: ${pin.lat}`,
      );
      assert.ok(
        typeof pin.lng === 'number' && !Number.isNaN(pin.lng),
        `pin ${pin.id} has invalid lng: ${pin.lng}`,
      );
    }
  });

  it('pin coordinates exactly match the source event locationLat/locationLng', () => {
    const pins = buildEventPins(MIXED_EVENTS);
    for (const pin of pins) {
      const source = MIXED_EVENTS.find((ev) => `event:${ev.id}` === pin.id);
      assert.ok(source, `no source event found for pin ${pin.id}`);
      assert.equal(pin.lat, source!.locationLat);
      assert.equal(pin.lng, source!.locationLng);
    }
  });

  it('the null-coord events (e2, e3, e5) produce zero pins', () => {
    const nullCoordEvents: FakeEvent[] = MIXED_EVENTS.filter((ev) =>
      ev.locationLat == null || ev.locationLng == null,
    );
    // Confirm the fixture has 3 such events (sanity-check the fixture itself).
    assert.equal(nullCoordEvents.length, 3, 'fixture should have exactly 3 null-coord events');

    const pins = buildEventPins(nullCoordEvents);
    assert.equal(
      pins.length,
      0,
      'events with null/incomplete coordinates must never produce map pins',
    );
  });

  it('does not crash when processing an all-null-location list', () => {
    const onlineOnlyEvents: FakeEvent[] = [
      { id: 'o1', visibility: 'public', locationLat: null, locationLng: null, title: 'Online webinar' },
      { id: 'o2', visibility: 'public', locationLat: null, locationLng: null, title: 'Virtual hangout' },
    ];
    let pins: FakeMapEntity[];
    assert.doesNotThrow(() => {
      pins = buildEventPins(onlineOnlyEvents);
    });
    assert.equal(pins!.length, 0);
  });

  it('each produced pin carries the events layer type and correct action capabilities', () => {
    const pins = buildEventPins(MIXED_EVENTS);
    for (const pin of pins) {
      assert.equal(pin.type, 'events');
      assert.deepEqual(pin.actionCapabilities, ['join', 'share', 'report']);
    }
  });

  it('detailRoute is set to /event/<id> for each pin', () => {
    const pins = buildEventPins(MIXED_EVENTS);
    for (const pin of pins) {
      const eventId = pin.payload.id;
      assert.equal(pin.detailRoute, `/event/${eventId}`);
    }
  });

  it('a list of events all with valid coordinates produces a pin for every event', () => {
    const allLocated: FakeEvent[] = [
      { id: 'x1', visibility: 'public', locationLat: 10, locationLng: 20, title: 'Venue A' },
      { id: 'x2', visibility: 'public', locationLat: 30, locationLng: 40, title: 'Venue B' },
      { id: 'x3', visibility: 'public', locationLat: 50, locationLng: 60, title: 'Venue C' },
    ];
    const pins = buildEventPins(allLocated);
    assert.equal(pins.length, 3);
  });

  it('an empty event list produces no pins and does not crash', () => {
    const pins = buildEventPins([]);
    assert.equal(pins.length, 0);
  });
});

// ── Red-proof: confirm the assertions catch a regressed (broken) version ──────
//
// A plausible prior bug: the coord guard (`if locationLat == null || locationLng == null)
// continue`) was absent, so every event with an eligible visibility produced a
// pin — even events with null coordinates. This is the regression we prove
// against.
//
// The tests below run the REGRESSED builder against the same fixture and verify
// that our assertions WOULD fail (i.e., they are not tautologies).

describe('red-proof: regressed builder (no coord guard) fails the pin assertions', () => {
  it('[REGRESSION] the regressed builder produces more than 2 pins from the mixed list', () => {
    // Without the coord guard, e2/e3/e5 (null-coord public events) all pass through.
    // e6 is still excluded by the visibility guard. So we get e1,e2,e3,e4,e5 = 5 pins.
    const pins = buildEventPins_REGRESSED(MIXED_EVENTS);
    assert.ok(
      pins.length > 2,
      `Red-proof: regressed builder should emit > 2 pins; got ${pins.length}`,
    );
  });

  it('[REGRESSION] the regressed builder emits a pin with null lat/lng (confirming correct builder catches this)', () => {
    const pins = buildEventPins_REGRESSED(MIXED_EVENTS);
    const badPins = pins.filter(
      (p) => p.lat == null || p.lng == null || Number.isNaN(p.lat) || Number.isNaN(p.lng),
    );
    assert.ok(
      badPins.length > 0,
      'Red-proof: regressed builder should emit at least one pin with null/NaN coordinates',
    );
  });

  it('[REGRESSION] the correct builder DOES pass the "no null coordinates" check (red-proof sanity)', () => {
    // This is the green counterpart: the correct builder emits no bad pins.
    const pins = buildEventPins(MIXED_EVENTS);
    const badPins = pins.filter(
      (p) => p.lat == null || p.lng == null || Number.isNaN(p.lat) || Number.isNaN(p.lng),
    );
    assert.equal(badPins.length, 0, 'Correct builder must emit zero null-coordinate pins');
  });
});
