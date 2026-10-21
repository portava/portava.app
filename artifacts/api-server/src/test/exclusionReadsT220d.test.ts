/**
 * census-telegraph §94 / T220d — the three reads T220c left: a group's block
 * list cut at the row cap, the whole-list block read's first request with no
 * count, and the moderation dossier's restrictCount rendered 0 from a read that
 * measured nothing.
 *
 * node:test + node:assert. In-process fakes; the dossier cases listen on
 * 127.0.0.1 (run with loopback allowed).
 *
 *   1. readGroupBlockExclusions (lib/exclusionSet.ts) was two unpaged `.in()`
 *      reads over a group's members. PostgREST cuts every answer at db-max-rows
 *      (1,000 hosted) and says nothing, so a member who blocked more than the
 *      cap — or one blocked by more than the cap — gave the group a prefix, and
 *      the people past the cut were recommended to the group. Each side is now
 *      read WHOLE, by the primary key, with counts.
 *   2. readBlockExclusions' whole-list first request (and so fetchBlockedSet)
 *      carried no count. At the hosted cap that was exact — a page-long answer
 *      is re-read by key — but a server whose db-max-rows is BELOW the page size
 *      (1,000) answered a short, cut list that read as the whole one. The first
 *      request now carries `{ count: "exact" }`, so an answer short of its count
 *      is read again by key, whatever the cap.
 *   3. The dossier's restrictCount read `user_restrictions` inline and rendered
 *      `count ?? 0`. It is now countRestrictRows (a HEAD exact count; every
 *      failure ok:false), so a count-less or failed answer refuses the record
 *      naming restrictCount — the dossier's way of saying "unknown" — as
 *      blockCount and muteCount already do. Never 0.
 *
 * The blocks fake filters, orders, limits, cuts at a server row cap and counts
 * the way PostgREST does (the rows that match every filter, the key cursor
 * included, before the cut), so "never a prefix" is MEASURED: each cut case
 * first shows the fake cutting the read the old code made, with no error. Each
 * case says whether it was RED or GREEN on the code before T220d (f3e5314ea).
 *
 * Run: node --import tsx/esm --test src/test/exclusionReadsT220d.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readGroupBlockExclusions, readBlockExclusions, countRestrictRows, isExcluded } from "../lib/exclusionSet.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

type Row = { id: string; blocker_id: string; blocked_id: string };
type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: unknown };

interface FakeOpts {
  /** PostgREST's db-max-rows: every response is cut to this many rows, with no error. */
  cap?: number;
  /** Leave `count` out of every answer even when it was asked for. */
  noCount?: boolean;
  /** Ignore these filter methods (a server or builder that drops the key cursor). */
  ignore?: ReadonlySet<string>;
  /** Override one read: return an Answer to replace it, or throw. `n` counts reads from 0. */
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

