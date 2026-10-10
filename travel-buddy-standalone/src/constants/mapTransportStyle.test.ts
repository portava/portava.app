/**
 * census-map M122 — the §16 Transport layer, under lead ruling D-36a
 * (docs/ops/lead-rulings-20261007-media.md): BASE-MAP STYLING, not a new
 * MapObjectKind. The toggle restyles the dark base map to show the transit
 * lines and stations already in the OpenMapTiles tiles it loads.
 *
 *   A. off is the base map itself — the same object, so the default map is
 *      unchanged and every `=== PORTAVA_DARK_MAP_STYLE` failure check holds;
 *   B. on adds exactly the transport layers, from the base map's own source,
 *      below every label, and changes nothing else;
 *   C. nothing new is read: no new source, no new source-layer beyond the
 *      OpenMapTiles `transportation` and `poi`, no text (the §4 label budget).
 *
 * Run: node --import tsx/esm --test src/constants/mapTransportStyle.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PORTAVA_DARK_MAP_STYLE,
  TRANSPORT_STYLE_LAYER_IDS,
  portavaBaseMapStyle,
} from './mapStyle.ts';

describe('A. Transport off is the base map itself', () => {
  it('returns PORTAVA_DARK_MAP_STYLE, the same reference', () => {
    assert.equal(portavaBaseMapStyle({ transport: false }), PORTAVA_DARK_MAP_STYLE);
  });
  it('the base map carries no transport layer', () => {
    const ids = PORTAVA_DARK_MAP_STYLE.layers.map((l) => l.id);
    for (const id of TRANSPORT_STYLE_LAYER_IDS) assert.ok(!ids.includes(id), id);
  });
});

describe('B. Transport on restyles the base map', () => {
  const on = portavaBaseMapStyle({ transport: true });
  const ids = on.layers.map((l) => l.id);

  it('adds exactly the three transport layers, and every base layer in its order', () => {
    assert.deepEqual(ids.filter((id) => (TRANSPORT_STYLE_LAYER_IDS as readonly string[]).includes(id)), [...TRANSPORT_STYLE_LAYER_IDS]);
    assert.deepEqual(ids.filter((id) => !(TRANSPORT_STYLE_LAYER_IDS as readonly string[]).includes(id)), PORTAVA_DARK_MAP_STYLE.layers.map((l) => l.id));
  });

  it('draws them below every label', () => {
    const firstLabel = on.layers.findIndex((l) => l.type === 'symbol');
    for (const id of TRANSPORT_STYLE_LAYER_IDS) assert.ok(ids.indexOf(id) < firstLabel, `${id} under the labels`);
  });

  it('is one memoised object, and the base style is not mutated', () => {
    assert.equal(portavaBaseMapStyle({ transport: true }), on);
    assert.notEqual(on, PORTAVA_DARK_MAP_STYLE);
    assert.equal(on.sources, PORTAVA_DARK_MAP_STYLE.sources);
    assert.equal(on.glyphs, PORTAVA_DARK_MAP_STYLE.glyphs);
  });
});

describe('C. nothing new is read, and no label is added', () => {
  it('every transport layer reads the base map\'s own vector source, from transportation or poi', () => {
    const on = portavaBaseMapStyle({ transport: true });
    for (const l of on.layers.filter((x) => (TRANSPORT_STYLE_LAYER_IDS as readonly string[]).includes(x.id))) {
      const any = l as { source?: string; 'source-layer'?: string; type: string };
      assert.equal(any.source, 'openmaptiles', l.id);
      assert.ok(['transportation', 'poi'].includes(any['source-layer'] ?? ''), l.id);
      assert.notEqual(any.type, 'symbol', `${l.id}: no text — the §4 label budget is unchanged`);
    }
    assert.deepEqual(Object.keys(on.sources), Object.keys(PORTAVA_DARK_MAP_STYLE.sources));
  });
});
