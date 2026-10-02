/**
 * discoveryDwell — server acceptance of `04` §7 dwell quality on a Discovery
 * place surface (census-discovery DV-41, §55).
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/discovery-v1/04_Behavior_Engine.md` §7:
 *
 *   "Distinguish: active dwell, passive foreground dwell, idle dwell.
 *    Do not infer interest from a phone sitting untouched."
 *
 * Migration 2890 gave `rank_events` the two columns and their CHECKs
 * (`dwell_ms >= 0`; `dwell_kind` ∈ active | passive_foreground | idle; a kind
 * requires a duration). Nothing wrote them. This module is the writer, and the
 * client emitter is `travel-buddy-standalone/src/services/discoveryDwell.ts`.
 *
 * GATED, AND SEEDED OFF
 * =====================
 * Dwell is new behavioural collection. Whether to collect it is the owner's
 * decision, so every write here sits behind `discovery_dwell_telemetry_enabled`
 * (migration 3395, seeded FALSE, never turned on by this lane). With the flag
 * off or unreadable this module reads nothing but the flag and writes nothing,
 * and the route answers 404 `feature_disabled`. The client checks the same flag
 * and sends nothing, so the server gate is the second of two.
 *
 * ONE ROW PER (EMISSION, KIND) — AND WHY NOT AN UPDATE OF THE EXPOSURE ROW
 * ========================================================================
 * A single view of a place sheet can contain all three kinds (read, put the
 * phone down, lock it). The exposure row has ONE `dwell_ms` and ONE
 * `dwell_kind`, so writing onto it would force a rule for which kind wins or how
 * episodes combine — and `04` states none (census §48.6 records exactly that
 * gap). So each emission is recorded as it happened: one ATTENTION row per kind
 * the client measured, bound to the exposure it was measured on. Readers
 * combine; the writer invents no combination. 2890's own header anticipated
 * this shape: "dwell_ms will be non-NULL on the ATTENTION subset only".
 *
 * Each row is `outcome = 'analytics'` — the sentinel every funnel, momentum,
 * seen-set and Trail reader already excludes — with `event_type = 'place_dwell'`,
 * so a dwell row can never be read as an exposure (the serve corpus is
 * `event_type IS NULL`) or as a funnel outcome.
 *
 * BOUND TO THE EXPOSURE, NEVER TO A GUESS
 * =======================================
 * A dwell carries the served `recommendation_id` and is accepted only if that id
 * names an exposure of THIS signed-in caller for THIS item on `discovery`
 * (the same (caller, id) binding `bindOutcomeToExposure` applies to outcomes).
 * Another viewer's id, an anonymous id or an unknown id binds nothing (404); an
 * id naming a different item is refused (409). There is no item-lookup fallback:
 * a dwell that cannot name its exposure is not written.
 *
 * IDEMPOTENT ON RETRY
 * ===================
 * The client names each emission with a `client_event_id` it mints once and
 * re-sends on every retry. Each row's `recommendation_id` is derived from
 * (caller, client_event_id, kind, item) under its own `dwell:` domain, so a
 * retry reproduces the same token and 2891's UNIQUE (recommendation_id, outcome)
 * index settles it `ON CONFLICT DO NOTHING`: the first landing stands and the
 * retry is answered as duplicates, not as new rows.
 *
 * INTEREST
 * ========
 * `04` §4 lists `active_dwell` alone among attention events, and `01` §3 and
 * `03` §5 name "active dwell" as the input. Passive-foreground and idle dwell are
 * RECORDED — §7 asks for the distinction — and are never an interest signal:
 * `dwellCountsAsInterest` is true for `active` only. No reader in this tree
 * consumes dwell as interest today; the predicate exists so the first one that
 * does inherits §7's rule instead of re-deciding it.
 */
