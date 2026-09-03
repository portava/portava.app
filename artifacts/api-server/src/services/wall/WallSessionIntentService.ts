/**
 * WallSessionIntentService — temporary typed Wall intent (spec §17 / TABLE 3).
 *
 * The Wall does NOT own an autocomplete engine (spec §17). It consumes the
 * platform-wide Global Input Intelligence layer (lib/inputAssistance) to turn a
 * typed/voice phrase ("Bangkok nightlife", "funny travel stories", "just
 * friends", "random") into a STRUCTURED, session-scoped intent:
 *
 *   • Canonical entities selected from typeahead become structured FILTERS with
 *     an entityId — never raw strings (spec §17).
 *   • Residual words that resolve to no canonical entity stay as `keywords`.
 *   • A few "mode" phrases (random / just friends / following) become `mode`
 *     filters that the ranker/route can act on.
 *
 * The intent is TEMPORARY: it steers For You for this session only and never
 * changes a saved preference. Clearing it restores the prior Wall state (spec
 * §17). "Temporary typed Wall intent" is Wall-owned state (spec TABLE 3), so the
 * single-row-per-user store lives in the Wall (migration 2271), even though the
 * PARSING is delegated to Global Input Intelligence.
 *
 * Everything here is fail-soft: a parse or store failure degrades to a
 * keyword-only intent (or no intent) rather than erroring — the Wall must render
 * regardless (spec §34).
 */
import { resolvePolicy } from "../../lib/inputAssistance/policyRegistry.js";
import { generateSuggestions } from "../../lib/inputAssistance/gateway.js";
import type { InputSuggestion, EntityType } from "../../lib/inputAssistance/types.js";
import type {
  StructuredIntent,
  StructuredIntentFilter,
  StructuredIntentFilterKind,
} from "../../lib/wallProjection.js";
import { logger } from "../../lib/logger.js";

/** Max characters of typed text we consider (and echo) — the rest is ignored,
 *  consistent with "do not log unnecessary raw typed content" (spec §32). */
const MAX_INTENT_TEXT = 120;
/** Max structured filters kept per intent — a session steer, not a query DSL. */
const MAX_FILTERS = 8;
/** Max residual keywords kept. */
const MAX_KEYWORDS = 6;

/** Map a Global Input Intelligence EntityType to a Wall filter kind. Returns null
 *  for entity classes that are not meaningful For You steers. */
function entityKind(t: EntityType | undefined): StructuredIntentFilterKind | null {
  switch (t) {
    case "city":
    case "country":
      return "city";
    case "place":
    case "neighborhood":
    case "hidden_gem":
      return "place";
    case "user":
    case "buddy":
      return "person";
    case "interest":
    case "activity":
    case "vibe":
      return "interest";
    case "hashtag":
      return "category";
    default:
      return null; // trip/event/plan/circle/post/stamp/language — not a steer
  }
}

/** Recognized "mode" phrases (spec §17 examples). Longest-match-ish, lowercased. */
const MODE_PHRASES: ReadonlyArray<{ match: RegExp; value: string; label: string }> = [
  { match: /\bjust friends\b|\bfriends only\b/i, value: "just_friends", label: "Just friends" },
  { match: /\bfollowing\b/i, value: "following", label: "Following" },
  { match: /\brandom\b|\bsurprise me\b/i, value: "random", label: "Random" },
];

/** A short, injection-safe keyword token. */
const KEYWORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-']{0,29}$/u;

function detectModeFilters(text: string): { filters: StructuredIntentFilter[]; residual: string } {
  const filters: StructuredIntentFilter[] = [];
  let residual = text;
  for (const m of MODE_PHRASES) {
    if (m.match.test(residual)) {
      filters.push({ kind: "mode", value: m.value, label: m.label });
      residual = residual.replace(m.match, " ");
    }
  }
  return { filters, residual };
}

/**
 * Parse a typed/voice phrase into a session-scoped StructuredIntent. Delegates
 * entity resolution to Global Input Intelligence (global_search context). Never
 * throws — on any failure it returns a keyword-only intent so the caller can
 * still steer softly.
 */
