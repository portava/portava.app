/**
 * features/media — contextual perspective-viewer model tests (spec §14).
 *
 * Covers the three behaviours the §14 viewer depends on:
 *   1. the related-perspectives collection builder — scoped to the entry
 *      context, EXCLUDES unrelated media (foreign entity, non-group media);
 *   2. the perspective-group navigation state — active group, related strip,
 *      group jumps, and safe index math;
 *   3. the degrade path — missing groups / garbage / empty never throw and
 *      produce a clean, well-formed (possibly empty) collection.
 *
 * Pure node:test suite — imports only the pure model module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { MediaProjection } from '../types/media.ts';
import type { PerspectiveGroup } from '../types/perspective.ts';
import {
  buildPerspectiveCollection,
  isEmptyCollection,
  clampIndex,
  indexOfMedia,
  initialIndexForMedia,
  stepIndex,
  activeGroupKeyAt,
  groupLabelFor,
  firstIndexOfGroup,
  relatedPerspectives,
  type BuildPerspectiveCollectionInput,
} from '../state/perspectiveViewer.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkMedia(over: Partial<MediaProjection> & { id: string }): MediaProjection {
  return {
    mediaType: 'image',
    thumbnailUrl: `thumb/${over.id}.jpg`,
    observationClass: 'observed',
    freshness: 'fresh',
    ...over,
  };
}

const GROUPS: PerspectiveGroup[] = [
  { key: 'street', label: 'Street', count: 3 },
  { key: 'entrance', label: 'Entrance', count: 2 },
  { key: 'rooftop', label: 'Rooftop', count: 1 },
];

const PLACE_ID = 'place-anthuong';

/** A realistic place entry context: media across three groups, all at the place. */
function placeInput(over: Partial<BuildPerspectiveCollectionInput> = {}): BuildPerspectiveCollectionInput {
  return {
    kind: 'place',
    entityId: PLACE_ID,
    entityLabel: 'An Thuong',
    groups: GROUPS,
    media: [
      mkMedia({ id: 's1', perspectiveKey: 'street', place: { id: PLACE_ID, name: 'An Thuong' } }),
      mkMedia({ id: 'e1', perspectiveKey: 'entrance', place: { id: PLACE_ID, name: 'An Thuong' } }),
      mkMedia({ id: 's2', perspectiveKey: 'street', place: { id: PLACE_ID, name: 'An Thuong' } }),
      mkMedia({ id: 'r1', perspectiveKey: 'rooftop', place: { id: PLACE_ID, name: 'An Thuong' } }),
    ],
    ...over,
  };
}

// ── 1. Builder: scoping + exclusion ───────────────────────────────────────────

test('buildPerspectiveCollection groups a place view in group order', () => {
  const c = buildPerspectiveCollection(placeInput());
  assert.equal(c.grouped, true);
  assert.equal(c.kind, 'place');
  assert.equal(c.entityId, PLACE_ID);
  // Items ordered by group order (street, street, entrance, rooftop) — street's
  // two items first because 'street' is the first group.
  assert.deepEqual(c.items.map((m) => m.id), ['s1', 's2', 'e1', 'r1']);
  // Only groups that actually carry media survive, in order.
  assert.deepEqual(c.groups.map((g) => g.key), ['street', 'entrance', 'rooftop']);
  // Server count is preferred over loaded count.
  assert.equal(c.groups.find((g) => g.key === 'street')?.count, 3);
});

test('buildPerspectiveCollection EXCLUDES media tagged to a different place', () => {
  const c = buildPerspectiveCollection(
    placeInput({
      media: [
        mkMedia({ id: 's1', perspectiveKey: 'street', place: { id: PLACE_ID, name: 'An Thuong' } }),
        // Foreign place — must be excluded from a place entry context (§46.2).
        mkMedia({ id: 'x9', perspectiveKey: 'street', place: { id: 'other-place', name: 'Elsewhere' } }),
      ],
    }),
  );
  assert.deepEqual(c.items.map((m) => m.id), ['s1']);
  assert.equal(indexOfMedia(c, 'x9'), -1);
});

test('buildPerspectiveCollection EXCLUDES media outside the entity groups', () => {
  const c = buildPerspectiveCollection(
    placeInput({
      media: [
        mkMedia({ id: 's1', perspectiveKey: 'street', place: { id: PLACE_ID, name: 'An Thuong' } }),
        // A perspective key that is not one of the entity's groups — unrelated.
        mkMedia({ id: 'f1', perspectiveKey: 'food', place: { id: PLACE_ID, name: 'An Thuong' } }),
        // No perspective key at all in a grouped context — unrelated.
        mkMedia({ id: 'n1', place: { id: PLACE_ID, name: 'An Thuong' } }),
      ],
    }),
  );
  assert.deepEqual(c.items.map((m) => m.id), ['s1']);
  assert.deepEqual(c.groups.map((g) => g.key), ['street']);
});

test('buildPerspectiveCollection drops empty-id media', () => {
  const c = buildPerspectiveCollection(
    placeInput({
      media: [
        mkMedia({ id: '', perspectiveKey: 'street', place: { id: PLACE_ID, name: 'An Thuong' } }),
        mkMedia({ id: 's1', perspectiveKey: 'street', place: { id: PLACE_ID, name: 'An Thuong' } }),
      ],
    }),
  );
  assert.deepEqual(c.items.map((m) => m.id), ['s1']);
});