import { z } from "zod";
import { recommendationIdFor } from "./discoveryRecommendationId.js";
import {
  canonicalServedAt,
  checkEventSchemaVersion,
  isDuplicateExposureReplay,
  screenFeaturesForStorage,
  DISCOVERY_EVENT_SCHEMA_VERSION,
  DISCOVERY_EVENT_PRIVACY_CLASS,
} from "./discoveryRecommendationRecord.js";
import {
  RECOMMENDATION_ARBITER,
  RECOMMENDATION_ID_SHAPE,
  isMissingRecommendationIdSchema,
  reportRankEventsRejection,
} from "./rankEventsProvenance.js";
import { isFlagEnabled } from "./featureFlags.js";
import { sendError } from "./http.js";
import { DWELL_KINDS, DISCOVERY_DWELL_EVENT_TYPE, dwellCountsAsInterest, type DwellKind } from "./discoveryDwellVocabulary.js";

// ═════════════════════════════════════════════════════════════════════════════
// Vocabulary — the pure words live in lib/discoveryDwellVocabulary.ts
// ═════════════════════════════════════════════════════════════════════════════

export { DWELL_KINDS, DISCOVERY_DWELL_EVENT_TYPE, dwellCountsAsInterest, type DwellKind };

/**
 * The capability flag (migration 3395), seeded FALSE. `*_enabled` ⇒ read
 * fail-closed through `isFlagEnabled`. Declared here, beside its one server
 * read, so `check:flag-polarity` resolves the name at the call site.
 */
export const DISCOVERY_DWELL_FLAG = "discovery_dwell_telemetry_enabled";

/** The one surface a dwell is accepted on: Discovery's place surfaces. */
export const DISCOVERY_DWELL_SURFACE = "discovery" as const;

/**
 * The largest duration the column can hold (`dwell_ms integer`). A storage
 * bound, not a product number: nothing here decides how long a dwell may be.
 */
export const DWELL_MS_MAX = 2_147_483_647;

/** Domain of the per-(emission, kind) token, so it can never equal an exposure's or a direct impression's. */
const DWELL_TOKEN_DOMAIN = "dwell";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═════════════════════════════════════════════════════════════════════════════
// The body
// ═════════════════════════════════════════════════════════════════════════════

const dwellMeasurementSchema = z.object({
  kind: z.enum(DWELL_KINDS),
  // A zero-length episode is not an episode; the client never sends one.
  ms:   z.number().int().min(1).max(DWELL_MS_MAX),
});

export const dwellBodySchema = z.object({
  item_id:           z.string().min(1).max(200),
  surface:           z.literal(DISCOVERY_DWELL_SURFACE),
  recommendation_id: z.string().regex(RECOMMENDATION_ID_SHAPE, "recommendation_id is not a served exposure id"),
  client_event_id:   z.string().regex(UUID_RE, "client_event_id must be a UUID"),
  dwell:             z.array(dwellMeasurementSchema).min(1).max(DWELL_KINDS.length)
    .refine((ds) => new Set(ds.map((d) => d.kind)).size === ds.length, "each dwell kind may appear once per emission"),
  schema_version:    z.unknown().optional(),
});
export type DwellBody = z.infer<typeof dwellBodySchema>;

/**
 * The attention row's token: a function of (caller, emission, kind, item) and
 * nothing else — no clock — so a retried emission reproduces it and collides
 * with its first landing on 2891's index.
 */
