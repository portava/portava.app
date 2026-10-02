/**
 * compassMemorySurfaces — the client for Compass's owner-only memory surfaces
 * (testing-mode WP-12, flows COMP-F16 and COMP-F17).
 *
 *   GET  /api/compass/me/passport/remembers          §12 "What Portava Remembers"
 *   POST /api/compass/me/passport/remembers/forget   forget an item
 *   POST /api/compass/me/passport/remembers/correct  correct an inferred item
 *   GET  /api/compass/me/recaps?kind=…               §5 Personal Recaps
 *   GET  /api/compass/me/on-this-day                 §5 On This Day
 *
 * Every read is owner-only on the server (the session is the subject; nothing
 * here sends a user id). FAILURE HONESTY (DV-83): a failed request is an
 * `{ ok: false }` result, never an empty surface, and a group or section the
 * server could not read arrives marked `unavailable` — the screens show that
 * as "couldn't load", never as "nothing remembered".
 */
import { freshToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type MemorySurfaceError = 'not_configured' | 'unauthenticated' | 'network' | 'server' | 'invalid';

export type MemorySurfaceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: MemorySurfaceError; status?: number; message?: string };

async function call<T>(method: 'GET' | 'POST', path: string, map: (raw: unknown) => T, body?: object): Promise<MemorySurfaceResult<T>> {
  if (!apiBase()) return { ok: false, error: 'not_configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const message = typeof json?.message === 'string' ? json.message : undefined;
    const error: MemorySurfaceError = res.status === 401 ? 'unauthenticated' : res.status === 400 ? 'invalid' : 'server';
    return { ok: false, error, status: res.status, message };
  }
  if (json === null) return { ok: false, error: 'server', status: res.status, message: 'The server sent an unreadable answer.' };
  return { ok: true, data: map(json) };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

// ── §12 What Portava Remembers ───────────────────────────────────────────────

export type Availability = 'ok' | 'unavailable';

export interface RememberedItem {
  id: string;
  group: string;
  label: string;
  title: string;
  detail: string | null;
  isInferred: boolean;
  inferredNote: string | null;
  visibility: string;
  subjectType: string;
  subjectId: string;
  memoryType: string | null;
  canForget: boolean;
  canCorrect: boolean;
  /** Why Correct is not offered (e.g. "Edit this in your profile settings."). */
  correctNote: string | null;
}

export interface RememberedGroup {
  group: string;
  label: string;
  description: string;
  items: RememberedItem[];
  availability: Availability;
}

export interface RememberedSurface {
  groups: RememberedGroup[];
  notes: string[];
  unavailable: string[];
}

function mapItem(raw: unknown): RememberedItem | null {
  const r = obj(raw);
  const id = str(r.id);
  const title = str(r.title);
  if (!id || !title) return null;
  const controls = obj(r.controls);
  const correct = obj(controls.correct);
  const forget = obj(controls.forget);
  return {
    id,
    group: str(r.group) ?? '',
    label: str(r.label) ?? '',
    title,
    detail: str(r.detail),
    isInferred: r.isInferred === true,
    inferredNote: str(r.inferredNote),
    visibility: str(r.visibility) ?? 'private',
    subjectType: str(r.subjectType) ?? '',
    subjectId: str(r.subjectId) ?? '',
    memoryType: str(r.memoryType),
    canForget: forget.supported === true,
    canCorrect: correct.supported === true,
    correctNote: str(correct.note),
  };
}

export function mapRememberedSurface(raw: unknown): RememberedSurface {
  const o = obj(raw);
  const groups: RememberedGroup[] = arr(o.groups).map((g) => {
    const b = obj(g);
    return {
      group: str(b.group) ?? '',
      label: str(b.label) ?? '',
      description: str(b.description) ?? '',
      items: arr(b.items).map(mapItem).filter((i): i is RememberedItem => i !== null),
      // A server that predates the field reports nothing about read health; its
      // groups are shown as read. The server in this tree always sends it.
      availability: b.availability === 'unavailable' ? 'unavailable' : 'ok',
    };
  });
  return {
    groups,
    notes: arr(o.notes).filter((n): n is string => typeof n === 'string'),
    unavailable: arr(o.unavailable).filter((n): n is string => typeof n === 'string'),
  };
}

export function fetchRemembered(): Promise<MemorySurfaceResult<RememberedSurface>> {
  return call('GET', '/api/compass/me/passport/remembers', mapRememberedSurface);
}

/** Derived items carry their projection id as `id`; source items are addressed by subject. */
function targetOf(item: RememberedItem): Record<string, string> {
  if (item.group === 'derived_memory') return { projectionId: item.id };
  return { subjectType: item.subjectType, subjectId: item.subjectId, ...(item.memoryType ? { memoryType: item.memoryType } : {}) };
}

export interface MemoryActionAck { message: string }

const mapAck = (raw: unknown): MemoryActionAck => ({ message: str(obj(raw).message) ?? 'Done.' });

export function forgetRemembered(item: RememberedItem): Promise<MemorySurfaceResult<MemoryActionAck>> {
  return call('POST', '/api/compass/me/passport/remembers/forget', mapAck, targetOf(item));
}

export function correctRemembered(item: RememberedItem, correctedValue: string): Promise<MemorySurfaceResult<MemoryActionAck>> {
  return call('POST', '/api/compass/me/passport/remembers/correct', mapAck, { ...targetOf(item), correctedValue });
}

// ── §5 Personal Recaps + On This Day ─────────────────────────────────────────

export interface RecapItem {
  id: string;
  label: string;
  title: string;
  detail: string | null;
  occurredAt: string | null;
  isInferred: boolean;
}

export interface RecapView {
  /** False when the server's `memory_recaps` flag is off: the surface is not turned on. */
  enabled: boolean;
  windowLabel: string;
  sections: Array<{ group: string; label: string; items: RecapItem[] }>;
  notes: string[];
  unavailable: string[];
}

export interface OnThisDayView {
  enabled: boolean;
  items: RecapItem[];
  notes: string[];
  unavailable: string[];
}

function mapRecapItem(raw: unknown): RecapItem | null {
  const r = obj(raw);
  const id = str(r.id);
  const title = str(r.title);
  if (!id || !title) return null;
  return { id, label: str(r.label) ?? '', title, detail: str(r.detail), occurredAt: str(r.occurredAt), isInferred: r.isInferred === true };
}

const items = (v: unknown): RecapItem[] => arr(v).map(mapRecapItem).filter((i): i is RecapItem => i !== null);
const strings = (v: unknown): string[] => arr(v).filter((n): n is string => typeof n === 'string');

export function mapRecap(raw: unknown): RecapView {
  const o = obj(raw);
  return {
    enabled: o.enabled === true,
    windowLabel: str(obj(o.window).label) ?? '',
    sections: arr(o.sections).map((sec) => {
      const s = obj(sec);
      return { group: str(s.group) ?? '', label: str(s.label) ?? '', items: items(s.items) };
    }),
    notes: strings(o.notes),
    unavailable: strings(o.unavailable),
  };
}

export function mapOnThisDay(raw: unknown): OnThisDayView {
  const o = obj(raw);
  return { enabled: o.enabled === true, items: items(o.items), notes: strings(o.notes), unavailable: strings(o.unavailable) };
}

export type RecapRequest =
  | { kind: 'year'; year: number }
  | { kind: 'month'; year: number; month: number };

export function fetchRecap(req: RecapRequest): Promise<MemorySurfaceResult<RecapView>> {
  const qs = new URLSearchParams({ kind: req.kind, year: String(req.year) });
  if (req.kind === 'month') qs.set('month', String(req.month));
  return call('GET', `/api/compass/me/recaps?${qs.toString()}`, mapRecap);
}

export function fetchOnThisDay(): Promise<MemorySurfaceResult<OnThisDayView>> {
  return call('GET', '/api/compass/me/on-this-day', mapOnThisDay);
}

/** Owner-facing names for the sources a surface may report unavailable. */
export const SOURCE_LABELS: Record<string, string> = {
  derived_memory: 'What Portava figured out',
  profile: 'About you',
  preferences: 'Your interests',
  saved_content: 'Saved & created',
  saved_compass_memory: 'Saved Compass memories',
  shared_moment: 'Shared Moments',
  availability: 'Availability',
};
