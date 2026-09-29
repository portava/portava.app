/**
 * Global Input Intelligence — §24 Paste Intelligence, the review model
 * (census G154–G157, G161, G162; flow GII-F08).
 *
 * The server classifies a paste and resolves every item through the shared
 * gateway (`POST /api/input-assistance/extract`, which writes nothing). This
 * module is what the REVIEW SCREEN reasons with: it parses that answer
 * defensively, decides what is pre-ticked, and turns the ticked candidates into
 * the destinations the field will persist. It persists nothing itself.
 *
 * WHAT IS PRE-TICKED, and why:
 *   - a `resolved` item whose answer was COMPLETE → its first candidate;
 *   - a `resolved` item whose answer was PARTIAL (a source could not be read) →
 *     NOT ticked: the best match may be the one that could not be looked up,
 *     so the person decides;
 *   - `no_match`, `failed`, `unsupported` → nothing to tick.
 *
 * Pure module — no React, no network, no RN. node:test-safe.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';

export type PasteItemStatus = 'resolved' | 'no_match' | 'failed' | 'unsupported';
export type PasteShape = 'coordinates' | 'map_link' | 'list' | 'itinerary' | 'single' | 'empty';

export interface PasteReviewItem {
  index: number;
  raw: string;
  source: 'coordinates' | 'map_link' | 'text';
  query: string | null;
  lat: number | null;
  lng: number | null;
  timeHint: string | null;
  dayLabel: string | null;
  status: PasteItemStatus;
  reason: string | null;
  partial: boolean;
  candidates: InputSuggestion[];
}

export interface PasteExtraction {
  requestId: string;
  shape: PasteShape;
  truncated: boolean;
  items: PasteReviewItem[];
}

/** What the review screen hands the field to persist — one per ticked item. */
export interface PasteDestination {
  itemIndex: number;
  city: string;
  country: string | null;
  lat: number | null;
  lng: number | null;
  placeId: string | null;
}

/** itemIndex → the chosen candidate's index within that item's candidates. */
export type PasteSelection = Record<number, number>;

const STATUSES: ReadonlySet<string> = new Set(['resolved', 'no_match', 'failed', 'unsupported']);
const SHAPES: ReadonlySet<string> = new Set(['coordinates', 'map_link', 'list', 'itinerary', 'single', 'empty']);

const str = (v: unknown, max = 300): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Parse the endpoint's answer. Returns null for anything that is not the
 * contract — the caller shows that as a FAILURE (with retry), never as an empty
 * review, because an unreadable answer is not "nothing was found".
 */
export function parsePasteExtraction(raw: unknown): PasteExtraction | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (b.mutated !== false) return null; // the endpoint's own promise; anything else is not the contract
  if (!Array.isArray(b.items) || typeof b.shape !== 'string' || !SHAPES.has(b.shape)) return null;
  const items: PasteReviewItem[] = [];
  for (const it of b.items) {
    if (!it || typeof it !== 'object') return null;
    const o = it as Record<string, unknown>;
    if (typeof o.status !== 'string' || !STATUSES.has(o.status) || typeof o.index !== 'number') return null;
    const source = o.source === 'coordinates' || o.source === 'map_link' ? o.source : 'text';
    items.push({
      index: o.index,
      raw: str(o.raw, 200) ?? '',
      source,
      query: str(o.query, 120),
      lat: num(o.lat),
      lng: num(o.lng),
      timeHint: str(o.timeHint, 20),
      dayLabel: str(o.dayLabel, 40),
      status: o.status as PasteItemStatus,
      reason: str(o.reason),
      partial: o.partial === true,
      candidates: Array.isArray(o.candidates) ? (o.candidates as InputSuggestion[]).filter(isCandidate) : [],
    });
  }
  return {
    requestId: str(b.requestId, 80) ?? '',
    shape: b.shape as PasteShape,
    truncated: b.truncated === true,
    items,
  };
}

function isCandidate(c: unknown): c is InputSuggestion {
  return !!c && typeof c === 'object' && typeof (c as InputSuggestion).label === 'string' && typeof (c as InputSuggestion).id === 'string';
}

/** The pre-ticked selection: complete, resolved answers only. */
export function initialSelection(items: readonly PasteReviewItem[]): PasteSelection {
  const sel: PasteSelection = {};
  for (const item of items) {
    if (item.status === 'resolved' && !item.partial && item.candidates.some((c) => destinationFromCandidate(c) !== null)) {
      sel[item.index] = item.candidates.findIndex((c) => destinationFromCandidate(c) !== null);
    }
  }
  return sel;
}

/** Tick, untick, or switch which candidate an item uses. */
export function toggleSelection(sel: PasteSelection, itemIndex: number, candidateIndex: number): PasteSelection {
  const next = { ...sel };
  if (next[itemIndex] === candidateIndex) delete next[itemIndex];
  else next[itemIndex] = candidateIndex;
  return next;
}

/**
 * The destination a candidate would persist, or null when it cannot be one
 * (e.g. a country row for a city field). Reads the canonical binding the
 * gateway put on the row — the same `structuredValue` a typed selection binds.
 */
export function destinationFromCandidate(c: InputSuggestion, itemIndex = -1): PasteDestination | null {
  const v = (c.structuredValue ?? null) as Record<string, unknown> | null;
  if (c.entityType === 'city' && v && typeof v.city === 'string' && v.city.trim()) {
    return {
      itemIndex,
      city: v.city.trim(),
      country: str(v.country, 100),
      lat: num(v.lat),
      lng: num(v.lng),
      placeId: typeof v.cityId === 'string' && v.cityId ? v.cityId : null,
    };
  }
  if (c.entityType === 'place' && c.label) {
    return { itemIndex, city: c.label, country: null, lat: null, lng: null, placeId: c.entityId ?? null };
  }
  return null;
}

/** The destinations the person ticked, in paste order. */
export function acceptedDestinations(items: readonly PasteReviewItem[], sel: PasteSelection): PasteDestination[] {
  const out: PasteDestination[] = [];
  for (const item of items) {
    const ci = sel[item.index];
    if (ci === undefined) continue;
    const c = item.candidates[ci];
    const d = c ? destinationFromCandidate(c, item.index) : null;
    if (d) out.push(d);
  }
  return out;
}

export interface PasteReviewSummary {
  resolved: number;
  noMatch: number;
  failed: number;
  unsupported: number;
  partial: number;
}

export function reviewSummary(items: readonly PasteReviewItem[]): PasteReviewSummary {
  const s: PasteReviewSummary = { resolved: 0, noMatch: 0, failed: 0, unsupported: 0, partial: 0 };
  for (const i of items) {
    if (i.status === 'resolved') s.resolved += 1;
    if (i.status === 'no_match') s.noMatch += 1;
    if (i.status === 'failed') s.failed += 1;
    if (i.status === 'unsupported') s.unsupported += 1;
    if (i.partial) s.partial += 1;
  }
  return s;
}

/** The line the review screen shows under an item that has nothing to tick. */
export function itemStatusCopy(item: PasteReviewItem): string | null {
  switch (item.status) {
    case 'failed':
      return item.reason ?? 'We couldn’t check this one.';
    case 'unsupported':
      return item.reason ?? 'This link can’t be read.';
    case 'no_match':
      return item.reason ?? `No place matched “${item.query ?? item.raw}”.`;
    case 'resolved':
      return item.partial ? 'Some sources couldn’t be checked — confirm this is the right place.' : null;
  }
}
