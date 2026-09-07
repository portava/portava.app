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
 */

type Row = Record<string, any>;

export interface FakeLayoverDbOptions {
  failures?: Record<string, { message: string }>;
  /** Bearer token → user id map for auth.getUser. */
  users?: Record<string, string>;
}

export function makeLayoverDb(tables: Record<string, Row[]>, opts: FakeLayoverDbOptions = {}) {
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

    const builder: any = {
      select() { return builder; },
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
      maybeSingle() { return Promise.resolve(resolve(true)); },
      single() { return Promise.resolve(resolve(true)); },
      then(onF: any, onR: any) { return Promise.resolve(resolve(false)).then(onF, onR); },
    };

    const matches = (r: Row) => filters.every((f) => f(r));
    const newId = () => `fake-${Math.random().toString(36).slice(2, 10)}`;

    function resolve(single: boolean): { data: any; error: any } {
      const failure = failures[`${table}:${op}`];
      if (failure) return { data: null, error: { message: failure.message } };

      if (op === "delete") {
        const gone = store.filter(matches);
        for (const g of gone) store.splice(store.indexOf(g), 1);
        return { data: single ? (gone[0] ?? null) : gone, error: null };
      }
      if (op === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const out: Row[] = [];
        for (const r of rows) {
          const row = { id: newId(), created_at: new Date().toISOString(), ...r };
          store.push(row); out.push(row);
        }
        return { data: single ? (out[0] ?? null) : out, error: null };
      }
      if (op === "upsert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const out: Row[] = [];
        for (const r of rows) {
          const keyCols = onConflict!;
          const hit = store.find((s) => keyCols.every((k) => r[k] != null && s[k] === r[k]));
          if (hit) { Object.assign(hit, r); out.push(hit); }
          else { const row = { id: newId(), created_at: new Date().toISOString(), ...r }; store.push(row); out.push(row); }
        }
        return { data: single ? (out[0] ?? null) : out, error: null };
      }
      if (op === "update") {
        const out: Row[] = [];
        for (const r of store) if (matches(r)) { Object.assign(r, payload); out.push(r); }
        return { data: single ? (out[0] ?? null) : out, error: null };
      }
      let rows = store.filter(matches);
      if (order) {
        const { col, asc } = order;
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }

    return builder;
  }

  return {
    from,
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
