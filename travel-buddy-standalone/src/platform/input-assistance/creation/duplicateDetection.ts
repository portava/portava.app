/**
 * Global Input Intelligence — Phase 5 (Creation): the gateway ⇄ duplicate-candidate bridge.
 *
 * §20 (Constraint-Aware Suggestions) — "Duplicate Place/Gem/Event candidates when
 * creation mode should resolve existing records first." — and §55 (Hidden Gem
 * Creation): as the user names/locates the entity, the system surfaces likely
 * EXISTING canonical records so the user can confirm the intended entity instead
 * of silently minting a duplicate. Creation continues with a canonical reference.
 *
 * This module maps the canonical `InputSuggestion` projection (§8) returned by the
 * P1 gateway for a creation context (`hidden_gem_name` / `event_title` / …) into
 * the compact `DuplicateCandidate` rows a creation screen renders — mirroring
 * `search/globalSearch.ts` and `social/telegraphRecipients.ts` (the Phase 3/4
 * gateway ⇄ row bridges), so the screen never reconstructs identity from gateway
 * internals.
 *
 * NON-BLOCKING BY CONTRACT (§2, §23, §37): a duplicate is a SUGGESTION. Nothing
 * here blocks creation — the caller may always proceed to create new. The mapper
 * only projects existing-entity rows; the screen offers "did you mean this
 * existing one?" and the user decides.
 *
 * WHAT COUNTS AS A DUPLICATE: only suggestions that resolve to an already-existing
 * entity of an allowed creation kind (a Gem, Place, or Event). Completion /
 * action / correction / validation rows are NOT existing records and are dropped
 * (never rendered as a dead "did you mean" row). A recent selection that is a real
 * entity still counts — it carries an entity id.
 *
 * Pure module — no React, no network — unit-testable under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { EntityType, InputContext } from '../types/inputContext.ts';

/**
 * The entity classes that represent an already-existing record a creation flow
 * could resolve to instead of creating a duplicate (§20/§55). A deliberate subset
 * of the canonical `EntityType` union.
 */
export type CreationEntityKind = 'hidden_gem' | 'place' | 'event';

/** Allowed duplicate kinds per creation surface (kept explicit + auditable). */
export const GEM_DUPLICATE_KINDS: readonly CreationEntityKind[] = ['hidden_gem', 'place'];
export const EVENT_DUPLICATE_KINDS: readonly CreationEntityKind[] = ['event', 'place'];
export const PLACE_DUPLICATE_KINDS: readonly CreationEntityKind[] = ['place', 'hidden_gem'];

/** Default kinds to resolve for a given creation InputContext (§5). */
export function duplicateKindsForContext(context: InputContext): readonly CreationEntityKind[] {
  switch (context) {
    case 'hidden_gem_name':
    case 'hidden_gem_location':
      return GEM_DUPLICATE_KINDS;
    case 'event_title':
    case 'event_location':
      return EVENT_DUPLICATE_KINDS;
    case 'place_picker':
    case 'address':
      return PLACE_DUPLICATE_KINDS;
    default:
      // A creation field with no specific mapping resolves the full set — the
      // gateway's own constraint layer (§20) already scopes what it returns.
      return ['hidden_gem', 'place', 'event'];
  }
}

/** A compact existing-entity row a creation screen renders as a "did you mean?". */
export interface DuplicateCandidate {
  /** Canonical id of the EXISTING entity (the reference creation would reuse). */
  entityId: string;
  entityType: CreationEntityKind;
  label: string;
  subtitle: string | null;
  /** "Why this is suggested" / how it matched (§28), when the gateway provided one. */
  reason: string | null;
  /** 0..1 match confidence, when the projection carried one (§19). */
  confidence: number | null;
  /** Router path to open the existing entity, when the projection carried one (§43). */
  route: string | null;
  source: InputSuggestion['source'];
  /** The original projection, so the UI can render it via the shared EntitySuggestionRow. */
  suggestion: InputSuggestion;
}

const CREATION_KINDS = new Set<EntityType>(['hidden_gem', 'place', 'event']);

function isCreationEntityKind(t: EntityType | undefined): t is CreationEntityKind {
  return t != null && CREATION_KINDS.has(t);
}

/**
 * The entity identity a suggestion carries, drawn from top-level fields or an
 * `open_entity` action, whichever is present (the same dual shape
 * `globalSearch.entityIdentity` + `telegraphRecipients.recipientUserId` handle).
 */
function entityIdentity(s: InputSuggestion): { entityType?: EntityType; entityId?: string } {
  const action = s.action;
  if (action && action.type === 'open_entity') {
    return {
      entityType: s.entityType ?? action.entityType,
      entityId: s.entityId ?? action.entityId,
    };
  }
  return { entityType: s.entityType, entityId: s.entityId };
}

/**
 * True only for assistance types that represent an already-existing record.
 * `entity`, `disambiguation`, and `recent` all resolve to a real entity; a
 * `completion` / `action` / `correction` / `validation` / `ai_suggestion` row is
 * not an existing record and must never be offered as a duplicate.
 */
function representsExistingEntity(s: InputSuggestion): boolean {
  return s.type === 'entity' || s.type === 'disambiguation' || s.type === 'recent';
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

/**
 * Project a single suggestion to a duplicate candidate, or `null` when it is not
 * an existing entity of an allowed kind (dropped rather than rendered inert).
 */
export function suggestionToDuplicate(
  s: InputSuggestion,
  allowedKinds: readonly CreationEntityKind[],
): DuplicateCandidate | null {
  if (!representsExistingEntity(s)) return null;

  const { entityType, entityId } = entityIdentity(s);
  if (!isCreationEntityKind(entityType)) return null;
  if (!allowedKinds.includes(entityType)) return null;

  const id = clean(entityId);
  if (!id) return null;

  const label = clean(s.label);
  if (!label) return null;

  return {
    entityId: id,
    entityType,
    label,
    subtitle: clean(s.subtitle),
    reason: clean(s.reason),
    confidence: typeof s.confidence === 'number' && Number.isFinite(s.confidence) ? s.confidence : null,
    route: clean(s.destination?.route ?? null),
    source: s.source,
    suggestion: s,
  };
}

export interface MapDuplicateOptions {
  /** Entity kinds to accept. Defaults to the full creation set. */
  allowedKinds?: readonly CreationEntityKind[];
  /** Cap on candidates surfaced (default 5). */
  limit?: number;
}

/**
 * Map a flat, already-ranked `InputSuggestion[]` (as returned by
 * `useInputAssistance` for a creation context) into duplicate candidates the
 * screen renders. Drops non-entity / disallowed-kind / id-less rows, de-duplicates
 * by entityId keeping the first (highest-ranked) occurrence (§9 canonical-first),
 * and caps the list. Degrades to `[]` for a null/empty stream (never throws).
 */
export function mapDuplicateCandidates(
  suggestions: InputSuggestion[] | null | undefined,
  opts: MapDuplicateOptions = {},
): DuplicateCandidate[] {
  const allowedKinds = opts.allowedKinds ?? (['hidden_gem', 'place', 'event'] as const);
  const limit = opts.limit ?? 5;

  const seen = new Set<string>();
  const out: DuplicateCandidate[] = [];
  for (const s of suggestions ?? []) {
    const cand = suggestionToDuplicate(s, allowedKinds);
    if (!cand) continue;
    const key = `${cand.entityType}:${cand.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cand);
    if (out.length >= limit) break;
  }
  return out;
}

/** True when at least one likely-existing candidate was surfaced (§55). */
export function hasLikelyDuplicate(candidates: DuplicateCandidate[]): boolean {
  return candidates.length > 0;
}
