/**
 * census-telegraph T220 part 2 — the directional, whole, batched and count
 * block readers in lib/exclusionSet.ts, held to the module's contract.
 *
 * node:test + node:assert. In-process fakes, no database, no network.
 *
 * Every reader here NEVER REJECTS, and every failure — a returned error, a
 * thrown read (synchronous or a rejected await), an answer that is not a row
 * list, a row that does not name its counter-party, a whole read that could
 * not be read whole, a scoped row outside its own filter, a count read with no
 * count — is `ok: false`. The truncation cases run against a fake that cuts
 * every response at a server row cap the way PostgREST's db-max-rows does, and
 * reports `{ count: "exact" }` the way PostgREST does (the rows matching every
 * filter, cursor included), so "never a prefix" is measured, not asserted.
 *
 * Run: node --import tsx/esm --test src/test/blockDirectionReaders.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readBlockDirection,
  readBlockDirections,
  readPairDirections,
  countBlockRows,
  isExcluded,
  BLOCK_AMONG_CHUNK,
} from "../lib/exclusionSet.js";
import { coalescingClient, coalescableShape } from "../services/telegraph/coalescedReads.js";

const V = "a0000000-0000-4000-a000-000000000001";
const id = (n: number) => `b0000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

type Row = { blocker_id: string; blocked_id: string; id?: string };
type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: number | null };

interface FakeOpts {
  /** PostgREST's db-max-rows: every response is cut to this many rows, with no error. */
  cap?: number;
  /** Override one read's answer: return an Answer to replace it, or throw. `n` counts reads from 0. */
  answer?: (calls: Call[], n: number) => Answer | undefined;
  /** Leave out `count` even when it was asked for. */
  noCount?: boolean;
  /** Ignore these filter methods (a builder bug / a fake that does not filter). */
  ignore?: ReadonlySet<string>;
}

/** A table-driven `blocks` that filters, orders, cuts at a cap and counts the way PostgREST does. */
function fake(rows: Row[], o: FakeOpts = {}) {
  const reads: Call[][] = [];
  function from(table: string) {
    assert.equal(table, "blocks");
    const calls: Call[] = [];
    const settle = (): Answer => {
      const n = reads.length;
      reads.push(calls);
      const over = o.answer?.(calls, n);
      if (over) return over;
      const sel = calls.find(([m]) => m === "select");
      const opts = (sel?.[1][1] ?? {}) as { count?: string; head?: boolean };
      let out = rows.filter((r) => calls.every(([m, a]) => {
        if (o.ignore?.has(m)) return true;
        const [c, v] = a as [keyof Row, any];
        if (m === "eq") return r[c] === v;
        if (m === "in") return (v as string[]).includes(r[c] as string);
        if (m === "gt") return String(r[c]) > String(v);
        if (m === "or") return String(a[0]).split(",").some((t) => { const [col, , val] = t.split("."); return (r as any)[col] === val; });
        return true;
      }));
      const ord = calls.find(([m]) => m === "order");
      if (ord) { const c = ord[1][0] as keyof Row; out = [...out].sort((x, y) => String(x[c]).localeCompare(String(y[c]))); }
      const total = out.length;
      const lim = calls.find(([m]) => m === "limit");
      if (lim) out = out.slice(0, lim[1][0] as number);
      if (o.cap !== undefined) out = out.slice(0, o.cap);
      const count = opts.count === "exact" && !o.noCount ? total : null;
      if (opts.head) return { data: null, error: null, count };
      const cols = String(sel?.[1][0] ?? "*").split(",").map((s) => s.trim());
      const data = out.map((r) => (cols[0] === "*" ? { ...r } : Object.fromEntries(cols.map((c) => [c, (r as any)[c]]))));
      return { data, error: null, count };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve().then(settle).then(f, r);
        return (...args: unknown[]) => { calls.push([prop, args]); return b; };
      },
    });
    return b;
  }
  return { client: { from } as any, reads };
}

const ERR = { message: "simulated blocks failure", code: "57014" };
const MALFORMED: Array<[string, Answer]> = [
  ["data: null with no error", { data: null, error: null }],
  ["a string", { data: "rows", error: null }],
  ["an object", { data: { rows: [] }, error: null }],
];

// ══ readBlockDirection — whole list ═══════════════════════════════════════════

