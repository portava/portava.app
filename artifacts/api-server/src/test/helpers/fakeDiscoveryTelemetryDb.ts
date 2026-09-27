/**
 * fakeDiscoveryTelemetryDb — an in-memory stand-in for the parts of PostgREST +
 * Postgres the Discovery telemetry path depends on, with the SEMANTICS that
 * matter to census-discovery §48 enforced rather than stubbed:
 *
 *   • rank_events' UNIQUE (recommendation_id, outcome) index (2891). A multi-row
 *     insert that collides on it is refused WHOLE with the 23505 Postgres raises,
 *     message naming the index — so a replayed serve writes nothing.
 *   • a plain `.update(p).eq(...)` affects matching rows; `.in(...)` narrows the
 *     same statement, and `.select("id")` returns the rows it moved — so the
 *     outcome route's compare-and-set is exercised, not assumed.
 *   • `.upsert(rows, { onConflict, ignoreDuplicates })` resolves on the arbiter
 *     the way ON CONFLICT DO NOTHING / DO UPDATE would.
 *   • served_at is READ BACK in PostgREST's `+00:00` spelling, never the `Z` the
 *     writer sent — the difference that makes a naive id re-derivation miss.
 *   • rpc: `record_discovery_serve_request` (3376: ON CONFLICT (id) DO NOTHING,
 *     answers written | duplicate), and counters for the two distribution RPCs.
 *
 * Every table not modelled answers empty and accepts writes (captured), so the
 * whole Discovery route runs against it. Failures can be injected per table and
 * per operation to model a partial failure.
 */
export interface FakeTelemetryDbOptions {
  flags?: Record<string, { enabled: boolean; metadata?: Record<string, unknown> }>;
  users?: Record<string, string>;   // token → user id
  /** Fail the NEXT n inserts into a table with this error, then succeed. */
  failInserts?: Record<string, { times: number; error: unknown }>;
  /** Fail the NEXT n upserts into a table with this error, then succeed. */
  failUpserts?: Record<string, { times: number; error: unknown }>;
  /** Fail the NEXT n updates of a table with this error, then succeed. */
  failUpdates?: Record<string, { times: number; error: unknown }>;
  /** When false, the per-request RPC answers PGRST202 (3376 not applied). */
  serveRequestRpc?: boolean;
  /**
   * Awaited before every rank_events SELECT resolves — how a test forces two
   * concurrent requests to both read the row before either writes it.
   */
  beforeRankEventsRead?: () => Promise<void>;
}

const ARBITER = "rank_events_recommendation_idempotency_idx";

function pgrstInstant(iso: unknown): unknown {
  if (typeof iso !== "string") return iso;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().replace("Z", "+00:00");
}

let idSeq = 0;
function newId(): string {
  idSeq += 1;
  return `00000000-0000-4000-8000-${String(idSeq).padStart(12, "0")}`;
}

