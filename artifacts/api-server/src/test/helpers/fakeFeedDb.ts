/**
 * fakeFeedDb — an in-memory PostgREST double for the media and post FEED
 * routes, built for census-media §47's question: what does a route say when a
 * read it depends on fails, or when a set it reads is larger than the server's
 * row cap?
 *
 * Modelled, because the defects under test live exactly there:
 *   - a failure RESOLVES `{ data: null, error, count: null }`, never throws
 *     (`failReads`, per table or per read; `failWrites` for writes);
 *   - PostgREST's db-max-rows: an un-HEADed read returns at most `maxRows`
 *     (default 1,000) rows and says nothing about the rest;
 *   - `{ count: "exact" }` counts every matching row (before limit and cap);
 *     `head: true` returns no rows at all;
 *   - `.or()` narrows, through the shared `orPredicate` parser;
 *   - writes are APPLIED, so a recount after a write sees it;
 *   - `.maybeSingle()` on several rows resolves PGRST116, as the real client does.
 *
 * Embedded resources are not projected: a seeded row carries its embeds
 * (`post_media`, `profiles`) and the read returns the row as stored.
 * Unknown tables read as empty, so helpers a route calls in passing work.
 */
import { orPredicate } from "./postgrestOrFilter.js";

export type Row = Record<string, any>;

export interface FakeRead {
  table: string;
  select: string;
  head: boolean;
  count: boolean;
  /** `col=op.val` for every filter, in call order. */
  filters: string[];
}

export interface FakeFeedDbSpec {
  tables: Record<string, Row[]>;
  /** token → user id */
  users: Record<string, string>;
  /** table → fail every read of it, or only the reads the predicate picks. */
  failReads?: Record<string, true | ((r: FakeRead) => boolean)>;
  /** table → fail every write to it. */
  failWrites?: Record<string, true>;
  /** PostgREST db-max-rows. */
  maxRows?: number;
  /** unique keys per table, for upsert conflict handling. */
  unique?: Record<string, string[]>;
}

export interface FakeFeedDb {
  client: any;
  reads: FakeRead[];
  writes: Array<{ table: string; op: string; payload: any }>;
  tables: Record<string, Row[]>;
}

const FAIL = { message: "canceling statement due to statement timeout", code: "57014", details: null, hint: null };

function cmp(a: any, b: any): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
}

