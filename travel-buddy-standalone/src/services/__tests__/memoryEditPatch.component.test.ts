import { memoryEditPatch } from '../memoryEditPatch.ts';
import type { Memory } from '../memories.ts';

const base: Memory = {
  id: 'memory', ownerId: 'owner', title: 'Title', caption: 'Caption', visibility: 'only_me',
  allowedUserIds: [], hiddenUserIds: [], tripId: null, eventId: null, placeId: 'old-place',
  canonicalLocationId: null, locationCity: 'Paris', locationCountry: 'France', locationLat: 48, locationLng: 2,
  startsAt: '2026-11-16T12:00:00.123456Z', endsAt: null, state: 'published',
  createdAt: '2026-11-16T12:00:00Z', updatedAt: null,
};

it('sends only changed facts with their original bases', () => {
  expect(memoryEditPatch(base, { title: 'Title', caption: 'New caption', visibility: 'only_me' })).toEqual({
    caption: 'New caption', expected: { state: 'published', caption: 'Caption' },
  });
  expect(memoryEditPatch(base, { title: 'Title' })).toBeNull();
});
it('compares the original related audience without sharing mutable arrays', () => {
  const expected = memoryEditPatch(base, { visibility: 'public' })!.expected!;
  expect(expected).toEqual({ state: 'published', visibility: 'only_me', allowedUserIds: [], hiddenUserIds: [] });
  expect(expected.allowedUserIds).not.toBe(base.allowedUserIds);
});
it('pins the location group and preserves explicit clears', () => {
  const edit = memoryEditPatch(base, { placeId: null });
  expect(edit).toEqual({ placeId: null, expected: { state: 'published', placeId: 'old-place', canonicalLocationId: null,
    locationCity: 'Paris', locationCountry: 'France', locationLat: 48, locationLng: 2, placeDisplayNameAtOccurrence: null } });
});
it('compares the time pair without rounding sub-millisecond precision', () => {
  expect(memoryEditPatch(base, { endsAt: '2026-11-16T13:00:00Z' })).toEqual({ endsAt: '2026-11-16T13:00:00Z',
    expected: { state: 'published', startsAt: base.startsAt, endsAt: null } });
});
