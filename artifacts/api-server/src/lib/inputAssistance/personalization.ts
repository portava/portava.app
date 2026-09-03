/**
 * Selection Memory & Personalization (Phase 8, backend — spec §35/§15/§14).
 *
 * The per-user PriorSelection signal (§15) and zero-character recents (§14) built
 * from a user's REPEATED EXPLICIT SELECTIONS — never inferred private facts.
 *
 * WHAT THIS IS, IN ONE SENTENCE
 * -----------------------------
 * When a user explicitly SELECTS a suggestion (accepts an entity/completion), the
 * gateway records (context, entity, the query that led to it) in
 * input_selection_history (migration 2222); on later requests this module feeds
 * that back as (a) a bounded confidence NUDGE that re-ranks candidates the user
 * has selected before — stronger when the SAME query led to them, which is the
 * "BKK"→Bangkok abbreviation mapping FOR THAT USER — and (b) zero-character
 * recents drawn from the user's own recent selections.
 *
 * THE FOUR INVARIANTS (why this is safe to enable by default)
 * -----------------------------------------------------------
 *   1. EXPLICIT ONLY. The sole writer is POST /input-assistance/select, called
 *      only on an explicit accept. Nothing here reads views, typing, or dwell.
 *   2. OWNER-SCOPED. Every read/write filters by the session user id (never a
 *      query param). One user's memory never reaches another user's suggestions.
 *   3. AUGMENT, NEVER OVERRIDE. The boost only nudges `confidence`, which is the
 *      SECONDARY sort key under the assistance-type rank (projection.ts). It
 *      reorders candidates WITHIN a type — a canonical entity still outranks an
 *      AI guess (§9) — and is clamped below the exact-match band so a strong
 *      canonical match is never displaced by a merely-remembered weaker one.
 *      It changes NO canonical entity data.
 *   4. PRIVACY GATE FIRST. The re-rank runs on the ALREADY privacy-filtered
 *      candidate list. The only rows this module INJECTS/surfaces on its own are
 *      public canonical GEO entities (city/country) — no per-viewer privacy
 *      variance — so a remembered person/place is re-surfaced only by re-ranking
 *      a candidate that already passed the gate, never injected around it.
 *
 * A user with no history gets today's behaviour exactly (graceful cold-start):
 * an empty memory makes every function here a no-op.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { searchKey, type CanonicalRow } from '../canonicalLocations';
import { cityBinding } from './geoResolver';
import type {
  AssistanceType,
  EntityType,
  InputContext,
  InputFieldPolicy,
  InputSuggestion,
  SuggestionAction,
} from './types';

// ── Tunables ──────────────────────────────────────────────────────────────────

/** How many of the user's rows to scan per (user, context). Bounded read. */
const MEMORY_SCAN_LIMIT = 200;
/** Repeats needed before a learned abbreviation→entity mapping is INJECTED. */
const MIN_REPEAT_FOR_INJECTION = 2;
/** Per-selection weight of the general "this user picks this entity" signal. */
const ENTITY_WEIGHT = 0.03;
/** Per-selection weight of the SAME-query signal (abbreviation mapping). */
const QUERY_WEIGHT = 0.06;
/** Hard cap on the confidence added by personalization. */
const MAX_BOOST = 0.25;
/**
 * Ceiling on a boosted row's confidence. Kept strictly below the exact-match
 * band (tierConfidence(3) = 0.99) so a personalized WEAKER match can never be
 * lifted past a genuine strong canonical match — augment, never override (§9).
 */
const BOOST_CEILING = 0.985;

/** Assistance types the boost may touch — real entities/recents only. */
const BOOSTABLE_TYPES: ReadonlySet<AssistanceType> = new Set<AssistanceType>([
  'entity',
  'recent',
  'personalized',
]);

