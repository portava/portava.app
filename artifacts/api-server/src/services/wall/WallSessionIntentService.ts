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
  IntentResolution,
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
 * ── HOW THE WALL CAN SEE AN OUTAGE AT ALL ────────────────────────────────────
 *
 * `generateSuggestions` does not throw. The shared gateway wraps every one of
 * its ~18 data-plane calls in `.catch(() => [])` (lib/inputAssistance/gateway.ts),
 * so a database that is completely unreachable and a query that legitimately
 * matched nothing BOTH arrive at this service as `[]`. That is the engine-side
 * half of W71's "cannot tell a transcription failure from silence", it is owned
 * by the Global Input Intelligence lane, and the Wall must not reach into it.
 *
 * What the Wall CAN observe without touching that engine is the client it hands
 * over. This probe wraps the supabase client so the queries the engine issues
 * are counted by outcome. The verdict is deliberately conservative:
 *
 *     an outage  ⟺  the engine issued at least one query and NOT ONE of them
 *                    succeeded.
 *
 * A partial failure is NOT an outage — the gateway's per-source catches exist
 * precisely so one dead source degrades instead of failing the request, and that
 * is a real answer. Zero queries issued is not an outage either: some contexts
 * resolve entirely in memory, and claiming an outage there would invent an
 * incident. Both of those directions were chosen so the probe can only ever
 * under-report, never manufacture, a failure.
 */
interface EngineProbe {
  ok: number;
  failed: number;
}

/** Wrap `sc` so every awaited query result is tallied. Never changes behaviour:
 *  values and rejections pass through untouched. */
function probeClient(sc: any, probe: EngineProbe): any {
  if (!sc || typeof sc.from !== "function") return sc;

  const wrap = (node: any): any => {
    if (!node || (typeof node !== "object" && typeof node !== "function")) return node;
    return new Proxy(node, {
      get(target, prop, receiver) {
        if (prop === "then") {
          const then = Reflect.get(target, prop, receiver);
          if (typeof then !== "function") return then;
          return (onFulfilled: any, onRejected: any) =>
            then.call(
              target,
              (res: any) => {
                // PostgREST reports failure in the body, not by rejecting.
                if (res && typeof res === "object" && res.error) probe.failed++;
                else probe.ok++;
                return onFulfilled ? onFulfilled(res) : res;
              },
              (err: any) => {
                probe.failed++;
                return onRejected ? onRejected(err) : Promise.reject(err);
              },
            );
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: any[]) => {
          const out = value.apply(target, args);
          return out && typeof out === "object" ? wrap(out) : out;
        };
      },
    });
  };

  return new Proxy(sc, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === "from" || prop === "rpc") && typeof value === "function") {
        return (...args: any[]) => wrap(value.apply(target, args));
      }
      return value;
    },
  });
}

/**
 * True when this intent is the product of an OUTAGE rather than of anything the
 * user said. Callers branch on this to keep an unavailable engine from being
 * rendered as a finding ("nothing matched") — see IntentResolution in
 * lib/wallProjection.ts and the W71 row on census-wall.md.
 *
 * It exists as a predicate rather than as an inline string comparison because
 * the comparison was the thing that kept being omitted.
 */
export function intentIsOutage(intent: Pick<StructuredIntent, "resolution">): boolean {
  return intent.resolution === "engine_unavailable";
}

/**
 * Parse a typed/voice phrase into a session-scoped StructuredIntent. Delegates
 * entity resolution to Global Input Intelligence (global_search context). Never
 * throws — on any failure it returns a keyword-only intent so the caller can
 * still steer softly.
 *
 * FAIL-SOFT IS NOT THE SAME AS SILENT (W71). Degrading softly is right: the Wall
 * must render (spec §34). Degrading INDISTINGUISHABLY is the defect — the caller
 * gets the same value whether the engine spoke or died. The returned
 * `resolution` is what separates the two, and it is the only thing in this
 * function that is allowed to say why `filters` is empty.
 */
