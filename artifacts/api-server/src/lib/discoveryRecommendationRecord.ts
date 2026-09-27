/**
 * discoveryRecommendationRecord — THE SHARED CONTRACT for one served Discovery
 * recommendation (census-discovery DV-40, DV-46, DV-06, DV-37, DV-38, DV-39).
 *
 * This module is PURE: no client, no clock unless one is passed, no throw. It is
 * the one place that says
 *
 *   1. what a served recommendation IS (the type and the nine-field record);
 *   2. how every served item gets its `recommendationId` (the stamping function);
 *   3. how that id travels: served item → client outcome event → `rank_events`
 *      (the propagation rules, as data and as one binding function);
 *   4. which event-schema versions are accepted (`04` §3 "versioned");
 *   5. which privacy class every stored field belongs to, and that an
 *      unclassified field does not reach storage (`04` §3 "privacy-classified").
 *
 * Writers (`lib/discoveryServeLog.ts`, `lib/rankLog.ts`, `routes/rankEvents.ts`)
 * and the serve paths in `routes/discovery.ts` consume it. Nothing here writes.
 *
 * ── WHAT `04` §5 ASKS FOR ────────────────────────────────────────────────────
 * > "Every served item must have a `recommendation_id`."
 * > Minimum record: recommendation_id, user_id, session_id, candidate_type/id,
 * > surface, rank_position, model_version, reason codes, served_at.
 * > "Without exposure denominators, engagement rates are misleading."
 *
 * The id binds the EXPOSURE (viewer, session, instant, surface, position, item),
 * never the item — `lib/discoveryRecommendationId.ts` makes that argument and
 * mints the digest; this module does not mint a second kind of id for the same
 * thing. It adds exactly two things that module does not have:
 *
 *   • a VIEWER KEY for the anonymous caller, so an anonymous serve's items carry
 *     an id too (see ANONYMOUS SERVES below), and
 *   • a per-REQUEST id (`serveId`, `10` §3's `recommendations.id`), so a
 *     denominator can be counted per request and not only per item (DV-06).
 *
 * ── ANONYMOUS SERVES — how they are, and are not, recorded ──────────────────
 * The shipping client calls `GET /api/discovery`, `/community` and `/counts`
 * without an Authorization header, so on production every one of those serves
 * is anonymous. `04` §5 still requires an id on every served item, so an
 * anonymous item IS stamped: the viewer coordinate is the fixed key
 * `ANONYMOUS_VIEWER_KEY`, which is not a UUID and so can never equal a real
 * user id, and the session coordinate is a fresh random UUID per request, so
 * two anonymous serves share nothing and cannot be linked to each other.
 *
 * What an anonymous serve does NOT get is a user-keyed row. `rank_events.user_id`
 * is NOT NULL with a foreign key to `auth.users`, and an exposure that cannot be
 * attributed to anybody must not be attributed to somebody. The durable record
 * of an anonymous serve is ONE per-request row (`public.recommendations`,
 * migration 3376) carrying `user_id` NULL, the per-request denominator and the
 * ordered item ids — enough to recover every served item's nine-field record
 * (with `user_id` null) and nothing that identifies a person. An anonymous id can
 * never be credited with an outcome: `POST /rank-events/outcome` requires a
 * signed-in caller and binds by (caller, id), and no row carries that id with a
 * user. That is the spec's own limit, stated rather than worked around.
 *
 * ── WHY THIS IS NOT THE COMPASS TOKEN ────────────────────────────────────────
 * Compass's `recommendation_id` is deterministic per ITEM and HMAC-signed
 * because it is a client-facing lookup handle. A denominator needs the opposite
 * (one item served twice is two exposures), and this id is never trusted as
 * proof of anything: an outcome carrying it is BOUND to the caller server-side,
 * so a forged or replayed id credits nothing (`bindOutcomeToExposure`).
 */
import { createHash, randomUUID } from "node:crypto";
import { recommendationIdFor } from "./discoveryRecommendationId.js";
import { DISCOVERY_MODEL_VERSION } from "./discoveryRankProvenance.js";
import { RECOMMENDATION_ID_SHAPE } from "./rankEventsProvenance.js";