describe("readBlockDirection — one direction, whole, by key", () => {
  const rows: Row[] = [
    { blocker_id: V, blocked_id: id(1) }, { blocker_id: V, blocked_id: id(2) },
    { blocker_id: id(3), blocked_id: V },
    { blocker_id: id(4), blocked_id: id(5) }, // not the viewer's
  ];

  it("outgoing is everyone the viewer blocked; incoming everyone who blocked the viewer — never mixed", async () => {
    const { client } = fake(rows);
    const out = await readBlockDirection(client, V, "outgoing");
    const inc = await readBlockDirection(client, V, "incoming");
    assert.ok(out.ok && inc.ok);
    assert.deepEqual([...out.ids].sort(), [id(1), id(2)]);
    assert.deepEqual([...inc.ids], [id(3)]);
  });

  it("an empty direction is a readable EMPTY set, and isExcluded answers false for a stranger", async () => {
    const r = await readBlockDirection(fake([]).client, V, "incoming");
    assert.equal(r.ok, true);
    assert.equal(isExcluded(r, id(9)), false);
  });

  it("the first request is the plain read the private sites made: select(<other>, count exact).eq(<self>, viewer) — one round trip under the cap", async () => {
    const { client, reads } = fake(rows);
    await readBlockDirection(client, V, "outgoing");
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0], [["select", ["blocked_id", { count: "exact" }]], ["eq", ["blocker_id", V]]]);
  });

  it("CUT: past the server's row cap it pages by key to the WHOLE list — where one range-less read stopped at the cap", async () => {
    const many: Row[] = Array.from({ length: 7 }, (_, i) => ({ blocker_id: V, blocked_id: id(10 + i) }));
    const { client, reads } = fake(many, { cap: 3 });
    // What the private sites' one range-less read saw: the first 3.
    const naive: any = await client.from("blocks").select("blocked_id").eq("blocker_id", V);
    assert.equal(naive.data.length, 3, "the fake cuts as PostgREST does");
    const r = await readBlockDirection(client, V, "outgoing");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ids.size, 7, "every block past the cap is still excluded");
    assert.ok(reads.length > 2, "it paged");
  });

  it("CUT, incoming: the same for the blockers of the viewer", async () => {
    const many: Row[] = Array.from({ length: 5 }, (_, i) => ({ blocker_id: id(20 + i), blocked_id: V }));
    const r = await readBlockDirection(fake(many, { cap: 2 }).client, V, "incoming");
    assert.ok(r.ok && r.ids.size === 5);
  });

  it("CUT that cannot be paged (pages repeat: the cursor is ignored) is ok:false, never the prefix", async () => {
    const many: Row[] = Array.from({ length: 5 }, (_, i) => ({ blocker_id: V, blocked_id: id(30 + i) }));
    const r = await readBlockDirection(fake(many, { cap: 2, ignore: new Set(["gt"]) }).client, V, "outgoing");
    assert.equal(r.ok, false);
  });

  it("CUT where a page comes back empty while the count says rows remain is ok:false", async () => {
    const many: Row[] = Array.from({ length: 5 }, (_, i) => ({ blocker_id: V, blocked_id: id(40 + i) }));
    const r = await readBlockDirection(fake(many, { cap: 2, answer: (c, n) => (n >= 1 && c.some(([m]) => m === "gt") ? { data: [], error: null, count: 3 } : undefined) }).client, V, "outgoing");
    assert.equal(r.ok, false);
  });

  it("a returned error on the FIRST read, or on a LATER page, is ok:false", async () => {
    assert.equal((await readBlockDirection(fake(rows, { answer: () => ({ data: null, error: ERR }) }).client, V, "outgoing")).ok, false);
    const many: Row[] = Array.from({ length: 5 }, (_, i) => ({ blocker_id: V, blocked_id: id(50 + i) }));
    const r = await readBlockDirection(fake(many, { cap: 2, answer: (_c, n) => (n === 2 ? { data: null, error: ERR } : undefined) }).client, V, "outgoing");
    assert.equal(r.ok, false);
  });

  for (const [name, ans] of MALFORMED) {
    it(`an answer that is ${name} is ok:false — not "blocked nobody"`, async () => {
      const r = await readBlockDirection(fake(rows, { answer: () => ans }).client, V, "outgoing");
      assert.equal(r.ok, false);
      assert.equal(isExcluded(r, id(99)), true, "an unreadable direction excludes everybody");
    });
  }

  it("a row that does not name its counter-party is ok:false — a DENY row is never dropped as absent", async () => {
    const r = await readBlockDirection(fake(rows, { answer: () => ({ data: [{ blocked_id: id(1) }, { other: 1 }], error: null, count: 2 }) }).client, V, "outgoing");
    assert.equal(r.ok, false);
  });

  it("a THROWN read — synchronous, or a rejected await — is ok:false and never rejects", async () => {
    const sync = { from() { throw new Error("client torn down"); } };
    assert.equal((await readBlockDirection(sync, V, "outgoing")).ok, false);
    const rejects = { from: () => ({ select: () => ({ eq: () => Promise.reject(new Error("fetch failed")) }) }) };
    assert.equal((await readBlockDirection(rejects, V, "incoming")).ok, false);
  });

  it("no client, no viewer, or a direction that is not one is ok:false", async () => {
    assert.equal((await readBlockDirection(null, V, "outgoing")).ok, false);
    assert.equal((await readBlockDirection(fake(rows).client, "", "outgoing")).ok, false);
    assert.equal((await readBlockDirection(fake(rows).client, V, "sideways" as any)).ok, false);
  });
});

