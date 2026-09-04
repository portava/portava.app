/**
 * memoryTimeline — pure grouping for the §15 Memories "Timeline" view.
 *
 * §15: "Memories are travel-contextual, not a generic media grid. Views: Trips,
 * Places, People, Timeline and Map." The Timeline view orders memories
 * chronologically (newest first) and groups them by month, so a Passport reads
 * as a travel story rather than an undated wall.
 *
 * Pure + deterministic (no `Date.now`, no locale surprises in the key) so the
 * grouping is unit-testable; the month LABEL is the only display string and is
 * built from a fixed month table, not toLocaleString, so tests are stable
 * across the CI timezone.
 */
import type { PassportMemory } from '../services/passportStamps.ts';

export interface MemoryTimelineSection {
  /** Stable key, e.g. "2026-09" (or "undated"). */
  key: string;
  /** Human label, e.g. "September 2026" (or "Undated"). */
  label: string;
  /** Memories in the section, newest first. */
  memories: PassportMemory[];
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The timestamp a memory is filed under: earnedAt, else createdAt. */
export function memoryTimestamp(m: PassportMemory): number | null {
  for (const raw of [m.earnedAt, m.createdAt]) {
    if (typeof raw === 'string' && raw.length > 0) {
      const t = Date.parse(raw);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

/**
 * Group memories into month sections, newest first, with any undated memories
 * collected into a trailing "Undated" section (never dropped). Within a section
 * memories are ordered newest first; undated ones keep input order.
 */
export function groupMemoriesByTimeline(memories: PassportMemory[]): MemoryTimelineSection[] {
  const sections = new Map<string, { sortKey: number; label: string; memories: PassportMemory[] }>();
  const undated: PassportMemory[] = [];

  for (const m of memories) {
    const ts = memoryTimestamp(m);
    if (ts === null) {
      undated.push(m);
      continue;
    }
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth(); // 0-11
    const key = `${y}-${String(mo + 1).padStart(2, '0')}`;
    let sec = sections.get(key);
    if (!sec) {
      sec = { sortKey: y * 12 + mo, label: `${MONTHS[mo]} ${y}`, memories: [] };
      sections.set(key, sec);
    }
    sec.memories.push(m);
  }

  const out: MemoryTimelineSection[] = Array.from(sections.entries())
    .sort((a, b) => b[1].sortKey - a[1].sortKey)
    .map(([key, sec]) => ({
      key,
      label: sec.label,
      memories: sec.memories.slice().sort((a, b) => (memoryTimestamp(b) ?? 0) - (memoryTimestamp(a) ?? 0)),
    }));

  if (undated.length > 0) {
    out.push({ key: 'undated', label: 'Undated', memories: undated });
  }
  return out;
}
