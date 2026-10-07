/**
 * LiveSuggestionService (Phase 9, §31/§15/§8/§40) — the live-intelligence lane of
 * the Global Input Intelligence gateway.
 *
 * WHAT IT DOES. For a suggestion whose entity has a CURRENT live state, it
 * attaches a §8 `freshness` projection (the state label — "Getting busier" /
 * "Recently confirmed" — plus a relative "Updated 4m ago" age) and nudges the
 * entity's rank slightly via the §15 Freshness component. Nothing else about the
 * suggestion changes: the entity stays a canonical entity that merely CARRIES a
 * live projection, exactly as §31 requires ("live suggestions ... remain
 * projections of the Live Intelligence system").
 *
 * THE ONE HARD RULE (§2/§31 anti-fabrication). A live label is NEVER
 * manufactured. Every "getting busier"/"busy now"/"recently confirmed" it emits
 * comes from `readLiveClaimEnvelopes` — the gated, fail-closed live read — with a
 * real, unexpired observation timestamp. When live intelligence is
 * off/stale/unavailable/unpromoted, that read returns [] and this attaches NO
 * freshness (the suggestion is returned untouched), which is precisely §31's
 * "remove the live label" degradation. This module invents nothing: it neither
 * scores confidence nor decides eligibility — `readLiveClaimEnvelopes` owns the
 * full IG gate chain (the flag dependency chain + the emergency kill switch +
 * `intel_limited_live` + per-scope promotion + the IG-09 density gate + the
 * privacy_eligible + not-expired filters), and this consumes its output verbatim.
 *
 * WHY ONLY PLACE-LIKE ENTITIES. Live claims in `intel_state_snapshots` are keyed
 * by a place/gem subject id (see lib/liveClaimRead + lib/mapProjection's
 * `liveSubjectIdFor`, which returns a subject only for place/gem objects). So a
 * suggestion is live-eligible only when its `entityType` is `place` or
 * `hidden_gem` and it carries an `entityId` — that id IS the snapshot subject id.
 * Cities/users/etc. carry no live claim today and are left untouched; the eligible
 * set can widen later without a contract change.
 *
 * ADDITIVE + GRACEFUL. With live off (the pre-launch default — ~0 observations),
 * `liveLabelsServable` is false, so this returns early having done at most one
 * flag read and ZERO per-entity snapshot reads: the gateway behaves identically
 * to a world with no LiveSuggestionService. That empty-substrate path is the
 * common case, and it is a no-op by construction.
 */
import { readLiveClaimEnvelopes, liveLabelsServable, type LiveClaimEnvelope } from '../liveClaimRead';
import type {
  EntityType,
  FreshnessState,
  InputContext,
  InputFieldPolicy,
  InputSuggestion,
} from './types';

/**
 * Entity classes that can carry a live claim. These are exactly the subjects
 * `intel_state_snapshots` is keyed by (place/gem), so `suggestion.entityId` is a
 * valid snapshot subject id for them and for nothing else. Kept as a set so the
 * eligible surface is a single, auditable declaration.
 */
export const LIVE_ELIGIBLE_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'place',
  'hidden_gem',
]);

/**
 * Bound on how many distinct entities in one response are probed for live state.
 * Mirrors lib/mapProjection.LIVE_ENRICHMENT_MAX_SUBJECTS's intent (cap the
 * per-subject fan-out). maxSuggestions is ≤ 8 in every registered policy, so this
 * effectively never bites — it is a guard, not a normal-path limiter.
 */
export const LIVE_ENRICHMENT_MAX_ENTITIES = 12;

// ── §15 Freshness rank component ──────────────────────────────────────────────
// A fresh, eligible live state adds a SMALL positive term to an entity's rank
// (the spec's Freshness component). It is added to `confidence`, the SECONDARY
// sort key (assistance-type rank is primary), so it only ever reorders WITHIN a
// type and never lifts a place above a stronger canonical match of another type
// (§9). Stale/absent contributes nothing — never a penalty, never a fabricated
// lift. `recently_confirmed` (a real but not-yet-live-qualified claim) gets a
// smaller nudge than a fully `fresh` (live-band) claim.
const FRESHNESS_BOOST: Record<'fresh' | 'recently_confirmed', number> = {
  fresh: 0.06,
  recently_confirmed: 0.03,
};

/**
 * Ceiling on a live-boosted row's confidence. Kept strictly below the exact-match
 * band (tierConfidence(3) = 0.99 in projection.ts) so a live nudge can never push
 * a weak match up to or past a strong canonical exact match (§9). Mirrors the
 * personalization boost ceiling.
 */
const BOOST_CEILING = 0.985;

