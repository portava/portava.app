/**
 * §35 `why_shown_opened` must describe the panel that was actually shown.
 * (census-map M263)
 *
 * ## The defect
 *
 * `WhyShownOpenedPayload.lineCount` is documented as *"How many provenance
 * lines the §9 panel showed"* and `provenanceRefs` as the panel's opaque
 * claim-snapshot refs. The one emitter in the tree builds them from the RAW
 * OBJECT instead of from the panel:
 *
 *     lineCount: obj.provenance?.lines.length ?? 0,
 *     provenanceRefs: obj.sourceRefs,
 *
 * `WhyShownSheet` renders `buildWhyPanel(object)`, and `buildWhyLines`
 * SYNTHESISES evidence lines whenever `provenance.lines` is absent — a source
 * count, an activity reading, a trend, a freshness line, an aggregation note.
 * For every such object the panel draws several lines and the event reports
 * zero, so §35's only measure of "was the explanation legible" reads 0 on
 * exactly the objects whose explanation the product built for itself.
 *
 * `provenanceRefs` diverges the other way: when `provenance.lines` DO carry
 * refs, those are what the panel showed, and `obj.sourceRefs` is a different
 * list — or absent.
 *
 * ## What this file pins
 *
 * One function, `whyShownOpenedPayload`, derived from the SAME
 * `buildWhyPanel` call the sheet renders, so the event and the pixels cannot
 * disagree. The tests assert the agreement against `buildWhyPanel` itself
 * rather than against hard-coded counts, so a change to §9's line rules moves
 * both together or fails here.
 *
 * ## Anti-vacuity
 *
 * The synthesised case asserts the naive expression and the panel DISAGREE
 * before asserting the helper matches the panel. A helper that simply returned
 * `obj.provenance?.lines.length ?? 0` would fail that pair, and a fixture that
 * never reached the synthesising branch would fail the disagreement assertion.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { whyShownOpenedPayload } from '../whyShownOpened.ts';
import { buildWhyPanel } from '../../truth/liveTruth.ts';
import { describeMapObject } from '../mapTelemetry.ts';
import { point, type MapObject } from '../../../../types/mapObjects.ts';

const NOW = new Date('2026-09-14T10:00:00Z');

/** Server-supplied §9 provenance: the panel renders these lines verbatim. */
const WITH_PROVENANCE: MapObject = {
  id: 'place:p1',
  kind: 'place',
  geometry: point(16.05, 108.22),
  title: 'Cong Caphe',
  privacyClass: 'place_level',
  renderingPriority: 50,
  confidence: 'strong',
  freshness: 'live',
  sourceRefs: ['src:unused-by-the-panel'],
  provenance: {
    confidence: 'strong',
    updatedAt: '2026-09-14T09:55:00Z',
    lines: [
      { text: 'Several recent traveler reports', ref: 'claim:c1' },
      { text: 'Busier than usual for a Monday morning', ref: 'claim:c2' },
      { text: 'An event is running nearby' },
    ],
  },
};

/**
 * NO `provenance.lines` — the common case, and the one the defect is about.
 * The panel synthesises its evidence from these axes instead.
 */
const SYNTHESISED: MapObject = {
  id: 'zone:z9',
  kind: 'activity_zone',
  geometry: point(16.06, 108.21),
  title: 'An Thuong',
  privacyClass: 'aggregate_only',
  renderingPriority: 40,
  confidence: 'strong',
  freshness: 'live',
  activity: 'busy',
  trend: 'getting_busier',
  sourceRefs: ['src:a', 'src:b', 'src:c'],
  observedAt: '2026-09-14T09:58:00Z',
};

describe('§35 why_shown_opened payload', () => {
  test('server-supplied provenance: counts and refs are the panel’s own', () => {
    const panel = buildWhyPanel(WITH_PROVENANCE, NOW);
    const payload = whyShownOpenedPayload(WITH_PROVENANCE, NOW);

    assert.equal(payload.lineCount, panel.lines.length);
    assert.deepEqual(payload.provenanceRefs, ['claim:c1', 'claim:c2']);
    // NOT the object's sourceRefs — the panel never showed those.
    assert.ok(!JSON.stringify(payload).includes('unused-by-the-panel'));
  });

  test('synthesised provenance: the naive expression under-reports, the helper does not', () => {
    const panel = buildWhyPanel(SYNTHESISED, NOW);
    const naive = SYNTHESISED.provenance?.lines.length ?? 0;

    // Anti-vacuity: the fixture must actually reach the synthesising branch,
    // and the two readings must actually differ, or the rest proves nothing.
    assert.ok(panel.lines.length > 0, 'the panel drew no lines');
    assert.notEqual(naive, panel.lines.length);

    assert.equal(whyShownOpenedPayload(SYNTHESISED, NOW).lineCount, panel.lines.length);
  });

  test('the ref is the §35 ref — no title, no coordinate', () => {
    const payload = whyShownOpenedPayload(WITH_PROVENANCE, NOW);
    assert.deepEqual(payload.ref, describeMapObject(WITH_PROVENANCE));

    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes('Cong Caphe'));
    assert.ok(!serialized.includes('108.22'));
    assert.ok(!serialized.includes('16.05'));
  });

  test('provenanceRefs is omitted rather than empty when the panel showed none', () => {
    const payload = whyShownOpenedPayload(SYNTHESISED, NOW);
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, 'provenanceRefs'),
      false,
      'an empty list reads as "the panel showed refs and they were none"',
    );
  });
});
