/**
 * census-telegraph §94 / T220c — the two WHOLE-LIST block reads of record,
 * `readBlockExclusions(sc, viewer)` (no `among`) and `fetchBlockedSet(sc, user)`,
 * read the viewer's block list WHOLE, by key — never the prefix PostgREST cut.
 *
 * node:test + node:assert. In-process fake, no database, no network.
 *
 * Both were ONE range-less `.or()` read. PostgREST cuts every answer at its
 * `db-max-rows` (1,000 hosted) and says nothing: no error, no flag. A viewer
 * with more block rows than the cap got a prefix, and every block past the cut
 * was not excluded — on every surface that consults these two (search, maps,
 * feeds, discovery, Compass, airport, follows, rent-a-buddy, trails, …).
 *
 * The first request is still that read (plus its exact count since T220d), so
 * no caller can tell the difference under the cap. An answer shorter than its
 * count — or, with no count, as long as a page — may have been cut, so the list
 * is read again by the primary key, `id`, with `{ count: "exact" }` on every
 * page. The fake below cuts every response at a server row cap the way
 * db-max-rows does, and answers `{ count: "exact" }` the way PostgREST does (the
 * rows that match every filter, the key cursor included, before the cut), so
 * "never a prefix" is MEASURED: each cut case first shows the fake cutting the
 * plain read the old code made, then shows the reader past it. Each case says
 * whether it was RED or GREEN on the code before T220c (a85d2eb78).
 *
 * Run: node --import tsx/esm --test src/test/blockWholeListPagingT220c.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readBlockExclusions, isExcluded } from "../lib/exclusionSet.js";
import { fetchBlockedSet } from "../lib/blocks.js";

const V = "a0000000-0000-4000-a000-0000000000c0";
const id = (n: number) => `b0000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const rowId = (n: number) => `c0000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

type Row = { id: string; blocker_id: string; blocked_id: string };
type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: number | null };

interface FakeOpts {
  /** PostgREST's db-max-rows: every response is cut to this many rows, with no error. */
  cap?: number;
  /** Leave `count` out of every answer even when it was asked for. */
  noCount?: boolean;
  /** Ignore these filter methods (a server or builder that drops the key cursor). */
  ignore?: ReadonlySet<string>;
  /** Override read `n` (from 0): return an Answer to replace it, or throw. */
  answer?: (calls: Call[], n: number) => Answer | undefined;
}

/** A table-driven `blocks` that filters, orders, limits, cuts at a cap and counts the way PostgREST does. */
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
        if (m === "in") return (v as string[]).includes(r[c]);
        if (m === "gt") return String(r[c]) > String(v);
        if (m === "or") return String(a[0]).split(",").some((t) => { const [col, op, val] = t.split("."); return op === "eq" && (r as any)[col] === val; });
        return true;
      }));
      const ord = calls.find(([m]) => m === "order");
      if (ord) { const c = ord[1][0] as keyof Row; out = [...out].sort((x, y) => (String(x[c]) < String(y[c]) ? -1 : String(x[c]) > String(y[c]) ? 1 : 0)); }
      const total = out.length;
      const lim = calls.find(([m]) => m === "limit");
      if (lim) out = out.slice(0, lim[1][0] as number);
      if (o.cap !== undefined) out = out.slice(0, o.cap);
      const count = opts.count === "exact" && !o.noCount ? total : null;
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

/**
 * `n` block rows touching V, alternating direction, keyed rowId(0..n-1) in key
 * order — with a MUTUAL pair at rows 999 / 1000 (two rows naming the same
 * counter-party, id(999)) that straddles the boundary of a 1,000-row page — plus
 * two rows that are not V's.
 */
function touching(n: number): Row[] {
  const rows: Row[] = Array.from({ length: n }, (_, i) => (i % 2 === 0
    ? { id: rowId(i), blocker_id: V, blocked_id: id(i) }
    : { id: rowId(i), blocker_id: id(i), blocked_id: V }));
  if (n > 1_000) rows[1_000] = { id: rowId(1_000), blocker_id: V, blocked_id: id(999) }; // mutual with row 999
  rows.push({ id: rowId(900_001), blocker_id: id(900_001), blocked_id: id(900_002) }, { id: rowId(900_002), blocker_id: id(900_002), blocked_id: id(900_001) });
  return rows;
}
/** The distinct counter-parties of touching(n). */
function counterpartiesOf(n: number): string[] {
  return [...new Set(touching(n).filter((r) => r.blocker_id === V || r.blocked_id === V).map((r) => (r.blocker_id === V ? r.blocked_id : r.blocker_id)))].sort();
}
const N = 1_005;
const HOSTED_CAP = 1_000;

