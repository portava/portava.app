/**
 * Metric resolvers — Stamp Wave 3 criteria engine.
 *
 * A metric is a named quantity the criteria evaluator can compare against.
 * Two kinds:
 *
 *   DB metrics    — resolved by querying real tables for the user's current
 *                   value (e.g. trips_completed, followers_count). Every query
 *                   here matches a verified column (see the Wave 3 audit notes).
 *   Context metrics — supplied by the caller at evaluation time from the
 *                   triggering event (e.g. is_solo_trip, trip_member_count),
 *                   because they describe THIS action, not an aggregate.
 *
 * A resolver returns a number (booleans as 0/1). Any query error resolves to 0
 * (fail-closed: a metric that can't be read never satisfies a threshold).
 *
 * The registry is the single source of truth for which metrics exist; the
 * evaluator rejects criteria referencing anything not registered.
 */

export interface EvalContext {
  /** Metrics supplied by the trigger site (override/augment DB metrics). */
  context?: Record<string, number | boolean>;
}

export type MetricResolver = (sc: any, userId: string, ctx: EvalContext) => Promise<number>;

/**
 * Head-count helper.
 *
 * ⚠ The select list MUST stay `"*"`, never a named column. PostgREST validates
 * the select list against the table even for a `head: true` count, so naming a
 * column the table does not have fails the WHOLE query (42703) and the
 * `if (error) return 0` below turns that into a silent zero.
 *
 * This is not hypothetical: `select("id")` was the shape here, and two of the
 * four tables counted through this helper have no `id` column at all —
 * `user_follows` (follower_id, following_id, created_at) and `event_rsvps`
 * (event_id, user_id, status, created_at) are both composite-key tables. That
 * made `following_count`, `followers_count` and `events_joined` permanently 0
 * for every user, so the follower-milestone stamps seeded by migration 0179 and
 * every event-category stamp activated by 0180 could never be awarded.
 * `user_follows.id` is independently recorded as verified-missing-in-production
 * on the repo's own dead-reference ratchet (checkSchemaReferences.ts).
 *
 * `"*"` is valid on every table, so the count is the only thing PostgREST has
 * to resolve. Guarded by stampCriteriaSchemaTruth.test.ts.
 */
async function countRows(sc: any, table: string, filters: Array<[string, any]>): Promise<number> {
  try {
    let q = sc.from(table).select("*", { count: "exact", head: true });
    for (const [k, v] of filters) q = q.eq(k, v);
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/** Distinct non-null values of a column for the user's non-revoked stamps. */
async function distinctStampField(sc: any, userId: string, field: string): Promise<number> {
  try {
    const { data, error } = await sc
      .from("user_stamps")
      .select(field)
      .eq("user_id", userId)
      .eq("is_revoked", false);
    if (error || !Array.isArray(data)) return 0;
    const set = new Set<string>();
    for (const row of data as any[]) {
      const v = row[field];
      if (typeof v === "string" && v.trim()) set.add(v.trim().toLowerCase());
    }
    return set.size;
  } catch {
    return 0;
  }
}

// ── DB metric registry ───────────────────────────────────────────────────────

const DB_METRICS: Record<string, MetricResolver> = {
  // Social graph (user_follows: follower_id follows following_id)
  following_count: (sc, u) => countRows(sc, "user_follows", [["follower_id", u]]),
  followers_count: (sc, u) => countRows(sc, "user_follows", [["following_id", u]]),

  // Trips (owner_id; status='completed')
  trips_created:   (sc, u) => countRows(sc, "trips", [["owner_id", u]]),
  trips_completed: (sc, u) => countRows(sc, "trips", [["owner_id", u], ["status", "completed"]]),

  // Events (host_id; event_rsvps user_id + status='going')
  events_hosted: (sc, u) => countRows(sc, "events", [["host_id", u]]),
  events_joined: (sc, u) => countRows(sc, "event_rsvps", [["user_id", u], ["status", "going"]]),

  // Content (posts.author_id — the table has NO user_id column; filtering on a
  // column that does not exist fails the whole query, so this metric was 0 for
  // every user)
  posts_count: (sc, u) => countRows(sc, "posts", [["author_id", u]]),

  // Passport aggregates (non-revoked user_stamps)
  stamps_earned:     (sc, u) => countRows(sc, "user_stamps", [["user_id", u], ["is_revoked", false]]),
  cities_visited:    (sc, u) => distinctStampField(sc, u, "city"),
  countries_visited: (sc, u) => distinctStampField(sc, u, "country"),
};

/** Metric names that must be provided via context (not queryable aggregates). */
export const CONTEXT_ONLY_METRICS = new Set<string>([
  "trip_member_count",   // members on the triggering trip
  "is_solo_trip",        // 1 when the trip had exactly one member
  "is_international",     // 1 when the trip crossed a border
  "event_category_food", // 1 when the triggering event is a food event
  "event_category_music",
  "event_category_outdoor",
]);

export function isKnownMetric(name: string): boolean {
  return name in DB_METRICS || CONTEXT_ONLY_METRICS.has(name);
}

export function knownMetricNames(): string[] {
  return [...Object.keys(DB_METRICS), ...CONTEXT_ONLY_METRICS];
}

/**
 * Resolve a single metric. Context wins over DB (the trigger site knows the
 * ground truth of THIS action). Booleans coerce to 0/1. Context-only metrics
 * missing from context resolve to 0 (fail-closed).
 */
export async function resolveMetric(
  sc: any,
  userId: string,
  name: string,
  ctx: EvalContext,
): Promise<number> {
  const provided = ctx.context?.[name];
  if (provided !== undefined) return typeof provided === "boolean" ? (provided ? 1 : 0) : Number(provided) || 0;
  const resolver = DB_METRICS[name];
  if (resolver) return resolver(sc, userId, ctx);
  return 0; // context-only metric not supplied, or unknown → fail-closed
}
