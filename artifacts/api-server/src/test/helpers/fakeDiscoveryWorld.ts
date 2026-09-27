/**
 * fakeDiscoveryWorld — one in-memory supabase-js stand-in for the Discovery
 * serve paths, shared by the census-discovery §47 suites
 * (discoveryCacheRevocation.test.ts, discoveryServePathIsolation.test.ts).
 *
 * WHY ANOTHER FAKE. The existing Discovery fakes each answer the tables their
 * own suite needed and resolve everything else to `[]`. That is exactly the
 * shape that lets an isolation test pass vacuously: a `user_mutes` read that
 * resolves `[]` because the fake ignored the table is indistinguishable from a
 * viewer who muted nobody. This world applies the filters a query ASKS for
 * (`eq`, `neq`, `in`, `not(col,'eq',v)`, `is(col,null)`, the `a.eq.x,b.eq.y`
 * form of `or`, `like` on flag names) over rows the test seeded, so a read that
 * forgets its viewer predicate returns someone else's rows and the test sees it.
 *
 * FAILURE IS SEEDED THE WAY SUPABASE-JS FAILS: a table in `errorTables`
 * RESOLVES `{ data: null, error }` — it does not reject — because that is the
 * shape every fail-open bug in this tree was written against.
 *
 * Every write (`insert`/`upsert`/`update`/`delete`/`rpc`) is RECORDED, never
 * applied, so a suite can assert which tables a path wrote to and with what.
 */

export interface WorldWrite { table: string; op: string; payload: unknown }

export interface WorldState {
  /** Bearer token → user id. */
  users: Record<string, string>;
  /** Table → rows. Mutated by tests between requests. */
  tables: Record<string, any[]>;
  /** Tables whose reads resolve with `{ data: null, error }`. */
  errorTables: Set<string>;
  /**
   * `table.method` pairs (e.g. `profiles.not`) whose query resolves with an
   * error — one READ SHAPE failing while the table's other reads succeed, which
   * is how a single policy read fails in a real outage of one index or grant.
   */
  errorOps: Set<string>;
  /** Every write attempted, in order. */
  writes: WorldWrite[];
  /** Every table read, in order — for "did this path consult X" assertions. */
  reads: string[];
}

export function newWorld(init: Partial<Pick<WorldState, "users" | "tables">> = {}): WorldState {
  return {
    users: { ...(init.users ?? {}) },
    tables: { ...(init.tables ?? {}) },
    errorTables: new Set<string>(),
    errorOps: new Set<string>(),
    writes: [],
    reads: [],
  };
}

type Pred = (r: any) => boolean;

function parseOr(expr: string): Pred | null {
  // Only the `col.eq.value,col2.eq.value2` form is interpreted (fetchBlockedSet
  // uses it). Any other term — ilike, is.null, not.in.(…) — makes the whole
  // expression pass through, which is what the city/source `or()` filters on
  // discovery_places need in a world that seeds only in-city, non-demo rows.
  const terms = expr.split(",").map((t) => t.trim()).filter(Boolean);
  const parsed: Array<[string, string]> = [];
  for (const t of terms) {
    const m = /^([a-z_]+)\.eq\.(.+)$/.exec(t);
    if (!m) return null;
    parsed.push([m[1]!, m[2]!]);
  }
  return (r) => parsed.some(([c, v]) => String(r[c]) === v);
}

export function worldClient(world: WorldState): any {
  function from(table: string) {
    const preds: Pred[] = [];
    let limitN: number | null = null;
    let write: { op: string; payload: unknown } | null = null;
    let opFailed = false;
    const mark = (m: string) => { if (world.errorOps.has(`${table}.${m}`)) opFailed = true; };

    const b: any = {
      select() { mark("select"); return b; },
      insert(p: unknown) { write = { op: "insert", payload: p }; world.writes.push({ table, op: "insert", payload: p }); return b; },
      upsert(p: unknown) { write = { op: "upsert", payload: p }; world.writes.push({ table, op: "upsert", payload: p }); return b; },
      update(p: unknown) { write = { op: "update", payload: p }; world.writes.push({ table, op: "update", payload: p }); return b; },
      delete() { write = { op: "delete", payload: null }; world.writes.push({ table, op: "delete", payload: null }); return b; },
      eq(c: string, v: unknown) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: unknown) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, vs: unknown[]) { const s = new Set(vs); preds.push((r) => s.has(r[c])); return b; },
      not(c: string, op: string, v: unknown) {
        mark("not");
        if (op === "eq") preds.push((r) => r[c] != null && r[c] !== v);
        return b;
      },
      is(c: string, v: unknown) { if (v === null) preds.push((r) => r[c] == null); return b; },
      or(expr: string) { const p = parseOr(String(expr)); if (p) preds.push(p); return b; },
      like(c: string, pattern: string) {
        const rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        preds.push((r) => typeof r[c] === "string" && rx.test(r[c]));
        return b;
      },
      ilike() { return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; },
      contains() { return b; }, overlaps() { return b; }, filter() { return b; },
      order() { return b; }, range() { return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { return one(); },
      single() { return one(); },
      then(onF: any, onR: any) { return list().then(onF, onR); },
    };

    function rows(): any[] {
      let out = (world.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    }
    async function list() {
      if (write) return { data: null, error: null, count: null };
      world.reads.push(table);
      if (world.errorTables.has(table) || opFailed) return { data: null, error: { message: `${table} unavailable` }, count: null };
      const r = rows();
      return { data: r, error: null, count: r.length };
    }
    async function one() {
      if (write) return { data: null, error: null };
      world.reads.push(table);
      if (world.errorTables.has(table) || opFailed) return { data: null, error: { message: `${table} unavailable` } };
      return { data: rows()[0] ?? null, error: null };
    }
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        const id = world.users[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from,
    rpc: async (fn: string, args: unknown) => {
      world.writes.push({ table: `rpc:${fn}`, op: "rpc", payload: args });
      return { data: null, error: null };
    },
  };
}

/** A `feature_flags` row. */
export function flag(name: string, enabled: boolean, metadata: Record<string, unknown> | null = null) {
  return { flag: name, enabled, metadata };
}

/** A `discovery_places` row in Miami, active, as `queryDbPlaces` selects it. */
export function communityRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, city: "Miami", name: `pick ${id}`, place_type: "traveler_pick",
    category: "food", primary_category: "food", secondary_categories: null,
    neighborhood: null, blurb: `blurb ${id}`, image_url: null, header_image_source: null,
    image_source_type: null, image_accuracy_status: null, rating: 4.2, saved_count: 3,
    lat: 25.77, lng: -80.19, tag: null, verified: false, created_at: "2026-01-01T00:00:00.000Z",
    source: "traveler", status: "active", submitted_by: null, note: null,
    ...over,
  };
}

/** A `profiles` row carrying what the §47 author policy and the age seam read. */
export function profileRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: `name ${id.slice(0, 4)}`, username: `h${id.slice(0, 4)}`, avatar_url: null,
    account_status: "active", date_of_birth: "1990-01-01", ...over,
  };
}

/** A fake Overpass response body with named nodes near Miami. */
export function overpassBody(nodes: Array<{ id: number; name: string; amenity?: string; lat?: number; lon?: number }>) {
  return {
    elements: nodes.map((n) => ({
      type: "node", id: n.id, lat: n.lat ?? 25.771, lon: n.lon ?? -80.191,
      tags: { name: n.name, amenity: n.amenity ?? "cafe" },
    })),
  };
}
