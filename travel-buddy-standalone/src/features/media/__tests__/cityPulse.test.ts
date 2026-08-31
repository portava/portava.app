/**
 * features/media — city visual-pulse formatting tests (§4.1/§20/§46).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zoneStateLabel,
  zoneGlyph,
  zoneGlyphChar,
  zonePulseLine,
  zoneIntensity,
} from '../state/cityPulse.ts';

test('zoneStateLabel maps every state to human copy', () => {
  assert.equal(zoneStateLabel('building'), 'Building');
  assert.equal(zoneStateLabel('peak'), 'Peak');
  assert.equal(zoneStateLabel('winding_down'), 'Winding down');
});

test('zoneGlyph: explicit trend dominates state', () => {
  // peak state but falling trend → down arrow
  assert.equal(zoneGlyph('peak', 'falling'), 'arrow-down');
  // moderate state but rising trend → up arrow
  assert.equal(zoneGlyph('moderate', 'rising'), 'arrow-up');
});

test('zoneGlyph: steady trend falls back to state directionality', () => {
  assert.equal(zoneGlyph('building', 'steady'), 'arrow-up');
  assert.equal(zoneGlyph('starting', 'steady'), 'arrow-up');
  assert.equal(zoneGlyph('winding_down', 'steady'), 'arrow-down');
  assert.equal(zoneGlyph('peak', 'steady'), 'dot');
  assert.equal(zoneGlyph('quiet', 'steady'), 'dot');
});

test('zoneGlyphChar renders the § arrows/dot', () => {
  assert.equal(zoneGlyphChar('arrow-up'), '↑');
  assert.equal(zoneGlyphChar('arrow-down'), '↓');
  assert.equal(zoneGlyphChar('dot'), '●');
});

test('zonePulseLine matches spec §20 formatting (label then glyph)', () => {
  assert.equal(zonePulseLine('building', 'rising'), 'Building ↑');
  assert.equal(zonePulseLine('peak', 'steady'), 'Peak ●');
  assert.equal(zonePulseLine('starting', 'rising'), 'Starting ↑');
});

test('zoneIntensity is ordered peak > building > moderate > starting > winding_down > quiet', () => {
  const order = ['peak', 'building', 'moderate', 'starting', 'winding_down', 'quiet'] as const;
  const vals = order.map(zoneIntensity);
  for (let i = 1; i < vals.length; i++) {
    assert.ok(vals[i - 1] > vals[i], `${order[i - 1]}(${vals[i - 1]}) should exceed ${order[i]}(${vals[i]})`);
  }
  // Bounded 0..1.
  for (const v of vals) assert.ok(v >= 0 && v <= 1);
});
