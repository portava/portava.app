/**
 * A whole block list is read to its END — census-telegraph §98 (lane BLOCKS-2).
 *
 * node:test + node:assert. No database and no network: every read goes through
 * the REAL @supabase/supabase-js client (so the real postgrest-js builds each
 * URL and parses each response), whose `fetch` is a small PostgREST emulator
 * over in-memory rows. The emulator applies `db-max-rows` the way PostgREST
 * does: every response is cut at the cap, whatever `limit` asked for, with no
 * error and no flag. Supabase hosted ships 1000.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * `blocks` is an exclusion table: a ROW means DENY, so a MISSING row means
 * ALLOW. The whole-list readers asked for a viewer's block list in ONE
 * range-less read, so a viewer with more than 1,000 block relationships was
 * answered with the first 1,000 (in no particular order) and every block past
 * them read as "not blocked": `readBlockExclusions` without `among`,
 * `fetchBlockedSet` (≈60 call sites), `readGroupBlockExclusions` over a group,
 * and Compass's profile and per-tool hidden-user refresh. They now page by the
 * primary key (lib/keysetRead) to an EMPTY page, and above BLOCK_LIST_CEILING
 * answer UNREADABLE — never a prefix.
 *
 * ── AND ONE SHAPE THE REAL CLIENT PRODUCES ────────────────────────────────
 * postgrest-js resolves `{ data: null, error: null }` — no error — for a 404
 * with an EMPTY body (it rewrites it to 204 No Content) and for a 2xx with an
 * empty body. Section 5 drives that through the real client: `isBlockedBetween`
 * read it as "not blocked", `fetchBlockedSet` as "nobody is blocked", and
 * keysetRead as "the end of the set".
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/blockListKeysetPaging.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Namespace imports, so this suite LOADS against main's readers too (a symbol
// main lacks is `undefined`, failing only the cases that use it).
import * as exclusionSet from "../lib/exclusionSet.js";
import * as keyset from "../lib/keysetRead.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { isBlockedBetween } from "../lib/blockGuard.js";
import { getCompassProfile, clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";

const { readBlockExclusions, readGroupBlockExclusions, readPairExclusion } = exclusionSet;
/** The stated ceiling (census-telegraph §98). Pinned below; fixtures are sized from THIS, never from the module. */
const CEILING = 10_000;
const readBlockDirection: (sc: any, side: "blocker_id" | "blocked_id", userId: string) => Promise<{ data: any[] | null; error: any }> =
  (exclusionSet as any).readBlockDirection ?? (async () => { throw new Error("readBlockDirection does not exist on this tree"); });

type Row = Record<string, any>;

// ── ids ──────────────────────────────────────────────────────────────────────

