/**
 * The database the safety re-drive's tests run against (telegraphSafetySignalRedrive.test.ts and its restart child,
 * safetyRedriveRestartChild.ts). It is the "queue's own test harness" in the plainest sense: the re-drive's only
 * durable state IS rows in public.messages and public.notifications, so a process restart is proven by handing this
 * object's `db` (serialised to JSON) to a SECOND node process that never ran the door.
 *
 * The chain supports what the producer, NotificationService and the pass send: select / insert / upsert, eq / neq /
 * in / is / gt / gte / lt / lte (a `col->>key` path reads into a JSON column), order (several keys), range, limit,
 * maybeSingle / single. Any other method is accepted and IGNORED (the same rule as telegraphSafetyNotifications's own
 * fake, which NotificationService is already proven against). Reads of a table can be made to fail: `fail[table]` =
 * "always" or a count of failures still to come; set or delete it mid-test to start or end an outage. Every read is
 * counted per table in `reads`.
 */
export type Row = Record<string, any>;

export interface FakeSafetyDb {
  db: Record<string, Row[]>;
  reads: Record<string, number>;
  fail: Record<string, number | "always">;
  from(table: string): any;
  rpc(): Promise<{ data: null; error: { code: string } }>;
}

export function fakeSafetyDb(seed: Record<string, Row[]>): FakeSafetyDb {
  const db: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  const reads: Record<string, number> = {};
  const fail: Record<string, number | "always"> = {};
  let n = 0;
  const val = (r: Row, c: string): unknown => {
    const m = /^(\w+)->>(\w+)$/.exec(c);
    return m ? ((r[m[1]!] ?? {}) as Row)[m[2]!] : r[c];
  };
  const cmp = (a: unknown, b: unknown): number => {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  };
  function from(table: string): any {
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let mode: "select" | "insert" | "upsert" = "select";
    let written: Row | null = null;
    let lim: number | null = null;
    let rng: [number, number] | null = null;
    let counted = false;
    const run = (): { data: unknown; error: unknown } => {
      if (mode === "select") {
        if (!counted) { counted = true; reads[table] = (reads[table] ?? 0) + 1; }
        const f = fail[table];
        if (f === "always" || (typeof f === "number" && f > 0)) {
          if (typeof f === "number") fail[table] = f - 1;
          return { data: null, error: { message: `${table} unreadable` } };
        }
        let out = (db[table] ?? []).filter((r) => filters.every((fn) => fn(r)));
        if (orders.length > 0) {
          out = [...out].sort((a, b) => {
            for (const o of orders) { const c = cmp(val(a, o.col), val(b, o.col)); if (c !== 0) return o.asc ? c : -c; }
            return 0;
          });
        }
        if (rng) out = out.slice(rng[0], rng[1] + 1);
        if (lim !== null) out = out.slice(0, lim);
        return { data: out, error: null };
      }
      return { data: written, error: null };
    };
    const t: any = {
      select() { return p; },
      insert(r: Row) { mode = "insert"; written = { id: `n-${++n}`, created_at: new Date().toISOString(), ...r }; (db[table] ??= []).push(written); return p; },
      upsert(r: Row, o?: { onConflict?: string }) {
        mode = "upsert";
        const key = o?.onConflict ?? "id";
        const rows = (db[table] ??= []);
        const at = rows.findIndex((x) => x[key] === r[key]);
        written = at >= 0 ? Object.assign(rows[at]!, r) : (rows.push({ ...r }), rows[rows.length - 1]!);
        return p;
      },
      eq(c: string, v: unknown) { filters.push((r) => String(val(r, c)) === String(v)); return p; },
      neq(c: string, v: unknown) { filters.push((r) => String(val(r, c)) !== String(v)); return p; },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.map(String).includes(String(val(r, c)))); return p; },
      is(c: string, v: unknown) { filters.push((r) => (v === null ? val(r, c) == null : val(r, c) === v)); return p; },
      gt(c: string, v: unknown) { filters.push((r) => val(r, c) != null && String(val(r, c)) > String(v)); return p; },
      gte(c: string, v: unknown) { filters.push((r) => val(r, c) != null && String(val(r, c)) >= String(v)); return p; },
      lt(c: string, v: unknown) { filters.push((r) => val(r, c) != null && String(val(r, c)) < String(v)); return p; },
      lte(c: string, v: unknown) { filters.push((r) => val(r, c) != null && String(val(r, c)) <= String(v)); return p; },
      order(c: string, o?: { ascending?: boolean }) { orders.push({ col: c, asc: o?.ascending !== false }); return p; },
      range(a: number, b: number) { rng = [a, b]; return p; },
      limit(k: number) { lim = k; return p; },
      maybeSingle() {
        const r = run();
        return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null });
      },
      single() { return t.maybeSingle(); },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    const p: any = new Proxy(t, {
      get(o, k) {
        if (k in o) return o[k as string];
        if (k === "catch" || k === "finally") return undefined;
        return () => p;
      },
    });
    return p;
  }
  return { db, reads, fail, from, rpc: async () => ({ data: null, error: { code: "PGRST202" } }) };
}
