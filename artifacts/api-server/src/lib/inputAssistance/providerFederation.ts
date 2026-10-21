/**
 * Provider federation, on the server — census G222 (§34 "Prefer server:
 * provider federation"), G237 (§36 provider neutrality), G153 (§23 provider
 * disagreement) and G192 (§30 the precedence chain). Wave 4, 2026-10-17.
 *
 * WHICH PROVIDER, AND WHY THIS ONE. OD-INPUT-6 rules out a PAID typeahead
 * provider for the initial release. The tree already holds one free provider
 * dataset: FSQ OS Places, an open dataset ingested per city into `fsq_places`
 * by scripts/load-fsq-city.mjs (migration 0184), behind that dataset's own
 * flag `fsq_places_enabled` (seeded FALSE) and with a required attribution. It
 * is a local table — reading it costs no per-call fee and calls no third party.
 * It is the one entry in {@link APPROVED_PROVIDER_ADAPTERS}; "approved" means
 * listed here AND its flag on. Nothing else is federated.
 *
 * WHERE IT RUNS. Inside the gateway, for the venue pickers only
 * ({@link PROVIDER_LANE_CONTEXTS}) — fields whose value is ONE place and whose
 * selection the picker resolves canonically (`/locations/resolve`, which knows
 * the `foursquare-<id>` namespace). Never on global search (a provider record
 * has no Portava page to open), never on the paste path (`catalogOnly`), never
 * for a Gem's location.
 *
 * BOUNDED READS. A provider table is never scanned by name alone: a read is
 * issued only inside a box around the request's position, or within the active
 * task's city. With neither, the lane reads nothing.
 *
 * WHAT A PROVIDER ROW IS. §9 step 9: `source: 'provider'`, ranked below every
 * canonical row by `projection.trustPosition`, at most {@link PROVIDER_ROW_MAX}
 * per answer, confidence capped below the canonical prefix band. It carries no
 * `entityId` — a provider record is not a Portava entity — and is bound as a
 * Place the picker can resolve, with the dataset's attribution.
 *
 * NEUTRALITY (G237). {@link neutralProviderOrder} orders by how well the NAME
 * matches the typed text, then distance, then the name, then the record's own
 * id — never by which adapter produced it or the order adapters were
 * registered in. The same venue from two sources is offered once; which
 * record survives is decided by its completeness, not its source.
 *
 * PRECEDENCE AND DISAGREEMENT (G192, G153). {@link PRECEDENCE_LADDER} is §30's
 * chain. {@link resolveByPrecedence} consults it whenever two rows assert the
 * SAME entity: the lower rung loses, in either arrival order; rows whose
 * identity is UNCERTAIN are all kept, as choices — §30: "If uncertainty
 * remains, show disambiguation rather than inventing resolution."
 * {@link resolveProviderConflicts} applies it between provider records and the
 * canonical places of the same answer: a provider record of a venue Portava
 * already has is dropped and the canonical row is left exactly as it was —
 * nothing from the provider is merged into it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFlagEnabled } from '../featureFlags';
import { logger } from '../logger';
import { normalizeLocationName } from '../canonicalLocations';
import { matchTier, haversineKm } from './searchQueryHelpers';
import { timezoneForCoords } from './geoResolver';
import type { InputContext, InputFieldPolicy, InputSuggestion } from './types';

// ── The lane's bounds ──────────────────────────────────────────────────────────

/** The fields that take ONE venue and resolve it canonically on selection. */
export const PROVIDER_LANE_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'place_picker',
  'trip_stop_place',
  'event_location',
]);

/** At most this many provider rows in one answer. */
export const PROVIDER_ROW_MAX = 3;
/** Rows read per adapter per serve (before the neutral merge and the cap). */
export const PROVIDER_READ_LIMIT = 12;
/** Half-width of the read box around the request's position. */
export const PROVIDER_SCOPE_RADIUS_KM = 25;
/** Two same-named records this close are the SAME venue. */
export const SAME_ENTITY_KM = 0.15;
/** Same-named records farther apart than SAME_ENTITY_KM but within this are UNCERTAIN. */
export const UNCERTAIN_ENTITY_KM = 1.5;

/** A provider row's confidence by name-match tier — every value under the canonical prefix band (0.85). */
const PROVIDER_TIER_CONFIDENCE: Record<number, number> = { 3: 0.8, 2: 0.7, 1: 0.5, 0: 0.3 };