/** A canonical lowercase uuid from a label. Hash order ≠ insertion order ≠ user order. */
function uuid(label: string): string {
  const h = createHash("sha1").update(label).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const VIEWER = uuid("viewer");
const user = (i: number) => uuid(`user-${i}`);

/**
 * `n` block relationships touching `viewer`: the viewer blocked the first
 * ⌈n/2⌉ users, the rest blocked the viewer. Plus noise rows between strangers
 * that the filter must exclude. Returns the rows and the expected counter-party set.
 */
function blockList(n: number, viewer = VIEWER, tag = "r"): { rows: Row[]; expected: Set<string> } {
  const rows: Row[] = [];
  const expected = new Set<string>();
  for (let i = 0; i < n; i++) {
    const other = user(i);
    expected.add(other);
    const outbound = i < Math.ceil(n / 2);
    rows.push({
      id: uuid(`${tag}-block-${viewer}-${i}`),
      blocker_id: outbound ? viewer : other,
      blocked_id: outbound ? other : viewer,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    });
  }
  for (let i = 0; i < 300; i++) {
    rows.push({ id: uuid(`${tag}-noise-${i}`), blocker_id: uuid(`stranger-a-${i}`), blocked_id: uuid(`stranger-b-${i}`), created_at: new Date(Date.UTC(2025, 0, 1)).toISOString() });
  }
  return { rows, expected };
}

// ── a PostgREST emulator behind the real client ─────────────────────────────

interface ServerOpts {
  /** PostgREST `db-max-rows`. Default 1000, the hosted value. */
  maxRows?: number;
  /** A server that drops the `id=gt.` cursor (a protocol violation the reader must not loop on). */
  ignoreCursor?: boolean;
  /**
   * Answer the n-th request to `table` (1-based) with this instead: a Response, "throw" for a rejected fetch, "abort"
   * for an aborted one. `cursor` is true for a keyset page past the first (the request carries `id=gt.`).
   */
  fault?: (table: string, n: number, cursor: boolean) => Response | "throw" | "abort" | undefined;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const cmp = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** One PostgREST filter term `col.op.value` (or a nested and(…)/or(…)) as a row predicate. */
function term(t: string): (r: Row) => boolean {
  const logic = t.match(/^(and|or)\((.*)\)$/s);
  if (logic) {
    const parts = splitTop(logic[2]).map(term);
    return logic[1] === "and" ? (r) => parts.every((p) => p(r)) : (r) => parts.some((p) => p(r));
  }
  const m = t.match(/^([a-z_]+)\.(eq|neq|gt|gte|lt|lte|in|is)\.(.*)$/s);
  if (!m) throw new Error(`emulator: unsupported filter "${t}"`);
  const [, col, op, raw] = m;
  switch (op) {
    case "eq": return (r) => String(r[col]) === raw;
    case "neq": return (r) => String(r[col]) !== raw;
    case "gt": return (r) => cmp(r[col], raw) > 0;
    case "gte": return (r) => cmp(r[col], raw) >= 0;
    case "lt": return (r) => cmp(r[col], raw) < 0;
    case "lte": return (r) => cmp(r[col], raw) <= 0;
    case "is": return (r) => (r[col] ?? null) === (raw === "null" ? null : raw);
    default: { const vals = raw.replace(/^\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, "")); return (r) => vals.includes(String(r[col])); }
  }
}

function postgrest(tables: Record<string, Row[]>, opts: ServerOpts = {}) {
  const calls: Record<string, number> = {};
  const fetchImpl = async (input: any, init?: any): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    calls[table] = (calls[table] ?? 0) + 1;
    const f = opts.fault?.(table, calls[table], (url.searchParams.get("id") ?? "").startsWith("gt."));
    if (f === "throw") throw new TypeError("fetch failed");
    if (f === "abort") throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    if (f) return f;
    if (table.startsWith("rpc/")) return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    let rows = (tables[table] ?? []).slice();
    let order: { col: string; asc: boolean } | null = null;
    let limit = Number.POSITIVE_INFINITY;
    let select: string[] | null = null;
    for (const [k, v] of url.searchParams) {
      if (k === "select") { select = v === "*" ? null : v.split(",").map((c) => c.trim()); continue; }
      if (k === "order") { const [col, dir] = v.split("."); order = { col, asc: dir !== "desc" }; continue; }
      if (k === "limit") { limit = Number(v); continue; }
      if (k === "offset") continue;
      if (k === "or" || k === "and") { rows = rows.filter(term(`${k}${v}`)); continue; }
      if (opts.ignoreCursor && k === "id" && v.startsWith("gt.")) continue;
      if (rows.length === 0) continue; // an empty table answers [] whatever it is asked
      rows = rows.filter(term(`${k}.${v}`));
    }
    if (order) { const o = order; rows.sort((a, b) => cmp(a[o.col], b[o.col]) * (o.asc ? 1 : -1)); }
    const matched = rows.length;
    rows = rows.slice(0, Math.min(limit, opts.maxRows ?? 1000));
    const body = rows.map((r) => (select ? Object.fromEntries(select.map((c) => [c, r[c]])) : r));
    const headers = { "content-type": "application/json", "content-range": `0-${Math.max(0, body.length - 1)}/${matched}` };
    if ((init?.method ?? "GET") === "HEAD") return new Response(null, { status: 200, headers });
    const accept = String((init?.headers instanceof Headers ? init.headers.get("Accept") : init?.headers?.Accept) ?? "");
    if (accept.includes("vnd.pgrst.object")) {
      return body.length === 1
        ? new Response(JSON.stringify(body[0]), { status: 200, headers })
        : new Response(JSON.stringify({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }), { status: 406, headers });
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  const client = createClient("http://127.0.0.1:9", "dummy", {
    global: { fetch: fetchImpl as any },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { client, calls };
}

const blocksServer = (rows: Row[], opts: ServerOpts = {}) => postgrest({ blocks: rows }, opts);
const EMPTY_404 = () => new Response("", { status: 404 });
const EMPTY_200 = () => new Response("", { status: 200 });
const ERROR_500 = () => new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });

function idsOf(set: exclusionSet.ExclusionSet): Set<string> {
  assert.equal(set.ok, true, `expected a readable set, got ${JSON.stringify(set)}`);
  return new Set((set as { ids: ReadonlySet<string> }).ids);
}
function sameSet(actual: Set<string>, expected: Set<string>, what: string): void {
  const missed = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  assert.equal(missed.length, 0, `${what}: ${missed.length} of ${expected.size} block relationships MISSED (read as "not blocked")`);
  assert.equal(extra.length, 0, `${what}: ${extra.length} ids that are not counter-parties`);
}

// ══ 1. the whole list, at and around the cap ════════════════════════════════

describe("whole-list reads return EVERY block relationship, at and past db-max-rows (1000)", () => {
  for (const n of [0, 1, 149, 150, 999, 1000, 1001, 2500]) {
    it(`${n} relationships: readBlockExclusions(viewer) is the full set`, async () => {
      const { rows, expected } = blockList(n);
      const { client } = blocksServer(rows);
      sameSet(idsOf(await readBlockExclusions(client, VIEWER)), expected, `readBlockExclusions, ${n} rows`);
    });
    it(`${n} relationships: fetchBlockedSet(viewer) is the full set`, async () => {
      const { rows, expected } = blockList(n);
      const { client } = blocksServer(rows);
      const set = await fetchBlockedSet(client as any, VIEWER);
      assert.ok(set, "a readable list must not be null");
      sameSet(set, expected, `fetchBlockedSet, ${n} rows`);
    });
  }

  it("a server cap BELOW the page size (db-max-rows 400) still reads the whole list — a short page is not the end", async () => {
    const { rows, expected } = blockList(2500);
    const { client, calls } = blocksServer(rows, { maxRows: 400 });
    sameSet(idsOf(await readBlockExclusions(client, VIEWER)), expected, "cap 400");
    assert.equal(calls.blocks, 1 + Math.ceil(2500 / 400) + 1, "the range-less read, seven pages of at most 400, and one empty page");
  });

  it("mutual blocks collapse to one id; both directions count", async () => {
    const other = user(7);
    const rows = [
      { id: uuid("m1"), blocker_id: VIEWER, blocked_id: other },
      { id: uuid("m2"), blocker_id: other, blocked_id: VIEWER },
      ...blockList(1200).rows.filter((r) => r.blocker_id !== VIEWER && r.blocked_id !== VIEWER),
    ];
    const ids = idsOf(await readBlockExclusions(blocksServer(rows).client, VIEWER));
    assert.deepEqual([...ids], [other]);
  });
});

// ══ 2. the cost is bounded ══════════════════════════════════════════════════

describe("the number of round trips is bounded: 1 under 150 rows, else 1 + ⌈rows / 1000⌉ + 1 at the hosted cap, at most 12", () => {
  // Measured, and pinned. Under 150 rows the range-less read every caller
  // always made is the whole answer (db-max-rows is at least 150 wherever this
  // module is correct). At 150 or more it may be a prefix, so the list is read
  // again by keyset to an EMPTY page.
  const expectedCalls: Record<number, number> = { 0: 1, 1: 1, 149: 1, 150: 3, 999: 3, 1000: 3, 1001: 4, 2500: 5 };
  for (const [n, want] of Object.entries(expectedCalls)) {
    it(`${n} relationships → ${want} read(s) of \`blocks\``, async () => {
      const { client, calls } = blocksServer(blockList(Number(n)).rows);
      await readBlockExclusions(client, VIEWER);
      assert.equal(calls.blocks ?? 0, want);
    });
  }

  it(`the ceiling is the stated ${CEILING} rows`, () => {
    assert.equal((exclusionSet as any).BLOCK_LIST_CEILING, CEILING);
  });

  it(`exactly the ceiling (${CEILING}) is read whole, in ${CEILING / 1000 + 2} reads`, async () => {
    const { rows, expected } = blockList(CEILING);
    const { client, calls } = blocksServer(rows);
    sameSet(idsOf(await readBlockExclusions(client, VIEWER)), expected, "at the ceiling");
    assert.equal(calls.blocks, CEILING / 1000 + 2);
  });

  it(`one past the ceiling is UNREADABLE — never the first ${CEILING} passed off as the list — and the walk stops`, async () => {
    const { rows } = blockList(CEILING + 1);
    const { client, calls } = blocksServer(rows);
    const set = await readBlockExclusions(client, VIEWER);
    assert.equal(set.ok, false, "a list past the ceiling must not be served as complete");
    assert.match((set as any).reason, /ceiling/);
    assert.ok(calls.blocks <= CEILING / 1000 + 2, `bounded: ${calls.blocks} reads`);
    assert.equal(exclusionSet.isExcluded(set, user(0)), true, "an unreadable list excludes everybody");
    const viaLegacy = blocksServer(rows);
    assert.equal(await fetchBlockedSet(viaLegacy.client as any, VIEWER), null, "fetchBlockedSet answers null (show nobody)");
    const dir = await readBlockDirection(blocksServer(blockList(2 * CEILING + 2).rows).client, "blocker_id", VIEWER);
    assert.equal(dir.data, null);
    assert.ok(dir.error, "a direction past the ceiling is { data: null, error }");
  });
});

// ══ 3. a failure on ANY page is unreadable — never the pages read so far ════

describe("a failure on a later page of a 2,500-row list is unreadable, not the rows read before it", () => {
  const faults: Array<[string, () => Response | "throw" | "abort"]> = [
    ["a returned error (500)", ERROR_500],
    ["an aborted fetch (postgrest-js never retries one)", () => "abort"],
    ["a 404 with an empty body (postgrest-js: data null, error null)", EMPTY_404],
    ["a 200 with an empty body (postgrest-js: data null, error null)", EMPTY_200],
  ];
  for (const [what, answer] of faults) {
    it(`${what}: readBlockExclusions and fetchBlockedSet`, async () => {
      const { rows } = blockList(2500);
      const fault = (t: string, _n: number, cursor: boolean) => (t === "blocks" && cursor ? answer() : undefined);
      const set = await readBlockExclusions(blocksServer(rows, { fault }).client, VIEWER);
      assert.equal(set.ok, false, `${what} on page 2 must not leave page 1 standing as the list`);
      assert.equal(await fetchBlockedSet(blocksServer(rows, { fault }).client as any, VIEWER), null);
    });
  }

  it("CONTROL: one rejected fetch on page 2 is retried by postgrest-js (GET is idempotent) and the list is still read WHOLE", async () => {
    const { rows, expected } = blockList(2500);
    let cursorRequests = 0;
    const { client, calls } = blocksServer(rows, { fault: (t, _n, cursor) => (t === "blocks" && cursor && ++cursorRequests === 1 ? "throw" : undefined) });
    sameSet(idsOf(await readBlockExclusions(client, VIEWER)), expected, "after one retried page");
    assert.equal(calls.blocks, 6, "the range-less read, four pages, and the one retried request");
  });

  it("a server that ignores the cursor is unreadable at its first repeated page, not looped to the ceiling", async () => {
    const { client, calls } = blocksServer(blockList(1500).rows, { ignoreCursor: true });
    const set = await readBlockExclusions(client, VIEWER);
    assert.equal(set.ok, false);
    assert.equal(calls.blocks, 3, "the range-less read, page 1, and page 1 again");
  });

  it("keysetRead itself: a non-list page mid-walk, and an ignored cursor, are ok:false (the helper every whole read shares)", async () => {
    const { rows } = blockList(2500);
    const build = (sc: any) => () => sc.from("blocks").select("id").or(`blocker_id.eq.${VIEWER},blocked_id.eq.${VIEWER}`);
    const nullPage = blocksServer(rows, { fault: (_t, n) => (n === 2 ? EMPTY_404() : undefined) });
    const r1 = await keyset.readAllByIdKeyset(build(nullPage.client), 5000);
    assert.equal(r1.ok, false, "a page that is not a row list is not the end of the set");
    const deaf = blocksServer(rows, { ignoreCursor: true });
    const r2 = await keyset.readAllByIdKeyset(build(deaf.client), 5000);
    assert.equal(r2.ok, false, "a cursor the server ignored is a failed read, not 5,000 copies of page 1");
    assert.ok((deaf.calls.blocks ?? 0) <= 2, `stopped at the first repeat (${deaf.calls.blocks} reads)`);
    const healthy = await keyset.readAllByIdKeyset(build(blocksServer(rows).client), 5000);
    assert.ok(healthy.ok && healthy.rows.length === 2500 && !healthy.truncated, "CONTROL: the healthy walk is whole");
  });
});

// ══ 4. the group read and the two Compass sites ═════════════════════════════

describe("the group read and Compass's two direction reads are whole too", () => {
  it("readGroupBlockExclusions over 3 members with 2,500 relationships between them and others", async () => {
    const members = [uuid("member-0"), uuid("member-1"), uuid("member-2")];
    const rows: Row[] = [];
    const expected = new Set<string>();
    for (let i = 0; i < 2500; i++) {
      const m = members[i % 3];
      const other = user(10_000 + i);
      expected.add(other);
      rows.push(i % 2 === 0
        ? { id: uuid(`g-${i}`), blocker_id: m, blocked_id: other }
        : { id: uuid(`g-${i}`), blocker_id: other, blocked_id: m });
    }
    rows.push({ id: uuid("g-inner"), blocker_id: members[0], blocked_id: members[1] }); // a member blocking a member stays out of the set
    const { client } = blocksServer(rows);
    sameSet(idsOf(await readGroupBlockExclusions(client, members)), expected, "group of 3");
  });

  it("readBlockDirection: each direction of a 2,500-row list is whole and keeps its own side", async () => {
    const { rows } = blockList(2500);
    const { client } = blocksServer(rows);
    const out = await readBlockDirection(client, "blocker_id", VIEWER);
    const inb = await readBlockDirection(client, "blocked_id", VIEWER);
    assert.equal(out.error, null);
    assert.equal(inb.error, null);
    assert.equal(out.data!.length, 1250);
    assert.equal(inb.data!.length, 1250);
    // Each row names its counter-party in the column the site maps (blocked_id for blocks SENT, blocker_id for RECEIVED).
    sameSet(new Set(out.data!.map((r) => String(r.blocked_id))), new Set(Array.from({ length: 1250 }, (_, i) => user(i))), "blocks sent");
    sameSet(new Set(inb.data!.map((r) => String(r.blocker_id))), new Set(Array.from({ length: 1250 }, (_, i) => user(1250 + i))), "blocks received");
    const failed = await readBlockDirection(blocksServer(rows, { fault: (_t, _n, cursor) => (cursor ? EMPTY_404() : undefined) }).client, "blocker_id", VIEWER);
    assert.equal(failed.data, null, "a page that is not a row list is never a prefix");
    assert.ok(failed.error);
  });

  it("Compass profile: blockedUserIds and blockerUserIds hold all 1,500 + 1,000 rows, not the first 1,000 of each", async () => {
    clearCompassProfileCache();
    const rows: Row[] = [];
    for (let i = 0; i < 1500; i++) rows.push({ id: uuid(`p-out-${i}`), blocker_id: VIEWER, blocked_id: user(i) });
    for (let i = 0; i < 1000; i++) rows.push({ id: uuid(`p-in-${i}`), blocker_id: user(20_000 + i), blocked_id: VIEWER });
    const { client } = postgrest({ blocks: rows });
    const profile = await getCompassProfile(client as any, VIEWER, true);
    assert.equal(new Set(profile.blockedUserIds).size, 1500, "every user the viewer blocked");
    assert.equal(new Set(profile.blockerUserIds).size, 1000, "every user who blocked the viewer");
    clearCompassProfileCache();
  });

  it("Compass profile: a page that is not a row list REFUSES the profile (fail closed), never builds it from a prefix", async () => {
    clearCompassProfileCache();
    const rows: Row[] = [];
    for (let i = 0; i < 1500; i++) rows.push({ id: uuid(`q-out-${i}`), blocker_id: VIEWER, blocked_id: user(i) });
    const { client } = postgrest({ blocks: rows }, { fault: (t, _n, cursor) => (t === "blocks" && cursor ? EMPTY_404() : undefined) });
    await assert.rejects(getCompassProfile(client as any, VIEWER, true), /safety-list load failed/);
    clearCompassProfileCache();
  });
});

// ── get_whos_around through refreshHiddenUsers ──────────────────────────────

const ALICE = uuid("alice");
const EVE = uuid("eve");
const BOB = uuid("bob");
const TRIP = uuid("trip");

/** An in-memory client for every table but `blocks` (the compass-social.test.ts pattern). */
function memoryClient(db: Record<string, Row[]>) {
  const builder = (rows: Row[]) => {
    let filtered = [...rows];
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] === v); return b; },
      neq: (c: string, v: any) => { filtered = filtered.filter((r) => r[c] !== v); return b; },
      in: (c: string, v: any[]) => { filtered = filtered.filter((r) => v.includes(r[c])); return b; },
      is: (c: string, v: any) => { filtered = filtered.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gte: () => b, lte: () => b, gt: () => b, lt: () => b, ilike: () => b, like: () => b, or: () => b, not: () => b, order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } }),
      then: (resolve: any, reject?: any) => Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
    };
    return b;
  };
  return { from: (t: string) => builder(db[t] ?? []), rpc: () => Promise.resolve({ data: null, error: null }) };
}

