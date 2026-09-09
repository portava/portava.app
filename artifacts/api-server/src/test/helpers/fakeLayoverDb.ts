/**
 * fakeLayoverDb — an in-memory supabase-js query surface for the Layover route
 * and service tests. Table-backed, so a write in one call is visible to the
 * next read, which is what the recommendation-identity and session-edit tests
 * need to observe.
 *
 * Supports: .from(t).select(cols).insert(rows).upsert(rows,{onConflict})
 *           .update(patch).delete().eq/.neq/.in/.is/.gt/.gte/.lt/.lte/.ilike
 *           .or (no-op)/.not (no-op)/.order/.limit/.maybeSingle/.single
 *           and thenable list resolution; plus auth.getUser(token).
 *
 * Failure injection: `failures["<table>:<op>"] = { message }` makes that
 * table+op RESOLVE with `{ data: null, error }` — the way supabase-js reports a
 * PostgREST failure (it does not throw). op ∈ select|insert|upsert|update|delete.
 *
 * Every builder is created per `.from()` call, so concurrent awaits (the
 * dashboard fans out three reads) cannot share filter state.
*
 * ── CHECKED AGAINST THE REAL CLIENT ─────────────────────────────────────────
 * `src/test/supabaseContract.test.ts` runs this double and the REAL installed
 * supabase-js client through the same scenarios every CI run and fails if they
 * disagree anywhere not listed below. Do not "improve" this file by making a
 * scenario pass more loosely; change the scenario, or declare a gap here.
 *
 * MODELLED EXACTLY (measured, not assumed): thenable execution — a builder with
 * no `.then`/`await` performs NOTHING, one with either performs it once;
 * `.single()`/`.maybeSingle()` cardinality including the RESOLVED PGRST116 for
 * more than one row; failures arriving RESOLVED as `{ data: null, error }`,
 * never thrown; a write with no chained `.select()` returning `data: null`, so
 * affected rows are UNKNOWABLE without one; `count` null unless requested.
 *
 * NOT MODELLED — every entry below is enforced: the contract suite fails if the
 * behaviour silently starts agreeing, and fails if a listed operation stops
 * refusing:
 *
 *   insert/unique-violation-23505 — no unique index. A duplicate insert appends
 *     a second row instead of resolving 23505. Stage the error via
 *     `failures["<table>:insert"] = { code: "23505", message }` if a test needs
 *     that shape; this double cannot DISCOVER the collision.
 *   error/unknown-column-42703 — no schema knowledge. An unknown column reads as
 *     `undefined` instead of failing the whole statement. Use
 *     schemaStrictSupabase for that question.
 *   rls/denied-read-yields-zero-rows, rls/denied-write-yields-42501 — there is
 *     one table set and no service-vs-user distinction, so a denied read cannot
 *     be told from an empty one. Passing `role` THROWS rather than answering.
 *     Use failClosedSupabase (`role` + `rlsHiddenTables`/`rlsProtectedTables`).
 *   rpc/success, rpc/error-resolves, rpc/unknown-function — no rpc surface.
 *     `.rpc()` THROWS. A double that answers an unknown stored procedure with a
 *     plausible shape is precisely what let the dead writes through.
 */

type Row = Record<string, any>;

export interface FakeLayoverDbOptions {
  failures?: Record<string, { message: string; code?: string }>;
  /** Bearer token → user id map for auth.getUser. */
  users?: Record<string, string>;
  /**
   * Present only so that asking for RLS is LOUD. This double has one table set
   * and no policies; see NOT MODELLED above.
   */
  role?: "service" | "user";
}