// ── Adapters ───────────────────────────────────────────────────────────────────

/** One record from a provider, in the lane's own shape. */
export interface ProviderCandidate {
  /** The adapter key that produced it (a `sources.key`). Never read by the ordering. */
  provider: string;
  providerPlaceId: string;
  name: string;
  lat: number | null;
  lng: number | null;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  address: string | null;
  category: string | null;
}

/** Where a provider read may look. */
export type ProviderScope =
  | { kind: 'near'; lat: number; lng: number }
  | { kind: 'city'; city: string };

export interface ProviderAdapter {
  /** The `sources.key` (lib/sourceRegistry.ts). */
  key: string;
  /** The flag that approves this source; off ⇒ never read. */
  flag: string;
  /** Reads {@link flag} — by its literal name, so the flag-polarity check can see which flag it is. */
  isApproved(sc: SupabaseClient | any): Promise<boolean>;
  /** Shown wherever this source's records are shown. */
  attribution: string;
  /** The Place-id namespace `/locations/resolve` knows (canonicalLocations.providerKeyOf). */
  placeIdPrefix: string;
  /** Bounded read; THROWS on a failed read so the lane can report it. */
  search(sc: SupabaseClient | any, q: string, scope: ProviderScope, limit: number): Promise<ProviderCandidate[]>;
}