const uuid = (prefix: string, n: number) => `${prefix}000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const HOSTED_CAP = 1_000;
const ERR = { message: "simulated blocks failure", code: "57014" };
const MALFORMED: Array<[string, Answer]> = [
  ["data: null with no error", { data: null, error: null }],
  ["a string", { data: "rows", error: null }],
  ["an object", { data: { rows: [] }, error: null }],
];

/** Which side of the group read a request is: the members as blockers, or as the blocked. */
const sideOf = (calls: Call[]) => (calls.some(([m, a]) => m === "in" && a[0] === "blocker_id") ? "asBlocker" : calls.some(([m, a]) => m === "in" && a[0] === "blocked_id") ? "asBlocked" : "other");
const isKeyedPage = (calls: Call[]) => calls.some(([m]) => m === "gt");

// ══ 1. readGroupBlockExclusions — each side WHOLE, by the primary key ════════

const M0 = uuid("a0", 1);
const M1 = uuid("a0", 2);
const M2 = uuid("a0", 3);
const MEMBERS = [M0, M1, M2];
const MUTUAL = uuid("e0", 1);
const S1 = uuid("f0", 1);
const S2 = uuid("f0", 2);
const out = (i: number) => uuid("b0", i);   // someone M0 blocked
const inb = (i: number) => uuid("d0", i);   // someone who blocked M1

/**
 * A group's block rows: M0 blocked `nOut` people, `nIn` people blocked M1, M2
 * blocked M0 (a member-member block — members stay), M0 and MUTUAL blocked each
 * other (two rows, one person), and a stranger's block (not the group's). Row
 * ids interleave the two sides in key order, so a page of either side holds
 * rows the other side also has to page past.
 */
function groupRows(nOut: number, nIn: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < nOut; i++) rows.push({ id: uuid("c1", i * 2), blocker_id: M0, blocked_id: out(i) });
  for (let i = 0; i < nIn; i++) rows.push({ id: uuid("c1", i * 2 + 1), blocker_id: inb(i), blocked_id: M1 });
  rows.push(
    { id: uuid("c2", 1), blocker_id: M2, blocked_id: M0 },
    { id: uuid("c2", 2), blocker_id: M0, blocked_id: MUTUAL },
    { id: uuid("c2", 3), blocker_id: MUTUAL, blocked_id: M0 },
    { id: uuid("c2", 4), blocker_id: S1, blocked_id: S2 },
  );
  return rows;
}
function groupWant(nOut: number, nIn: number): string[] {
  return [...Array.from({ length: nOut }, (_, i) => out(i)), ...Array.from({ length: nIn }, (_, i) => inb(i)), MUTUAL].sort();
}
/** The two reads the group helper used to make, issued raw against the fake: what the old code saw. */
async function oldGroupReads(client: any) {
  return Promise.all([
    client.from("blocks").select("blocker_id, blocked_id").in("blocker_id", MEMBERS),
    client.from("blocks").select("blocker_id, blocked_id").in("blocked_id", MEMBERS),
  ]);
}

describe("T220d — readGroupBlockExclusions: each side WHOLE, by the primary key, never a prefix", () => {
  it("GREEN before (CONTROL): a small group's union of both directions, members dropped, strangers out — one request per side", async () => {
    const { client, reads } = fake(groupRows(4, 3));
    const r = await readGroupBlockExclusions(client, MEMBERS);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([...r.ids].sort(), groupWant(4, 3));
    for (const m of MEMBERS) assert.equal(r.ids.has(m), false, "a member never excludes a member");
    assert.equal(isExcluded(r, S1), false, "a stranger's block is not the group's");
    assert.equal(reads.length, 2, "one request per side under the cap");
  });

  it("RED before (shape): each side's first request is the side's read with its key and its exact count", async () => {
    const { client, reads } = fake(groupRows(2, 2));
    assert.ok((await readGroupBlockExclusions(client, MEMBERS)).ok);
    const shapes = reads.map((c) => JSON.stringify(c)).sort();
    assert.deepEqual(shapes, [
      JSON.stringify([["select", ["id, blocker_id, blocked_id", { count: "exact" }]], ["in", ["blocked_id", MEMBERS]]]),
      JSON.stringify([["select", ["id, blocker_id, blocked_id", { count: "exact" }]], ["in", ["blocker_id", MEMBERS]]]),
    ]);
  });

  it("RED before: a member who blocked MORE than the hosted cap — every one of them is excluded for the group, where the unpaged read stopped at 1,000", async () => {
    const { client, reads } = fake(groupRows(1_005, 3), { cap: HOSTED_CAP });
    const [oldOut] = await oldGroupReads(client);
    assert.equal(oldOut.data.length, HOSTED_CAP, "the fake cuts the old read as PostgREST does");
    assert.equal(oldOut.error, null, "and says nothing");
    reads.length = 0;
    const r = await readGroupBlockExclusions(client, MEMBERS);
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    assert.deepEqual([...r.ids].sort(), groupWant(1_005, 3));
    assert.equal(isExcluded(r, out(1_004)), true, "the last person past the cut");
    const keyed = reads.filter(isKeyedPage);
    assert.ok(keyed.length >= 1, "the cut side was read again by key");
    for (const page of reads.filter((c) => c.some(([m]) => m === "order"))) {
      assert.deepEqual(page[0], ["select", ["id, blocker_id, blocked_id", { count: "exact" }]], "every page keyed by the PRIMARY key and counted");
      assert.ok(page.some(([m, a]) => m === "order" && a[0] === "id"));
    }
  });

  it("RED before: a member blocked BY more than the hosted cap — every blocker is excluded for the group", async () => {
    const { client } = fake(groupRows(3, 1_005), { cap: HOSTED_CAP });
    const [, oldIn] = await oldGroupReads(client);
    assert.equal(oldIn.data.length, HOSTED_CAP, "the fake cuts the old read");
    const r = await readGroupBlockExclusions(client, MEMBERS);
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    assert.deepEqual([...r.ids].sort(), groupWant(3, 1_005));
    assert.equal(isExcluded(r, inb(1_004)), true);
  });

  it("RED before: BOTH sides past the cap at once — the whole union", async () => {
    const r = await readGroupBlockExclusions(fake(groupRows(2_010, 1_500), { cap: HOSTED_CAP }).client, MEMBERS);
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    assert.equal(r.ids.size, 2_010 + 1_500 + 1);
  });

  for (const cap of [999, 300]) {
    it(`RED before: a server whose db-max-rows is ${cap} — BELOW the page size — is paged through by count, never taken as the end`, async () => {
      const { client } = fake(groupRows(1_005, 1_005), { cap });
      const [oldOut, oldIn] = await oldGroupReads(client);
      assert.equal(oldOut.data.length, cap, "the old read got a prefix");
      assert.equal(oldIn.data.length, cap);
      const r = await readGroupBlockExclusions(client, MEMBERS);
      assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
      assert.deepEqual([...r.ids].sort(), groupWant(1_005, 1_005));
    });
  }

  it("RED before: with NO count in any answer, a page-long side is still never taken as the whole side", async () => {
    const { client } = fake(groupRows(1_005, 3), { cap: HOSTED_CAP, noCount: true });
    const r = await readGroupBlockExclusions(client, MEMBERS);
    assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
    assert.deepEqual([...r.ids].sort(), groupWant(1_005, 3));
  });

  it("RED before: a cut it cannot page past (the server ignores the key cursor) is ok:false — never the prefix", async () => {
    const r = await readGroupBlockExclusions(fake(groupRows(1_005, 3), { cap: HOSTED_CAP, ignore: new Set(["gt"]) }).client, MEMBERS);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
    assert.equal(isExcluded(r, out(3)), true, "an unreadable set excludes everybody");
  });

  it("RED before: a keyed page that comes back EMPTY while its count says rows remain is ok:false", async () => {
    const r = await readGroupBlockExclusions(fake(groupRows(1_005, 3), {
      cap: HOSTED_CAP,
      answer: (calls) => (isKeyedPage(calls) ? { data: [], error: null, count: 5 } : undefined),
    }).client, MEMBERS);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  });

  it("RED before: a keyed page that repeats a key already read is ok:false", async () => {
    const rows = groupRows(1_005, 3);
    const r = await readGroupBlockExclusions(fake(rows, {
      cap: HOSTED_CAP,
      answer: (calls) => (isKeyedPage(calls) ? { data: [{ ...rows[0] }], error: null, count: 1 } : undefined),
    }).client, MEMBERS);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  });

  it("RED before: a returned error on a keyed page is ok:false", async () => {
    const r = await readGroupBlockExclusions(fake(groupRows(3, 1_005), {
      cap: HOSTED_CAP,
      answer: (calls) => (isKeyedPage(calls) ? { data: null, error: ERR } : undefined),
    }).client, MEMBERS);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  });

  for (const [name, ans] of MALFORMED) {
    it(`RED before: a keyed page answering ${name} is ok:false`, async () => {
      const r = await readGroupBlockExclusions(fake(groupRows(1_005, 3), { cap: HOSTED_CAP, answer: (calls) => (isKeyedPage(calls) ? ans : undefined) }).client, MEMBERS);
      assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
    });
  }

  it("RED before: a row on a keyed page that does not name its counter-party is ok:false (a DENY we cannot attribute is not dropped)", async () => {
    const r = await readGroupBlockExclusions(fake(groupRows(1_005, 3), {
      cap: HOSTED_CAP,
      answer: (calls) => (isKeyedPage(calls) && sideOf(calls) === "asBlocker" ? { data: [{ id: uuid("c9", 1), blocker_id: M0 }], error: null, count: 1 } : undefined),
    }).client, MEMBERS);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  });

  it("RED before: a thrown keyed page is ok:false (never rejects)", async () => {
    const r = await readGroupBlockExclusions(fake(groupRows(1_005, 3), {
      cap: HOSTED_CAP,
      answer: (calls) => { if (isKeyedPage(calls)) throw new Error("socket hang up"); return undefined; },
    }).client, MEMBERS);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  });

  it("GREEN before: a returned error, a thrown read or a non-list on a FIRST request is ok:false, on either side", async () => {
    for (const side of ["asBlocker", "asBlocked"]) {
      for (const make of [() => ({ data: null, error: ERR }), () => { throw new Error("boom"); }, () => ({ data: null, error: null })] as Array<() => Answer>) {
        const r = await readGroupBlockExclusions(fake(groupRows(3, 3), { answer: (calls) => (sideOf(calls) === side ? make() : undefined) }).client, MEMBERS);
        assert.equal(r.ok, false, `${side}: ${JSON.stringify(r).slice(0, 200)}`);
      }
    }
  });

  it("GREEN before (CONTROL): no members is a readable empty set and reads nothing; no client is ok:false", async () => {
    const { client, reads } = fake(groupRows(3, 3));
    const r = await readGroupBlockExclusions(client, []);
    assert.ok(r.ok);
    assert.equal(r.ids.size, 0);
    assert.equal(reads.length, 0);
    assert.equal((await readGroupBlockExclusions(null, MEMBERS)).ok, false);
  });
});

// ══ 2. readBlockExclusions / fetchBlockedSet — the first request is counted ══

const V = uuid("a1", 0);
const vRowId = (n: number) => uuid("c3", n);
const vOther = (n: number) => uuid("b1", n);
/** `n` block rows touching V, alternating direction, plus a stranger's block. */
function touching(n: number): Row[] {
  const rows: Row[] = Array.from({ length: n }, (_, i) => (i % 2 === 0
    ? { id: vRowId(i), blocker_id: V, blocked_id: vOther(i) }
    : { id: vRowId(i), blocker_id: vOther(i), blocked_id: V }));
  rows.push({ id: vRowId(900_001), blocker_id: S1, blocked_id: S2 });
  return rows;
}
const vWant = (n: number) => Array.from({ length: n }, (_, i) => vOther(i)).sort();
/** The first request as T220c sent it — the plain `.or()` read with NO count. */
async function uncountedFirstRead(client: any) {
  return client.from("blocks").select("blocker_id, blocked_id").or(`blocker_id.eq.${V},blocked_id.eq.${V}`);
}

describe("T220d — readBlockExclusions (whole list): the first request carries its exact count, so a cap BELOW the page size cannot cut it", () => {
  it("RED before (shape): the first request is the `.or()` read plus `{ count: \"exact\" }` — one request under the cap", async () => {
    const { client, reads } = fake(touching(7));
    const r = await readBlockExclusions(client, V);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([...r.ids].sort(), vWant(7));
    assert.deepEqual(reads, [[["select", ["blocker_id, blocked_id", { count: "exact" }]], ["or", [`blocker_id.eq.${V},blocked_id.eq.${V}`]]]]);
  });

  for (const [cap, n] of [[500, 1_005], [999, 1_000], [3, 7]] as Array<[number, number]>) {
    it(`RED before: db-max-rows ${cap} (below the page size), ${n} rows — the WHOLE list, where the uncounted first read's ${cap}-row answer read as the whole list`, async () => {
      const { client, reads } = fake(touching(n), { cap });
      const naive = await uncountedFirstRead(client);
      assert.equal(naive.data.length, cap, "the fake cuts the uncounted read");
      assert.equal(naive.error, null, "with no error");
      assert.equal(naive.count, null, "and no count to say so — shorter than a page, it looked whole");
      reads.length = 0;
      const r = await readBlockExclusions(client, V);
      assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
      assert.deepEqual([...r.ids].sort(), vWant(n), "every block past the cut is still excluded");
      assert.ok(reads.length >= 2, "an answer short of its count is read again by key");
    });
  }

  it("CONTROL: a cap below the page size with a list SHORTER than the cap is still one request", async () => {
    const { client, reads } = fake(touching(7), { cap: 500 });
    const r = await readBlockExclusions(client, V);
    assert.ok(r.ok);
    assert.equal(r.ids.size, 7);
    assert.equal(reads.length, 1);
  });

  it("RED before: a cut below the page size that cannot be paged past (the cursor is ignored) is ok:false — it was the 500-row prefix", async () => {
    const r = await readBlockExclusions(fake(touching(1_005), { cap: 500, ignore: new Set(["gt"]) }).client, V);
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
    assert.equal(isExcluded(r, vOther(3)), true, "an unreadable set excludes everybody");
  });
});