export function makeLayoverDb(tables: Record<string, Row[]>, opts: FakeLayoverDbOptions = {}) {
  if (opts.role !== undefined) {
    throw new Error(
      "fakeLayoverDb does not model RLS: there is one table set and no service-vs-user distinction. " +
        "Use failClosedSupabase (role/rlsHiddenTables) for a role-sensitive read.",
    );
  }
  const failures = opts.failures ?? {};
  const users = opts.users ?? {};

  function from(table: string) {
    if (!tables[table]) tables[table] = [];
    const store = tables[table];
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null;
    let onConflict: string[] | null = null;

    let selected = false;
    let countMode: string | null = null;
    let headOnly = false;

    const builder: any = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) {
        selected = true;
        if (o?.count) countMode = String(o.count);
        if (o?.head) headOnly = true;
        return builder;
      },
      insert(rows: Row | Row[]) { op = "insert"; payload = rows; return builder; },
      upsert(rows: Row | Row[], o?: { onConflict?: string }) {
        op = "upsert"; payload = rows;
        onConflict = o?.onConflict ? o.onConflict.split(",").map((s) => s.trim()) : ["id"];
        return builder;
      },
      update(patch: Row) { op = "update"; payload = patch; return builder; },
      delete() { op = "delete"; return builder; },
      eq(col: string, v: any)  { filters.push((r) => r[col] === v); return builder; },
      neq(col: string, v: any) { filters.push((r) => r[col] !== v); return builder; },
      in(col: string, vs: any[]) { filters.push((r) => vs.includes(r[col])); return builder; },
      is(col: string, v: any)  { filters.push((r) => (r[col] ?? null) === v); return builder; },
      gt(col: string, v: any)  { filters.push((r) => r[col] > v);  return builder; },
      gte(col: string, v: any) { filters.push((r) => r[col] >= v); return builder; },
      lt(col: string, v: any)  { filters.push((r) => r[col] < v);  return builder; },
      lte(col: string, v: any) { filters.push((r) => r[col] <= v); return builder; },
      ilike(col: string, v: string) {
        const needle = String(v).replace(/%/g, "").toLowerCase();
        filters.push((r) => typeof r[col] === "string" && r[col].toLowerCase().includes(needle));
        return builder;
      },
      or() { return builder; },
      not() { return builder; },
      order(col: string, o: any = {}) { order = { col, asc: o.ascending !== false }; return builder; },
      limit(n: number) { limitN = n; return builder; },
      range() { return builder; },
      maybeSingle() { return Promise.resolve(resolve("maybeSingle")); },
      single() { return Promise.resolve(resolve("single")); },
      then(onF: any, onR: any) { return Promise.resolve(resolve("list")).then(onF, onR); },
    };

    const matches = (r: Row) => filters.every((f) => f(r));
    const newId = () => `fake-${Math.random().toString(36).slice(2, 10)}`;

    /** PostgREST's answer when `application/vnd.pgrst.object+json` sees != 1 row. */
    function pgrst116(n: number) {
      return {
        data: null,
        error: {
          code: "PGRST116",
          details: `Results contain ${n} rows, application/vnd.pgrst.object+json requires 1 row`,
          hint: null,
          message: "JSON object requested, multiple (or no) rows returned",
        },
      };
    }

    /** Shape a settled row set the way the wire would, given the terminal call. */
    function shape(rows: Row[], mode: "list" | "single" | "maybeSingle") {
      if (mode === "list") return { data: rows, error: null };
      if (rows.length > 1 || (mode === "single" && rows.length !== 1)) return pgrst116(rows.length);
      return { data: rows[0] ?? null, error: null };
    }

    function resolve(mode: "list" | "single" | "maybeSingle"): { data: any; error: any } {
      const failure = failures[`${table}:${op}`];
      if (failure) {
        return { data: null, error: failure.code ? { message: failure.message, code: failure.code } : { message: failure.message } };
      }

      if (op !== "select") {
        let out: Row[] = [];
        if (op === "delete") {
          out = store.filter(matches);
          for (const g of out) store.splice(store.indexOf(g), 1);
        } else if (op === "insert") {
          for (const r of Array.isArray(payload) ? payload : [payload]) {
            const row = { id: newId(), created_at: new Date().toISOString(), ...r };
            store.push(row); out.push(row);
          }
        } else if (op === "upsert") {
          for (const r of Array.isArray(payload) ? payload : [payload]) {
            const keyCols = onConflict!;
            const hit = store.find((s) => keyCols.every((k) => r[k] != null && s[k] === r[k]));
            if (hit) { Object.assign(hit, r); out.push(hit); }
            else { const row = { id: newId(), created_at: new Date().toISOString(), ...r }; store.push(row); out.push(row); }
          }
        } else {
          for (const r of store) if (matches(r)) { Object.assign(r, payload); out.push(r); }
        }
        // No chained `.select()` means PostgREST sent 201/204 with no body, so
        // there is nothing to count. See NOT MODELLED in the header.
        if (!selected) return { data: null, error: null };
        return shape(out, mode);
      }

      let rows = store.filter(matches);
      if (order) {
        const { col, asc } = order;
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      const total = rows.length;
      if (limitN !== null) rows = rows.slice(0, limitN);
      if (mode === "list") {
        // `count` mirrors PostgREST's Content-Range: null unless asked for.
        return { data: headOnly ? null : rows, error: null, count: countMode ? total : null } as any;
      }
      return shape(rows, mode);
    }

    return builder;
  }

  return {
    from,
    rpc(fn: string) {
      throw new Error(
        `fakeLayoverDb does not model rpc (called "${fn}"). A double that answers every rpc with a plausible ` +
          "shape is exactly what hid the dead writes; use fakeMapDb or failClosedSupabase, which take explicit handlers.",
      );
    },
    auth: {
      getUser: async (token: string) =>
        users[token]
          ? { data: { user: { id: users[token] } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  } as any;
}

/** A curated airport row shaped like `airport_profiles`. */
export function airportRow(over: Row = {}): Row {
  return {
    id: "airport-tpe", iata_code: "TPE", name: "Taiwan Taoyuan International Airport",
    city: "Taoyuan", country: "Taiwan", country_code: "TW", timezone: "Asia/Taipei",
    lat: 25.0797, lng: 121.2342,
    domestic_buffer_min: 60, domestic_buffer_max: 90,
    international_buffer_min: 120, international_buffer_max: 180,
    immigration_extra_min: 30, checked_bags_extra_min: 15, traffic_extra_min: 20,
    verified: false, ...over,
  };
}

/** A session row shaped like `layover_sessions`. Departure 8h from now by default. */
export function sessionRow(over: Row = {}): Row {
  const now = Date.now();
  return {
    id: "session-1", user_id: "user-1", airport_id: "airport-tpe", trip_id: null,
    arrival_time: new Date(now + 5 * 60_000).toISOString(),
    departure_time: new Date(now + 8 * 3_600_000).toISOString(),
    boarding_time: null, layover_minutes: 475,
    flight_type: "international", immigration_required: true, checked_bags: false,
    lounge_access: false, wants_to_leave: true, comfort_level: "moderate", vibe_chips: ["food"],
    manual_airport_name: null, manual_city: null, manual_country: null, manual_iata: null,
    canonical_city_id: null, share_city_status: false, return_reminder_at: null,
    status: "active", created_at: new Date(now - 60_000).toISOString(), updated_at: new Date(now - 60_000).toISOString(),
    ...over,
  };
}
