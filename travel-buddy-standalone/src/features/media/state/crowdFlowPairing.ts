/**
 * features/media — "WHERE THE NIGHT IS MOVING" (spec §22 Crowd Flow
 * Integration; census-media MD162 §51; lead ruling D-26d).
 *
 *   WHERE THE NIGHT IS MOVING
 *   Beachfront   [recent perspectives]
 *        ↓
 *   An Thuong    [recent perspectives]
 *   Activity appears to be moving toward An Thuong
 *   — "Never expose individual routes."
 *
 * THE PAIRING IS A JOIN OF TWO ANSWERS THIS CLIENT ALREADY RECEIVES. It derives
 * nothing about people and owns no zone model:
 *
 *   • the canonical Map gateway's `crowd_flow` objects (`GET /map/projection`).
 *     Every flow there has already cleared the k floor, MIN_SIGNAL_FAMILIES,
 *     freshness, cohort density and the §24 protected-zone withholding, and
 *     the gateway (api-server lib/mapProjection.attachFlowEndpoints) has named
 *     each end: `payload.endpoints.{from,to}` = the curated zone name plus the
 *     ids of the zone's disclosable public places;
 *   • Media's perspective counts per canonical place (`GET /media/map`), which
 *     the server already gated for this viewer.
 *
 * A perspective belongs to an end when its canonical place id is IN that end's
 * `placeIds`. Never by name: a place called "An Thuong" outside the zone's list
 * is not the zone. Media does not decide which places a zone holds — the
 * gateway does (`gatewayBypassGuard` forbids a second zone model server-side,
 * and this module does not build one client-side either).
 *
 * WHAT IS NEVER RENDERED FROM A FLOW: its geometry, its cohort size, its zone
 * ids, its signal families, or any line between the two ends. The card carries
 * two zone NAMES, a direction word, and per-end perspective counts. The spec's
 * "↓" is a glyph between two names, not a path.
 *
 * FAIL CLOSED, NEVER "NOTHING IS MOVING". Every refusal below yields NO card,
 * and the card has no empty state: a failed read, a disabled gateway, an
 * unread or partial end, or a stale flow must never be told to the viewer as
 * "the night is quiet". The client re-applies the Map renderer's own aggregate
 * gates (CrowdFlowLine: the cohort floor and the `aggregate_only` rung) and the
 * gateway's endpoint floor, so a projection bug, a hand-built fixture or a
 * stale object cannot name the place a small cohort stood at.
 *
 * Pure, framework-free (no network, no React state) — safe for node:test.
 */
import type { MapObject } from '../../../types/mapObjects.ts';
import { FRESHNESS_THRESHOLDS_MS, isRenderable, mayRenderAsLive } from '../../../types/mapObjects.ts';
import { isAggregateGeometry, meetsCohortFloor } from '../../../components/map/CrowdFlowLine.tsx';
import type { FreshnessClass } from '../types/media.ts';
import type { MediaMapCluster } from './mediaMapStore.ts';

/**
 * Fewer listed places than this and an end pairs with nothing. It MIRRORS the
 * gateway's own floor (api-server `lib/mapProjection.ts`
 * `MIN_FLOW_ENDPOINT_PLACES`), which exists so a list can never single out the
 * place a cohort stood at; `__tests__/crowdFlowPairing.test.ts` pins the two
 * equal. The gateway already refuses to list fewer; this is the client's copy
 * of the same refusal, for an object that did not come from that gateway path.
 */
export const MIN_FLOW_ENDPOINT_PLACES = 3;

/** At most this many flows are shown — the gateway's ranked order, first ones. */
export const MAX_NIGHT_FLOWS = 3;

/** One end of a served flow, as far as Media may use it. */
export interface ServedFlowEnd {
  /** The curated zone name the gateway published. Always non-empty here. */
  name: string;
  /** The zone's disclosable public place ids, or EMPTY when the end may not be paired. */
  placeIds: readonly string[];
}

