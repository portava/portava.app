/**
 * features/media — My World §31 / §31.1 memory + §30 bucket mapping tests.
 *
 * Verifies the client mapper matches the REAL merged backend shape
 * (MediaProjectionService.buildMyWorldProjection + MyWorldMemoryService): the
 * owner-only `memory` field carries §31 groups (each with entries) and §31.1
 * Hidden Gem Memory lines, alongside real §30 bucket counts. Covers:
 *   - the memory mapper matches the backend `memory` shape and pins every entry
 *     to `visibility: 'owner_only'` (a mutated payload can't downgrade privacy);
 *   - the section's render selectors (visibleMemoryGroups / isMyWorldMemoryEmpty)
 *     surface owner-only groups and self-hide when empty;
 *   - the §30 buckets + memory map together from a realistic /media/me body;
 *   - the degrade path: absent / partial / garbage ⇒ empty, well-formed, no throw.
 *
 * Pure node:test suite — imports only the pure service mappers (no react-native).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapMyWorldLibrary,
  mapMyWorldMemory,
  isMyWorldEmpty,
  isMyWorldMemoryEmpty,
  visibleMemoryGroups,
} from '../services/mediaProjection.ts';

/** A realistic §31 memory payload, shaped like MyWorldMemoryService output. */
function serverMemory(over: Record<string, unknown> = {}) {
  return {
    ownerId: 'u1',
    visibility: 'owner_only',
    groups: [
      {
        group: 'returned_to_place',
        label: 'Returned to Place',
        description: 'Places you have come back to.',
        entries: [
          {
            id: 'myworld:returned::place::p1',
            group: 'returned_to_place',
            title: 'Returned to Place',
            detail: 'Visited Da Nang (returned)',
            subjectType: 'place',
            subjectId: 'p1',
            occurredAt: '2026-08-01T00:00:00Z',
            source: { kind: 'derived_memory', derivation: 'memory_remembers_for_user' },
            visibility: 'owner_only',
          },
        ],
      },
      // An all-empty group — the section must hide it.
      {
        group: 'visited_hidden_gem',
        label: 'Visited Hidden Gem',
        description: 'Hidden Gems you have been to.',
        entries: [],
      },
      {
        group: 'favorite_atmosphere',
        label: 'Favorite atmosphere',
        description: 'The kinds of places and vibes you keep coming back to.',
        entries: [
          {
            id: 'myworld:atmosphere::pref::a1',
            group: 'favorite_atmosphere',
            title: 'Favorite atmosphere',
            detail: 'quiet rooftop bars',
            subjectType: 'pref',
            subjectId: 'a1',
            // occurredAt absent — the source has no date.
            source: { kind: 'derived_memory', derivation: 'memory_remembers_for_user' },
            visibility: 'owner_only',
          },
        ],
      },
    ],
    hiddenGemMemory: [
      {
        gemId: 'g1',
        gemName: 'The Alley Cafe',
        kind: 'discovered',
        label: 'You discovered this Gem.',
        subjectType: 'myworld_gem:discovered',
        subjectId: 'g1',
        occurredAt: '2026-07-01T00:00:00Z',
        visibility: 'owner_only',
      },
      {
        gemId: 'g1',
        gemName: 'The Alley Cafe',
        kind: 'visited_before_popular',
        label: 'You visited before it became popular.',
        subjectType: 'myworld_gem:visited_before_popular',
        subjectId: 'g1',
        visibility: 'owner_only',
      },
    ],
    totals: { surfaced: 4, suppressed: 1 },
    notes: [
      'This view is private to you — it is never shown on your public profile or anyone else’s My World.',
      'Memory here is derived from what you did.',
    ],
    ...over,
  };
}

// ── §31 memory mapper ─────────────────────────────────────────────────────────