// ── Value → label formatters (§31) ────────────────────────────────────────────
// Deterministic maps from a REAL claim value to a human label. They are pure and
// total: an unrecognised value returns null (fall through), never a default
// "busy"/"available" — that null is what makes fabrication impossible even if a
// future claim value is unknown.

/** Extract the scalar payload of a claim value (`"busy"` or `{level:"busy"}`). */
function claimScalar(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const k of ['level', 'value', 'trajectory', 'state', 'label']) {
      if (typeof v[k] === 'string') return v[k] as string;
    }
  }
  return null;
}

/**
 * crowd.trajectory → a trend label (the §31 "↑ Getting busier" headline).
 * Vocabulary is intelContracts.TRAJECTORIES. Unknown ⇒ null.
 */
function trajectoryLabel(value: unknown): string | null {
  switch (claimScalar(value)) {
    case 'emerging':    return 'Starting to pick up';
    case 'building':    return 'Getting busier';
    case 'peaking':     return 'At its busiest';
    case 'stable':      return 'Holding steady';
    case 'declining':   return 'Winding down';
    case 'ending':      return 'Winding down';
    case 'fragmenting': return 'Thinning out';
    case 'relocating':  return 'Crowd moving on';
    default:            return null;
  }
}

/**
 * crowd.level → a current-state label. Vocabulary is intelContracts.CROWD_LEVELS.
 * `unsafe_density` is a specialist-only SAFETY claim (SPECIALIST_ONLY_CROWD_LEVELS)
 * and is deliberately NOT turned into a casual crowd badge here — it returns null
 * so the formatter falls through rather than presenting a safety signal as vibe.
 * Unknown ⇒ null.
 */
function crowdLevelLabel(value: unknown): string | null {
  switch (claimScalar(value)) {
    case 'dead':     return 'Very quiet right now';
    case 'quiet':    return 'Quiet right now';
    case 'moderate': return 'Moderately busy';
    case 'busy':     return 'Busy right now';
    case 'packed':   return 'Packed right now';
    default:         return null; // incl. unsafe_density (specialist-only)
  }
}

const TRAJECTORY_CLAIM_TYPES: ReadonlySet<string> = new Set(['crowd.trajectory']);
const CROWD_LEVEL_CLAIM_TYPES: ReadonlySet<string> = new Set(['crowd.level', 'crowd']);

/**
 * Format the relative observation age ("Updated 4m ago"). Deterministic given a
 * fixed `now`. A future or non-finite timestamp degrades to "Updated just now"
 * rather than a negative age.
 */
export function formatRelativeAge(observedAt: string, nowMs: number): string {
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return 'Updated just now';
  const deltaS = Math.max(0, Math.round((nowMs - t) / 1000));
  if (deltaS < 60) return 'Updated just now';
  const m = Math.floor(deltaS / 60);
  if (m < 60) return `Updated ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Updated ${h}h ago`;
  const d = Math.floor(h / 24);
  return `Updated ${d}d ago`;
}

/**
 * Build the §8 FreshnessState from a subject's live-claim envelopes, or null when
 * there is no live claim to project.
 *
 * PURE and the anti-fabrication chokepoint. The ONLY input is envelopes that
 * `readLiveClaimEnvelopes` already deemed servable (fresh + eligible + promoted).
 * Empty ⇒ null ⇒ the caller attaches no freshness. So a label exists here if and
 * only if a real gated claim backs it: there is no branch that emits a live label
 * without an envelope.
 *
 * MUTATION-PROOF: make this return a non-null FreshnessState for `[]` (e.g. a
 * hardcoded {state:'fresh', label:'Busy now'}) and the "no fabricated live"
 * assertions go RED.
 */
export function buildFreshnessState(
  envelopes: readonly LiveClaimEnvelope[],
  nowMs: number,
): FreshnessState | null {
  if (!envelopes || envelopes.length === 0) return null;

  // Choose the claim to headline, deterministically over the already-ordered
  // (best/current-first) envelopes: a trend claim leads (the §31 "Getting busier"
  // headline), else a current crowd level, else the best claim as a generic
  // "recently confirmed" (the §31 Gem example). Never invents a claim.
  let primary: LiveClaimEnvelope | null = null;
  let label: string | null = null;

  for (const e of envelopes) {
    if (TRAJECTORY_CLAIM_TYPES.has(e.claimType)) {
      const l = trajectoryLabel(e.value);
      if (l) { primary = e; label = l; break; }
    }
  }
  if (!primary) {
    for (const e of envelopes) {
      if (CROWD_LEVEL_CLAIM_TYPES.has(e.claimType)) {
        const l = crowdLevelLabel(e.value);
        if (l) { primary = e; label = l; break; }
      }
    }
  }
  if (!primary) {
    // No crowd trend/level claim: the subject still has a fresh, gated claim
    // (e.g. a structural/existence confirmation), so it is honestly "recently
    // confirmed" — a projection of a real observation, not a manufactured badge.
    primary = envelopes[0];
    label = 'Recently confirmed';
  }

  // A live-band claim ('live'/'strong' → envelope.state 'live') is 'fresh';
  // a claim that cleared the serve floor but not the live band ('emerging') is
  // 'recently_confirmed'. readLiveClaimEnvelopes never emits 'typical'/'unknown'.
  const state: FreshnessState['state'] = primary.state === 'live' ? 'fresh' : 'recently_confirmed';

  const out: FreshnessState = {
    state,
    updatedAtLabel: formatRelativeAge(primary.observedAt, nowMs),
  };
  if (label) out.label = label;
  return out;
}