describe("T220d — fetchBlockedSet: the same counted first request, in its Set | null shape", () => {
  for (const [cap, n] of [[500, 1_005], [999, 1_000]] as Array<[number, number]>) {
    it(`RED before: db-max-rows ${cap}, ${n} rows — the WHOLE Set, where the uncounted read answered ${cap}`, async () => {
      const { client } = fake(touching(n), { cap });
      assert.equal((await uncountedFirstRead(client)).data.length, cap);
      const s = await fetchBlockedSet(client, V);
      assert.ok(s instanceof Set, String(s));
      assert.deepEqual([...s].sort(), vWant(n));
    });
  }

  it("RED before: a cap below the page size it cannot page past is null (show nobody) — never the prefix", async () => {
    assert.equal(await fetchBlockedSet(fake(touching(1_005), { cap: 500, ignore: new Set(["gt"]) }).client, V), null);
  });
});

// ══ 3. the moderation dossier's restrictCount (countRestrictRows) ════════════

const ADMIN = "a1111111-1111-4111-8111-1111111220d0";
const TARGET = "ab000000-0000-4000-a000-0000000220d0";
const RERR = { message: "simulated user_restrictions failure", code: "57014" };

type RestrictMode =
  | { kind: "healthy"; count: number }
  | { kind: "error" }
  | { kind: "throw" }
  | { kind: "count"; count: unknown };