test('mapMyWorldMemory maps the backend §31 groups + §31.1 gem lines', () => {
  const mem = mapMyWorldMemory(serverMemory());

  assert.equal(mem.visibility, 'owner_only');
  assert.equal(mem.groups.length, 3);

  const returned = mem.groups.find((g) => g.group === 'returned_to_place');
  assert.ok(returned);
  assert.equal(returned.label, 'Returned to Place');
  assert.equal(returned.entries.length, 1);
  assert.equal(returned.entries[0].detail, 'Visited Da Nang (returned)');
  assert.equal(returned.entries[0].occurredAt, '2026-08-01T00:00:00Z');

  // A missing occurredAt maps to null, not a throw.
  const atmosphere = mem.groups.find((g) => g.group === 'favorite_atmosphere');
  assert.ok(atmosphere);
  assert.equal(atmosphere.entries[0].occurredAt, null);

  // §31.1 lines.
  assert.equal(mem.hiddenGemMemory.length, 2);
  assert.equal(mem.hiddenGemMemory[0].label, 'You discovered this Gem.');
  assert.equal(mem.hiddenGemMemory[0].gemName, 'The Alley Cafe');
  assert.equal(mem.hiddenGemMemory[1].gemName, 'The Alley Cafe');

  // Totals + notes carried through.
  assert.deepEqual(mem.totals, { surfaced: 4, suppressed: 1 });
  assert.equal(mem.notes.length, 2);
});

test('mapMyWorldMemory pins every entry + gem line to owner_only (no privacy downgrade)', () => {
  // A mutated / hand-rolled payload tries to make a private entry public — the
  // mapper must ignore that and keep it owner-only.
  const mem = mapMyWorldMemory(
    serverMemory({
      visibility: 'public',
      groups: [
        {
          group: 'returned_to_place',
          label: 'Returned to Place',
          description: 'x',
          entries: [
            { id: 'e1', group: 'returned_to_place', title: 't', detail: 'd', visibility: 'public' },
          ],
        },
      ],
      hiddenGemMemory: [
        { gemId: 'g1', kind: 'discovered', label: 'You discovered this Gem.', visibility: 'followers' },
      ],
    }),
  );

  assert.equal(mem.visibility, 'owner_only');
  for (const g of mem.groups) {
    for (const e of g.entries) assert.equal(e.visibility, 'owner_only');
  }
  for (const line of mem.hiddenGemMemory) assert.equal(line.visibility, 'owner_only');
});

test('mapMyWorldMemory drops malformed entries / groups / gem lines defensively', () => {
  const mem = mapMyWorldMemory({
    groups: [
      null,
      { label: 'No group key', entries: [] }, // no `group` → dropped
      { group: 'returned_to_place' }, // no `label` → dropped
      {
        group: 'favorite_atmosphere',
        label: 'Favorite atmosphere',
        entries: [
          { title: 'no id' }, // no id → dropped
          { id: 'ok', title: 'kept' },
          'garbage',
        ],
      },
    ],
    hiddenGemMemory: [
      { gemName: 'no id/label' }, // no gemId/label → dropped
      { gemId: 'g9', label: 'You confirmed it twice.' },
      42,
    ],
  });

  assert.equal(mem.groups.length, 1);
  assert.equal(mem.groups[0].group, 'favorite_atmosphere');
  assert.equal(mem.groups[0].description, ''); // absent description defaults to ''
  assert.equal(mem.groups[0].entries.length, 1);
  assert.equal(mem.groups[0].entries[0].id, 'ok');
  assert.equal(mem.hiddenGemMemory.length, 1);
  assert.equal(mem.hiddenGemMemory[0].gemId, 'g9');
});

test('mapMyWorldMemory degrades an absent / garbage payload to an empty owner-only surface', () => {
  for (const raw of [undefined, null, 'nope', 42, []]) {
    const mem = mapMyWorldMemory(raw);
    assert.equal(mem.visibility, 'owner_only');
    assert.deepEqual(mem.groups, []);
    assert.deepEqual(mem.hiddenGemMemory, []);
    assert.deepEqual(mem.totals, { surfaced: 0, suppressed: 0 });
    assert.deepEqual(mem.notes, []);
    assert.equal(isMyWorldMemoryEmpty(mem), true);
  }
});

