/**
 * compassActionTarget — "View place" / "View event" open the one card the reply showed.
 *
 * Run with: node --import tsx --test src/lib/__tests__/compassActionTarget.test.ts
 *
 * Pinned: one place (across place cards, map and comparison, by id) is opened;
 * two different places, or none, fall back to the tab; events the same way.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { solePlaceCard, soleEventCard } from '../compassActionTarget.ts';

const place = (id: string) => ({ id, name: id, category: null, neighborhood: null, rating: null, blurb: null, verified: false, lat: 1, lng: 2 }) as any;
const event = (id: string) => ({ id, title: id, city: null, country: null, startsAt: null, category: null, description: null }) as any;

describe('solePlaceCard', () => {
  it('one place shown in cards and again on the map is that place', () => {
    const p = place('p1');
    assert.equal(solePlaceCard([{ type: 'place_cards', places: [p] }, { type: 'map', places: [place('p1')] }])?.id, 'p1');
  });
  it('a comparison of one place is that place', () => {
    assert.equal(solePlaceCard([{ type: 'comparison', columns: [], rows: [{ kind: 'place', id: 'p2', label: 'x', values: [], place: place('p2') }] }])?.id, 'p2');
  });
  it('two places, or none, is no single target', () => {
    assert.equal(solePlaceCard([{ type: 'place_cards', places: [place('a'), place('b')] }]), null);
    assert.equal(solePlaceCard([]), null);
    assert.equal(solePlaceCard(undefined), null);
    assert.equal(solePlaceCard([{ type: 'event_cards', events: [event('e1')] }]), null);
  });
});

describe('soleEventCard', () => {
  it('one event is that event; two are not', () => {
    assert.equal(soleEventCard([{ type: 'event_cards', events: [event('e1')] }])?.id, 'e1');
    assert.equal(soleEventCard([{ type: 'event_cards', events: [event('e1'), event('e2')] }]), null);
    assert.equal(soleEventCard([{ type: 'place_cards', places: [place('p1')] }]), null);
  });
});