export async function parseIntent(
  sc: any,
  userId: string,
  rawText: string,
  ctx: { lat?: number | null; lng?: number | null; city?: string | null } = {},
): Promise<StructuredIntent> {
  const text = (rawText ?? "").trim().slice(0, MAX_INTENT_TEXT);
  const createdAt = new Date().toISOString();
  // NOTHING TO PARSE. Not "we searched and found nothing" — no search happened.
  // Collapsing this into `resolved_no_entities` is mutation M3 in
  // src/test/wallIntentResolutionTruthfulness.test.ts.
  if (!text) {
    return { filters: [], keywords: [], sessionScoped: true, createdAt, resolution: "no_text" };
  }

  // Mode phrases first, so "just friends" / "random" never leak into keywords.
  const { filters: modeFilters, residual } = detectModeFilters(text);

  const filters: StructuredIntentFilter[] = [...modeFilters];
  const usedLabels = new Set<string>();

  // Delegate entity resolution to Global Input Intelligence (never invent a
  // second taxonomy — spec §17). Fail-soft: if the layer is unavailable we keep
  // only the mode filters + keywords.
  let suggestions: InputSuggestion[] = [];
  // Starts as an OUTAGE and is only downgraded to a finding once the engine has
  // actually answered. The default must be the pessimistic one: every past
  // version of this function defaulted to "we found nothing" and therefore
  // reported an outage as a fact about the user whenever the engine failed.
  let resolution: IntentResolution = "engine_unavailable";
  const probe: EngineProbe = { ok: 0, failed: 0 };
  try {
    const policy = resolvePolicy("global_search");
    if (policy && sc) {
      suggestions = await generateSuggestions(probeClient(sc, probe), {
        context: "global_search",
        policy,
        text: residual.trim(),
        userId,
        limit: policy.maxSuggestions,
        lat: ctx.lat ?? null,
        lng: ctx.lng ?? null,
        city: ctx.city ?? null,
      });
      // The engine returned. Whether that RETURN is an answer or an outage is
      // what the probe decides: a gateway whose every query failed returned `[]`
      // without ever learning anything about the user's words.
      resolution =
        probe.ok === 0 && probe.failed > 0 ? "engine_unavailable" : "resolved_no_entities";
    }
    // No policy or no client is also an unavailable engine, not a no-match:
    // `resolution` stays "engine_unavailable" and nothing is claimed.
  } catch (err) {
    logger.warn({ err }, "wallSessionIntent: entity resolution failed — keyword-only intent");
    suggestions = [];
    // Left as "engine_unavailable". Setting it to "resolved_no_entities" here is
    // mutation M2 — the original defect this row is about.
    resolution = "engine_unavailable";
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

  const kept = filters.slice(0, MAX_FILTERS);
  // Only an engine that ANSWERED can be upgraded to "resolved"; an outage that
  // happened to produce mode filters ("random", "just friends") is still an
  // outage, because no entity resolution took place.
  if (resolution === "resolved_no_entities" && kept.some((f) => f.entityId)) {
    resolution = "resolved";
  }
  return { filters: kept, keywords, sessionScoped: true, createdAt, resolution };
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
    // A STORED intent was produced by an earlier successful parse and persisted;
    // reading it back is not a fresh engine verdict. Rows written before this
    // column existed carry no resolution, so derive the only two a stored row
    // can honestly claim — never "engine_unavailable", which would report THIS
    // read's health as though it were that parse's.
    const storedResolution: IntentResolution =
      si.resolution === "resolved" ||
      si.resolution === "resolved_no_entities" ||
      si.resolution === "no_text"
        ? si.resolution
        : si.filters.some((f: any) => f?.entityId)
          ? "resolved"
          : "resolved_no_entities";
    return {
      filters: si.filters,
      keywords: Array.isArray(si.keywords) ? si.keywords : [],
      sessionScoped: true,
      createdAt: typeof si.createdAt === "string" ? si.createdAt : new Date().toISOString(),
      resolution: storedResolution,
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