// ══ readBlockDirection — scoped (`among`) ═════════════════════════════════════

describe("readBlockDirection — scoped to candidates", () => {
  const rows: Row[] = [{ blocker_id: V, blocked_id: id(1) }, { blocker_id: id(2), blocked_id: V }, { blocker_id: V, blocked_id: id(3) }];

  it("answers only among the candidates, per direction", async () => {
    const { client } = fake(rows);
    const out = await readBlockDirection(client, V, "outgoing", { among: [id(1), id(2)] });
    const inc = await readBlockDirection(client, V, "incoming", { among: [id(1), id(2)] });
    assert.ok(out.ok && inc.ok);
    assert.deepEqual([...out.ids], [id(1)], "id(3) is blocked but not a candidate");
    assert.deepEqual([...inc.ids], [id(2)]);
  });

  it(`chunks the candidates at ${BLOCK_AMONG_CHUNK} per read, so no read is cut and no URL grows without bound`, async () => {
    const among = Array.from({ length: 2 * BLOCK_AMONG_CHUNK + 7 }, (_, i) => id(1000 + i));
    const all: Row[] = among.map((o) => ({ blocker_id: V, blocked_id: o }));
    const { client, reads } = fake(all);
    const r = await readBlockDirection(client, V, "outgoing", { among });
    assert.ok(r.ok && r.ids.size === among.length);
    assert.equal(reads.length, 3);
    for (const c of reads) assert.ok(((c.find(([m]) => m === "in")?.[1][1]) as string[]).length <= BLOCK_AMONG_CHUNK);
  });

  it("an empty candidate list is a readable empty set and issues NO read", async () => {
    const { client, reads } = fake(rows);
    const r = await readBlockDirection(client, V, "outgoing", { among: [] });
    assert.ok(r.ok && r.ids.size === 0);
    assert.equal(reads.length, 0);
  });

  it("a row outside the chunk (the `.in()` filter not applied) is ok:false", async () => {
    const r = await readBlockDirection(fake(rows, { ignore: new Set(["in"]) }).client, V, "outgoing", { among: [id(1)] });
    assert.equal(r.ok, false);
  });

  it("a row whose viewer column is not the viewer (the `.eq()` filter not applied) is ok:false", async () => {
    const r = await readBlockDirection(fake([...rows, { blocker_id: id(7), blocked_id: id(1) }], { ignore: new Set(["eq"]) }).client, V, "outgoing", { among: [id(1)] });
    assert.equal(r.ok, false);
  });

  it("a count that is missing, or that disagrees with the rows, is ok:false", async () => {
    assert.equal((await readBlockDirection(fake(rows, { noCount: true }).client, V, "outgoing", { among: [id(1)] })).ok, false);
    assert.equal((await readBlockDirection(fake(rows, { answer: () => ({ data: [{ blocker_id: V, blocked_id: id(1) }], error: null, count: 2 }) }).client, V, "outgoing", { among: [id(1)] })).ok, false);
  });

  it("a returned error, a malformed answer, or a thrown read in ANY chunk is ok:false", async () => {
    const among = Array.from({ length: BLOCK_AMONG_CHUNK + 1 }, (_, i) => id(2000 + i));
    assert.equal((await readBlockDirection(fake([], { answer: (_c, n) => (n === 1 ? { data: null, error: ERR } : undefined) }).client, V, "outgoing", { among })).ok, false);
    for (const [, ans] of MALFORMED) assert.equal((await readBlockDirection(fake([], { answer: () => ans }).client, V, "incoming", { among })).ok, false);
    assert.equal((await readBlockDirection({ from() { throw new Error("x"); } }, V, "incoming", { among })).ok, false);
  });
});

// ══ readBlockDirections ═══════════════════════════════════════════════════════

