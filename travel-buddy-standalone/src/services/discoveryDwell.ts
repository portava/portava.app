/**
 * discoveryDwell — `04` §7 dwell quality on a Discovery place surface, the
 * client half (census-discovery DV-41, §55).
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/discovery-v1/04_Behavior_Engine.md` §7:
 *
 *   "Distinguish: active dwell, passive foreground dwell, idle dwell.
 *    Do not infer interest from a phone sitting untouched."
 *
 * THE THREE KINDS, FROM REAL SIGNALS ONLY
 * =======================================
 * Time a served place is on screen is split, millisecond by millisecond, by two
 * facts the device actually reports:
 *
 *   foreground  AppState is 'active'. Anything else — 'background', and
 *               iOS's 'inactive' (screen locking, the notification shade, an
 *               incoming call) — is NOT foreground.
 *   touched     the viewer touched or dragged the surface. Opening the surface
 *               is itself a touch (the viewer tapped to open it).
 *
 *   active              foreground, and within DWELL_INTERACTION_WINDOW_MS of
 *                       the last touch.
 *   passive_foreground  foreground, and more than that window since the last
 *                       touch — the screen is on, nobody is touching it.
 *   idle                not foreground: backgrounded or screen off. NEVER
 *                       interest, whatever happened before it.
 *
 * Returning to the foreground is NOT a touch of the surface: unlocking the phone
 * says nothing about the place on screen, so time after it is passive until the
 * viewer touches the sheet again. The bias is stated: every rule here errs
 * toward NOT calling time active.
 *
 * THE WINDOW IS UNRATIFIED
 * ========================
 * No specification states how long after a touch a viewer still counts as
 * active. `DWELL_INTERACTION_WINDOW_MS` is therefore an engineering placeholder,
 * named so it can be found, NOT a ratified product number and NOT tuned. It is
 * the owner's to set (census-discovery §55), together with turning collection on.
 *
 * GATED, SIGNED-IN, AND BOUND
 * ===========================
 * Nothing is measured or sent unless `discovery_dwell_telemetry_enabled` (3395,
 * seeded FALSE) is on, the viewer is signed in (no token ⇒ nothing sent), the
 * surface is 'discovery', and the served item carried a well-formed
 * `recommendationId` — the server binds each emission to the viewer's own
 * exposure by that id and writes nothing it cannot bind.
 *
 * RETRY-SAFE
 * ==========
 * Each emission carries a `client_event_id` minted once; a retry re-sends the
 * same body, and the server's per-(emission, kind) token collides with the
 * first landing, so a retry never double-writes.
 */
import { freshToken } from './apiToken.ts';

// ── Vocabulary ────────────────────────────────────────────────────────────────

/** `04` §7's three kinds, in the specification's order (2890's CHECK vocabulary). */
export const DWELL_KINDS = ['active', 'passive_foreground', 'idle'] as const;
export type DwellKind = (typeof DWELL_KINDS)[number];
export type DwellTotals = Record<DwellKind, number>;

/**
 * UNRATIFIED. How long after the viewer's last touch foreground time still
 * counts as ACTIVE. No spec states this number; it is a named placeholder, not
 * a tuned or approved value. Changing it changes what `active` means.
 */
export const DWELL_INTERACTION_WINDOW_MS = 10_000;

/** The capability flag (migration 3395), seeded FALSE. */
export const DISCOVERY_DWELL_FLAG = 'discovery_dwell_telemetry_enabled';

/** Mirrors the API's RECOMMENDATION_ID_SHAPE (2891's CHECK). */
const RECOMMENDATION_ID_SHAPE = /^[A-Za-z0-9_-]{22}$/;

const zeroTotals = (): DwellTotals => ({ active: 0, passive_foreground: 0, idle: 0 });

// ── The classifier ────────────────────────────────────────────────────────────

/**
 * Split the interval [fromMs, toMs) into the three kinds. Pure.
 *
 * Boundary: a millisecond `t` is active iff foreground and
 * `t < lastInteractionMs + windowMs`. So exactly `windowMs` after a touch the
 * viewer stops being active.
 */
export function classifyInterval(
  fromMs: number,
  toMs: number,
  s: { foreground: boolean; lastInteractionMs: number; windowMs: number },
): DwellTotals {
  const out = zeroTotals();
  if (!(toMs > fromMs)) return out;          // an empty or backwards interval is nothing
  const span = toMs - fromMs;
  if (!s.foreground) { out.idle = span; return out; }
  const activeEnd = Math.min(toMs, Math.max(fromMs, s.lastInteractionMs + s.windowMs));
  out.active = activeEnd - fromMs;
  out.passive_foreground = toMs - activeEnd;
  return out;
}