/** A permissive world for the dossier: `user_restrictions` per `mode`, every other read empty and healthy. */
function dossierWorld(mode: RestrictMode, restrictReads?: Call[][]) {
  function builder(table: string) {
    const calls: Call[] = [];
    const answer = (single: boolean): Answer => {
      if (table === "user_restrictions") {
        restrictReads?.push(calls);
        if (mode.kind === "error") return { data: null, error: RERR, count: null };
        if (mode.kind === "throw") throw new Error("simulated thrown user_restrictions read");
        const sel = calls.find(([m]) => m === "select");
        const opts = (sel?.[1][1] ?? {}) as { count?: string; head?: boolean };
        const count = mode.count;
        return { data: opts.head ? null : [], error: null, count };
      }
      if (table === "profiles") return { data: single ? { id: TARGET, role: "admin", handle: "target", account_status: "active" } : [], error: null };
      if (table === "blocks" || table === "user_mutes") return { data: null, error: null, count: 0 };
      return { data: single ? null : [], error: null, count: single ? null : 0 };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve().then(() => answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve().then(() => answer(true));
        return (...args: unknown[]) => { calls.push([prop, args]); return b; };
      },
    });
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: ADMIN } }, error: null }) },
  } as any;
}

function serve(router: express.Router) {
  let server: http.Server;
  let base = "";
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use(router);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => server.close());
  return async (path: string, client: any): Promise<{ status: number; body: any }> => {
    _setTestClient(client, true);
    _setTestServiceClient(client);
    const r = await fetch(`${base}${path}`, { headers: { authorization: "Bearer fake.jwt.token" } });
    const text = await r.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
}