/** The read both functions used to make, issued raw against the fake: what the old code saw. */
async function oldRead(client: any) {
  return client.from("blocks").select("blocker_id, blocked_id").or(`blocker_id.eq.${V},blocked_id.eq.${V}`);
}

const ERR = { message: "simulated blocks failure", code: "57014" };
const MALFORMED: Array<[string, Answer]> = [
  ["data: null with no error", { data: null, error: null }],
  ["a string", { data: "rows", error: null }],
  ["an object", { data: { rows: [] }, error: null }],
];

describe("T220c — readBlockExclusions (whole list): WHOLE, by key, never a prefix", () => {
  it("CONTROL: under the cap it is ONE request — the `.or()` read it always made, plus its exact count (T220d; byte for byte before)", async () => {
    const { client, reads } = fake(touching(7));
    const r = await readBlockExclusions(client, V);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([...r.ids].sort(), counterpartiesOf(7));
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0], [
      ["select", ["blocker_id, blocked_id", { count: "exact" }]],
      ["or", [`blocker_id.eq.${V},blocked_id.eq.${V}`]],
    ]);
  });

  it("RED before: past the hosted row cap (1,000) it pages by key to the WHOLE list — where the one range-less read stopped at the cap", async () => {
    const { client, reads } = fake(touching(N), { cap: HOSTED_CAP });
    const naive = await oldRead(client);
    assert.equal(naive.data.length, HOSTED_CAP, "the fake cuts the old read as PostgREST does");
    assert.equal(naive.error, null, "and says nothing");
    reads.length = 0;
    const r = await readBlockExclusions(client, V);
    assert.ok(r.ok, JSON.stringify(r));
    const want = counterpartiesOf(N);
    assert.equal(want.length, N - 1, "1,005 rows, one mutual pair: 1,004 people");
    assert.deepEqual([...r.ids].sort(), want, "every block past the cap is still excluded");
    assert.equal(isExcluded(r, id(1_004)), true, "the last row's counter-party");
    assert.equal(isExcluded(r, id(900_001)), false, "a stranger's block is not the viewer's");
    assert.equal(reads.length, 3, "the plain read, then two keyed pages");
    for (const page of reads.slice(1)) {
      assert.deepEqual(page[0], ["select", ["id, blocker_id, blocked_id", { count: "exact" }]], "every page is the same scope, keyed by the PRIMARY key, counted");
      assert.ok(page.some(([m, a]) => m === "or" && a[0] === `blocker_id.eq.${V},blocked_id.eq.${V}`));
      assert.ok(page.some(([m, a]) => m === "order" && a[0] === "id"));
    }
  });

  it("RED before: with NO count in any answer, a page-long answer is still never taken as the whole list", async () => {
    const { client } = fake(touching(N), { cap: HOSTED_CAP, noCount: true });
    assert.equal((await oldRead(client)).data.length, HOSTED_CAP);
    const r = await readBlockExclusions(client, V);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ids.size, N - 1);
  });

  it("RED before: a cut it cannot page past (the server ignores the key cursor) is ok:false — never the prefix it got", async () => {
    const r = await readBlockExclusions(fake(touching(N), { cap: HOSTED_CAP, ignore: new Set(["gt"]) }).client, V);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
    assert.equal(isExcluded(r, id(3)), true, "an unreadable set excludes everybody");
  });

  it("RED before: a page that comes back EMPTY while its count says rows remain is ok:false", async () => {
    const r = await readBlockExclusions(fake(touching(N), {
      cap: HOSTED_CAP,
      answer: (_c, n) => (n === 2 ? { data: [], error: null, count: 5 } : undefined),
    }).client, V);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
  });

  it("GREEN before and after: a returned error on the first read is ok:false", async () => {
    const r = await readBlockExclusions(fake(touching(N), { cap: HOSTED_CAP, answer: (_c, k) => (k === 0 ? { data: null, error: ERR } : undefined) }).client, V);
    assert.equal(r.ok, false);
  });
  for (const n of [1, 2]) {
    it(`RED before: a returned error on keyed page ${n} is ok:false`, async () => {
      const r = await readBlockExclusions(fake(touching(N), { cap: HOSTED_CAP, answer: (_c, k) => (k === n ? { data: null, error: ERR } : undefined) }).client, V);
      assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
    });
  }

  for (const [name, ans] of MALFORMED) {
    it(`RED before: a keyed page answering ${name} is ok:false`, async () => {
      const r = await readBlockExclusions(fake(touching(N), { cap: HOSTED_CAP, answer: (_c, k) => (k === 2 ? ans : undefined) }).client, V);
      assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
    });
  }

  it("RED before: a row on a later page that does not name both parties is ok:false (a DENY we cannot attribute is not dropped)", async () => {
    const r = await readBlockExclusions(fake(touching(N), {
      cap: HOSTED_CAP,
      answer: (_c, k) => (k === 2 ? { data: [{ id: rowId(1_000), blocker_id: V }], error: null, count: 1 } : undefined),
    }).client, V);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
  });

  it("RED before: a thrown keyed page is ok:false (never rejects); GREEN before: a thrown first read is too", async () => {
    for (const n of [0, 2]) {
      const r = await readBlockExclusions(fake(touching(N), { cap: HOSTED_CAP, answer: (_c, k) => { if (k === n) throw new Error("socket hang up"); return undefined; } }).client, V);
      assert.equal(r.ok, false, `read ${n}: ${JSON.stringify(r).slice(0, 200)}`);
    }
  });
});