export function dwellTokenFor(userId: string, clientEventId: string, kind: DwellKind, itemId: string): string {
  return recommendationIdFor({
    userId,
    sessionId: `${DWELL_TOKEN_DOMAIN}:${clientEventId.toLowerCase()}:${kind}`,
    servedAt:  "",
    surface:   DISCOVERY_DWELL_SURFACE,
    position:  0,
    itemId,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Binding
// ═════════════════════════════════════════════════════════════════════════════

/** What the exposure lookup returns (the select list below, as read back). */
export interface DwellExposureRow {
  id?:                unknown;
  user_id?:           unknown;
  item_id?:           unknown;
  item_kind?:         unknown;
  surface?:           unknown;
  outcome?:           unknown;
  event_type?:        unknown;
  position?:          unknown;
  served_at?:         unknown;
  session_id?:        unknown;
  recommendation_id?: unknown;
}

export type DwellBinding =
  | { kind: "bound"; exposure: DwellExposureRow }
  /** Not this caller's, unknown, anonymous, or not an exposure. Never says which. */
  | { kind: "not_found" }
  | { kind: "mismatch"; field: "item_id" | "surface" };

/**
 * Bind a dwell to the exposure its id names. `row` is what a lookup filtered on
 * (user_id = caller, id) returned; the owner, the kind of row and the item are
 * checked again here so a lookup that lost a filter cannot credit another
 * viewer's exposure or attach attention to an analytics row.
 */
export function bindDwellToExposure(input: {
  callerUserId: string;
  body: { item_id: string; surface: string };
  row: DwellExposureRow | null | undefined;
}): DwellBinding {
  const { callerUserId, body, row } = input;
  if (!row || typeof row.id !== "string" || row.id.length === 0) return { kind: "not_found" };
  if (row.user_id !== callerUserId) return { kind: "not_found" };
  // An exposure is a serve row: `event_type IS NULL` and never the analytics sentinel.
  if (row.outcome === "analytics" || (row.event_type !== undefined && row.event_type !== null)) return { kind: "not_found" };
  if (String(row.surface ?? "") !== body.surface) return { kind: "mismatch", field: "surface" };
  if (String(row.item_id ?? "") !== body.item_id) return { kind: "mismatch", field: "item_id" };
  return { kind: "bound", exposure: row };
}

// ═════════════════════════════════════════════════════════════════════════════
// Acceptance — POST /rank-events/dwell (routes/rankEvents.ts, at its tail)
// ═════════════════════════════════════════════════════════════════════════════

/** The exposure lookup's columns. Literal, so check:write-path-columns reads it. */
const DWELL_EXPOSURE_COLUMNS = "id, user_id, item_id, item_kind, surface, outcome, event_type, position, served_at, session_id, recommendation_id";

/** This writer's name in the rejection counter. */
const DWELL_WRITER = "lib/discoveryDwell.ts";

/** The subset of pino's logger used here; absent in unit tests. */
type DwellLog = { warn?: (ctx: unknown, msg?: string) => void; error?: (ctx: unknown, msg?: string) => void } | undefined;

/**
 * One attention row, spelled out so `check:write-path-columns` reads every
 * column this writer sends. Every column is classified in
 * `RANK_EVENTS_COLUMN_CLASSES`, and every value satisfies 2890's CHECKs and
 * 2891's shape CHECK (pinned by the dwell suite).
 */
export function dwellRowFor(
  userId: string,
  exposure: DwellExposureRow,
  exposureId: string,
  clientEventId: string,
  measurement: { kind: DwellKind; ms: number },
  receivedAt: string,
) {
  const itemId = String(exposure.item_id ?? "");
  return {
    event_type:        DISCOVERY_DWELL_EVENT_TYPE,
    item_id:           itemId,
    item_kind:         typeof exposure.item_kind === "string" ? exposure.item_kind : null,
    position:          typeof exposure.position === "number" ? exposure.position : null,
    surface:           DISCOVERY_DWELL_SURFACE,
    user_id:           userId,
    session_id:        typeof exposure.session_id === "string" ? exposure.session_id : null,
    // The EXPOSURE's instant: an attention row belongs to the serve it measures,
    // so any window over `served_at` keeps the two together.
    served_at:         canonicalServedAt(String(exposure.served_at ?? receivedAt)),
    outcome:           "analytics",
    outcome_at:        receivedAt,
    recommendation_id: dwellTokenFor(userId, clientEventId, measurement.kind, itemId),
    dwell_ms:          measurement.ms,
    dwell_kind:        measurement.kind,
    schema_version:    DISCOVERY_EVENT_SCHEMA_VERSION,
    privacy_class:     DISCOVERY_EVENT_PRIVACY_CLASS,
    // `recommendationId` names the exposure this attention was measured on — the
    // key every Discovery serve row already carries for the same fact.
    features:          screenFeaturesForStorage({ recommendationId: exposureId }).kept,
  };
}

/** The exposure a claimed id names, for THIS viewer only; column first, then `features`. */
async function readDwellExposure(sc: any, userId: string, rid: string): Promise<{ row: DwellExposureRow | null; error: any }> {
  // `rid` passed 2891's shape at the zod boundary ([A-Za-z0-9_-]{22}), so it
  // cannot carry a PostgREST filter delimiter into the `or` expression.
  const res = await sc.from("rank_events").select(DWELL_EXPOSURE_COLUMNS)
    .eq("user_id", userId)
    .or(`recommendation_id.eq.${rid},features->>recommendationId.eq.${rid}`)
    .is("event_type", null)
    .neq("outcome", "analytics")
    .order("served_at", { ascending: false })
    .limit(1);
  if (res?.error) return { row: null, error: res.error };
  return { row: ((res?.data as DwellExposureRow[] | null) ?? [])[0] ?? null, error: null };
}

/**
 * Accept one dwell emission for a signed-in caller. The route has already
 * authenticated; everything else — the flag, the body, the version, the
 * binding, the write — is here. Answers exactly once.
 */
export async function acceptDiscoveryDwell(
  sc: any,
  req: { body: unknown; log?: DwellLog },
  res: any,
  userId: string,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  // The owner's gate first: with it off nothing else is read and nothing written.
  if (!(await isFlagEnabled(sc, DISCOVERY_DWELL_FLAG))) {
    sendError(res, "feature_disabled", "dwell telemetry is not enabled");
    return;
  }

  const parsed = dwellBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = (issue?.path?.length ?? 0) > 0 ? `${issue!.path.join(".")}: ` : "";
    sendError(res, "invalid_payload", `${where}${issue?.message ?? "Invalid payload"}`);
    return;
  }
  const body = parsed.data;
  const version = checkEventSchemaVersion(body.schema_version);
  if (!version.ok) { sendError(res, "invalid_payload", `unsupported_schema_version: ${version.reason}`); return; }

  const picked = await readDwellExposure(sc, userId, body.recommendation_id);
  if (picked.error) {
    (req.log?.error ?? console.error).call(req.log ?? console, { err: picked.error }, "rank-events/dwell: exposure select failed");
    sendError(res, "db_error", String(picked.error?.message ?? "db_error"));
    return;
  }
  const binding = bindDwellToExposure({ callerUserId: userId, body, row: picked.row });
  if (binding.kind === "not_found") { sendError(res, "not_found", "No exposure with this recommendation_id for this viewer"); return; }
  if (binding.kind === "mismatch") { sendError(res, "conflict", `recommendation_id names a different ${binding.field} than this dwell`); return; }

  // ON CONFLICT (recommendation_id, outcome) DO NOTHING: a retried emission
  // reproduces its tokens and lands nothing; `.select("id")` returns only the
  // rows that DID land. Table, payload and select are spelled at the call site
  // so check:write-path-columns resolves every column this writer sends.
  const expected = body.dwell.length;
  const attempt = await sc.from("rank_events")
    .upsert(body.dwell.map((d) => dwellRowFor(userId, binding.exposure, body.recommendation_id, body.client_event_id, d, nowIso)),
      { onConflict: RECOMMENDATION_ARBITER, ignoreDuplicates: true })
    .select("id");
  const error = attempt?.error ?? null;

  if (error && isDuplicateExposureReplay(error)) {
    // A replay that reached the arbiter as an error rather than DO NOTHING.
    res.json({ ok: true, recorded: 0, duplicates: expected });
    return;
  }
  if (error) {
    reportRankEventsRejection(req.log, { writer: DWELL_WRITER, err: error, rows: expected, extra: { where: "dwell insert" } });
    if (isMissingRecommendationIdSchema(error)) {
      // 2890/2891 absent here: without the arbiter a retry would double-write,
      // so nothing is written rather than something non-idempotent.
      sendError(res, "degraded_unavailable", "dwell requires migrations 2890 and 2891");
      return;
    }
    sendError(res, "db_error", String(error?.message ?? "db_error"));
    return;
  }
  const landed = Array.isArray(attempt?.data) ? attempt.data.length : expected;
  res.json({ ok: true, recorded: landed, duplicates: expected - landed });
}