export function makeFeedDb(spec: FakeFeedDbSpec): FakeFeedDb {
  const reads: FakeRead[] = [];
  const writes: FakeFeedDb["writes"] = [];
  const maxRows = spec.maxRows ?? 1_000;

  function readFails(r: FakeRead): boolean {
    const f = spec.failReads?.[r.table];
    if (!f) return false;
    return f === true ? true : f(r);
  }

  function builder(table: string) {
    const preds: Array<(row: Row) => boolean> = [];
    const filterText: string[] = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let selectCols = "*";
    let wantCount = false;
    let head = false;
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null;
    let upsertOpts: any = null;
    let returning = false;

    const store = () => (spec.tables[table] ??= []);
    const matches = () => store().filter((r) => preds.every((p) => p(r)));

    const f = (text: string, p: (row: Row) => boolean) => {
      filterText.push(text);
      preds.push(p);
      return b;
    };

    function runRead(single: "no" | "maybe" | "one") {
      const r: FakeRead = { table, select: selectCols, head, count: wantCount, filters: [...filterText] };
      reads.push(r);
      if (readFails(r)) return { data: null, error: { ...FAIL }, count: null, status: 500, statusText: "error" };
      let rows = matches();
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, c) => cmp(a[o.col], c[o.col]) * (o.asc ? 1 : -1));
      }
      const total = rows.length;
      if (rangeFrom !== null) rows = rows.slice(rangeFrom, (rangeTo ?? rows.length - 1) + 1);
      if (limitN !== null) rows = rows.slice(0, limitN);
      if (head) return { data: null, error: null, count: wantCount ? total : null, status: 200, statusText: "OK" };
      rows = rows.slice(0, maxRows).map((x) => ({ ...x }));
      if (single !== "no") {
        if (rows.length > 1) {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null }, count: null, status: 406, statusText: "error" };
        }
        if (rows.length === 0 && single === "one") {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: null, hint: null }, count: null, status: 406, statusText: "error" };
        }
        return { data: rows[0] ?? null, error: null, count: wantCount ? total : null, status: 200, statusText: "OK" };
      }
      return { data: rows, error: null, count: wantCount ? total : null, status: 200, statusText: "OK" };
    }

    function runWrite(single: "no" | "maybe" | "one") {
      writes.push({ table, op, payload });
      if (spec.failWrites?.[table]) return { data: null, error: { ...FAIL, message: `write to ${table} refused` }, count: null, status: 500, statusText: "error" };
      let affected: Row[] = [];
      if (op === "insert" || op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload];
        const key = (upsertOpts?.onConflict ? String(upsertOpts.onConflict).split(",").map((s: string) => s.trim()) : spec.unique?.[table]) ?? null;
        for (const raw of list) {
          const row = { ...raw };
          const clash = key ? store().find((s) => key.every((k: string) => s[k] === row[k])) : undefined;
          if (clash) {
            if (op === "upsert" && !upsertOpts?.ignoreDuplicates) Object.assign(clash, row);
            if (op === "insert") return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint", details: null, hint: null }, count: null, status: 409, statusText: "error" };
            affected.push(clash);
            continue;
          }
          if (row.id === undefined) row.id = `${table}-${store().length + 1}-${Math.random().toString(16).slice(2, 10)}`;
          if (row.created_at === undefined) row.created_at = new Date().toISOString();
          store().push(row);
          affected.push(row);
        }
      } else if (op === "update") {
        affected = matches();
        for (const r of affected) Object.assign(r, payload);
      } else if (op === "delete") {
        affected = matches();
        spec.tables[table] = store().filter((r) => !affected.includes(r));
      }
      if (!returning) return { data: null, error: null, count: null, status: 204, statusText: "OK" };
      const out = affected.map((x) => ({ ...x }));
      if (single !== "no") return { data: out[0] ?? null, error: null, count: null, status: 200, statusText: "OK" };
      return { data: out, error: null, count: null, status: 200, statusText: "OK" };
    }

    const run = (single: "no" | "maybe" | "one") => (op === "select" ? runRead(single) : runWrite(single));

    const b: any = {
      select(cols?: string, opts?: any) {
        if (op === "select") {
          selectCols = cols ?? "*";
          wantCount = opts?.count === "exact";
          head = opts?.head === true;
        } else {
          returning = true;
        }
        return b;
      },
      eq: (c: string, v: any) => f(`${c}=eq.${v}`, (r) => r[c] === v),
      neq: (c: string, v: any) => f(`${c}=neq.${v}`, (r) => r[c] !== v),
      gt: (c: string, v: any) => f(`${c}=gt.${v}`, (r) => r[c] != null && r[c] > v),
      gte: (c: string, v: any) => f(`${c}=gte.${v}`, (r) => r[c] != null && r[c] >= v),
      lt: (c: string, v: any) => f(`${c}=lt.${v}`, (r) => r[c] != null && r[c] < v),
      lte: (c: string, v: any) => f(`${c}=lte.${v}`, (r) => r[c] != null && r[c] <= v),
      in: (c: string, vs: any[]) => f(`${c}=in.(${vs.join(",")})`, (r) => vs.includes(r[c])),
      is: (c: string, v: any) => f(`${c}=is.${v}`, (r) => (v === null ? r[c] == null : r[c] === v)),
      ilike: (c: string, pat: string) => {
        const re = new RegExp(`^${String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
        return f(`${c}=ilike.${pat}`, (r) => r[c] != null && re.test(String(r[c])));
      },
      not: (c: string, o: string, v: any) => {
        if (o === "in") {
          const items = String(v).replace(/^\(/, "").replace(/\)$/, "").split(",").map((s) => s.trim());
          return f(`${c}=not.in.${v}`, (r) => !items.includes(String(r[c])));
        }
        if (o === "is") return f(`${c}=not.is.${v}`, (r) => (v === null ? r[c] != null : r[c] !== v));
        if (o === "eq") return f(`${c}=not.eq.${v}`, (r) => r[c] !== v);
        throw new Error(`fakeFeedDb: not(${o}) is not modelled`);
      },
      or: (expr: string) => f(`or=(${expr})`, orPredicate(expr)),
      filter: (c: string, o: string, v: any) => {
        if (o === "eq") return f(`${c}=eq.${v}`, (r) => r[c] === v);
        throw new Error(`fakeFeedDb: filter(${o}) is not modelled`);
      },
      contains: () => b,
      overlaps: () => b,
      textSearch: () => b,
      order(c: string, o?: { ascending?: boolean }) {
        orders.push({ col: c, asc: o?.ascending !== false });
        return b;
      },
      limit(n: number) { limitN = n; return b; },
      range(from: number, to: number) { rangeFrom = from; rangeTo = to; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      upsert(p: any, o?: any) { op = "upsert"; payload = p; upsertOpts = o ?? null; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      maybeSingle: () => Promise.resolve(run("maybe")),
      single: () => Promise.resolve(run("one")),
      abortSignal: () => b,
      then(onF: any, onR: any) {
        return Promise.resolve(run("no")).then(onF, onR);
      },
    };
    return b;
  }

  const client = {
    from: (t: string) => builder(t),
    rpc: (fn: string) => Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}`, details: null, hint: null }, count: null }),
    auth: {
      getUser: async (token: string) =>
        spec.users[token]
          ? { data: { user: { id: spec.users[token] } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "no storage" } }) }) },
  };

  return { client, reads, writes, tables: spec.tables };
}

/** Did any read of `table` match `pred`? For asserting what a route asked. */
export function readsOf(db: FakeFeedDb, table: string): FakeRead[] {
  return db.reads.filter((r) => r.table === table);
}