test('experience entry context does NOT filter across places (chain spans places)', () => {
  const c = buildPerspectiveCollection({
    kind: 'experience',
    entityId: 'exp-1',
    entityLabel: 'Friday Night An Thuong',
    groups: [
      { key: 'dinner', label: 'Dinner', count: 1 },
      { key: 'rooftop', label: 'Rooftop', count: 1 },
    ],
    media: [
      mkMedia({ id: 'd1', perspectiveKey: 'dinner', place: { id: 'place-a', name: 'A' } }),
      mkMedia({ id: 'r1', perspectiveKey: 'rooftop', place: { id: 'place-b', name: 'B' } }),
    ],
  });
  // Both kept — an experience legitimately spans multiple places.
  assert.deepEqual(c.items.map((m) => m.id), ['d1', 'r1']);
});

// ── 2. Navigation state ───────────────────────────────────────────────────────

test('initialIndexForMedia opens on the tapped media, else the first', () => {
  const c = buildPerspectiveCollection(placeInput());
  assert.equal(initialIndexForMedia(c, 'e1'), 2);
  // Absent / excluded id falls back to the first item, never -1.
  assert.equal(initialIndexForMedia(c, 'does-not-exist'), 0);
  assert.equal(initialIndexForMedia(c, null), 0);
});

test('activeGroupKeyAt + groupLabelFor reflect the current media', () => {
  const c = buildPerspectiveCollection(placeInput());
  // items: [s1(street), s2(street), e1(entrance), r1(rooftop)]
  assert.equal(activeGroupKeyAt(c, 0), 'street');
  assert.equal(activeGroupKeyAt(c, 2), 'entrance');
  assert.equal(groupLabelFor(c, activeGroupKeyAt(c, 3)), 'Rooftop');
});

test('relatedPerspectives marks the active group and points each chip at its first item', () => {
  const c = buildPerspectiveCollection(placeInput());
  const related = relatedPerspectives(c, 2); // active media e1 → entrance
  assert.deepEqual(related.map((r) => r.key), ['street', 'entrance', 'rooftop']);
  assert.deepEqual(related.map((r) => r.active), [false, true, false]);
  // Jump indices: street→0 (s1), entrance→2 (e1), rooftop→3 (r1).
  assert.deepEqual(related.map((r) => r.index), [0, 2, 3]);
});

test('firstIndexOfGroup finds the first item of a group, -1 when unknown', () => {
  const c = buildPerspectiveCollection(placeInput());
  assert.equal(firstIndexOfGroup(c, 'entrance'), 2);
  assert.equal(firstIndexOfGroup(c, 'nope'), -1);
  assert.equal(firstIndexOfGroup(c, null), -1);
});

test('clampIndex + stepIndex never leave the valid range (no wrap)', () => {
  const c = buildPerspectiveCollection(placeInput()); // 4 items
  assert.equal(clampIndex(c, -5), 0);
  assert.equal(clampIndex(c, 99), 3);
  assert.equal(clampIndex(c, NaN), 0);
  assert.equal(stepIndex(c, 0, -1), 0); // clamped at the start
  assert.equal(stepIndex(c, 3, 1), 3); // clamped at the end
  assert.equal(stepIndex(c, 1, 1), 2);
});

// ── 3. Degrade path ───────────────────────────────────────────────────────────

test('missing groups degrade to a flat, ungrouped collection', () => {
  const c = buildPerspectiveCollection({
    kind: 'place',
    entityId: PLACE_ID,
    entityLabel: 'An Thuong',
    groups: [], // server sent no perspective groups
    media: [
      mkMedia({ id: 'a', place: { id: PLACE_ID, name: 'An Thuong' } }),
      mkMedia({ id: 'b', place: { id: PLACE_ID, name: 'An Thuong' } }),
    ],
  });
  assert.equal(c.grouped, false);
  assert.deepEqual(c.items.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(c.groups, []);
  // The related strip is empty but the collection is still navigable.
  assert.deepEqual(relatedPerspectives(c, 0), []);
  assert.equal(isEmptyCollection(c), false);
});

test('empty media produces an empty collection (not an error)', () => {
  const c = buildPerspectiveCollection(placeInput({ media: [] }));
  assert.equal(isEmptyCollection(c), true);
  assert.deepEqual(c.items, []);
  assert.deepEqual(c.groups, []);
});

test('garbage / partial input never throws and yields an empty collection', () => {
  const cases: unknown[] = [
    { kind: 'place', media: [null, 42, 'x', {}, { id: '' }, []] },
    { kind: 'place', media: null },
    { kind: 'place', media: undefined, groups: null },
    { kind: 'place', media: [{ id: 's1' }], groups: [{ label: 'No key' }, null, 7] },
  ];
  for (const bad of cases) {
    const c = buildPerspectiveCollection(bad as BuildPerspectiveCollectionInput);
    assert.equal(Array.isArray(c.items), true);
    // None of these carry a valid grouped item → empty or flat, never a throw.
    assert.equal(isEmptyCollection(c) || c.grouped === false, true);
  }
});

test('isEmptyCollection is true for null/undefined', () => {
  assert.equal(isEmptyCollection(null), true);
  assert.equal(isEmptyCollection(undefined), true);
});