// ═════════════════════════════════════════════════════════════════════════════
// 1. The exposure — minted ONCE per request, handed to the response AND the log
// ═════════════════════════════════════════════════════════════════════════════

/** The surface every Discovery serve point writes. */
export const DISCOVERY_RECOMMENDATION_SURFACE = "discovery" as const;

/**
 * The viewer coordinate of an anonymous serve.
 *
 * Deliberately not a UUID: `rank_events.user_id` and `recommendations.user_id`
 * are UUIDs, so no real viewer's coordinate can ever equal this one, and an id
 * minted under it can never be bound to a signed-in caller's outcome.
 */
export const ANONYMOUS_VIEWER_KEY = "anonymous" as const;

/**
 * One serve's identity.
 *
 * `userId` is null for an anonymous caller. `sessionId` is the one session every
 * row of the serve shares. `servedAt` is canonical ISO-8601 (`toISOString()`),
 * the instant written to `rank_events.served_at`.
 */
export interface ServeExposure {
  userId:    string | null;
  sessionId: string;
  servedAt:  string;
}

/**
 * Mint the exposure for one request. Call it ONCE, before any serve path runs,
 * and hand the SAME object to the response stamping and to the serve log —
 * two clocks or two session ids mint two ids for one exposure, and the id the
 * client holds then joins to no row (census-discovery §34.2).
 */
export function mintServeExposure(
  userId: string | null,
  sessionId?: string | null,
  now: Date = new Date(),
): ServeExposure {
  return {
    userId:    userId && userId.length > 0 ? userId : null,
    sessionId: sessionId && sessionId.length > 0 ? sessionId : randomUUID(),
    servedAt:  now.toISOString(),
  };
}

/**
 * The canonical spelling of a serve instant.
 *
 * WHY THIS EXISTS: PostgREST reads `timestamptz` back as
 * `2026-09-27T10:00:00.123+00:00`, while the writer minted
 * `2026-09-27T10:00:00.123Z`. Same instant, different string — and the id is a
 * digest of the string. A reader re-deriving an id from a row it READ must
 * canonicalise first or it derives an id that matches nothing. A value that is
 * not a parseable instant is returned unchanged (the derivation stays total).
 */