/**
 * Entity classes this module may SURFACE ON ITS OWN (inject / zero-char recents).
 * Restricted to public canonical GEO registry entities: they carry no per-viewer
 * privacy variance, so re-surfacing one cannot leak a blocked/private record. A
 * remembered person/place is only ever re-RANKED among candidates that already
 * passed the privacy gate — never injected around it.
 */
const SURFACEABLE_GEO_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'city',
  'country',
]);

// ── Normalization (shared by read + write so keys always match) ───────────────

/**
 * Normalize the query text that led to a selection into a stable key. Uses the
 * canonical diacritic/stroke `searchKey` fold (so "BKK"/"bkk" collapse) but does
 * NOT alias-expand — the whole point is to learn a user's OWN abbreviation that
 * the global alias dictionary does not already know. Empty → '' (a zero-char pick
 * has no query). Read and write MUST use this identically.
 */
export function selectionQueryKey(text: string | null | undefined): string {
  const key = searchKey((text ?? '').trim());
  return key || '';
}

function entityMemoryKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

// ── In-memory shape ───────────────────────────────────────────────────────────

export interface SelectionRow {
  context: string;
  entity_type: string;
  entity_id: string;
  query_key: string;
  label: string | null;
  selection_count: number;
  last_selected_at: string | null;
}

interface EntityAggregate {
  entityType: string;
  entityId: string;
  /** Total selections of this entity in this context, across all query keys. */
  total: number;
  /** query_key → selections that used exactly that query. */
  byQuery: Map<string, number>;
  /** Most recent selection timestamp seen (ISO). */
  lastSelectedAt: string | null;
  /** Freshest known display label. */
  label: string | null;
}

export interface SelectionMemory {
  /** Aggregated per entity, keyed by `${entityType}:${entityId}`. */
  byEntity: Map<string, EntityAggregate>;
  /** Recency-ordered distinct entities (newest first). */
  recentEntities: EntityAggregate[];
  /** True when the user has no selection history for this context. */
  isEmpty: boolean;
}

const EMPTY_MEMORY: SelectionMemory = {
  byEntity: new Map(),
  recentEntities: [],
  isEmpty: true,
};

export function emptyMemory(): SelectionMemory {
  return EMPTY_MEMORY;
}

// ── Read: load the user's selection memory for a context ──────────────────────

/**
 * Load and aggregate the OWNER's selection rows for one input context. Bounded,
 * read-only, fail-soft (returns an empty memory on any error). Owner-scoped: the
 * user_id filter is mandatory and comes from the session, never a query param —
 * dropping it would make one user's history affect another's rank, which is the
 * exact regression the owner-scoped test mutation-proves.
 */
export async function fetchSelectionMemory(
  db: SupabaseClient,
  opts: { userId: string; context: InputContext; max?: number },
): Promise<SelectionMemory> {
  if (!opts.userId) return EMPTY_MEMORY;
  const max = opts.max ?? MEMORY_SCAN_LIMIT;

  let rows: SelectionRow[] = [];
  try {
    const { data, error } = await db
      .from('input_selection_history')
      .select('context, entity_type, entity_id, query_key, label, selection_count, last_selected_at')
      .eq('user_id', opts.userId) // OWNER SCOPE — do not remove.
      .eq('context', opts.context)
      .order('last_selected_at', { ascending: false })
      .limit(max);
    if (error || !data) return EMPTY_MEMORY;
    rows = data as SelectionRow[];
  } catch {
    return EMPTY_MEMORY;
  }
  if (rows.length === 0) return EMPTY_MEMORY;

  const byEntity = new Map<string, EntityAggregate>();
  for (const r of rows) {
    if (!r || !r.entity_type || !r.entity_id) continue;
    const count = typeof r.selection_count === 'number' && r.selection_count > 0 ? r.selection_count : 1;
    const key = entityMemoryKey(r.entity_type, r.entity_id);
    let agg = byEntity.get(key);
    if (!agg) {
      agg = {
        entityType: r.entity_type,
        entityId: r.entity_id,
        total: 0,
        byQuery: new Map(),
        lastSelectedAt: r.last_selected_at ?? null,
        label: r.label ?? null,
      };
      byEntity.set(key, agg);
    }
    agg.total += count;
    const qk = r.query_key ?? '';
    agg.byQuery.set(qk, (agg.byQuery.get(qk) ?? 0) + count);
    // Keep the freshest label + timestamp.
    if (r.last_selected_at && (!agg.lastSelectedAt || r.last_selected_at > agg.lastSelectedAt)) {
      agg.lastSelectedAt = r.last_selected_at;
      if (r.label) agg.label = r.label;
    }
    if (!agg.label && r.label) agg.label = r.label;
  }

  const recentEntities = [...byEntity.values()].sort((a, b) => {
    const ta = a.lastSelectedAt ?? '';
    const tb = b.lastSelectedAt ?? '';
    if (ta !== tb) return ta < tb ? 1 : -1; // newest first
    return b.total - a.total;
  });

  return { byEntity, recentEntities, isEmpty: false };
}

