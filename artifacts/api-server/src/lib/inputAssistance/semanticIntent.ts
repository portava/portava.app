/**
 * Semantic Intent orchestrator (Phase 6 — §18/§19/§21/§43).
 *
 * Composes the deterministic parser (semanticParser.ts) into the Phase-1 gateway
 * for the two search-like contexts the phase targets — `global_search` and
 * `compass_prompt`. It:
 *
 *   1. Parses the text into a structured `ParsedIntent` (pure, deterministic).
 *   2. Resolves a parsed PLACE anchor and a §21 add-to-trip destination to a
 *      canonical city (reusing geoResolver.resolveGeoCandidates — no new resolver).
 *   3. Projects §18 structure into ADDITIVE `action`/`ai_suggestion` suggestion
 *      rows, and recognizes §21 smart actions ("add Bangkok to my trip").
 *
 * INVARIANTS (hard constraints):
 *   - §2/§19: a structured row is emitted ONLY when the parse reaches MEDIUM+
 *     confidence (`shouldProjectStructured`). LOW/VERY-LOW ⇒ nothing is added and
 *     the raw query is preserved by the gateway (the raw "SEARCH FOR" completion
 *     is built from the user's text and always stays). Every builder here guards
 *     on that gate, so forcing it true is the mutation the raw-preserved tests
 *     catch.
 *   - The parse AUGMENTS, never overrides: all rows are `action`/`ai_suggestion`
 *     types, which sort AFTER `entity` rows under §9 trust order — a strong
 *     canonical entity always outranks a parsed guess.
 *   - §21/§47: a smart action is PROPOSE-ONLY. `add_to_trip` carries a resolved
 *     entityId but does not execute; the write happens behind the trip endpoint's
 *     own authorization. The row is only surfaced when the field POLICY allows
 *     the `action` assistance type.
 *   - NO model call (deterministic). The LLM CompassIntentClassifier stays in
 *     shadow mode and is deliberately NOT productionized into this hot path
 *     because it is non-deterministic and can hallucinate an intent.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveGeoCandidates } from './geoResolver';
import {
  parseSemanticIntent,
  parseSmartAction,
  shouldProjectStructured,
  type ParsedIntent,
  type StageIntent,
  type ExperienceQualifier,
  type Anchor,
} from './semanticParser';
import type { InputContext, InputFieldPolicy, InputSuggestion, SuggestSessionContext } from './types';

/** The contexts Phase 6 wires the semantic layer into. Others are untouched. */
export const SEMANTIC_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'global_search',
  'compass_prompt',
]);

export function isSemanticContext(context: InputContext): boolean {
  return SEMANTIC_CONTEXTS.has(context);
}

// ── Small display helpers (pure) ───────────────────────────────────────────────