const COUNTLESS: unknown[] = [null, undefined, -1, 1.5, "3", Number.NaN];

describe("T220d — the moderation dossier's restrictCount: a count-less or failed answer is unknown, never 0", () => {
  const get = serve(adminRouter);
  const summary = (c: any) => get(`/admin/users/${TARGET}/summary`, c);

  it("GREEN before (CONTROL): counts the user's restrictions and renders the record", async () => {
    const r = await summary(dossierWorld({ kind: "healthy", count: 4 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.restrictCount, 4);
  });
  it("GREEN before (CONTROL): nobody restricted is a measured 0", async () => {
    const r = await summary(dossierWorld({ kind: "healthy", count: 0 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.restrictCount, 0);
  });
  it("GREEN before: a returned error refuses the record and names restrictCount", async () => {
    const r = await summary(dossierWorld({ kind: "error" }));
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /restrictCount/);
  });
  for (const count of COUNTLESS) {
    it(`RED before: a HEAD answer with count ${typeof count === "string" ? JSON.stringify(count) : String(count)} and no error refuses the record, naming restrictCount — it rendered the record (${count == null ? "restrictCount 0" : "a count nothing measured"})`, async () => {
      const r = await summary(dossierWorld({ kind: "count", count }));
      assert.notEqual(r.status, 200, `a count-less restrictions answer rendered a record: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "db_error");
      assert.match(JSON.stringify(r.body), /restrictCount/);
      assert.equal(r.body?.restrictCount, undefined, "no count is shown at all");
    });
  }
  it("RED before: a THROWN restrictions count is the same named refusal — not a bare 500", async () => {
    const r = await summary(dossierWorld({ kind: "throw" }));
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /restrictCount/);
  });
});

describe("T220d — countRestrictRows: the count's definition of record", () => {
  it("a HEAD exact count of the rows the user WROTE (restrictor_id) — one request", async () => {
    const reads: Call[][] = [];
    const r = await countRestrictRows(dossierWorld({ kind: "healthy", count: 2 }, reads), TARGET);
    assert.deepEqual(r, { ok: true, count: 2 });
    assert.deepEqual(reads, [[["select", ["id", { count: "exact", head: true }]], ["eq", ["restrictor_id", TARGET]]]]);
  });
  it("a measured 0 is ok:true, count 0", async () => {
    assert.deepEqual(await countRestrictRows(dossierWorld({ kind: "healthy", count: 0 }), TARGET), { ok: true, count: 0 });
  });
  for (const mode of [{ kind: "error" }, { kind: "throw" }, ...COUNTLESS.map((count) => ({ kind: "count", count }))] as RestrictMode[]) {
    it(`${mode.kind === "count" ? `a count of ${typeof mode.count === "string" ? JSON.stringify(mode.count) : String(mode.count)}` : `a ${mode.kind === "error" ? "returned error" : "thrown read"}`} → ok:false (never rejects, never 0)`, async () => {
      const r = await countRestrictRows(dossierWorld(mode), TARGET);
      assert.equal(r.ok, false, JSON.stringify(r));
    });
  }
  it("no client or no user → ok:false", async () => {
    assert.equal((await countRestrictRows(null, TARGET)).ok, false);
    assert.equal((await countRestrictRows(dossierWorld({ kind: "healthy", count: 1 }), "")).ok, false);
  });
});