export async function parseIntent(
  sc: any,
  userId: string,
  rawText: string,
  ctx: { lat?: number | null; lng?: number | null; city?: string | null } = {},
): Promise<StructuredIntent> {
  const text = (rawText ?? "").trim().slice(0, MAX_INTENT_TEXT);
  const createdAt = new Date().toISOString();
  const empty: StructuredIntent = { filters: [], keywords: [], sessionScoped: true, createdAt };
  if (!text) return empty;

  // Mode phrases first, so "just friends" / "random" never leak into keywords.
  const { filters: modeFilters, residual } = detectModeFilters(text);

  const filters: StructuredIntentFilter[] = [...modeFilters];
  const usedLabels = new Set<string>();

  // Delegate entity resolution to Global Input Intelligence (never invent a
  // second taxonomy — spec §17). Fail-soft: if the layer is unavailable we keep
  // only the mode filters + keywords.
  let suggestions: InputSuggestion[] = [];
  try {
    const policy = resolvePolicy("global_search");
    if (policy && sc) {
      suggestions = await generateSuggestions(sc, {
        context: "global_search",
        policy,
        text: residual.trim(),
        userId,
        limit: policy.maxSuggestions,
        lat: ctx.lat ?? null,
        lng: ctx.lng ?? null,
        city: ctx.city ?? null,
      });
    }
  } catch (err) {
    logger.warn({ err }, "wallSessionIntent: entity resolution failed — keyword-only intent");
    suggestions = [];
  }

  for (const s of suggestions) {
    if (filters.length >= MAX_FILTERS) break;
    // A canonical FILTER requires a resolved entity id (spec §17: canonical
    // entities become structured filters, not raw strings). Anything without one
    // is a completion/correction, not a steer — skip it.
    if (!s.entityId) continue;
    const kind = entityKind(s.entityType);
    if (!kind) continue;
    const label = (s.label ?? "").slice(0, 60);
    const dedupeKey = `${kind}:${s.entityId}`;
    if (usedLabels.has(dedupeKey)) continue;
    usedLabels.add(dedupeKey);
    filters.push({ kind, entityId: s.entityId, label, value: null });
  }

  // Residual keywords: tokens that resolved to no canonical entity. De-duplicated,
  // format-validated, capped. These carry no entity id and are advisory only.
  const entityWords = new Set(
    filters.flatMap((f) => (f.label ? f.label.toLowerCase().split(/\s+/) : [])),
  );
  const keywords: string[] = [];
  for (const tok of residual.toLowerCase().split(/\s+/)) {
    const t = tok.trim();
    if (!t || !KEYWORD_RE.test(t)) continue;
    if (entityWords.has(t) || keywords.includes(t)) continue;
    keywords.push(t);
    if (keywords.length >= MAX_KEYWORDS) break;
  }

  return { filters: filters.slice(0, MAX_FILTERS), keywords, sessionScoped: true, createdAt };
}

// ── Persistence (one row per user, service-role only) ────────────────────────

/** Read the caller's stored session intent, or null. Fail-soft to null. */
export async function getStoredIntent(sc: any, userId: string): Promise<StructuredIntent | null> {
  if (!sc || !userId) return null;
  try {
    const { data, error } = await sc
      .from("wall_session_intents")
      .select("structured_intent")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const si = (data as any).structured_intent;
    if (!si || !Array.isArray(si.filters)) return null;
    return {
      filters: si.filters,
      keywords: Array.isArray(si.keywords) ? si.keywords : [],
      sessionScoped: true,
      createdAt: typeof si.createdAt === "string" ? si.createdAt : new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err }, "wallSessionIntent: getStoredIntent failed");
    return null;
  }
}

/** Upsert the caller's session intent. Fail-soft (returns false on failure). */
export async function setStoredIntent(
  sc: any,
  userId: string,
  intent: StructuredIntent,
  rawText: string,
): Promise<boolean> {
  if (!sc || !userId) return false;
  try {
    const { error } = await sc.from("wall_session_intents").upsert(
      {
        user_id: userId,
        structured_intent: intent,
        raw_text: (rawText ?? "").slice(0, MAX_INTENT_TEXT),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      logger.warn({ err: error }, "wallSessionIntent: setStoredIntent rejected");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "wallSessionIntent: setStoredIntent threw");
    return false;
  }
}

/** Clear the caller's session intent (restores prior Wall state, spec §17). */
export async function clearStoredIntent(sc: any, userId: string): Promise<boolean> {
  if (!sc || !userId) return false;
  try {
    const { error } = await sc.from("wall_session_intents").delete().eq("user_id", userId);
    if (error) {
      logger.warn({ err: error }, "wallSessionIntent: clearStoredIntent rejected");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "wallSessionIntent: clearStoredIntent threw");
    return false;
  }
}

export const _internal = { entityKind, detectModeFilters };