export function canonicalServedAt(servedAt: string): string {
  const ms = Date.parse(servedAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : servedAt;
}

/** The viewer coordinate the id is derived over. */
export function viewerKeyFor(userId: string | null | undefined): string {
  return typeof userId === "string" && userId.length > 0 ? userId : ANONYMOUS_VIEWER_KEY;
}

/**
 * The recommendation id of ONE served item: the exposure at `position`.
 *
 * For a signed-in viewer this is byte-identical to `recommendationIdFor` over
 * the same coordinates — every token already in `rank_events` stays valid.
 */
export function servedRecommendationId(e: ServeExposure, position: number, itemId: string): string {
  return recommendationIdFor({
    userId:    viewerKeyFor(e.userId),
    sessionId: e.sessionId,
    servedAt:  canonicalServedAt(e.servedAt),
    surface:   DISCOVERY_RECOMMENDATION_SURFACE,
    position,
    itemId,
  });
}

/** Domain separation for the per-request id, so it can never equal an item id. */
const SERVE_DOMAIN = "portava:discovery:serve:v1";

/**
 * The per-REQUEST id — `10` §3's `recommendations.id` (DV-06).
 *
 * Deterministic over the exposure, for the same reason the item id is: a
 * retried per-request write must collide with itself (`ON CONFLICT (id) DO
 * NOTHING`) rather than mint a second request. Same shape as an item id
 * (22 base64url chars), different domain, so the two can never coincide.
 */
export function serveIdFor(e: ServeExposure): string {
  const canonical = JSON.stringify([
    SERVE_DOMAIN,
    viewerKeyFor(e.userId),
    String(e.sessionId ?? ""),
    canonicalServedAt(String(e.servedAt ?? "")),
    DISCOVERY_RECOMMENDATION_SURFACE,
  ]);
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

/**
 * THE STAMPING FUNCTION. Every served item gets `recommendationId`, anonymous
 * serves included, at the index it is served at.
 *
 * `offset` is the position of `items[0]` in the flattened served list — for a
 * route that serves two lists in one response (the feed's places, then its
 * posts) the second list is stamped with `offset = first.length`, which is the
 * position the serve log writes for it. Order-preserving and additive: one new
 * key, nothing removed, input not mutated.
 */
export function stampServedRecommendations<T extends { id: string }>(
  items: readonly T[],
  e: ServeExposure,
  offset = 0,
): Array<T & { recommendationId: string }> {
  return items.map((item, i) => ({
    ...item,
    recommendationId: servedRecommendationId(e, offset + i, String(item.id)),
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. The record — `04` §5's nine fields, plus what makes it a denominator
// ═════════════════════════════════════════════════════════════════════════════

/** `rank_events.item_kind`'s vocabulary (0153), or null for a kind it has no word for. */
export type RecommendationCandidateType = "post" | "event" | "plan" | "buddy" | "place" | "gem";

/**
 * One served Discovery recommendation.
 *
 * The first nine fields are `04` §5's minimum record, in the specification's
 * order (`candidate_type/id` is two fields here because it is two values). The
 * last four are what the record needs to BE a denominator and to be trusted:
 * the request it belongs to and that request's size (DV-06), and the schema
 * version and privacy class it was written under (DV-38, DV-39).
 */
export interface DiscoveryRecommendationRecord {
  recommendation_id: string;
  /** NULL ⇔ an anonymous serve. Never a sentinel string. */
  user_id:           string | null;
  session_id:        string;
  candidate_type:    RecommendationCandidateType | null;
  candidate_id:      string;
  surface:           typeof DISCOVERY_RECOMMENDATION_SURFACE;
  rank_position:     number;
  model_version:     string;
  reason_codes:      readonly string[];
  served_at:         string;

  serve_id:          string;
  /** How many items the REQUEST served — the per-request denominator (DV-06). */
  served_count:      number;
  schema_version:    number;
  privacy_class:     string;
}

/** Build every served item's record for one serve. Pure; the ids equal the stamped ones. */
export function recommendationRecordsFor(
  e: ServeExposure,
  items: ReadonlyArray<{ id: string; kind?: RecommendationCandidateType | null }>,
  opts: { modelVersion?: string; reasonCodesById?: Readonly<Record<string, readonly string[]>> } = {},
): DiscoveryRecommendationRecord[] {
  const serveId = serveIdFor(e);
  return items.map((item, position) => ({
    recommendation_id: servedRecommendationId(e, position, String(item.id)),
    user_id:           e.userId,
    session_id:        e.sessionId,
    candidate_type:    item.kind ?? null,
    candidate_id:      String(item.id),
    surface:           DISCOVERY_RECOMMENDATION_SURFACE,
    rank_position:     position,
    model_version:     opts.modelVersion ?? DISCOVERY_MODEL_VERSION,
    reason_codes:      opts.reasonCodesById?.[item.id] ?? [],
    served_at:         canonicalServedAt(e.servedAt),
    serve_id:          serveId,
    served_count:      items.length,
    schema_version:    DISCOVERY_EVENT_SCHEMA_VERSION,
    privacy_class:     DISCOVERY_EVENT_PRIVACY_CLASS,
  }));
}

/**
 * Recover the record from a `rank_events` row as READ back (columns + features).
 *
 * Returns null for a row that is not a Discovery exposure or carries no usable
 * id. The id is taken from the column, then `features.recommendationId`; it is
 * never re-derived here, because a record that cannot name its own id is not
 * the record `04` §5 asks for.
 */
export function recommendationRecordFromRankEventsRow(
  row: Record<string, unknown> | null | undefined,
): DiscoveryRecommendationRecord | null {
  if (!row || row["surface"] !== DISCOVERY_RECOMMENDATION_SURFACE) return null;
  const f = (row["features"] ?? {}) as Record<string, unknown>;
  const col = row["recommendation_id"];
  const rid = typeof col === "string" && RECOMMENDATION_ID_SHAPE.test(col) ? col
    : typeof f["recommendationId"] === "string" && RECOMMENDATION_ID_SHAPE.test(f["recommendationId"] as string)
      ? (f["recommendationId"] as string) : null;
  if (!rid) return null;
  const kind = row["item_kind"];
  return {
    recommendation_id: rid,
    user_id:           typeof row["user_id"] === "string" ? (row["user_id"] as string) : null,
    session_id:        String(row["session_id"] ?? ""),
    candidate_type:    typeof kind === "string" ? (kind as RecommendationCandidateType) : null,
    candidate_id:      String(row["item_id"] ?? ""),
    surface:           DISCOVERY_RECOMMENDATION_SURFACE,
    rank_position:     typeof row["position"] === "number" ? (row["position"] as number) : -1,
    model_version:     typeof f["modelVersion"] === "string" ? (f["modelVersion"] as string) : "",
    reason_codes:      Array.isArray(f["reasonCodes"]) ? (f["reasonCodes"] as string[]) : [],
    served_at:         canonicalServedAt(String(row["served_at"] ?? "")),
    serve_id:          typeof f["serveId"] === "string" ? (f["serveId"] as string) : "",
    served_count:      typeof f["servedCount"] === "number" ? (f["servedCount"] as number) : -1,
    schema_version:    typeof row["schema_version"] === "number" ? (row["schema_version"] as number)
      : typeof f["schemaVersion"] === "number" ? (f["schemaVersion"] as number) : -1,
    privacy_class:     typeof row["privacy_class"] === "string" ? (row["privacy_class"] as string)
      : typeof f["privacyClass"] === "string" ? (f["privacyClass"] as string) : "",
  };
}

/**
 * Recover every item's record from ONE per-request row (`public.recommendations`)
 * — the only durable record an anonymous serve has. `user_id` is null there and
 * stays null here; the ids are re-derived under the anonymous viewer key, which
 * is exactly what the response carried.
 */
export function recommendationRecordsFromServeRequest(
  row: Record<string, unknown> | null | undefined,
): DiscoveryRecommendationRecord[] {
  if (!row) return [];
  const ids = Array.isArray(row["item_ids"]) ? (row["item_ids"] as unknown[]).map(String) : [];
  const kinds = Array.isArray(row["item_kinds"]) ? (row["item_kinds"] as unknown[]) : [];
  const e: ServeExposure = {
    userId:    typeof row["user_id"] === "string" ? (row["user_id"] as string) : null,
    sessionId: String(row["session_id"] ?? ""),
    servedAt:  canonicalServedAt(String(row["served_at"] ?? "")),
  };
  return recommendationRecordsFor(
    e,
    ids.map((id, i) => ({ id, kind: typeof kinds[i] === "string" && kinds[i] !== "" ? (kinds[i] as RecommendationCandidateType) : null })),
    { modelVersion: typeof row["model_version"] === "string" ? (row["model_version"] as string) : DISCOVERY_MODEL_VERSION },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Propagation — served item → client outcome event → `rank_events`
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The propagation rules, as data, so a test can hold the code to them.
 *
 * Each hop names who carries the id and what happens when it is wrong. The
 * client half (hop 3) is the client package's to wire; the server accepts the
 * field today and binds it (hop 4) whether or not any client sends it yet.
 */
export const RECOMMENDATION_PROPAGATION_RULES = [
  { hop: 1, from: "serve", to: "response",
    rule: "every served item carries `recommendationId` from stampServedRecommendations over the ONE exposure minted for the request; anonymous serves included" },
  { hop: 2, from: "serve", to: "store",
    rule: "signed-in: one rank_events impression row per item, recommendation_id column + features.recommendationId equal to the stamped id, features.serveId + features.servedCount; every serve (signed-in or anonymous): one public.recommendations row per request. Anonymous: NO rank_events row" },
  { hop: 3, from: "response", to: "client outcome event",
    rule: "the client echoes the item's `recommendationId` as `recommendation_id` in POST /rank-events/outcome" },
  { hop: 4, from: "client outcome event", to: "binding",
    rule: "bound by (signed-in caller, recommendation_id) only: another viewer's id, an anonymous id, a stale id or an unknown id binds nothing and credits nothing (404); an id naming a different item or surface is refused (409)" },
  { hop: 5, from: "binding", to: "store",
    rule: "the funnel UPDATE is compare-and-set on the row's current outcome and writes the same recommendation_id; the analytics row is upserted on (recommendation_id, outcome='analytics'); a replay of an outcome already recorded is answered 200 duplicate and moves no counter" },
] as const;

/** What an outcome event's recommendation id bound to — or why it bound to nothing. */
export type OutcomeBinding =
  | { kind: "bound";          rowId: string }
  /** Recorded already: answer 200, move no counter a second time. */
  | { kind: "duplicate";      rowId: string }
  /** Not this caller's, not a known id, or an anonymous one. Never says which. */
  | { kind: "not_found" }
  /** The id names a different item or surface than the event claims. */
  | { kind: "mismatch";       field: "item_id" | "surface" }
  /** The exposure already moved past (or away from) this outcome: stale. */
  | { kind: "not_upgradable"; current: string };

/**
 * Bind an outcome event to the exposure its `recommendation_id` names.
 *
 * `row` is what a query filtered on (user_id = caller, recommendation_id = id)
 * returned — so a cross-viewer replay arrives here as `null`. The owner is
 * checked AGAIN here anyway: a lookup that lost its user filter must not become
 * a way to credit somebody else's exposure.
 */
export function bindOutcomeToExposure(input: {
  callerUserId: string;
  body: { item_id: string; surface: string; outcome: string };
  row: { id?: unknown; user_id?: unknown; item_id?: unknown; surface?: unknown; outcome?: unknown } | null | undefined;
  upgradable: readonly string[];
}): OutcomeBinding {
  const { callerUserId, body, row, upgradable } = input;
  if (!row || typeof row.id !== "string" || row.id.length === 0) return { kind: "not_found" };
  if (row.user_id !== undefined && row.user_id !== callerUserId) return { kind: "not_found" };
  if (row.item_id !== undefined && String(row.item_id) !== body.item_id) return { kind: "mismatch", field: "item_id" };
  if (row.surface !== undefined && String(row.surface) !== body.surface) return { kind: "mismatch", field: "surface" };
  const current = String(row.outcome ?? "");
  if (current === body.outcome) return { kind: "duplicate", rowId: row.id };
  if (!upgradable.includes(current)) return { kind: "not_upgradable", current };
  return { kind: "bound", rowId: row.id };
}

/** Is this a well-formed recommendation id (2891's shape CHECK)? */
export function isRecommendationId(v: unknown): v is string {
  return typeof v === "string" && RECOMMENDATION_ID_SHAPE.test(v);
}

/** 2891's unique index — the arbiter a replayed exposure collides on. */
export const EXPOSURE_ARBITER_INDEX = "rank_events_recommendation_idempotency_idx";

/**
 * Is this insert error a REPLAY of an exposure already written — a 23505 on
 * 2891's (recommendation_id, outcome) index?
 *
 * DV-37: the serve-log writers insert with no ON CONFLICT clause, so a replayed
 * batch is refused WHOLE by the unique index and writes nothing. That refusal is
 * the idempotency guarantee working, not a rejected write: it must not be
 * counted as one, and it must not move the exposure denominator a second time.
 * A 23505 on any OTHER constraint is not this and keeps its treatment.
 */
export function isDuplicateExposureReplay(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  if (String(e?.code ?? "") !== "23505") return false;
  const text = `${String(e?.message ?? "")} ${String(e?.details ?? "")}`;
  return text.includes(EXPOSURE_ARBITER_INDEX) || /\(recommendation_id,\s*outcome\)/.test(text);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Versioning — `04` §3 "versioned" (DV-38)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The event-record shape this tree writes. Mirrors
 * `lib/discoveryServeLog.ts`'s `DISCOVERY_EVENT_SCHEMA_VERSION` (which is cited
 * by line elsewhere and so stays where it is); a test pins that the two agree.
 * Migration 3375 constrains `rank_events.schema_version` to the same set, so a
 * bump here without a migration is refused by the database, not merely unread.
 */
export const DISCOVERY_EVENT_SCHEMA_VERSION = 1 as const;

/** Every version this tree can read AND write. The database admits exactly these (3375). */
export const SUPPORTED_EVENT_SCHEMA_VERSIONS: readonly number[] = [1];

export type SchemaVersionCheck =
  | { ok: true;  version: number; defaulted: boolean }
  | { ok: false; reason: string };

/**
 * Accept or refuse a client event's declared schema version.
 *
 * Absent ⇒ the current version, `defaulted: true` — every client that exists
 * today predates the field, and refusing them would be an outage, not a check.
 * Present and unknown ⇒ REFUSED: a record whose shape this server cannot read
 * must not be stored as though it could.
 */
export function checkEventSchemaVersion(v: unknown): SchemaVersionCheck {
  if (v === undefined || v === null) return { ok: true, version: DISCOVERY_EVENT_SCHEMA_VERSION, defaulted: true };
  if (typeof v !== "number" || !Number.isInteger(v)) {
    return { ok: false, reason: "schema_version must be an integer" };
  }
  if (!SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(v)) {
    return { ok: false, reason: `unsupported schema_version ${v}; this server accepts ${SUPPORTED_EVENT_SCHEMA_VERSIONS.join(", ")}` };
  }
  return { ok: true, version: v, defaulted: false };
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Privacy classification — `04` §3 "privacy-classified", `04` §12 (DV-39)
// ═════════════════════════════════════════════════════════════════════════════

/** The ROW's class — `rank_events.privacy_class` (2890's CHECK vocabulary). */
export const DISCOVERY_EVENT_PRIVACY_CLASS = "raw_behavioral_event" as const;

/**
 * The FIELD classes. Every column and every `features` key a Discovery writer
 * stores belongs to exactly one. `precise_location` is the class that is never
 * stored (`04` §12): it is listed so the refusal can name what it refused.
 */
export type TelemetryFieldClass =
  | "person_pseudonym"        // a user or session id: identifies a person or one visit
  | "exposure_token"          // an opaque id derived from an exposure
  | "public_content_ref"      // an id or kind of public content (a place, a post)
  | "exposure_coordinate"     // where/when/how an item was served
  | "behavioral_outcome"      // what the viewer did
  | "coarse_request_context"  // a city, a category, a radius, a filter — never a position
  | "derived_ranking_signal"  // a ranker's output about an item
  | "record_metadata"         // shape, class and provenance of the row itself
  | "precise_location";       // NEVER STORED

/** Every `rank_events` column, classified. A column not here is unclassified. */
export const RANK_EVENTS_COLUMN_CLASSES: Readonly<Record<string, TelemetryFieldClass>> = {
  id:                "record_metadata",
  user_id:           "person_pseudonym",
  session_id:        "person_pseudonym",
  item_id:           "public_content_ref",
  item_kind:         "public_content_ref",
  content_type:      "public_content_ref",
  position:          "exposure_coordinate",
  served_at:         "exposure_coordinate",
  surface:           "exposure_coordinate",
  outcome:           "behavioral_outcome",
  outcome_at:        "behavioral_outcome",
  event_type:        "behavioral_outcome",
  dwell_ms:          "behavioral_outcome",
  dwell_kind:        "behavioral_outcome",
  features:          "record_metadata",
  recommendation_id: "exposure_token",
  schema_version:    "record_metadata",
  privacy_class:     "record_metadata",
  retention_tier:    "record_metadata",
};

/**
 * Every `features` key a Discovery writer may store, classified.
 *
 * Three sources, and a key from any of them that is NOT here is refused before
 * insert: the record's own keys (written by the writers), the context keys the
 * ten serve-point callers pass, and the ranker's feature vector
 * (`lib/portavaRank.ts` scoreCandidate). A new ranker feature or a new context
 * key must be classified HERE before it can be stored — a test enumerates the
 * ranker's keys and fails when one is missing, so the refusal is not a silent
 * data loss waiting to happen.
 */
export const DISCOVERY_FEATURE_KEY_CLASSES: Readonly<Record<string, TelemetryFieldClass>> = {
  // the record's own keys
  servePoint:       "exposure_coordinate",
  route:            "exposure_coordinate",
  rankedInRequest:  "exposure_coordinate",
  servedCount:      "exposure_coordinate",
  serveId:          "exposure_token",
  recommendationId: "exposure_token",
  modelVersion:     "record_metadata",
  reasonCodes:      "derived_ranking_signal",
  schemaVersion:    "record_metadata",
  privacyClass:     "record_metadata",
  privacyDropped:   "record_metadata",
  privacyRefused:   "record_metadata",
  // serve-point context — coarse by construction; every caller is listed
  destination:      "coarse_request_context",
  category:         "coarse_request_context",
  categories:       "coarse_request_context",
  cacheLevel:       "exposure_coordinate",
  engineMode:       "exposure_coordinate",
  modeReason:       "exposure_coordinate",
  offset:           "exposure_coordinate",
  city:             "coarse_request_context",
  neighborhood:     "coarse_request_context",
  ageFilter:        "coarse_request_context",
  radiusKm:         "coarse_request_context",
  type:             "coarse_request_context",
  hasQuery:         "coarse_request_context",
  resultCount:      "exposure_coordinate",
  groupCount:       "exposure_coordinate",
  layoverSafe:      "coarse_request_context",
  // the ranker's feature vector (lib/portavaRank.ts scoreCandidate) — every
  // value is a weighted contribution in [≈-1, ≈1], never a raw input
  recency:           "derived_ranking_signal",
  followedAuthor:    "derived_ranking_signal",
  mutualAuthor:      "derived_ranking_signal",
  engagedAuthor:     "derived_ranking_signal",
  interestTag:       "derived_ranking_signal",
  categoryAffinity:  "derived_ranking_signal",
  cityMatch:         "derived_ranking_signal",
  neighborhoodMatch: "derived_ranking_signal",
  distance:          "derived_ranking_signal",
  actionability:     "derived_ranking_signal",
  availabilityFit:   "derived_ranking_signal",
  socialProof:       "derived_ranking_signal",
  trust:             "derived_ranking_signal",
  verifiedBonus:     "derived_ranking_signal",
  capacityOpen:      "derived_ranking_signal",
  seenPenalty:       "derived_ranking_signal",
  kindPrior:         "derived_ranking_signal",
  localMomentum:     "derived_ranking_signal",
  trailAffinity:     "derived_ranking_signal",
  officialPublisher: "derived_ranking_signal",
  placeEngagement:   "derived_ranking_signal",
};

/**
 * Keys that are a position whatever else is true (`04` §12, spec §8). Refused
 * as `precise_location` even if a caller also classified them.
 */
const PRECISE_LOCATION_KEYS = new Set([
  "lat", "lng", "latitude", "longitude", "distancekm", "coords", "coordinates",
  "geo", "gps", "position", "point", "bbox",
]);
const PRECISE_LOCATION_SUFFIXES = ["lat", "lng", "latitude", "longitude"];

/** The class of one `features` key, or null when it is unclassified. */
export function featureKeyClass(key: string): TelemetryFieldClass | null {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (PRECISE_LOCATION_KEYS.has(norm) || PRECISE_LOCATION_SUFFIXES.some((s) => norm.endsWith(s))) {
    return "precise_location";
  }
  return Object.prototype.hasOwnProperty.call(DISCOVERY_FEATURE_KEY_CLASSES, key)
    ? DISCOVERY_FEATURE_KEY_CLASSES[key]!
    : null;
}

export interface ScreenedFeatures<V> {
  /** What may be stored: every key classified, none of them a position. */
  kept:    Record<string, V>;
  /** Refused: unclassified keys and precise-location keys. NAMES only, never values. */
  refused: string[];
}

/**
 * THE STORAGE SCREEN. Keep a `features` key only if it is classified and is
 * not a position; refuse everything else, by name.
 *
 * Pure and total. The writer that calls it logs the refused names (never the
 * values — those are the thing being withheld) and stores `privacyRefused` on
 * the row so a refusal is visible in the data, not only in a log line.
 */
export function screenFeaturesForStorage<V>(features: Readonly<Record<string, V>> | null | undefined): ScreenedFeatures<V> {
  const kept: Record<string, V> = {};
  const refused: string[] = [];
  if (!features) return { kept, refused };
  for (const [k, v] of Object.entries(features)) {
    const cls = featureKeyClass(k);
    if (cls === null || cls === "precise_location") refused.push(k);
    else kept[k] = v;
  }
  return { kept, refused };
}

/** Columns of a row that no class covers. A writer's row literal must return []. */
export function unclassifiedColumns(row: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(row).filter((c) => !Object.prototype.hasOwnProperty.call(RANK_EVENTS_COLUMN_CLASSES, c));
}