/** The §15 Freshness rank term for a given freshness state (0 when absent). */
function freshnessBoost(state: FreshnessState['state']): number {
  if (state === 'fresh') return FRESHNESS_BOOST.fresh;
  if (state === 'recently_confirmed') return FRESHNESS_BOOST.recently_confirmed;
  return 0;
}

/**
 * Attach a live-intelligence freshness projection (and the §15 Freshness rank
 * nudge) to the suggestions whose entity has a current, gated live state.
 *
 * Returns a NEW array; inputs are never mutated. Every step is fail-closed and
 * additive — anything off/absent/erroring leaves the suggestion exactly as it
 * was, and no live label is ever fabricated.
 *
 * ORDER OF GATES (cheapest, most-restrictive first):
 *   1. policy.allowLiveContext — a field that does not want live context gets no
 *      reads at all (§6);
 *   2. no live-eligible entities in the list — return before any DB call;
 *   3. liveLabelsServable — the ONE global gate (flag chain + kill switch +
 *      pilot switch); off ⇒ return after a single flag read, ZERO snapshot reads
 *      (the pre-launch default);
 *   4. per entity, readLiveClaimEnvelopes — the per-scope/per-subject gated read;
 *      [] ⇒ that suggestion is left untouched (no fabricated live).
 */
export async function enrichSuggestionsWithLive(
  sc: any,
  suggestions: InputSuggestion[],
  opts: { policy: InputFieldPolicy; context: InputContext; now?: Date; max?: number },
): Promise<InputSuggestion[]> {
  // (1) Field-policy gate (§6): only fields that declare allowLiveContext ever
  // consult the live system. username / private message / hidden-gem NAME etc.
  // never reach the live read.
  if (!opts.policy.allowLiveContext) return suggestions;
  if (!sc || !Array.isArray(suggestions) || suggestions.length === 0) return suggestions;

  // (2) Any live-eligible entities at all? If not, do not even read a flag.
  const eligibleIdx: number[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    if (s.entityType && LIVE_ELIGIBLE_ENTITY_TYPES.has(s.entityType) && typeof s.entityId === 'string' && s.entityId.length > 0) {
      eligibleIdx.push(i);
    }
  }
  if (eligibleIdx.length === 0) return suggestions;

  // (3) Global Live-label gate. Fail-closed: off/unreadable/kill-switched ⇒ no
  // per-entity reads, suggestions returned unchanged (the empty-substrate case).
  let servable = false;
  try {
    servable = await liveLabelsServable(sc);
  } catch {
    servable = false;
  }
  if (!servable) return suggestions;

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const max = Math.max(0, opts.max ?? LIVE_ENRICHMENT_MAX_ENTITIES);

  // (4) Per-subject gated reads, de-duplicated by entity id and capped. Each read
  // is independently fail-soft: an error or empty result leaves that suggestion
  // untouched (never a fabricated label).
  const take = eligibleIdx.slice(0, max);
  const freshnessById = new Map<string, FreshnessState | null>();
  await Promise.all(
    [...new Set(take.map((i) => suggestions[i].entityId as string))].map(async (id) => {
      try {
        const envelopes = await readLiveClaimEnvelopes(sc, id, { now });
        freshnessById.set(id, buildFreshnessState(envelopes, nowMs));
      } catch {
        freshnessById.set(id, null);
      }
    }),
  );

  const takeSet = new Set(take);
  return suggestions.map((s, i) => {
    if (!takeSet.has(i)) return s;
    const id = s.entityId as string;
    const freshness = freshnessById.get(id) ?? null;
    if (!freshness) return s; // no gated live claim ⇒ no label, no boost (§31)
    const base = s.confidence ?? 0;
    const boosted = Math.min(BOOST_CEILING, base + freshnessBoost(freshness.state));
    return {
      ...s,
      freshness,
      // §15 Freshness rank term. Only ever raises confidence, clamped below the
      // exact-match band; never lowers it (a stale/absent state simply never
      // reaches here). Keep the higher of the two so a boost can't demote.
      confidence: Math.max(base, boosted),
    };
  });
}