export interface DwellTracker {
  /** The viewer touched the surface at `atMs`. Ignored while not foreground. */
  noteInteraction(atMs: number): void;
  /** AppState became 'active'. Not a touch. */
  noteForeground(atMs: number): void;
  /** AppState left 'active' (background, screen off, iOS 'inactive'). */
  noteBackground(atMs: number): void;
  /** Close the open interval at `atMs` and hand back (and reset) what accumulated. */
  drain(atMs: number): DwellTotals;
  readonly foreground: boolean;
}

/**
 * One surface view. `startMs` is when the surface became visible — a touch
 * (the viewer opened it). `foreground` is AppState at that moment.
 *
 * Clock steps backwards are absorbed (no negative time); the tracker never
 * invents time it did not observe.
 */
export function createDwellTracker(
  startMs: number,
  opts: { windowMs?: number; foreground?: boolean } = {},
): DwellTracker {
  const windowMs = opts.windowMs ?? DWELL_INTERACTION_WINDOW_MS;
  let foreground = opts.foreground ?? true;
  let lastInteractionMs = startMs;
  let cursor = startMs;
  let totals = zeroTotals();

  const advance = (toMs: number) => {
    if (!(toMs > cursor)) return;             // backwards or equal: nothing elapsed
    const part = classifyInterval(cursor, toMs, { foreground, lastInteractionMs, windowMs });
    totals.active += part.active;
    totals.passive_foreground += part.passive_foreground;
    totals.idle += part.idle;
    cursor = toMs;
  };

  return {
    noteInteraction(atMs) {
      advance(atMs);
      if (foreground) lastInteractionMs = Math.max(lastInteractionMs, atMs);
    },
    noteForeground(atMs) { advance(atMs); foreground = true; },
    // Leaving the foreground ends the touch's reach: after a trip away, time is
    // passive until the viewer touches the surface again, however short the trip.
    noteBackground(atMs) { advance(atMs); foreground = false; lastInteractionMs = Number.NEGATIVE_INFINITY; },
    drain(atMs) {
      advance(atMs);
      const out = totals;
      totals = zeroTotals();
      return out;
    },
    get foreground() { return foreground; },
  };
}

// ── The emission ──────────────────────────────────────────────────────────────

export interface DwellEmission {
  item_id: string;
  surface: 'discovery';
  recommendation_id: string;
  client_event_id: string;
  dwell: Array<{ kind: DwellKind; ms: number }>;
}

/** A served item's own exposure id, or null when it carried none or a malformed one. */
export function servedExposureId(v: unknown): string | null {
  return typeof v === 'string' && RECOMMENDATION_ID_SHAPE.test(v) ? v : null;
}

/** A v4-shaped id: `crypto.randomUUID` where the runtime has it, else composed. */
export function newClientEventId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}

/**
 * The body for one drain, or null when there is nothing to say: no bound id, or
 * no kind reached a whole millisecond. Kinds are listed in `04` §7's order and
 * only when non-zero — a zero is not an episode.
 */
export function dwellEmissionFor(
  itemId: string | null | undefined,
  recommendationId: unknown,
  totals: DwellTotals,
  clientEventId: string,
): DwellEmission | null {
  const rid = servedExposureId(recommendationId);
  if (!itemId || !rid) return null;
  const dwell = DWELL_KINDS
    .map((kind) => ({ kind, ms: Math.round(totals[kind]) }))
    .filter((d) => Number.isFinite(d.ms) && d.ms >= 1);
  if (dwell.length === 0) return null;
  return { item_id: itemId, surface: 'discovery', recommendation_id: rid, client_event_id: clientEventId, dwell };
}

export type DwellSendResult =
  | 'sent'
  | 'skipped_disabled'
  | 'skipped_no_api'
  | 'skipped_signed_out'
  | 'refused'
  | 'failed';

const API_BASE = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

/**
 * POST one emission to /api/rank-events/dwell. Never throws.
 *
 * Flag off ⇒ nothing, not even a token read. Signed out ⇒ nothing sent. A
 * network failure or a 5xx is retried ONCE with the SAME body (same
 * client_event_id), which the server settles as a duplicate if the first
 * attempt had landed. A 4xx is the server refusing the emission (flag off
 * there, an exposure it cannot bind) and is not retried.
 */
export async function sendDwellEmission(
  emission: DwellEmission,
  opts: { enabled: boolean },
): Promise<DwellSendResult> {
  if (!opts.enabled) return 'skipped_disabled';
  const base = API_BASE();
  if (!base) return 'skipped_no_api';
  let token: string | null = null;
  try { token = await freshToken(); } catch { token = null; }
  if (!token) return 'skipped_signed_out';

  const body = JSON.stringify(emission);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${base}/api/rank-events/dwell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body,
      });
      if (res.ok) return 'sent';
      if (res.status < 500) return 'refused';
    } catch {
      // network failure: fall through to the one retry
    }
  }
  return 'failed';
}