/** A `crowd_flow` object the gateway served that Media may render. */
export interface ServedNightFlow {
  /** The gateway's object id — a React key only, never rendered. */
  key: string;
  from: ServedFlowEnd;
  to: ServedFlowEnd;
  /** When the flow stops being presentable as current (epoch ms). */
  liveUntilMs: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function epochMs(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The end as the gateway published it, or null when the flow must not be
 * rendered at all:
 *   - the end is missing, or names a different zone than `payload.observed`;
 *   - the zone has no curated name;
 *   - `placesStatus` is `unread` (the gateway could not read the places, the
 *     protected zones or the gems — an unread constraint is never an absent
 *     one), or anything it does not define;
 *   - `placesPartial` is anything but `false` — the list is then a SAMPLE of
 *     the zone, and counting a sample as "the zone's perspectives" would be a
 *     claim the client cannot back.
 * A `too_few` end is a complete answer ("this zone lists none") and is kept,
 * with no places: it is named, and paired with nothing.
 */
function readEnd(raw: unknown, observedZoneId: string): ServedFlowEnd | null {
  if (!isObj(raw)) return null;
  if (raw.zoneId !== observedZoneId) return null;
  const name = nonEmpty(raw.name);
  if (!name) return null;
  if (raw.placesPartial !== false) return null;
  if (raw.placesStatus === 'too_few') return { name: name.trim(), placeIds: [] };
  if (raw.placesStatus !== 'listed') return null;
  if (!Array.isArray(raw.placeIds)) return null;
  const ids = new Set<string>();
  for (const id of raw.placeIds) {
    const s = nonEmpty(id);
    if (s) ids.add(s);
  }
  return { name: name.trim(), placeIds: ids.size >= MIN_FLOW_ENDPOINT_PLACES ? [...ids] : [] };
}

/** One served `crowd_flow` object → a flow Media may render, or null. */
export function readServedNightFlow(obj: MapObject, nowMs: number): ServedNightFlow | null {
  if (!obj || obj.kind !== 'crowd_flow') return null;
  // The Map renderer's own gates, applied to the same object.
  if (!isRenderable(obj)) return null;
  if (!isAggregateGeometry(obj)) return null;
  if (!meetsCohortFloor(obj)) return null;
  if (!mayRenderAsLive(obj.freshness)) return null;

  // §37 "Do not let stale claims remain visually live": no observation time,
  // no card; an expiry that cannot be read is not "no expiry".
  const observedMs = epochMs(obj.observedAt);
  if (observedMs === null) return null;
  let liveUntilMs = observedMs + FRESHNESS_THRESHOLDS_MS.recent;
  if (obj.expiresAt !== undefined) {
    const expiresMs = epochMs(obj.expiresAt);
    if (expiresMs === null) return null;
    liveUntilMs = Math.min(liveUntilMs, expiresMs);
  }
  if (!(liveUntilMs > nowMs)) return null;

  const payload = isObj(obj.payload) ? obj.payload : null;
  const observed = payload && isObj(payload.observed) ? payload.observed : null;
  const endpoints = payload && isObj(payload.endpoints) ? payload.endpoints : null;
  const fromZoneId = nonEmpty(observed?.fromZoneId);
  const toZoneId = nonEmpty(observed?.toZoneId);
  if (!endpoints || !fromZoneId || !toZoneId || fromZoneId === toZoneId) return null;

  const from = readEnd(endpoints.from, fromZoneId);
  const to = readEnd(endpoints.to, toZoneId);
  if (!from || !to) return null;
  // Zones are disjoint. A place listed at BOTH ends is a malformed object, and
  // pairing it would count one perspective as two places' activity.
  const fromIds = new Set(from.placeIds);
  if (to.placeIds.some((id) => fromIds.has(id))) return null;

  return { key: obj.id, from, to, liveUntilMs };
}

/** Every renderable flow in a gateway answer, deduplicated, in the gateway's order. */
export function readServedNightFlows(objects: readonly MapObject[], nowMs: number): ServedNightFlow[] {
  const out: ServedNightFlow[] = [];
  const seen = new Set<string>();
  for (const o of objects) {
    const f = readServedNightFlow(o, nowMs);
    if (!f || seen.has(f.key)) continue;
    seen.add(f.key);
    out.push(f);
  }
  return out;
}

/** True when at least one end could be paired at all — the only case worth reading counts for. */
export function anyEndListsPlaces(flows: readonly ServedNightFlow[]): boolean {
  return flows.some((f) => f.from.placeIds.length > 0 || f.to.placeIds.length > 0);
}

// ── Pairing ───────────────────────────────────────────────────────────────────

/** One end of a rendered card. */
export interface NightFlowEndView {
  name: string;
  /** Perspectives at this end's recent places. 0 ⇒ the end shows its name only — never "none here". */
  perspectiveCount: number;
  /** The freshest class among those places, or null when unpaired. */
  freshness: FreshnessClass | null;
  /** The place with the most recent perspectives — what a tap opens. Null when unpaired. */
  top: MediaMapCluster | null;
}

export interface NightFlowCardModel {
  key: string;
  from: NightFlowEndView;
  to: NightFlowEndView;
  /** The spec's sentence, about the destination ZONE only. */
  sentence: string;
  liveUntilMs: number;
}

/**
 * "Recent" is Media's own vocabulary: a place whose newest perspective is
 * fresh (< 1 h) or recent (< 24 h) — `aggregateFreshness` server-side. A
 * place whose newest perspective is historical is not where the night is.
 */
function isRecent(f: FreshnessClass | null): boolean {
  return f === 'live' || f === 'fresh' || f === 'recent';
}

const FRESHNESS_ORDER: readonly FreshnessClass[] = ['live', 'fresh', 'recent', 'historical'];

function fresher(a: FreshnessClass | null, b: FreshnessClass | null): FreshnessClass | null {
  if (a === null) return b;
  if (b === null) return a;
  return FRESHNESS_ORDER.indexOf(a) <= FRESHNESS_ORDER.indexOf(b) ? a : b;
}

function pairEnd(end: ServedFlowEnd, recentByPlace: ReadonlyMap<string, MediaMapCluster>): NightFlowEndView {
  let perspectiveCount = 0;
  let freshness: FreshnessClass | null = null;
  let top: MediaMapCluster | null = null;
  for (const placeId of end.placeIds) {
    const c = recentByPlace.get(placeId);
    if (!c) continue;
    perspectiveCount += c.perspectiveCount;
    freshness = fresher(freshness, c.freshness);
    if (!top || c.perspectiveCount > top.perspectiveCount) top = c;
  }
  return { name: end.name, perspectiveCount, freshness, top };
}

/** The spec's own sentence (§22). "Appears": an aggregate of signals, never a certainty. */
export function movementSentence(toZoneName: string): string {
  return `Activity appears to be moving toward ${toZoneName}`;
}

/**
 * Pair each served flow with the recent perspectives at its ends' places. A
 * flow neither of whose ends has a recent perspective is not shown: §22 is
 * "where the night is moving" FROM PERSPECTIVES, not a second Map flow layer.
 */
export function pairNightFlows(
  flows: readonly ServedNightFlow[],
  clusters: readonly MediaMapCluster[],
): NightFlowCardModel[] {
  const recentByPlace = new Map<string, MediaMapCluster>();
  for (const c of clusters) {
    if (!c || typeof c.placeId !== 'string' || c.placeId === '') continue;
    if (!(c.perspectiveCount > 0) || !isRecent(c.freshness)) continue;
    if (!recentByPlace.has(c.placeId)) recentByPlace.set(c.placeId, c);
  }
  const cards: NightFlowCardModel[] = [];
  for (const f of flows) {
    const from = pairEnd(f.from, recentByPlace);
    const to = pairEnd(f.to, recentByPlace);
    if (from.perspectiveCount === 0 && to.perspectiveCount === 0) continue;
    cards.push({ key: f.key, from, to, sentence: movementSentence(f.to.name), liveUntilMs: f.liveUntilMs });
    if (cards.length >= MAX_NIGHT_FLOWS) break;
  }
  return cards;
}

/** The cards still presentable as current at `nowMs`. */
export function liveNightFlowCards(cards: readonly NightFlowCardModel[], nowMs: number): NightFlowCardModel[] {
  return cards.filter((c) => c.liveUntilMs > nowMs);
}