describe("Compass get_whos_around re-reads the hidden set WHOLE (refreshHiddenUsers)", () => {
  it("Eve's block row is the 1,500th: she is hidden, and Bob (not blocked) is shown", async () => {
    // Eve's row is inserted LAST, so a range-less read (insertion order, cut at 1000) misses it.
    const blocks: Row[] = [];
    for (let i = 0; i < 1499; i++) blocks.push({ id: uuid(`w-${i}`), blocker_id: ALICE, blocked_id: user(30_000 + i) });
    blocks.push({ id: uuid("w-eve"), blocker_id: ALICE, blocked_id: EVE });
    const real = blocksServer(blocks).client;
    const now = new Date().toISOString();
    const presence = (id: string) => ({ user_id: id, context_type: "trip", context_id: TRIP, status: "arrived", status_label: "Grabbing dinner", approximate_label: "Lahug area", venue_label: "Secret Exact Bar", checked_in: false, stale_after_secs: 999999, last_seen_at: now, expires_at: null, is_stale: false, needs_help: false });
    const sharing = (id: string) => ({ user_id: id, global_enabled: true, visibility_mode: "status_only", trip_sharing_default: "approximate_area", event_sharing_default: "status_only", is_paused: false, consent_version: "v1", consented_at: "2026-07-01T00:00:00Z" });
    const mem = memoryClient({
      feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
      trips: [{ id: TRIP, title: "Cebu Trip", destination_city: "Cebu", status: "active", owner_id: ALICE, start_date: "2026-07-18", end_date: "2026-07-28" }],
      trip_members: [ALICE, BOB, EVE].map((id, i) => ({ trip_id: TRIP, user_id: id, role: i === 0 ? "owner" : "member", status: "accepted" })),
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice" },
        { id: BOB, handle: "bob", name: "Bob" },
        { id: EVE, handle: "eve", name: "Eve" },
      ],
      circle_visibility_settings: [sharing(BOB), sharing(EVE)],
      circle_presence: [presence(BOB), presence(EVE)],
    });
    const hybrid = { from: (t: string) => (t === "blocks" ? real.from("blocks") : mem.from(t)), rpc: mem.rpc } as any;
    const stale = { userId: ALICE, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
    const result: any = await executeCompassTool(hybrid, ALICE, stale, "get_whos_around", {});
    const handles = (result.people ?? []).map((p: any) => p.handle);
    assert.deepEqual(handles, ["@bob"], `Eve (block row 1,500 of 1,500) must be hidden; got ${JSON.stringify(result)}`);
  });
});

