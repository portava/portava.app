/**
 * S39 (census-sensing §21.4 blocker #3) — a Compass turn names the zone its own
 * device is in, and ONLY while capture is running.
 *
 * `services/compass` cannot load under node (react-native via apiToken →
 * supabase; see scripts/run-node-tests.mjs KNOWN_BROKEN), so the rule is a
 * pure function in `services/sensing/sensingZoneHint` and this file proves the
 * rule directly, then proves BY SOURCE that both ask paths apply it — the same
 * way sensingWiring.test.ts proves the capture installer is mounted.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerSensingZoneSource, sensingZoneHint, withSensingZone } from '../sensing/sensingZoneHint.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPASS = readFileSync(join(HERE, '..', 'compass.ts'), 'utf8');

beforeEach(() => registerSensingZoneSource(null));
after(() => registerSensingZoneSource(null));

describe('sensingZoneHint', () => {
  it('is null with no source, and null for a blank, non-string or throwing source', () => {
    assert.equal(sensingZoneHint(), null);
    registerSensingZoneSource(() => '   ');
    assert.equal(sensingZoneHint(), null);
    registerSensingZoneSource((() => 42) as unknown as () => string | null);
    assert.equal(sensingZoneHint(), null);
    registerSensingZoneSource(() => { throw new Error('boom'); });
    assert.equal(sensingZoneHint(), null);
    registerSensingZoneSource(() => 'u4pruy');
    assert.equal(sensingZoneHint(), 'u4pruy');
  });
});

describe('withSensingZone — the ask carries the zone only while capture is running', () => {
  /** The shape the two ask paths pass: production hands in a typed options object, never a bare literal. */
  type Ask = { city?: string; conversationId?: string; sensingZoneIds?: string[] };

  it('no source ⇒ the body has no sensingZoneIds at all', () => {
    const opts: Ask = { city: 'Lisbon' };
    const out = withSensingZone(opts);
    assert.equal('sensingZoneIds' in out, false);
    assert.deepEqual(out, { city: 'Lisbon' });
  });

  it('a running capture ⇒ sensingZoneIds is exactly [its current zone], other fields untouched', () => {
    registerSensingZoneSource(() => 'u4pruy');
    const opts: Ask = { city: 'Lisbon', conversationId: 'c1' };
    const out = withSensingZone(opts);
    assert.deepEqual(out, { city: 'Lisbon', conversationId: 'c1', sensingZoneIds: ['u4pruy'] });
  });

  it('an explicit sensingZoneIds wins over the hint; an explicit [] sends nothing', () => {
    registerSensingZoneSource(() => 'u4pruy');
    const explicit: Ask = { sensingZoneIds: ['zzzzzz'] };
    assert.deepEqual(withSensingZone(explicit).sensingZoneIds, ['zzzzzz']);
    const empty: Ask = { city: 'Lisbon', sensingZoneIds: [] };
    const out = withSensingZone(empty);
    assert.equal('sensingZoneIds' in out, false);
    assert.deepEqual(out, { city: 'Lisbon' });
  });
});

describe('the wiring, by source: both ask paths apply the rule to the body they send', () => {
  it('compass.ts imports withSensingZone from the pure module and spreads it on BOTH /api/compass/ask bodies', () => {
    assert.match(COMPASS, /import \{ withSensingZone \} from '\.\/sensing\/sensingZoneHint\.ts';/);
    const plain = /body:\s+JSON\.stringify\(\{ prompt, \.\.\.withSensingZone\(opts\), tzOffsetMinutes: deviceTzOffsetMinutes\(\) \}\)/;
    const stream = /body: JSON\.stringify\(\{ prompt, \.\.\.withSensingZone\(opts\), stream: true, tzOffsetMinutes: deviceTzOffsetMinutes\(\) \}\)/;
    assert.match(COMPASS, plain, 'postCompassAsk spreads withSensingZone(opts)');
    assert.match(COMPASS, stream, 'postCompassAskStream spreads withSensingZone(opts)');
    // No ask body spreads the raw opts any more: the rule cannot be bypassed by one path.
    assert.doesNotMatch(COMPASS, /\{ prompt, \.\.\.opts, /);
  });

  it('the option is declared on both ask signatures', () => {
    assert.ok((COMPASS.match(/sensingZoneIds\?:\s+string\[\]/g) ?? []).length >= 2);
  });
});
