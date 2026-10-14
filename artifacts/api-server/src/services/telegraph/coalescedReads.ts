/**
 * Read coalescing for a batch of §5 share resolutions — census-telegraph T448 /
 * T359 / T445 (lane w-tg-cardtruth, 2026-10-14): "batch the re-resolution, no
 * N+1".
 *
 * WHY A CLIENT WRAPPER AND NOT A SECOND SET OF LOADERS
 * ====================================================
 * Every §5 loader in `services/telegraph/shareables.ts` opens with the same
 * read — one row of its source table by id — and most follow it with
 * pair lookups (`blocks` either way, `event_attendees`, `meetup_invites`,
 * `trip_members`). Resolving fifty shared cards one loader at a time is fifty
 * primary reads and up to a hundred block reads. Writing batched twins of those
 * loaders would put a SECOND copy of each family's privacy rule beside the
 * first, and the two would drift — the exact failure §5's single registry
 * exists to prevent.
 *
 * So the loaders stay the only policy, and this wrapper changes only HOW their
 * reads reach the database. Every chain a loader builds is RECORDED; when it is
 * awaited, one of three things happens:
 *
 *   1. `.select(cols).eq("id", v).maybeSingle()`  — coalesced with every other
 *      such read of the same table and columns issued in the same turn of the
 *      event loop into ONE `.in("id", [...])` query.
 *   2. `.select(cols).eq(a, x).eq(b, y)` ending `.maybeSingle()` or `.limit(1)`
 *      — coalesced per (table, cols, a, b) into ONE `.in(a, xs).in(b, ys)`
 *      query and answered per pair.
 *   3. anything else — REPLAYED on the real client exactly as written.
 *
 * Semantics are kept, including the failure ones: a batch that errors answers
 * EVERY caller in it with that error (so each loader takes its own
 * fail-closed `unknown` branch); `.maybeSingle()` over more than one matching
 * row answers an error, as PostgREST does; a column the batch had to add to
 * match rows back is stripped from what the caller receives. Only simple
 * comma-separated column lists are coalesced — an embedded resource or `*` is
 * replayed.
 */

type Call = readonly [method: string, args: readonly unknown[]];

type Answer = { data: unknown; error: unknown; count: null };

interface Waiter {
  resolve: (a: Answer) => void;
}

/** Counts, so a test can prove the batching instead of trusting it. */
export interface CoalescingStats {
  /** Queries actually issued to the real client (batched + replayed). */
  issued: number;
  /** Reads that were answered from a batched query. */
  coalesced: number;
}

const SIMPLE_COLUMNS = /^\s*[a-z_][a-z0-9_]*(\s*,\s*[a-z_][a-z0-9_]*)*\s*$/i;
const ID_CHUNK = 100;
/** A pair batch whose cross product could exceed PostgREST's row cap is not coalesced. */
const PAIR_PRODUCT_MAX = 900;

function columnsOf(cols: string): string[] {
  return cols.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
}

function withColumns(cols: string, extra: string[]): string {
  const have = columnsOf(cols);
  const add = extra.filter((c) => !have.includes(c));
  return [...have, ...add].join(", ");
}

function projectRow(row: unknown, cols: string[]): unknown {
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = (row as Record<string, unknown>)[c];
  return out;
}

const key = (v: unknown) => String(v);

/**
 * The shapes this wrapper coalesces. Exported so the test can pin that a chain
 * it does NOT recognise is replayed rather than mis-batched.
 */