// ══ 5. `{ data: null, error: null }` is a REAL client outcome ══════════════

describe("the real client resolves { data: null, error: null } for an empty-bodied 404 or 2xx — and that is never 'not blocked'", () => {
  const A = uuid("a"), B = uuid("b");

  it("the premise: postgrest-js really resolves a .limit(1) list read to data null, error null on a 404 with an empty body", async () => {
    const { client } = blocksServer([], { fault: () => EMPTY_404() });
    const res = await client.from("blocks").select("blocker_id").or(`and(blocker_id.eq.${A},blocked_id.eq.${B})`).limit(1);
    assert.equal(res.error, null);
    assert.equal(res.data, null);
    assert.equal(res.status, 204, "postgrest-js rewrites an empty 404 to 204 No Content (its issue #295 workaround)");
  });

  for (const [what, answer] of [["404, empty body", EMPTY_404], ["200, empty body", EMPTY_200]] as const) {
    it(`isBlockedBetween: ${what} → blocked (deny), not "not blocked"`, async () => {
      assert.equal(await isBlockedBetween(blocksServer([], { fault: () => answer() }).client, A, B), true);
    });
    it(`readPairExclusion and fetchBlockedSet: ${what} → unreadable`, async () => {
      assert.equal((await readPairExclusion(blocksServer([], { fault: () => answer() }).client, A, B)).ok, false);
      assert.equal(await fetchBlockedSet(blocksServer([], { fault: () => answer() }).client as any, A), null);
      assert.equal((await readBlockExclusions(blocksServer([], { fault: () => answer() }).client, A)).ok, false);
    });
  }

  it("CONTROLS on the real client: a blocked pair is blocked, an unblocked pair is not, both directions", async () => {
    const { client } = blocksServer([{ id: uuid("ab"), blocker_id: B, blocked_id: A }]);
    assert.equal(await isBlockedBetween(client, A, B), true);
    assert.equal(await isBlockedBetween(client, B, A), true);
    assert.equal(await isBlockedBetween(client, A, uuid("c")), false);
    assert.equal(await isBlockedBetween(blocksServer([]).client, A, B), false);
    assert.deepEqual([...idsOf(await readBlockExclusions(client, A))], [B]);
  });
});
