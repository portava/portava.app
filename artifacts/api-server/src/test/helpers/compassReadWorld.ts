/**
 * census-discovery §107 (DV-83 round 10, lane W11-X2): the fake world the round-9 verifier's
 * probes ran over (scratchpad v9-probes/zz-v9-compassHomeTelegraphConfidence), shared by the
 * round-10 suites for GET /compass/home, GET /compass/telegraph and GET /compass/city-confidence.
 *
 * supabase-js RESOLVES a failed read as `{ data: null, error }`, so a failing table answers
 * exactly that. `answer` lets a case answer one read by its filters (every builder call is
 * recorded in `calls`), which is how a case fails the SECOND read of a table and not the first.
 */
export const VIEWER = "ab000000-0000-4000-a000-000000000099";
export const TOKEN = "tok-r10-compass";
export const THREAD = "cd000000-0000-4000-a000-000000000001";
export const EVENT_ID = "ee000000-0000-4000-a000-000000000001";
export const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };
/** The five candidate tables CompassItemHydrator reads. */
export const CANDIDATE_SOURCES = ["posts", "rent_buddy_profiles", "events", "discovery_places", "hidden_gems"];

export type Call = [method: string, args: unknown[]];
export interface WorldOpts {
  failTables?: string[];
  /** The COMPASS_% bulk flag read fails. */
  flagsFail?: boolean;
  /** Flags the bulk read returns (default: Compass, rule-based and Telegraph ON). */
  flags?: Record<string, boolean>;
  city?: string | null;
  /** Answer one read before the defaults; `undefined` falls through. */
  answer?: (table: string, calls: Call[], single: boolean) => { data: unknown; error: unknown } | undefined;
}

export function compassWorld(opts: WorldOpts = {}) {
  const fail = new Set(opts.failTables ?? []);
  const readsSeen: string[] = [];
  const flags = opts.flags ?? { COMPASS_ENABLED: true, COMPASS_V1_RULE_BASED_ENABLED: true, COMPASS_TELEGRAPH: true };
  function builder(table: string) {
    const calls: Call[] = [];
    const has = (m: string) => calls.some(([k]) => k === m);
    const arg0 = (m: string) => calls.find(([k]) => k === m)?.[1][0];
    const answer = (single: boolean): { data: unknown; error: unknown } => {
      if (table === "feature_flags" && has("like")) {
        if (opts.flagsFail) return { data: null, error: DB_ERR };
        return { data: Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled })), error: null };
      }
      if (table === "profiles" && arg0("select") === "account_status") return { data: { account_status: "active" }, error: null };
      if (table !== "feature_flags") readsSeen.push(table);
      const custom = opts.answer?.(table, calls, single);
      if (custom) return custom;
      if (table === "feature_flags") return { data: null, error: null };
      if (fail.has(table)) return { data: null, error: DB_ERR };
      if (table === "user_location_state") return { data: opts.city === null ? null : { city: opts.city ?? "Paris", country: "FR" }, error: null };
      if (table === "message_thread_members") return single ? { data: { user_id: VIEWER }, error: null } : { data: [{ user_id: VIEWER }], error: null };
      if (table === "discovery_places") return { data: [{ id: "11111111-1111-4111-a111-111111111111", city: "Paris", name: "Le Place", category: "food", status: "active", rating: 4, created_at: new Date().toISOString(), submitted_by: null, lat: 48.85, lng: 2.35 }], error: null };
      if (table === "events" && String(arg0("select") ?? "").includes("going_count")) {
        return { data: [{ id: EVENT_ID, host_id: "ff000000-0000-4000-a000-000000000001", title: "Jazz night", category: "music", starts_at: new Date(Date.now() + 86_400_000).toISOString(), ends_at: null, city: "Paris", max_attendees: 50, going_count: 3, visibility: "public", state: "open", location_lat: 48.85, location_lng: 2.35, location_name: "Club", cover_url: null, show_exact_location: true }], error: null };
      }
      return { data: single ? null : [], error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer(true));
        return (...args: unknown[]) => { calls.push([prop, args]); return b; };
      },
    });
    return b;
  }
  return {
    readsSeen,
    client: {
      auth: { getUser: async (tok: string) => (tok === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
      from: (table: string) => builder(table),
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
  };
}

/** The filter value a recorded call chain applied with `eq(column, value)`. */
export function eqValue(calls: Call[], column: string): unknown {
  return calls.find(([k, a]) => k === "eq" && a[0] === column)?.[1][1];
}