describe("readBlockDirections — both directions, kept apart", () => {
  const rows: Row[] = [
    { blocker_id: V, blocked_id: id(1) },
    { blocker_id: id(2), blocked_id: V },
    { blocker_id: V, blocked_id: id(3) }, { blocker_id: id(3), blocked_id: V }, // mutual
  ];

  it("outgoing, incoming and their union; a mutual block is in both", async () => {
    const r = await readBlockDirections(fake(rows).client, V);
    assert.ok(r.ok);
    assert.deepEqual([...r.outgoing].sort(), [id(1), id(3)]);
    assert.deepEqual([...r.incoming].sort(), [id(2), id(3)]);
    assert.deepEqual([...r.ids].sort(), [id(1), id(2), id(3)]);
    assert.equal(isExcluded(r, id(2)), true);
    assert.equal(isExcluded(r, id(9)), false);
  });

  it("pages EACH direction past the cap", async () => {
    const many: Row[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ blocker_id: V, blocked_id: id(100 + i) })),
      ...Array.from({ length: 4 }, (_, i) => ({ blocker_id: id(200 + i), blocked_id: V })),
    ];
    const r = await readBlockDirections(fake(many, { cap: 2 }).client, V);
    assert.ok(r.ok && r.outgoing.size === 5 && r.incoming.size === 4);
  });

  it("with `among` it is the batched pair form: two reads for N others", async () => {
    const others = [id(1), id(2), id(3), id(8)];
    const { client, reads } = fake(rows);
    const r = await readBlockDirections(client, V, { among: others });
    assert.ok(r.ok);
    assert.equal(reads.length, 2);
    assert.deepEqual(others.map((o) => [r.outgoing.has(o), r.incoming.has(o)]), [[true, false], [false, true], [true, true], [false, false]]);
  });

  it("ONE direction failing — error or malformed — makes the whole answer ok:false (half a block list is not a block list)", async () => {
    const incomingOnly = (ans: Answer) => (c: Call[]) => (c.some(([m, a]) => m === "eq" && a[0] === "blocked_id") ? ans : undefined);
    assert.equal((await readBlockDirections(fake(rows, { answer: incomingOnly({ data: null, error: ERR }) }).client, V)).ok, false);
    for (const [, ans] of MALFORMED) assert.equal((await readBlockDirections(fake(rows, { answer: incomingOnly(ans) }).client, V)).ok, false);
    const outgoingOnly = (c: Call[]) => (c.some(([m, a]) => m === "eq" && a[0] === "blocker_id") ? { data: null, error: null } : undefined);
    const r = await readBlockDirections(fake(rows, { answer: outgoingOnly }).client, V);
    assert.equal(r.ok, false);
    assert.equal(isExcluded(r, id(9)), true);
  });

  it("a thrown read is ok:false; no client or viewer is ok:false", async () => {
    assert.equal((await readBlockDirections({ from() { throw new Error("x"); } }, V)).ok, false);
    assert.equal((await readBlockDirections(null, V)).ok, false);
    assert.equal((await readBlockDirections(fake(rows).client, "")).ok, false);
  });
});

// ══ readPairDirections (and the batch it makes through the coalescer) ═════════