export function coalescableShape(
  calls: readonly Call[],
):
  | { kind: "id"; cols: string; id: unknown }
  | { kind: "pair"; cols: string; a: string; x: unknown; b: string; y: unknown; terminal: "maybeSingle" | "limit1" }
  | null {
  if (calls.length < 3) return null;
  const [first, ...rest] = calls;
  if (first[0] !== "select" || first[1].length !== 1 || typeof first[1][0] !== "string") return null;
  const cols = first[1][0] as string;
  if (!SIMPLE_COLUMNS.test(cols)) return null;
  const last = rest[rest.length - 1];
  const terminal =
    last[0] === "maybeSingle" && last[1].length === 0 ? "maybeSingle"
    : last[0] === "limit" && last[1].length === 1 && last[1][0] === 1 ? "limit1"
    : null;
  if (!terminal) return null;
  const filters = rest.slice(0, -1);
  if (!filters.every((f) => f[0] === "eq" && f[1].length === 2 && typeof f[1][0] === "string")) return null;
  if (filters.some((f) => f[1][1] === null || f[1][1] === undefined || typeof f[1][1] === "object")) return null;
  if (filters.length === 1 && terminal === "maybeSingle" && filters[0][1][0] === "id") {
    return { kind: "id", cols, id: filters[0][1][1] };
  }
  if (filters.length === 2 && filters[0][1][0] !== filters[1][1][0]) {
    return {
      kind: "pair",
      cols,
      a: filters[0][1][0] as string,
      x: filters[0][1][1],
      b: filters[1][1][0] as string,
      y: filters[1][1][1],
      terminal,
    };
  }
  return null;
}

/**
 * Wrap `real` so the reads issued through it in one turn of the event loop are
 * coalesced. Every other property (`rpc`, `auth`, …) passes straight through.
 */