// ── Section render selectors ──────────────────────────────────────────────────

test('visibleMemoryGroups surfaces only groups with entries; empty ⇒ section hidden', () => {
  const mem = mapMyWorldMemory(serverMemory());
  const visible = visibleMemoryGroups(mem);
  // The all-empty "visited_hidden_gem" group is hidden; the two with entries show.
  assert.equal(visible.length, 2);
  assert.ok(visible.every((g) => g.entries.length > 0));
  assert.equal(isMyWorldMemoryEmpty(mem), false);

  // A memory with only empty groups + no gem lines ⇒ nothing renders.
  const emptyMem = mapMyWorldMemory({
    groups: [{ group: 'returned_to_place', label: 'Returned to Place', entries: [] }],
    hiddenGemMemory: [],
  });
  assert.equal(visibleMemoryGroups(emptyMem).length, 0);
  assert.equal(isMyWorldMemoryEmpty(emptyMem), true);

  // Gem-lines-only memory is NOT empty (the section still renders).
  const gemsOnly = mapMyWorldMemory({
    groups: [],
    hiddenGemMemory: [{ gemId: 'g1', label: 'You discovered this Gem.' }],
  });
  assert.equal(isMyWorldMemoryEmpty(gemsOnly), false);
});

// ── §30 buckets + memory together (GET /media/me) ─────────────────────────────

test('mapMyWorldLibrary maps §30 buckets and the §31 memory from a real /media/me body', () => {
  const lib = mapMyWorldLibrary({
    generatedAt: '2026-08-31T10:00:00Z',
    buckets: [
      { key: 'all', label: 'All', ownerOnly: false, count: 0, media: [] },
      { key: 'postcards', label: 'Postcards', ownerOnly: false, count: 3, media: [] }, // count-only bucket
      { key: 'drafts', label: 'Drafts', ownerOnly: true, count: 0, media: [] },
      { key: 'uploads', label: 'Uploads', ownerOnly: true, count: 2, media: [] },
    ],
    memory: serverMemory(),
  });

  assert.equal(lib.buckets.length, 4);
  assert.equal(lib.generatedAt, '2026-08-31T10:00:00Z');
  // The owner-only operational bucket carries its flag.
  assert.equal(lib.buckets.find((b) => b.key === 'uploads')?.ownerOnly, true);
  // Memory came through.
  assert.equal(lib.memory.groups.length, 3);
  assert.equal(lib.memory.hiddenGemMemory.length, 2);

  // A world with no media anywhere but real bucket counts is NOT empty.
  assert.equal(isMyWorldEmpty(lib), false);
});

test('isMyWorldEmpty: memory-only world (no media, no counts) is not empty', () => {
  const lib = mapMyWorldLibrary({
    buckets: [
      { key: 'all', label: 'All', ownerOnly: false, count: 0, media: [] },
      { key: 'gems', label: 'Hidden Gems', ownerOnly: false, count: 0, media: [] },
    ],
    memory: {
      groups: [],
      hiddenGemMemory: [{ gemId: 'g1', label: 'You discovered this Gem.' }],
    },
  });
  assert.equal(isMyWorldEmpty(lib), false); // the private memory keeps it non-empty
});

test('mapMyWorldLibrary degrades an empty / garbage body to an empty, well-formed library', () => {
  for (const raw of [undefined, null, {}, 'nope', 7]) {
    const lib = mapMyWorldLibrary(raw);
    assert.deepEqual(lib.buckets, []);
    assert.equal(lib.memory.visibility, 'owner_only');
    assert.deepEqual(lib.memory.groups, []);
    assert.deepEqual(lib.memory.hiddenGemMemory, []);
    assert.equal(lib.generatedAt, null);
    assert.equal(isMyWorldEmpty(lib), true);
  }
});