describe("T220c — fetchBlockedSet: the same whole read, in its Set | null shape", () => {
  it("CONTROL: under the cap — one request, the plain read plus its exact count (T220d); a Set of every counter-party (both directions), never the caller", async () => {
    const { client, reads } = fake(touching(7));
    const s = await fetchBlockedSet(client, V);
    assert.ok(s instanceof Set);
    assert.deepEqual([...s].sort(), counterpartiesOf(7));
    assert.ok(!s.has(V));
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0], [["select", ["blocker_id, blocked_id", { count: "exact" }]], ["or", [`blocker_id.eq.${V},blocked_id.eq.${V}`]]]);
  });

  it("GREEN before and after: nobody blocked is a readable EMPTY Set, not null", async () => {
    const s = await fetchBlockedSet(fake([]).client, V);
    assert.ok(s instanceof Set);
    assert.equal(s.size, 0);
  });

  it("RED before: past the hosted row cap the Set is WHOLE — where the one range-less read returned the first 1,000", async () => {
    const { client } = fake(touching(N), { cap: HOSTED_CAP });
    assert.equal((await oldRead(client)).data.length, HOSTED_CAP, "the fake cuts the old read");
    const s = await fetchBlockedSet(client, V);
    assert.ok(s instanceof Set, String(s));
    assert.deepEqual([...s].sort(), counterpartiesOf(N), "every block past the cap is in the set");
  });

  it("RED before: a cut it cannot page past is null (show nobody) — never the prefix", async () => {
    assert.equal(await fetchBlockedSet(fake(touching(N), { cap: HOSTED_CAP, ignore: new Set(["gt"]) }).client, V), null);
  });

  it("GREEN before and after: a returned error is null, and a thrown read is null (the contract it always had)", async () => {
    assert.equal(await fetchBlockedSet(fake(touching(7), { answer: () => ({ data: null, error: ERR }) }).client, V), null);
    assert.equal(await fetchBlockedSet(fake(touching(7), { answer: () => { throw new Error("boom"); } }).client, V), null);
  });

  for (const [name, ans] of MALFORMED) {
    it(`${name === "an object" ? "GREEN before (a TypeError reached its catch)" : "RED before"}: an answer that is ${name} is null — not an empty "nobody is blocked" Set`, async () => {
      assert.equal(await fetchBlockedSet(fake(touching(7), { answer: () => ans }).client, V), null);
    });
  }

  it("RED before: a row that does not name both parties is null — not a Set holding `undefined`", async () => {
    const s = await fetchBlockedSet(fake([], { answer: () => ({ data: [{ blocker_id: V }], error: null }) }).client, V);
    assert.equal(s, null);
  });
});