export function coalescingClient<C extends object>(real: C, stats: CoalescingStats = { issued: 0, coalesced: 0 }): C {
  const realFrom = (real as unknown as { from: (t: string) => any }).from.bind(real);

  type IdGroup = { table: string; cols: string; byId: Map<string, Waiter[]> };
  type PairReq = { x: unknown; y: unknown; terminal: "maybeSingle" | "limit1"; waiter: Waiter };
  type PairGroup = { table: string; cols: string; a: string; b: string; reqs: PairReq[] };
  const idGroups = new Map<string, IdGroup>();
  const pairGroups = new Map<string, PairGroup>();
  let scheduled = false;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    // A macrotask, not a microtask: a loader's chain can take a different number
    // of promise hops to reach its first read than its neighbour's, and every
    // microtask must drain before the batch is cut or the slower one misses it.
    setImmediate(() => {
      scheduled = false;
      void flush();
    });
  };

  async function flushIdGroup(g: IdGroup): Promise<void> {
    const want = columnsOf(g.cols);
    const ids = [...g.byId.keys()];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const part = ids.slice(i, i + ID_CHUNK);
      let answer: { data: unknown; error: unknown };
      try {
        stats.issued += 1;
        answer = await realFrom(g.table).select(withColumns(g.cols, ["id"])).in("id", part);
      } catch (err) {
        answer = { data: null, error: err ?? { message: "coalesced read threw" } };
      }
      const rows = Array.isArray(answer.data) ? (answer.data as Array<Record<string, unknown>>) : [];
      for (const id of part) {
        const waiters = g.byId.get(id) ?? [];
        if (answer.error) {
          for (const w of waiters) w.resolve({ data: null, error: answer.error, count: null });
          continue;
        }
        const hits = rows.filter((r) => key(r.id) === id);
        for (const w of waiters) {
          stats.coalesced += 1;
          w.resolve(
            hits.length > 1
              ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" }, count: null }
              : { data: hits.length === 1 ? projectRow(hits[0], want) : null, error: null, count: null },
          );
        }
      }
    }
  }

  async function flushPairGroup(g: PairGroup): Promise<void> {
    const want = columnsOf(g.cols);
    const xs = [...new Set(g.reqs.map((r) => key(r.x)))];
    const ys = [...new Set(g.reqs.map((r) => key(r.y)))];
    let answer: { data: unknown; error: unknown };
    if (xs.length * ys.length > PAIR_PRODUCT_MAX) {
      // Too wide to batch safely under the row cap: replay each one as written.
      await Promise.all(g.reqs.map(async (r) => {
        stats.issued += 1;
        let q = realFrom(g.table).select(g.cols).eq(g.a, r.x).eq(g.b, r.y);
        q = r.terminal === "maybeSingle" ? q.maybeSingle() : q.limit(1);
        try {
          const res = await q;
          r.waiter.resolve({ data: res?.data ?? null, error: res?.error ?? null, count: null });
        } catch (err) {
          r.waiter.resolve({ data: null, error: err ?? { message: "read threw" }, count: null });
        }
      }));
      return;
    }
    try {
      stats.issued += 1;
      answer = await realFrom(g.table).select(withColumns(g.cols, [g.a, g.b])).in(g.a, xs).in(g.b, ys);
    } catch (err) {
      answer = { data: null, error: err ?? { message: "coalesced read threw" } };
    }
    const rows = Array.isArray(answer.data) ? (answer.data as Array<Record<string, unknown>>) : [];
    for (const r of g.reqs) {
      if (answer.error) {
        r.waiter.resolve({ data: null, error: answer.error, count: null });
        continue;
      }
      stats.coalesced += 1;
      const hits = rows.filter((row) => key(row[g.a]) === key(r.x) && key(row[g.b]) === key(r.y));
      if (r.terminal === "limit1") {
        r.waiter.resolve({ data: hits.slice(0, 1).map((h) => projectRow(h, want)), error: null, count: null });
      } else {
        r.waiter.resolve(
          hits.length > 1
            ? { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" }, count: null }
            : { data: hits.length === 1 ? projectRow(hits[0], want) : null, error: null, count: null },
        );
      }
    }
  }

  async function flush(): Promise<void> {
    const ids = [...idGroups.values()];
    const pairs = [...pairGroups.values()];
    idGroups.clear();
    pairGroups.clear();
    await Promise.all([...ids.map(flushIdGroup), ...pairs.map(flushPairGroup)]);
  }

  function recordingBuilder(table: string): any {
    const calls: Call[] = [];
    let settled: Promise<Answer> | null = null;

    const run = (): Promise<Answer> => {
      if (settled) return settled;
      const shape = coalescableShape(calls);
      if (shape?.kind === "id") {
        settled = new Promise<Answer>((resolve) => {
          const gk = `${table}\u0000${shape.cols}`;
          let g = idGroups.get(gk);
          if (!g) { g = { table, cols: shape.cols, byId: new Map() }; idGroups.set(gk, g); }
          const id = key(shape.id);
          const list = g.byId.get(id) ?? [];
          list.push({ resolve });
          g.byId.set(id, list);
          schedule();
        });
        return settled;
      }
      if (shape?.kind === "pair") {
        settled = new Promise<Answer>((resolve) => {
          const gk = `${table}\u0000${shape.cols}\u0000${shape.a}\u0000${shape.b}`;
          let g = pairGroups.get(gk);
          if (!g) { g = { table, cols: shape.cols, a: shape.a, b: shape.b, reqs: [] }; pairGroups.set(gk, g); }
          g.reqs.push({ x: shape.x, y: shape.y, terminal: shape.terminal, waiter: { resolve } });
          schedule();
        });
        return settled;
      }
      // Not a shape this wrapper understands: the chain, exactly as written.
      stats.issued += 1;
      let q: any = realFrom(table);
      for (const [m, args] of calls) q = q[m](...args);
      settled = Promise.resolve(q) as Promise<Answer>;
      return settled;
    };

    const target = {
      then(onFulfilled?: (v: Answer) => unknown, onRejected?: (e: unknown) => unknown) {
        return run().then(onFulfilled, onRejected);
      },
      catch(onRejected?: (e: unknown) => unknown) {
        return run().catch(onRejected);
      },
      finally(onFinally?: () => void) {
        return run().finally(onFinally);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return (t as any)[prop];
        if (typeof prop === "symbol") return undefined;
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          return proxy;
        };
      },
    });
    return proxy;
  }

  return new Proxy(real, {
    get(t, prop, receiver) {
      if (prop === "from") return (table: string) => recordingBuilder(table);
      const v = Reflect.get(t, prop, receiver);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as C;
}
