/**
 * memoryTimeline — the §15 Timeline grouping.
 *
 *   • Groups by calendar month, sections ordered newest first.
 *   • Within a section, memories are newest first.
 *   • earnedAt wins; createdAt is the fallback timestamp.
 *   • Undated memories are collected into a trailing section, never dropped.
 */
import { groupMemoriesByTimeline, memoryTimestamp } from '../memoryTimeline.ts';
import type { PassportMemory } from '../../services/passportStamps.ts';

function mem(over: Partial<PassportMemory>): PassportMemory {
  return {
    id: 'm', status: 'active', title: null, description: null, country: null, city: null,
    neighborhood: null, category: null, visibility: 'public', verificationLevel: 'none',
    sourceType: null, photoUrl: null, mediaType: null, planId: null, tripId: null,
    suggestionReason: null, earnedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as PassportMemory;
}

it('memoryTimestamp prefers earnedAt, falls back to createdAt, else null', () => {
  expect(memoryTimestamp(mem({ earnedAt: '2026-05-02T00:00:00Z', createdAt: '2020-01-01T00:00:00Z' })))
    .toBe(Date.parse('2026-05-02T00:00:00Z'));
  expect(memoryTimestamp(mem({ earnedAt: '' as unknown as string, createdAt: '2020-03-04T00:00:00Z' })))
    .toBe(Date.parse('2020-03-04T00:00:00Z'));
  expect(memoryTimestamp(mem({ earnedAt: '' as unknown as string, createdAt: 'nope' as unknown as string }))).toBeNull();
});

it('groups by month, newest section first, newest memory first within a section', () => {
  const sections = groupMemoriesByTimeline([
    mem({ id: 'sep-early', earnedAt: '2026-09-03T00:00:00Z' }),
    mem({ id: 'aug', earnedAt: '2026-08-15T00:00:00Z' }),
    mem({ id: 'sep-late', earnedAt: '2026-09-20T00:00:00Z' }),
  ]);
  expect(sections.map((s) => s.key)).toEqual(['2026-09', '2026-08']);
  expect(sections[0].label).toBe('September 2026');
  expect(sections[0].memories.map((m) => m.id)).toEqual(['sep-late', 'sep-early']);
  expect(sections[1].memories.map((m) => m.id)).toEqual(['aug']);
});

it('collects undated memories into a trailing "Undated" section, never dropping them', () => {
  const sections = groupMemoriesByTimeline([
    mem({ id: 'dated', earnedAt: '2026-07-01T00:00:00Z' }),
    mem({ id: 'undated', earnedAt: '' as unknown as string, createdAt: 'not-a-date' as unknown as string }),
  ]);
  expect(sections.map((s) => s.key)).toEqual(['2026-07', 'undated']);
  expect(sections[1].label).toBe('Undated');
  expect(sections[1].memories.map((m) => m.id)).toEqual(['undated']);
});

it('empty input yields no sections', () => {
  expect(groupMemoriesByTimeline([])).toEqual([]);
});
