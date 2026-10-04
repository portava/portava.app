/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83): a PostgREST-shaped double that CUTS a response at db-max-rows
 * the way the hosted server does, for the suites that prove a list is read whole.
 *
 * PostgREST caps every response at `db-max-rows` (1000 on this deployment) and says nothing: the cut answer has the
 * shape of a whole one, and an explicit `.limit()` cannot lift the cap. The only evidence of a cut is the exact count a
 * caller asked for (`select(cols, { count: "exact" })`), which is the number of rows the filter MATCHES, not the number
 * answered. This double models exactly that, and nothing a test could lean on by accident:
 *
 *   - filters (`eq`, `neq`, `in`, `not(col, "in" | "is", …)`, `gt`/`gte`/`lt`/`lte` as string comparison, `is`, and
 *     `.or()` through `logicFilter`) narrow the rows; a filter it does not model is ignored and RECORDED (`read.ignored`);
 *   - `.order()` sorts (every order column in turn, `sortByOrders`); with no order the rows keep insertion order;
 *   - `.range()` then `.limit()` then the db-max-rows cap are applied, in that order;
 *   - `count` is the number of rows the filter matched, present only when the read asked for it;
 *   - `fail(read)` may answer any read with an error (`true`) or make it throw (`"throw"`), and sees how the read was
 *     shaped (its table, its `eq` filters, whether it was ordered, and its ordinal among the reads of that table).
 */
import { logicFilter, sortByOrders } from "./postgrestKeyset.js";

export interface Row { [k: string]: any }
export interface SeenRead {
  table: string;
  cols: string;
  eqs: Record<string, unknown>;
  ins: Record<string, unknown[]>;
  ordered: boolean;
  counted: boolean;
  /** 1 for the first read of this table through this client, 2 for the second, … */
  nth: number;
  ignored: string[];
}
export interface CappedOptions {
  /** PostgREST's db-max-rows. Default 1000, the hosted value. */
  dbMaxRows?: number;
  fail?: (read: SeenRead) => boolean | "throw";
  /** Every read that settled, in order. */
  reads?: SeenRead[];
  auth?: { getUser: (token: string) => Promise<unknown> };
  rpc?: (name: string, args: unknown) => Promise<unknown>;
}

export const DOUBLE_READ_ERROR = { code: "57014", message: "canceling statement due to statement timeout" };

export function cappedClient(tables: Record<string, Row[]>, opts: CappedOptions = {}) {
  const max = opts.dbMaxRows ?? 1000;
  const perTable = new Map<string, number>();
  function builder(table: string) {
    let rows: Row[] = (tables[table] ?? []).map((r) => ({ ...r }));
    const orders: Array<{ col: string; asc?: boolean; nullsFirst?: boolean }> = [];
    let limit: number | null = null; let range: [number, number] | null = null; let head = false;
    const read: SeenRead = { table, cols: "", eqs: {}, ins: {}, ordered: false, counted: false, nth: 0, ignored: [] };
    const settle = (single: boolean): any => {
      read.nth = (perTable.get(table) ?? 0) + 1; perTable.set(table, read.nth);
      opts.reads?.push(read);
      const f = opts.fail?.(read);
      if (f === "throw") throw new Error("socket hang up");
      if (f) return { data: null, error: DOUBLE_READ_ERROR, count: null };
      let out = orders.length > 0 ? sortByOrders(rows, orders) : rows;
      const total = out.length;
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      out = out.slice(0, max);
      const count = read.counted ? total : null;
      if (single) return { data: out[0] ?? null, error: null, count };
      return { data: head ? null : out, error: null, count };
    };
    const cmp = (op: "gt" | "gte" | "lt" | "lte") => (c: string, v: unknown) => {
      rows = rows.filter((r) => {
        if (r[c] === null || r[c] === undefined) return false;
        const a = String(r[c]), b = String(v);
        return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
      });
      return b;
    };
    const ignore = (name: string) => (..._a: unknown[]) => { read.ignored.push(name); return b; };
    const b: any = {
      select: (c?: string, o?: { count?: string; head?: boolean }) => { read.cols = c ?? ""; if (o?.count === "exact") read.counted = true; if (o?.head) head = true; return b; },
      eq: (c: string, v: unknown) => { read.eqs[c] = v; rows = rows.filter((r) => r[c] === v); return b; },
      neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return b; },
      in: (c: string, vs: unknown[]) => { read.ins[c] = vs; rows = rows.filter((r) => vs.includes(r[c])); return b; },
      not: (c: string, op: string, v: unknown) => {
        if (op === "in") { const ids = String(v).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")); rows = rows.filter((r) => !ids.includes(String(r[c]))); }
        else if (op === "is" && v === null) rows = rows.filter((r) => r[c] !== null && r[c] !== undefined);
        else if (op === "eq") rows = rows.filter((r) => r[c] !== v);
        else read.ignored.push(`not.${op}`);
        return b;
      },
      gt: cmp("gt"), gte: cmp("gte"), lt: cmp("lt"), lte: cmp("lte"),
      is: (c: string, v: unknown) => { rows = rows.filter((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return b; },
      or: (expr: string) => { const p = logicFilter(expr); if (p) rows = rows.filter(p); else read.ignored.push("or"); return b; },
      ilike: ignore("ilike"), like: ignore("like"), contains: ignore("contains"), overlaps: ignore("overlaps"), filter: ignore("filter"), match: ignore("match"), textSearch: ignore("textSearch"),
      order: (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => { read.ordered = true; orders.push({ col: c, asc: o?.ascending !== false, ...(o?.nullsFirst !== undefined ? { nullsFirst: o.nullsFirst } : {}) }); return b; },
      limit: (n: number) => { limit = n; return b; },
      range: (from: number, to: number) => { range = [from, to]; return b; },
      maybeSingle: () => Promise.resolve().then(() => settle(true)),
      single: () => Promise.resolve().then(() => settle(true)),
      then: (res: any, rej: any) => Promise.resolve().then(() => settle(false)).then(res, rej),
    };
    return b;
  }
  return {
    auth: opts.auth ?? { getUser: async () => ({ data: { user: null }, error: { message: "invalid", status: 401, code: "bad_jwt" } }) },
    from: (table: string) => builder(table),
    rpc: (name: string, args: unknown) => (opts.rpc ? opts.rpc(name, args) : Promise.resolve({ data: null, error: null })),
  };
}

/** A deterministic uuid-shaped id whose string order is its numeric order: `prefix-…-000000000042`. */
export function seqId(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