function categoryHuman(slug: string): string {
  return slug.replace(/_/g, ' ');
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function anchorPhrase(anchor: Anchor, resolvedName?: string | null): string {
  switch (anchor.kind) {
    case 'current_hotel':
      return 'near your hotel';
    case 'meeting_point':
      return 'near your meeting point';
    case 'airport':
      return 'near the airport';
    case 'current_location':
      return 'near you';
    case 'place':
      return `near ${resolvedName || anchor.text}`;
  }
}

function qualifierPhrase(quals: ExperienceQualifier[]): string {
  return quals.map((q) => q.replace(/_/g, ' ')).join(', ');
}

/** The tap-target search query for a stage or the whole parse (never the raw). */
function subjectQuery(category: string | undefined, residual: string, quals: ExperienceQualifier[], raw: string): string {
  if (category) return categoryHuman(category);
  if (residual) return residual;
  if (quals.length > 0) return qualifierPhrase(quals);
  return raw;
}

function subjectLabel(category: string | undefined, residual: string, quals: ExperienceQualifier[], raw: string): string {
  return titleCase(subjectQuery(category, residual, quals, raw));
}

// ── Structured value payloads (the §42 structured projection, UI-safe) ─────────

interface StructuredSemanticValue {
  category?: string;
  experienceQualifiers: ExperienceQualifier[];
  relationship?: string;
  anchor?: { kind: string; text?: string; cityId?: string | null; city?: string | null };
  temporal?: { type: string; label: string; startsAfter: string | null; startsBefore: string | null; deferred?: boolean };
  sequence: boolean;
  stages: Array<{ index: number; category?: string; experienceQualifiers: ExperienceQualifier[]; subject: string }>;
}

export interface ResolvedAnchor {
  cityId: string;
  city: string;
  country: string | null;
}

function buildStructuredValue(parsed: ParsedIntent, resolvedAnchor?: ResolvedAnchor | null): StructuredSemanticValue {
  const v: StructuredSemanticValue = {
    experienceQualifiers: parsed.experienceQualifiers,
    sequence: parsed.sequence,
    stages: parsed.stages.map((s) => ({
      index: s.index,
      category: s.category,
      experienceQualifiers: s.experienceQualifiers,
      subject: subjectQuery(s.category, s.residualText, s.experienceQualifiers, s.raw),
    })),
  };
  if (parsed.category) v.category = parsed.category;
  if (parsed.relationship) v.relationship = parsed.relationship;
  if (parsed.anchor) {
    v.anchor =
      parsed.anchor.kind === 'place'
        ? { kind: 'place', text: parsed.anchor.text, cityId: resolvedAnchor?.cityId ?? null, city: resolvedAnchor?.city ?? null }
        : { kind: parsed.anchor.kind };
  }
  if (parsed.temporal) {
    v.temporal = {
      type: parsed.temporal.type,
      label: parsed.temporal.label,
      startsAfter: parsed.temporal.startsAfter,
      startsBefore: parsed.temporal.startsBefore,
      deferred: parsed.temporal.deferred,
    };
  }
  return v;
}

// ── Row builders (pure; each GUARDS on the §19 confidence gate) ────────────────

/**
 * A single "scoped search" row for a NON-sequenced confident parse (§18).
 * category + experience + anchor + time → one refined, tappable search that is
 * ADDITIVE to (never a replacement of) the raw query. Returns null when the
 * parse is below MEDIUM confidence — the gate the raw-preserved test mutates.
 */
export function buildStructuredSearchRow(
  context: InputContext,
  policyVersion: string,
  parsed: ParsedIntent,
  resolvedAnchor?: ResolvedAnchor | null,
): InputSuggestion | null {
  if (!shouldProjectStructured(parsed)) return null;
  if (parsed.sequence) return null; // sequences use per-stage rows instead

  const query = subjectQuery(parsed.category, parsed.residualText, parsed.experienceQualifiers, parsed.raw);
  const parts: string[] = [subjectLabel(parsed.category, parsed.residualText, parsed.experienceQualifiers, parsed.raw)];
  if (parsed.experienceQualifiers.length > 0) parts[0] = `${titleCase(qualifierPhrase(parsed.experienceQualifiers))} ${parts[0]}`;
  if (parsed.anchor) parts.push(anchorPhrase(parsed.anchor, resolvedAnchor?.city));
  if (parsed.temporal) parts.push(parsed.temporal.label.toLowerCase());
  const label = parts.join(' · ');

  return {
    id: `${context}:semantic:search`,
    type: 'action',
    context,
    label,
    // Tapping runs a refined search. The RAW query row is untouched (§2).
    action: { type: 'submit_search', query },
    structuredValue: buildStructuredValue(parsed, resolvedAnchor),
    confidence: parsed.confidence,
    source: 'local',
    reason: 'Interpreted from your search',
    policyVersion,
  };
}

/**
 * Per-stage rows for a SEQUENCED confident parse ("food then somewhere busy" →
 * an ordered list of stage searches). Returns [] below MEDIUM confidence.
 */
export function buildSequencedRows(
  context: InputContext,
  policyVersion: string,
  parsed: ParsedIntent,
  max = 4,
): InputSuggestion[] {
  if (!shouldProjectStructured(parsed) || !parsed.sequence) return [];
  const total = parsed.stages.length;
  return parsed.stages.slice(0, Math.max(0, max)).map((stage: StageIntent): InputSuggestion => {
    const query = subjectQuery(stage.category, stage.residualText, stage.experienceQualifiers, stage.raw);
    const label = `${stage.index}. ${subjectLabel(stage.category, stage.residualText, stage.experienceQualifiers, stage.raw)}`;
    return {
      id: `${context}:semantic:stage:${stage.index}`,
      type: 'action',
      context,
      label,
      action: { type: 'submit_search', query },
      structuredValue: {
        kind: 'sequence_stage',
        stageIndex: stage.index,
        totalStages: total,
        sequence: true,
        category: stage.category,
        experienceQualifiers: stage.experienceQualifiers,
        subject: query,
      },
      // Later stages are progressively less certain; keep them just under the
      // overall confidence and strictly below any real entity (type rank does
      // the §9 ordering — these are `action` rows, entities lead regardless).
      confidence: Math.max(0.5, parsed.confidence - (stage.index - 1) * 0.05),
      source: 'local',
      reason: total > 1 ? `Step ${stage.index} of ${total}` : 'Interpreted from your search',
      policyVersion,
    };
  });
}

/**
 * For `compass_prompt`: a structured interpretation the user can hand to Compass.
 * An `ai_suggestion` row (policy-allowed) whose text is EDITABLE (§22, never
 * silently inserted) and whose action opens Compass with the parsed context
 * (§43 open_compass). Returns null below MEDIUM confidence.
 */
export function buildCompassStructuredRow(
  context: InputContext,
  policyVersion: string,
  parsed: ParsedIntent,
  resolvedAnchor?: ResolvedAnchor | null,
): InputSuggestion | null {
  if (!shouldProjectStructured(parsed)) return null;

  const value = buildStructuredValue(parsed, resolvedAnchor);
  let label: string;
  if (parsed.sequence) {
    label = parsed.stages
      .map((s) => subjectLabel(s.category, s.residualText, s.experienceQualifiers, s.raw))
      .join(' → ');
  } else {
    const parts: string[] = [subjectLabel(parsed.category, parsed.residualText, parsed.experienceQualifiers, parsed.raw)];
    if (parsed.anchor) parts.push(anchorPhrase(parsed.anchor, resolvedAnchor?.city));
    if (parsed.temporal) parts.push(parsed.temporal.label.toLowerCase());
    label = parts.join(' · ');
  }

  return {
    id: `${context}:semantic:compass`,
    type: 'ai_suggestion',
    context,
    label,
    // Editable prompt text — the field is never silently mutated (§22).
    replacementText: parsed.raw,
    action: { type: 'open_compass', context: value },
    structuredValue: value,
    confidence: parsed.confidence,
    source: 'ai',
    reason: 'Structured interpretation',
    policyVersion,
  };
}

function citySlug(name: string): string {
  return `/city/${encodeURIComponent((name || '').toLowerCase())}`;
}

/**
 * §21 smart action row: "add <city> to your trip". PROPOSE-ONLY — the
 * `add_to_trip` action carries the resolved canonical city id but execution
 * stays behind the trip endpoint's own authorization (§47).
 */
export function buildAddToTripRow(
  context: InputContext,
  policyVersion: string,
  city: ResolvedAnchor,
  sessionContext?: SuggestSessionContext,
): InputSuggestion {
  const row: InputSuggestion = {
    id: `${context}:action:add_to_trip:${city.cityId}`,
    type: 'action',
    context,
    label: `Add ${city.city} to your trip`,
    entityType: 'city',
    entityId: city.cityId,
    action: { type: 'add_to_trip', entityId: city.cityId },
    structuredValue: {
      kind: 'add_to_trip',
      entityId: city.cityId,
      city: city.city,
      tripId: sessionContext?.tripId ?? null,
    },
    confidence: 0.9,
    source: 'canonical',
    reason: 'Add destination',
    destination: { route: citySlug(city.city), entityType: 'city', entityId: city.cityId },
    policyVersion,
  };
  if (city.country) row.subtitle = city.country;
  return row;
}

// ── Async orchestration used by the gateway ────────────────────────────────────

export interface SemanticParams {
  context: InputContext;
  policy: InputFieldPolicy;
  /** Alias-expanded user text (phrases intact; NOT the DB-sanitized query). */
  text: string;
  tz: string | null;
  sessionContext?: SuggestSessionContext;
  policyVersion: string;
  max: number;
}

function allows(policy: InputFieldPolicy, type: string): boolean {
  return policy.allowedSuggestionTypes.includes(type as never);
}

async function resolveCity(sc: SupabaseClient, text: string): Promise<ResolvedAnchor | null> {
  const res = await resolveGeoCandidates(sc, text, 3).catch(() => null);
  const row = res?.rows?.[0];
  if (!row) return null;
  return { cityId: row.id, city: row.name || row.display_name, country: row.country ?? null };
}

/**
 * Build the additive semantic-intent rows for a search-like context. Fail-soft:
 * any resolution error degrades to fewer rows, never an exception (typeahead
 * must never surface an error mid-keystroke — the gateway also try/catches).
 */
export async function buildSemanticAssistance(
  sc: SupabaseClient,
  p: SemanticParams,
): Promise<InputSuggestion[]> {
  const { context, policy, text, tz, sessionContext, policyVersion, max } = p;
  if (!isSemanticContext(context)) return [];

  const parsed = parseSemanticIntent(text, { tz });
  const out: InputSuggestion[] = [];

  // ── §21 smart action recognition (gated by the target action's policy) ────────
  if (allows(policy, 'action')) {
    const sa = parseSmartAction(text);
    if (sa) {
      const city = await resolveCity(sc, sa.destinationText);
      if (city) out.push(buildAddToTripRow(context, policyVersion, city, sessionContext));
    }
  }

  // ── §18 structured suggestions (only MEDIUM+; else raw is preserved) ──────────
  if (shouldProjectStructured(parsed)) {
    // Resolve a parsed place anchor to a canonical city (best-effort).
    let resolvedAnchor: ResolvedAnchor | null = null;
    if (parsed.anchor?.kind === 'place') {
      resolvedAnchor = await resolveCity(sc, parsed.anchor.text);
    }

    if (parsed.sequence) {
      // A staged query → sequenced suggestions (one row per stage).
      if (allows(policy, 'action')) out.push(...buildSequencedRows(context, policyVersion, parsed, max));
    } else if (allows(policy, 'action')) {
      const row = buildStructuredSearchRow(context, policyVersion, parsed, resolvedAnchor);
      if (row) out.push(row);
    }

    // compass_prompt gets an editable structured interpretation (open_compass).
    if (context === 'compass_prompt' && allows(policy, 'ai_suggestion')) {
      const row = buildCompassStructuredRow(context, policyVersion, parsed, resolvedAnchor);
      if (row) out.push(row);
    }
  }

  return out.slice(0, Math.max(0, max));
}