export function makeTelemetryDb(opts: FakeTelemetryDbOptions = {}) {
  const tables: Record<string, any[]> = { rank_events: [], recommendations: [] };
  const captured: Array<{ table: string; op: string; payload: unknown }> = [];
  const rpcCalls: Array<{ name: string; params: any }> = [];
  const failInserts = { ...(opts.failInserts ?? {}) };
  const failUpserts = { ...(opts.failUpserts ?? {}) };
  const failUpdates = { ...(opts.failUpdates ?? {}) };

  function collides(table: string, row: any, against: any[]): boolean {
    if (table !== "rank_events") return false;
    const rid = row.recommendation_id;
    if (rid === undefined || rid === null) return false;
    return against.some((r) => r.recommendation_id === rid && r.outcome === row.outcome);
  }

  function dup23505() {
    return {
      code: "23505",
      message: `duplicate key value violates unique constraint "${ARBITER}"`,
      details: "Key (recommendation_id, outcome)=(…) already exists.",
    };
  }

  function stored(table: string, row: any): any {
    const out = { ...row };
    if (table === "rank_events") {
      out.id = out.id ?? newId();
      out.served_at = pgrstInstant(out.served_at ?? new Date().toISOString());
      out.features = out.features ?? {};
      out.outcome = out.outcome ?? "impression";
    }
    return out;
  }

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: any[] = [];
    let patch: Record<string, unknown> = {};
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let wantRows = false;
    let limitN: number | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;

    const colOf = (r: any, col: string) => {
      const m = /^features->>(.+)$/.exec(col);
      return m ? r.features?.[m[1]!] : r[col];
    };

    const b: any = {
      select(_cols?: string) { if (op !== "select") wantRows = true; return b; },
      insert(p: any) { op = "insert"; payload = Array.isArray(p) ? p : [p]; return b; },
      upsert(p: any, o?: any) { op = "upsert"; payload = Array.isArray(p) ? p : [p]; upsertOpts = o ?? {}; return b; },
      update(p: any) { op = "update"; patch = p; return b; },
      delete() { return b; },
      eq(col: string, val: any) { preds.push((r) => colOf(r, col) === val); return b; },
      neq(col: string, val: any) { preds.push((r) => colOf(r, col) !== val); return b; },
      in(col: string, vals: any[]) { preds.push((r) => vals.includes(colOf(r, col))); return b; },
      or(expr: string) {
        const alts = expr.split(",").map((a) => {
          const m = /^(.+)\.eq\.(.+)$/.exec(a);
          return m ? { col: m[1]!, val: m[2]! } : null;
        }).filter(Boolean) as Array<{ col: string; val: string }>;
        preds.push((r) => alts.some((a) => String(colOf(r, a.col)) === a.val));
        return b;
      },
      is() { return b; }, not() { return b; }, gt() { return b; }, gte() { return b; },
      lt() { return b; }, lte() { return b; }, ilike() { return b; }, like() { return b; },
      contains() { return b; }, overlaps() { return b; }, range() { return b; },
      order(col: string, o?: { ascending?: boolean }) { orderCol = col; orderAsc = o?.ascending !== false; return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { return run().then((r: any) => ({ data: (r.data ?? [])[0] ?? null, error: r.error })); },
      single() { return run().then((r: any) => ({ data: (r.data ?? [])[0] ?? null, error: r.error })); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    function matching(): any[] {
      const rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (orderCol) {
        const c = orderCol;
        rows.sort((a, z) => (String(a[c]) < String(z[c]) ? -1 : String(a[c]) > String(z[c]) ? 1 : 0) * (orderAsc ? 1 : -1));
      }
      return limitN === null ? rows : rows.slice(0, limitN);
    }

    async function run(): Promise<any> {
      if (table === "feature_flags") {
        const rows = Object.entries(opts.flags ?? {}).map(([flag, v]) => ({ flag, ...v }));
        tables["feature_flags"] = rows;
      }
      if (op === "select") {
        if (table === "rank_events" && opts.beforeRankEventsRead) await opts.beforeRankEventsRead();
        return { data: matching(), error: null };
      }
      if (op === "insert") {
        captured.push({ table, op, payload });
        const f = failInserts[table];
        if (f && f.times > 0) { f.times -= 1; return { data: null, error: f.error }; }
        const current = tables[table] ?? (tables[table] = []);
        const batch: any[] = [];
        for (const row of payload) {
          if (collides(table, row, current) || collides(table, row, batch)) return { data: null, error: dup23505() };
          batch.push(stored(table, row));
        }
        current.push(...batch);
        return { data: wantRows ? batch.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (op === "upsert") {
        captured.push({ table, op, payload });
        const f = failUpserts[table];
        if (f && f.times > 0) { f.times -= 1; return { data: null, error: f.error }; }
        const current = tables[table] ?? (tables[table] = []);
        const landed: any[] = [];
        for (const row of payload) {
          const hit = current.find((r) => table === "rank_events" && r.recommendation_id === row.recommendation_id && r.outcome === row.outcome);
          if (hit) {
            if (!upsertOpts.ignoreDuplicates) { Object.assign(hit, { ...row, served_at: pgrstInstant(row.served_at) }); landed.push(hit); }
            continue;
          }
          const s = stored(table, row);
          current.push(s);
          landed.push(s);
        }
        return { data: wantRows ? landed.map((r) => ({ id: r.id })) : null, error: null };
      }
      // update
      captured.push({ table, op, payload: patch });
      const fu = failUpdates[table];
      if (fu && fu.times > 0) { fu.times -= 1; return { data: null, error: fu.error }; }
      const moved = matching();
      for (const r of moved) {
        Object.assign(r, patch);
        if (table === "rank_events" && (patch as any).outcome !== undefined) {
          const clash = (tables[table] ?? []).some((o) => o !== r && o.recommendation_id && o.recommendation_id === r.recommendation_id && o.outcome === r.outcome);
          if (clash) return { data: null, error: dup23505() };
        }
      }
      return { data: wantRows ? moved.map((r) => ({ id: r.id })) : null, error: null };
    }

    return b;
  }

  const client = {
    auth: {
      getUser: async (token: string) => {
        const id = opts.users?.[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from,
    rpc: async (name: string, params: any) => {
      rpcCalls.push({ name, params });
      if (name === "record_discovery_serve_request") {
        if (opts.serveRequestRpc === false) {
          return { data: null, error: { code: "PGRST202", message: "Could not find the function public.record_discovery_serve_request(p_row) in the schema cache" } };
        }
        const row = params?.p_row ?? {};
        if (tables["recommendations"]!.some((r) => r.id === row.id)) return { data: "duplicate", error: null };
        tables["recommendations"]!.push({ ...row, served_at: pgrstInstant(row.served_at) });
        return { data: "written", error: null };
      }
      return { data: null, error: null };
    },
  };

  return {
    client,
    tables,
    captured,
    rpcCalls,
    rankEvents: () => tables["rank_events"]!,
    impressions: () => tables["rank_events"]!.filter((r) => r.outcome !== "analytics"),
    analytics: () => tables["rank_events"]!.filter((r) => r.outcome === "analytics"),
    serveRequests: () => tables["recommendations"]!,
    rpcCount: (name: string) => rpcCalls.filter((c) => c.name === name).length,
  };
}