// ── The PriorSelection boost (§15) ────────────────────────────────────────────

/** Bounded confidence boost for one entity given the current query key. */
function boostFor(memory: SelectionMemory, entityType: string, entityId: string, queryKey: string): number {
  const agg = memory.byEntity.get(entityMemoryKey(entityType, entityId));
  if (!agg) return 0;
  const sameQuery = queryKey ? agg.byQuery.get(queryKey) ?? 0 : 0;
  const boost = ENTITY_WEIGHT * agg.total + QUERY_WEIGHT * sameQuery;
  return Math.min(MAX_BOOST, boost);
}

/**
 * Re-rank: raise the confidence of candidates the user has selected before in
 * this context. Returns a NEW array (does not mutate inputs). Only boostable
 * types are touched, and the boosted confidence is clamped to BOOST_CEILING so a
 * strong canonical match is never displaced — the boost AUGMENTS ordering within
 * a type, never overrides §9 trust order.
 *
 * MUTATION-PROOF: return `suggestions` unchanged (drop the boost) and the
 * "repeated selection ranks higher" assertion goes RED. Make the boost ignore
 * `memory` scoping (apply a fixed boost to every row, or fetch memory without the
 * user filter) and the "owner-scoped" assertion goes RED.
 */
export function applyPriorSelectionBoost(
  suggestions: InputSuggestion[],
  memory: SelectionMemory,
  queryKey: string,
): InputSuggestion[] {
  if (memory.isEmpty) return suggestions;
  return suggestions.map((s) => {
    if (!BOOSTABLE_TYPES.has(s.type) || !s.entityType || !s.entityId) return s;
    const boost = boostFor(memory, s.entityType, s.entityId, queryKey);
    if (boost <= 0) return s;
    const base = s.confidence ?? 0;
    const boosted = Math.min(BOOST_CEILING, base + boost);
    if (boosted <= base) return s;
    const next: InputSuggestion = { ...s, confidence: boosted };
    // Explain the nudge only when the row has no reason of its own (do not
    // clobber a real canonical reason). Kept generic — no counts leaked (§42).
    if (!next.reason) next.reason = 'Based on your recent picks';
    return next;
  });
}

// ── Surfacing helpers (public geo entities only) ──────────────────────────────

