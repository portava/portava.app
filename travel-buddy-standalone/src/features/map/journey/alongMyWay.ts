/**
 * alongMyWay — the client half of §36 Phase 6 "Along My Way".
 *
 * WHAT IT DOES, AND WHERE THE INTELLIGENCE ACTUALLY LIVES
 * ======================================================
 * The corridor is decided on the SERVER (lib/mapCorridor, reached through
 * `corridor=` on GET /api/map/projection). §19 forbids the client from
 * reconstructing Portava's rules, so this module does exactly two things and
 * neither is a rule:
 *
 *   1. Turns the viewer's own route plan into the polyline to ASK with — the
 *      same stop list, in the same order, that `composeRoutes` draws as the
 *      route line. Asking about a different line than the one on screen is the
 *      one bug this module exists to make impossible.
 *   2. Joins the objects the gateway returned with the detour estimates it
 *      returned, preserving the gateway's §31 order.
 *
 * It computes NO distance, NO detour and NO ranking. Every number it displays
 * came off the wire.
 *
 * §37. `MapCorridorMatch.line` already reads "Est. +6 min detour · …". This
 * module passes it through verbatim and never reformats it into something that
 * could read as a measured travel time.
 *
 * Pure: no React, no network, no storage.
 */
import type { MapObject } from '../../../types/mapObjects.ts';
import type {
  MapCorridorMatch,
  MapCorridorReport,
} from '../../../services/mapProjection.ts';
import type { FullRoutePlan } from '../../../services/routePlan.ts';

/** A polyline vertex. Deliberately the same shape the service parameter takes. */
export interface CorridorPoint {
  lat: number;
  lng: number;
}

/**
 * Corridor half-widths a user can choose between, in metres.
 *
 * They exist as a named list so the UI cannot invent a fourth: the server
 * clamps to [50, 5000] and a slider would let a caller ask for 4 999 m, which
 * is not "along my way", it is "in this city".
 */
export const CORRIDOR_PRESETS = [
  { key: 'tight', meters: 200, label: 'Right on my route' },
  { key: 'normal', meters: 400, label: 'A short walk off' },
  { key: 'wide', meters: 1000, label: 'A detour worth making' },
] as const;

export type CorridorPresetKey = (typeof CORRIDOR_PRESETS)[number]['key'];

export const DEFAULT_CORRIDOR_PRESET: CorridorPresetKey = 'normal';

export function corridorMetersFor(key: CorridorPresetKey): number {
  return CORRIDOR_PRESETS.find((p) => p.key === key)?.meters ?? 400;
}

/**
 * The polyline to ask the gateway with: the route plan's stops, in
 * `orderIndex` order, dropping any stop with no usable coordinate.
 *
 * This is deliberately the SAME filter, sort and tie-break
 * `features/map/trip/tripMapSources.composeRoutes` uses to draw the line, so
 * the corridor is measured against the route the user is looking at. Returns
 * null below two DISTINCT points — a single position is a location, and the
 * server would (correctly) refuse it as `invalid_corridor` rather than quietly
 * doing a radius search around it.
 */
export function corridorPathFromRoutePlan(
  plan: FullRoutePlan | null | undefined,
): CorridorPoint[] | null {
  if (!plan || !plan.plan) return null;
  const ordered = [...(plan.stops ?? [])]
    .filter(
      (s) =>
        s.structuredLocation &&
        Number.isFinite(s.structuredLocation.lat) &&
        Number.isFinite(s.structuredLocation.lng),
    )
    .sort((a, b) => a.orderIndex - b.orderIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const path = ordered.map((s) => ({
    lat: s.structuredLocation.lat,
    lng: s.structuredLocation.lng,
  }));
  return distinctEnough(path) ? path : null;
}

/**
 * The polyline from HERE to the next stop, for a viewer with a position but no
 * route plan: the smallest honest corridor there is.
 *
 * Null when either end is missing or they are the same point — walking from a
 * place to itself is not a journey, and inflating it into one would make the
 * corridor a circle around the user without saying so.
 */
export function corridorPathFromNextStop(
  from: CorridorPoint | null | undefined,
  to: CorridorPoint | null | undefined,
): CorridorPoint[] | null {
  if (!from || !to) return null;
  const path = [from, to].filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
  );
  return distinctEnough(path) ? path : null;
}

function distinctEnough(path: CorridorPoint[]): boolean {
  if (path.length < 2) return false;
  return path.some((p) => p.lat !== path[0]!.lat || p.lng !== path[0]!.lng);
}

// ── Joining the answer ────────────────────────────────────────────────────────

export interface AlongMyWayItem {
  object: MapObject;
  /**
   * The server's detour estimate, or null when the object has none (an
   * aggregated cell). Never computed here.
   */
  detour: MapCorridorMatch['detour'] | null;
  /** The server's rendered line, verbatim. Null when there is no estimate. */
  detourLine: string | null;
}

export type AlongMyWayState =
  | { status: 'off'; reason: 'flag_off'; items: [] }
  | { status: 'invalid'; reason: 'invalid_corridor'; items: [] }
  | { status: 'no_route'; reason: 'no_corridor_requested'; items: [] }
  | { status: 'ready'; items: AlongMyWayItem[]; kept: number; droppedOffRoute: number };

/**
 * Fold a gateway answer into the Along My Way list.
 *
 * A REFUSAL IS NOT AN EMPTY CORRIDOR. When the flag is off the server ignores
 * the corridor and returns the WHOLE bbox — presenting that as "here is what is
 * along your way" would be a straightforward lie, so this returns `off` with no
 * items rather than the unfiltered list. The same applies to a corridor the
 * server could not parse.
 */
export function foldAlongMyWay(
  objects: readonly MapObject[],
  report: MapCorridorReport | null,
  matches: readonly MapCorridorMatch[] | null,
): AlongMyWayState {
  if (!report) return { status: 'no_route', reason: 'no_corridor_requested', items: [] };
  if (report.refusal === 'flag_off') return { status: 'off', reason: 'flag_off', items: [] };
  if (report.refusal === 'invalid_corridor') {
    return { status: 'invalid', reason: 'invalid_corridor', items: [] };
  }

  const byId = new Map<string, MapCorridorMatch>();
  for (const m of matches ?? []) byId.set(m.objectId, m);

  // Input order is the gateway's §31 rank order. Preserved, never re-sorted by
  // detour: a nearer café must not outrank a safety notice because it is closer
  // to the line.
  const items: AlongMyWayItem[] = objects.map((object) => {
    const m = byId.get(object.id) ?? null;
    return { object, detour: m?.detour ?? null, detourLine: m?.line ?? null };
  });

  return {
    status: 'ready',
    items,
    kept: report.kept,
    droppedOffRoute: report.droppedOffRoute,
  };
}

/**
 * The one-line summary of what the corridor did, for the list header.
 *
 * It names the counts the server reported and nothing else — "3 off your route"
 * is the honest version of silently showing fewer pins than the map has.
 */
export function corridorSummaryLine(state: AlongMyWayState): string {
  switch (state.status) {
    case 'off':
      return 'Along My Way is off';
    case 'invalid':
      return 'No usable route to follow';
    case 'no_route':
      return 'Start a route to see what is on your way';
    case 'ready':
      return state.droppedOffRoute > 0
        ? `${state.kept} on your way · ${state.droppedOffRoute} off it`
        : `${state.kept} on your way`;
  }
}