describe("readPairDirections — one pair, per direction", () => {
  const A = V; const B = id(1);

  it("the four states: none, a→b, b→a, mutual", async () => {
    const at = async (rows: Row[]) => {
      const r = await readPairDirections(fake(rows).client, A, B);
      assert.ok(r.ok);
      return [r.aBlockedB, r.bBlockedA, isExcluded(r, B)];
    };
    assert.deepEqual(await at([]), [false, false, false]);
    assert.deepEqual(await at([{ blocker_id: A, blocked_id: B }]), [true, false, true]);
    assert.deepEqual(await at([{ blocker_id: B, blocked_id: A }]), [false, true, true]);
    assert.deepEqual(await at([{ blocker_id: A, blocked_id: B }, { blocker_id: B, blocked_id: A }]), [true, true, true]);
  });

  it("issues exactly the pair shape the share coalescer batches, both directions", async () => {
    const { client, reads } = fake([]);
    await readPairDirections(client, A, B);
    assert.deepEqual(reads, [
      [["select", ["blocker_id"]], ["eq", ["blocker_id", A]], ["eq", ["blocked_id", B]], ["limit", [1]]],
      [["select", ["blocker_id"]], ["eq", ["blocker_id", B]], ["eq", ["blocked_id", A]], ["limit", [1]]],
    ]);
    for (const c of reads) assert.equal(coalescableShape(c as any)?.kind, "pair");
  });

  it("a returned error, a malformed answer or a thrown read in EITHER direction is ok:false", async () => {
    for (const n of [0, 1]) {
      assert.equal((await readPairDirections(fake([], { answer: (_c, k) => (k === n ? { data: null, error: ERR } : undefined) }).client, A, B)).ok, false);
      for (const [, ans] of MALFORMED) {
        const r = await readPairDirections(fake([], { answer: (_c, k) => (k === n ? ans : undefined) }).client, A, B);
        assert.equal(r.ok, false);
        assert.equal(isExcluded(r, B), true);
      }
    }
    assert.equal((await readPairDirections({ from() { throw new Error("x"); } }, A, B)).ok, false);
    assert.equal((await readPairDirections(null, A, B)).ok, false);
    assert.equal((await readPairDirections(fake([]).client, A, "")).ok, false);
  });

  it("BATCH: twelve pairs read in one turn through the coalescing client are ONE query, each answered for its own pair", async () => {
    const owners = Array.from({ length: 12 }, (_, i) => id(300 + i));
    const rows: Row[] = [
      { blocker_id: owners[1], blocked_id: V },                                          // they blocked the viewer
      { blocker_id: V, blocked_id: owners[2] },                                          // the viewer blocked them
      { blocker_id: owners[3], blocked_id: V }, { blocker_id: V, blocked_id: owners[3] }, // mutual
    ];
    const { client, reads } = fake(rows);
    const stats = { issued: 0, coalesced: 0 };
    const batched = coalescingClient(client, stats);
    const out = await Promise.all(owners.map((o) => readPairDirections(batched, V, o)));
    assert.equal(stats.issued, 1, "one query for every pair in both directions");
    assert.equal(reads.length, 1);
    assert.deepEqual(out.map((r) => (r.ok ? [r.aBlockedB, r.bBlockedA] : "unreadable")).slice(0, 5), [[false, false], [false, true], [true, false], [true, true], [false, false]]);
  });

  it("BATCH failure: a batch that errors, or answers no row list, fails EVERY pair in it — none reads as clear", async () => {
    const owners = Array.from({ length: 5 }, (_, i) => id(400 + i));
    for (const ans of [{ data: null, error: ERR }, ...MALFORMED.map(([, a]) => a)]) {
      const batched = coalescingClient(fake([], { answer: () => ans }).client);
      const out = await Promise.all(owners.map((o) => readPairDirections(batched, V, o)));
      assert.deepEqual(out.map((r) => r.ok), owners.map(() => false), JSON.stringify(ans));
    }
  });
});

// ══ countBlockRows ════════════════════════════════════════════════════════════

describe("countBlockRows — a row count, or nothing", () => {
  const rows: Row[] = [
    { blocker_id: V, blocked_id: id(1), id: "r1" },
    { blocker_id: id(2), blocked_id: V, id: "r2" },
    { blocker_id: V, blocked_id: id(3), id: "r3" }, { blocker_id: id(3), blocked_id: V, id: "r4" },
    { blocker_id: id(5), blocked_id: id(6), id: "r5" },
  ];

  it("either / outgoing / incoming count ROWS — a mutual block is two", async () => {
    const { client } = fake(rows);
    assert.deepEqual(await countBlockRows(client, V, "either"), { ok: true, count: 4 });
    assert.deepEqual(await countBlockRows(client, V, "outgoing"), { ok: true, count: 2 });
    assert.deepEqual(await countBlockRows(client, V, "incoming"), { ok: true, count: 2 });
  });

  it("is a HEAD count (Postgres counts; the row cap does not apply), and `either` is the moderation dossier's own query", async () => {
    const { client, reads } = fake(rows, { cap: 1 });
    assert.deepEqual(await countBlockRows(client, V, "either"), { ok: true, count: 4 });
    assert.deepEqual(reads[0], [["select", ["id", { count: "exact", head: true }]], ["or", [`blocker_id.eq.${V},blocked_id.eq.${V}`]]]);
  });

  it("a returned error, a count-less answer, a count that is not a non-negative integer, or a thrown read is ok:false — never 0", async () => {
    for (const ans of [{ data: null, error: ERR }, { data: null, error: null }, { data: null, error: null, count: null }, { data: null, error: null, count: -1 }, { data: null, error: null, count: 1.5 }, { data: null, error: null, count: "3" as any }]) {
      assert.equal((await countBlockRows(fake(rows, { answer: () => ans }).client, V, "either")).ok, false, JSON.stringify(ans));
    }
    assert.equal((await countBlockRows({ from() { throw new Error("x"); } }, V, "outgoing")).ok, false);
    assert.equal((await countBlockRows(null, V, "either")).ok, false);
    assert.equal((await countBlockRows(fake(rows).client, V, "sideways" as any)).ok, false);
  });
});