export class ProviderReadError extends Error {
  constructor(readonly provider: string, readonly cause: unknown) {
    super(`provider ${provider} unreadable`);
  }
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** FSQ OS Places — the open dataset in `fsq_places` (migration 0184's columns only). */
export const FSQ_OS_PLACES_ADAPTER: ProviderAdapter = {
  key: 'fsq_os_places',
  flag: 'fsq_places_enabled',
  isApproved: (sc) => isFlagEnabled(sc, 'fsq_places_enabled'),
  attribution: 'Powered by Foursquare',
  placeIdPrefix: 'foursquare',
  async search(sc, q, scope, limit) {
    let query = sc
      .from('fsq_places')
      .select('fsq_id, name, latitude, longitude, category, address, locality, region, country')
      .ilike('name', `%${likeEscape(q)}%`);
    if (scope.kind === 'near') {
      const dLat = PROVIDER_SCOPE_RADIUS_KM / 111.32;
      const dLng = PROVIDER_SCOPE_RADIUS_KM / (111.32 * Math.max(0.01, Math.cos((scope.lat * Math.PI) / 180)));
      query = query
        .gte('latitude', scope.lat - dLat).lte('latitude', scope.lat + dLat)
        .gte('longitude', scope.lng - dLng).lte('longitude', scope.lng + dLng);
    } else {
      query = query.ilike('locality', likeEscape(scope.city));
    }
    const { data, error } = await query.limit(limit);
    if (error) throw new ProviderReadError('fsq_os_places', error);
    if (!Array.isArray(data)) return [];
    return (data as Array<Record<string, unknown>>)
      .filter((r) => str(r.fsq_id) && str(r.name))
      .map((r) => ({
        provider: 'fsq_os_places',
        providerPlaceId: str(r.fsq_id)!,
        name: str(r.name)!,
        lat: num(r.latitude),
        lng: num(r.longitude),
        locality: str(r.locality),
        region: str(r.region),
        countryCode: str(r.country)?.toUpperCase() ?? null,
        address: str(r.address),
        category: str(r.category),
      }));
  },
};

/** The approved candidate sources. One, deliberately (OD-INPUT-6: no paid provider). */
export const APPROVED_PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [FSQ_OS_PLACES_ADAPTER];

// ── Neutral federation (G237) ─────────────────────────────────────────────────

function fold(s: string | null | undefined): string {
  return normalizeLocationName(s ?? '');
}

function distanceKm(a: { lat: number | null; lng: number | null }, b: { lat: number | null; lng: number | null }): number | null {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  return haversineKm(a.lat, a.lng, b.lat, b.lng);
}

/** How many facts a record carries — the only thing that decides which duplicate survives. */
function completeness(c: ProviderCandidate): number {
  return [c.lat, c.lng, c.locality, c.region, c.countryCode, c.address, c.category].filter((v) => v != null).length;
}

/**
 * Order provider records by what they ARE, never by where they came from:
 * name-match tier, then distance from the origin, then the folded name, then the
 * record's own id. The same venue reported by two sources (same name, within
 * SAME_ENTITY_KM) is kept once — the more complete record, then the smaller id.
 * Neither step reads `provider` or any adapter's position in a list.
 */
export function neutralProviderOrder(
  candidates: readonly ProviderCandidate[],
  q: string,
  origin: { lat: number; lng: number } | null,
): ProviderCandidate[] {
  const byQuality = [...candidates].sort((a, b) => completeness(b) - completeness(a) || (a.providerPlaceId < b.providerPlaceId ? -1 : a.providerPlaceId > b.providerPlaceId ? 1 : 0));
  const kept: ProviderCandidate[] = [];
  for (const c of byQuality) {
    const dup = kept.some((k) => {
      if (fold(k.name) !== fold(c.name)) return false;
      const d = distanceKm(k, c);
      return d !== null ? d <= SAME_ENTITY_KM : fold(k.locality) !== '' && fold(k.locality) === fold(c.locality);
    });
    if (!dup) kept.push(c);
  }
  const dist = (c: ProviderCandidate) => (origin ? distanceKm(c, origin) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY);
  return kept.sort((a, b) => {
    const ta = matchTier(a.name, q), tb = matchTier(b.name, q);
    if (ta !== tb) return tb - ta;
    const da = dist(a), db = dist(b);
    if (da !== db) return da - db;
    const na = fold(a.name), nb = fold(b.name);
    if (na !== nb) return na < nb ? -1 : 1;
    return a.providerPlaceId < b.providerPlaceId ? -1 : a.providerPlaceId > b.providerPlaceId ? 1 : 0;
  });
}

/**
 * Read every APPROVED adapter (listed, and its flag on) inside the scope, in
 * parallel, and merge neutrally. A failed adapter is reported through
 * `onUnreadable` and contributes nothing; it never fails the others.
 */
export async function federateProviderCandidates(
  sc: SupabaseClient | any,
  opts: {
    q: string;
    scope: ProviderScope;
    origin: { lat: number; lng: number } | null;
    adapters?: readonly ProviderAdapter[];
    limit: number;
    onUnreadable?: (providerKey: string) => void;
  },
): Promise<ProviderCandidate[]> {
  const adapters = opts.adapters ?? APPROVED_PROVIDER_ADAPTERS;
  const approved = (await Promise.all(adapters.map(async (a) => ((await a.isApproved(sc)) ? a : null))))
    .filter((a): a is ProviderAdapter => a !== null);
  if (approved.length === 0) return [];
  const lists = await Promise.all(
    approved.map((a) =>
      a.search(sc, opts.q, opts.scope, PROVIDER_READ_LIMIT).catch((err) => {
        opts.onUnreadable?.(a.key);
        logger.warn({ err, provider: a.key }, 'input provider lane: provider read failed — canonical rows unaffected');
        return [] as ProviderCandidate[];
      }),
    ),
  );
  return neutralProviderOrder(lists.flat(), opts.q, opts.origin).slice(0, Math.max(0, opts.limit));
}

// ── §30 the precedence chain (G192) ───────────────────────────────────────────

/** §30, in order: "Canonical identity > verified/current authoritative state > current eligible Portava community state > approved provider state > cached historical state > user raw input > AI guess". */
export const PRECEDENCE_LADDER = [
  'canonical_identity',
  'authoritative_state',
  'community_state',
  'approved_provider_state',
  'cached_historical_state',
  'user_raw_input',
  'ai_guess',
] as const;
export type PrecedenceRungName = (typeof PRECEDENCE_LADDER)[number];

const RUNG = (name: PrecedenceRungName): number => PRECEDENCE_LADDER.indexOf(name);

/**
 * The rung a row's claim sits on (lower wins). `authoritative_state` has no
 * row source: verified/official status is projected ON canonical rows, never
 * served as a row of its own.
 */
export function precedenceRung(s: Pick<InputSuggestion, 'source' | 'type'>): number {
  if (s.type === 'ai_suggestion' || s.source === 'ai') return RUNG('ai_guess');
  if (s.type === 'completion') return RUNG('user_raw_input');
  switch (s.source) {
    case 'canonical': return RUNG('canonical_identity');
    case 'live_intelligence': return RUNG('community_state');
    case 'provider': return RUNG('approved_provider_state');
    case 'recent':
    case 'memory':
    case 'local': return RUNG('cached_historical_state');
    default: return RUNG('user_raw_input');
  }
}

export type EntityRelation = 'same' | 'uncertain' | 'distinct';

/**
 * §30 as a conflict rule: among rows that assert the SAME entity, keep the one
 * on the highest rung (the earliest of equals); rows that are distinct or whose
 * identity is uncertain are all kept, so uncertainty reaches the user as a
 * choice. The result keeps input order and does not depend on it.
 */
export function resolveByPrecedence<T extends Pick<InputSuggestion, 'source' | 'type'>>(
  rows: readonly T[],
  relate: (a: T, b: T) => EntityRelation,
): T[] {
  const rung = rows.map((r) => precedenceRung(r));
  return rows.filter((r, i) =>
    !rows.some((other, j) => j !== i && relate(r, other) === 'same' && (rung[j] < rung[i] || (rung[j] === rung[i] && j < i))),
  );
}

// ── Disagreement with the canonical record (G153) ─────────────────────────────

/** The canonical place facts a provider record is compared against (a gateway SearchResult's). */
export interface CanonicalPlaceFacts {
  id: string;
  title: string;
  lat: number | null;
  lng: number | null;
  city: string | null;
}

function relateToCanonical(p: ProviderCandidate, c: CanonicalPlaceFacts): EntityRelation {
  if (fold(p.name) === '' || fold(p.name) !== fold(c.title)) return 'distinct';
  const d = distanceKm(p, c);
  if (d !== null) return d <= SAME_ENTITY_KM ? 'same' : d <= UNCERTAIN_ENTITY_KM ? 'uncertain' : 'distinct';
  const pc = fold(p.locality), cc = fold(c.city);
  return pc !== '' && cc !== '' && pc !== cc ? 'distinct' : 'uncertain';
}

/**
 * Apply the ladder between provider records and the canonical places of the
 * same answer. A provider record of a venue Portava already has is SUPERSEDED
 * (canonical identity outranks approved provider state) and the facts it
 * disagreed on are named; nothing is written to, or merged into, the canonical
 * row. A record whose identity is uncertain is KEPT and marked, so the picker
 * offers it as a separate choice.
 */
export function resolveProviderConflicts(
  candidates: readonly ProviderCandidate[],
  canonical: readonly CanonicalPlaceFacts[],
): {
  kept: Array<ProviderCandidate & { uncertainOf?: string }>;
  superseded: Array<{ providerPlaceId: string; canonicalId: string; disagreements: string[] }>;
} {
  type Row = Pick<InputSuggestion, 'source' | 'type'> & ({ kind: 'c'; c: CanonicalPlaceFacts } | { kind: 'p'; p: ProviderCandidate });
  const rows: Row[] = [
    ...canonical.map((c): Row => ({ source: 'canonical', type: 'entity', kind: 'c', c })),
    ...candidates.map((p): Row => ({ source: 'provider', type: 'entity', kind: 'p', p })),
  ];
  const relate = (a: Row, b: Row): EntityRelation => {
    if (a.kind === b.kind) return 'distinct'; // same-source duplicates are settled elsewhere
    const p = a.kind === 'p' ? a.p : (b as { p: ProviderCandidate }).p;
    const c = a.kind === 'c' ? a.c : (b as { c: CanonicalPlaceFacts }).c;
    return relateToCanonical(p, c);
  };
  const survivors = new Set(resolveByPrecedence(rows, relate));
  const kept: Array<ProviderCandidate & { uncertainOf?: string }> = [];
  const superseded: Array<{ providerPlaceId: string; canonicalId: string; disagreements: string[] }> = [];
  for (const r of rows) {
    if (r.kind !== 'p') continue;
    if (survivors.has(r)) {
      const near = canonical.find((c) => relateToCanonical(r.p, c) === 'uncertain');
      kept.push(near ? { ...r.p, uncertainOf: near.title } : r.p);
      continue;
    }
    const c = canonical.find((x) => relateToCanonical(r.p, x) === 'same')!;
    const disagreements: string[] = [];
    if (fold(r.p.locality) !== fold(c.city)) disagreements.push('locality');
    const d = distanceKm(r.p, c);
    if (d !== null && d > 0.001) disagreements.push('position');
    superseded.push({ providerPlaceId: r.p.providerPlaceId, canonicalId: c.id, disagreements });
  }
  return { kept, superseded };
}

// ── Projection + the gateway entry point ──────────────────────────────────────

/** A provider record as a §8 row the picker can render, attribute and resolve. */
export function projectProviderCandidate(
  c: ProviderCandidate & { uncertainOf?: string },
  adapter: ProviderAdapter,
  context: InputContext,
  policyVersion: string,
  q: string,
): InputSuggestion {
  const tier = matchTier(c.name, q, c.locality);
  const place = {
    id: `${adapter.placeIdPrefix}-${c.providerPlaceId}`,
    type: 'place',
    name: c.name,
    displayName: [c.name, c.locality].filter(Boolean).join(', '),
    country: null,
    countryCode: c.countryCode,
    region: c.region,
    city: c.locality,
    district: null,
    lat: c.lat,
    lng: c.lng,
    timezone: timezoneForCoords(c.lat, c.lng),
    source: adapter.placeIdPrefix,
    address: c.address,
    postalCode: null,
    formattedAddress: c.address,
  };
  const row: InputSuggestion = {
    id: `${context}:provider:${c.provider}:${c.providerPlaceId}`,
    type: 'entity',
    context,
    label: c.name,
    entityType: 'place',
    action: { type: 'set_structured_value', value: place },
    structuredValue: place,
    confidence: PROVIDER_TIER_CONFIDENCE[tier] ?? PROVIDER_TIER_CONFIDENCE[0],
    source: 'provider',
    attribution: adapter.attribution,
    policyVersion,
  };
  const subtitle = [c.locality, c.countryCode].filter(Boolean).join(', ');
  if (subtitle) row.subtitle = subtitle;
  if (c.uncertainOf) row.reason = `A separate listing from the Portava place "${c.uncertainOf}"`;
  return row;
}

/** The read scope for this request: near its position, else its task's city, else none. */
export function providerScope(p: { lat: number | null; lng: number | null; taskCity: string | null }): ProviderScope | null {
  if (typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
    return { kind: 'near', lat: p.lat, lng: p.lng };
  }
  const city = (p.taskCity ?? '').trim();
  return city.length > 0 ? { kind: 'city', city } : null;
}

/**
 * The gateway's provider lane. Every gate is checked before anything is read:
 * a venue-picker field whose policy takes places, not the paste path, a typed
 * query, a bounded scope, and (inside federation) the adapter's flag.
 */
export async function buildProviderSuggestions(
  sc: SupabaseClient | any,
  p: {
    context: InputContext;
    policy: InputFieldPolicy;
    q: string;
    lat: number | null;
    lng: number | null;
    taskCity: string | null;
    canonicalPlaces: ReadonlyArray<{ id: string; title: string; locationPreview: string | null; metadata: Record<string, unknown> | null }>;
    catalogOnly: boolean;
    policyVersion: string;
    onUnreadable?: (lane: string) => void;
    adapters?: readonly ProviderAdapter[];
  },
): Promise<InputSuggestion[]> {
  if (p.catalogOnly) return [];
  if (!PROVIDER_LANE_CONTEXTS.has(p.context)) return [];
  if (!(p.policy.entityTypes ?? []).includes('place')) return [];
  if (p.q.trim().length < 2) return [];
  const scope = providerScope({ lat: p.lat, lng: p.lng, taskCity: p.taskCity });
  if (!scope) return [];
  const adapters = p.adapters ?? APPROVED_PROVIDER_ADAPTERS;
  const federated = await federateProviderCandidates(sc, {
    q: p.q,
    scope,
    origin: scope.kind === 'near' ? { lat: scope.lat, lng: scope.lng } : null,
    adapters,
    limit: PROVIDER_READ_LIMIT,
    onUnreadable: (key) => p.onUnreadable?.(`provider:${key}`),
  });
  if (federated.length === 0) return [];
  const canonical: CanonicalPlaceFacts[] = p.canonicalPlaces.map((r) => ({
    id: r.id,
    title: r.title,
    lat: num(r.metadata?.lat),
    lng: num(r.metadata?.lng),
    city: r.locationPreview,
  }));
  const { kept } = resolveProviderConflicts(federated, canonical);
  const byKey = new Map(adapters.map((a) => [a.key, a] as const));
  return kept
    .slice(0, PROVIDER_ROW_MAX)
    .map((c) => projectProviderCandidate(c, byKey.get(c.provider)!, p.context, p.policyVersion, p.q));
}