async function fetchCanonicalRowsByIds(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, CanonicalRow>> {
  const out = new Map<string, CanonicalRow>();
  const unique = [...new Set(ids)].filter((x) => typeof x === 'string' && x.length > 0);
  if (unique.length === 0) return out;
  try {
    const { data, error } = await db
      .from('canonical_locations')
      .select('*')
      .in('id', unique)
      .limit(unique.length);
    if (error || !data) return out;
    for (const row of data as CanonicalRow[]) {
      if (row && row.id) out.set(row.id, row);
    }
  } catch {
    return out;
  }
  return out;
}

function citySlug(name: string): string {
  return `/city/${encodeURIComponent((name || '').toLowerCase())}`;
}

/**
 * Project a canonical GEO row as a personalized suggestion. For a picker it BINDS
 * the field to the canonical structured value (§17/§53); for a search-like
 * context it opens the canonical entity. Either way it resolves to the EXISTING
 * canonical entity — no new entity, no changed canonical data.
 */
function projectPersonalizedGeo(
  row: CanonicalRow,
  context: InputContext,
  policyVersion: string,
  opts: { isGeoPicker: boolean; type: AssistanceType; reason: string; confidence: number },
): InputSuggestion {
  const label = row.name || row.display_name;
  const subtitle = [row.region, row.country].filter(Boolean).join(', ') || null;
  let action: SuggestionAction;
  const suggestion: InputSuggestion = {
    id: `${context}:${opts.type}:city:${row.id}`,
    type: opts.type,
    context,
    label,
    entityType: 'city',
    entityId: row.id,
    action: { type: 'open_entity', entityType: 'city', entityId: row.id },
    confidence: opts.confidence,
    source: 'memory',
    reason: opts.reason,
    destination: { route: citySlug(label), entityType: 'city', entityId: row.id },
    canonicalUri: `portava:${citySlug(label)}`,
    policyVersion,
  };
  if (opts.isGeoPicker) {
    const binding = cityBinding(row);
    action = { type: 'set_structured_value', value: binding };
    suggestion.action = action;
    suggestion.structuredValue = binding;
  }
  if (subtitle) suggestion.subtitle = subtitle;
  return suggestion;
}

/**
 * §35 abbreviation mapping: when the typed query key matches a query the user has
 * REPEATEDLY used to select a canonical GEO entity, and that entity is not
 * already among the candidates, INJECT it as a `personalized` suggestion. This is
 * the "BKK"→Bangkok case: it surfaces an EXISTING canonical city for THAT user
 * only, without changing the canonical entity or affecting anyone else.
 *
 * MUTATION-PROOF: gate on the OWNER's memory only; making the lookup global lets
 * user B's "bkk" mapping surface for user A → owner-scoped assertion RED.
 */
export async function buildLearnedGeoInjections(
  db: SupabaseClient,
  opts: {
    memory: SelectionMemory;
    queryKey: string;
    context: InputContext;
    isGeoPicker: boolean;
    policyVersion: string;
    max: number;
    existingEntityIds: ReadonlySet<string>;
  },
): Promise<InputSuggestion[]> {
  if (opts.memory.isEmpty || !opts.queryKey) return [];
  // Candidate mappings: geo entities this user reached via EXACTLY this query,
  // repeatedly, that are not already present.
  const candidates = [...opts.memory.byEntity.values()].filter((agg) => {
    if (!SURFACEABLE_GEO_TYPES.has(agg.entityType as EntityType)) return false;
    if (opts.existingEntityIds.has(agg.entityId)) return false;
    return (agg.byQuery.get(opts.queryKey) ?? 0) >= MIN_REPEAT_FOR_INJECTION;
  });
  if (candidates.length === 0) return [];
  // Strongest mappings first.
  candidates.sort((a, b) => (b.byQuery.get(opts.queryKey) ?? 0) - (a.byQuery.get(opts.queryKey) ?? 0));
  const wanted = candidates.slice(0, Math.max(0, opts.max));

  const rows = await fetchCanonicalRowsByIds(db, wanted.map((a) => a.entityId));
  const out: InputSuggestion[] = [];
  for (const agg of wanted) {
    const row = rows.get(agg.entityId);
    if (!row) continue; // canonical entity gone — never fabricate one
    out.push(
      projectPersonalizedGeo(row, opts.context, opts.policyVersion, {
        isGeoPicker: opts.isGeoPicker,
        type: 'personalized',
        reason: 'You usually pick this',
        // MEDIUM-HIGH but below the exact-match band: a strong learned mapping,
        // still never auto-replacing over a canonical exact match.
        confidence: 0.8,
      }),
    );
  }
  return out;
}

/**
 * §14 zero-character recents from the user's own recent GEO selections. Bounded,
 * fail-soft. Restricted to public geo entities (see SURFACEABLE_GEO_TYPES) so no
 * privacy-gated record is re-surfaced here.
 *
 * MUTATION-PROOF: return [] and the "zero-char returns the user's recents"
 * assertion goes RED.
 */
export async function buildSelectionRecents(
  db: SupabaseClient,
  opts: {
    memory: SelectionMemory;
    context: InputContext;
    isGeoPicker: boolean;
    policyVersion: string;
    max: number;
    existingEntityIds?: ReadonlySet<string>;
  },
): Promise<InputSuggestion[]> {
  if (opts.memory.isEmpty) return [];
  const existing = opts.existingEntityIds ?? new Set<string>();
  const geo = opts.memory.recentEntities.filter(
    (agg) => SURFACEABLE_GEO_TYPES.has(agg.entityType as EntityType) && !existing.has(agg.entityId),
  );
  if (geo.length === 0) return [];
  const wanted = geo.slice(0, Math.max(0, opts.max));

  const rows = await fetchCanonicalRowsByIds(db, wanted.map((a) => a.entityId));
  const out: InputSuggestion[] = [];
  for (const agg of wanted) {
    const row = rows.get(agg.entityId);
    if (!row) continue;
    out.push(
      projectPersonalizedGeo(row, opts.context, opts.policyVersion, {
        isGeoPicker: opts.isGeoPicker,
        type: 'recent',
        reason: 'Recently selected',
        confidence: 0.75,
      }),
    );
  }
  return out;
}

// ── Write: record one explicit selection ──────────────────────────────────────

export interface RecordSelectionResult {
  recorded: boolean;
  reason?: string;
}

/**
 * Record ONE explicit selection for the OWNER. Refuses (records nothing) unless:
 *   • the context is personalization-enabled (policy.allowPersonalization) — so
 *     username / private-message / hidden-gem contexts are never tracked; and
 *   • the selected entity_type is one the context's policy actually allows.
 * This is the ONLY write path, and it is called ONLY from the explicit
 * POST /input-assistance/select endpoint — never from a view/typing signal.
 *
 * Atomic upsert-with-increment via the input_record_selection RPC. Fail-soft:
 * a write failure is logged and returns recorded:false (typeahead never breaks),
 * and the DB error is observed (not a silent supabase write).
 */
export async function recordSelection(
  db: SupabaseClient,
  policy: InputFieldPolicy,
  params: {
    userId: string;
    context: InputContext;
    entityType: EntityType;
    entityId: string;
    query?: string | null;
    label?: string | null;
  },
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<RecordSelectionResult> {
  if (!params.userId) return { recorded: false, reason: 'no_user' };
  // EXPLICIT-ONLY + OWNER-SCOPED gate: only personalization-enabled contexts.
  if (!policy.allowPersonalization) {
    return { recorded: false, reason: 'personalization_disabled' };
  }
  const allowed = policy.entityTypes ?? [];
  if (!allowed.includes(params.entityType)) {
    return { recorded: false, reason: 'entity_type_not_allowed' };
  }
  const queryKey = selectionQueryKey(params.query);
  const label =
    typeof params.label === 'string' && params.label.trim().length > 0
      ? params.label.trim().slice(0, 200)
      : null;

  try {
    const { error } = await db.rpc('input_record_selection', {
      p_user_id: params.userId,
      p_context: params.context,
      p_entity_type: params.entityType,
      p_entity_id: params.entityId,
      p_query_key: queryKey,
      p_label: label,
    });
    if (error) {
      if (log) log.warn({ err: error, context: params.context }, 'input selection record failed');
      return { recorded: false, reason: 'db_error' };
    }
  } catch (err) {
    if (log) log.warn({ err, context: params.context }, 'input selection record threw');
    return { recorded: false, reason: 'db_error' };
  }
  return { recorded: true };
}
