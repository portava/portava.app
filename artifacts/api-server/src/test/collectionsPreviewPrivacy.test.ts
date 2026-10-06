/**
 * A saved id is not a read grant — the collection-item PREVIEW for a Memory and
 * a Highlight takes the same answer as reading that Memory or Highlight.
 *
 * census-highlights-memories H81 / H91 / H189 (lane R, 2026-10-06).
 * `GET /users/me/collections/:id/items` resolves a title (and, for a Highlight,
 * a caption AND a media URL) for every saved entity through the SERVICE
 * client. `POST /saves` accepts any UUID. Before this change neither arm asked
 * whether the saver may still see the thing: a Memory or Highlight saved while
 * it was visible kept serving its text after the owner narrowed it, deleted it,
 * let it expire or blocked the saver, and an id learned anywhere else read a
 * private one outright.
 *
 * Every case asserts the SERVED PAYLOAD, both directions: the intended preview
 * is still served (owner; public; mutual follower), and each refusal withholds
 * the title and cover while keeping the row itself, so a withheld preview reads
 * exactly like an entity that no longer resolves.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import collectionsRouter from "../routes/collections.js";
import { decideHighlightViewAccess, decideHighlightViewAccessMany } from "../routes/highlights.js";

type Row = Record<string, unknown>;
interface FakeTable { rows: Row[]; failSelect?: boolean }
interface Result { data: unknown; error: unknown }

const SAVER = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";
const COL = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const M_ID = "a0000000-0000-0000-0000-000000000001";
const H_ID = "b0000000-0000-0000-0000-000000000001";

const FUTURE = new Date(Date.now() + 6 * 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();

/**
 * The query surface the routes under test call, and nothing more: equality,
 * membership and null filters, ordering and limits (no-ops here), and the two
 * terminal forms. A builder method the route starts calling that this fake does
 * not implement throws, which is louder than a fake that silently ignores it.
 */
interface Builder extends PromiseLike<Result> {
  select(cols?: string): Builder;
  eq(c: string, v: unknown): Builder;
  neq(c: string, v: unknown): Builder;
  in(c: string, vs: readonly unknown[]): Builder;
  is(c: string, v: unknown): Builder;
  not(c: string, op: string, v: unknown): Builder;
  order(c?: string, o?: unknown): Builder;
  limit(n: number): Builder;
  maybeSingle(): Promise<Result>;
  single(): Promise<Result>;
}

/**
 * A row as a SELECT returns it: the selected columns and nothing else
 * (verifier F3). A fake that hands back whole fixture rows cannot see a column
 * dropped from a select list — the gate would then read `undefined` and, for
 * `hidden_user_ids`, `?? []` would make the owner's hide list vacuous while
 * every case stayed green. `*` (or no list) returns the whole row.
 */
function project(row: Row, cols: string | null): Row {
  if (cols === null || cols.trim() === "*") return { ...row };
  const out: Row = {};
  for (const raw of cols.split(",")) {
    const c = raw.trim();
    if (c === "") continue;
    if (c.includes("(") || c.includes(":")) throw new Error(`fake: select expression ${c} is not modelled`);
    out[c] = row[c];
  }
  return out;
}

/** Every `from(table)` a request makes, in order — the query-count ceiling reads it (verifier F5). */
let fromCalls: string[] = [];

function makeClient(tables: Record<string, FakeTable>) {
  const db: Record<string, FakeTable> = { ...tables };
  function chain(name: string): Builder {
    fromCalls.push(name);
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let cols: string | null = null;
    async function run(one: boolean): Promise<Result> {
      const t = db[name] ?? { rows: [] };
      if (t.failSelect) return { data: null, error: { message: `${name} unreadable`, code: "XX000" } };
      let rows = t.rows.filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      const projected = rows.map((r) => project(r, cols));
      return { data: one ? (projected[0] ?? null) : projected, error: null };
    }
    const b: Builder = {
      select(c) { cols = c ?? null; return b; },
      eq(c, v) { filters.push((r) => r[c] === v); return b; },
      neq(c, v) { filters.push((r) => r[c] !== v); return b; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c, op, v) {
        if (op !== "is") throw new Error(`fake: not(${op}) is not implemented`);
        filters.push((r) => (r[c] ?? null) !== v);
        return b;
      },
      order() { return b; },
      limit(n) { limitN = n; return b; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(onF, onR) { return run(false).then(onF, onR); },
    };
    return b;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async (): Promise<Result> => ({ data: null, error: null }),
    auth: {
      getUser: async (token: string) =>
        token === "saver-token"
          ? { data: { user: { id: SAVER } }, error: null }
          : token === "owner-token"
            ? { data: { user: { id: OWNER } }, error: null }
            : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

function baseTables(viewer: string, entityType: "memory" | "highlight", entityId: string): Record<string, FakeTable> {
  return {
    collections: { rows: [{ id: COL, owner_id: viewer, name: "Saved", is_default: true, position: 0 }] },
    collection_items: {
      rows: [{ id: "i1", collection_id: COL, entity_type: entityType, entity_id: entityId, saved_at: "2026-10-01T00:00:00Z" }],
    },
    blocks: { rows: [] },
    user_follows: { rows: [] },
    trip_members: { rows: [] },
    trips: { rows: [] },
    circle_memberships: { rows: [] },
  };
}

function memoryRow(over: Row = {}): Row {
  return {
    id: M_ID, owner_id: OWNER, title: "Sunset at the old harbour", visibility: "public",
    state: "published", trip_id: null, allowed_user_ids: [], hidden_user_ids: [], ...over,
  };
}

function highlightRow(over: Row = {}): Row {
  return {
    id: H_ID, owner_id: OWNER, caption: "Night market crawl", media_url: "https://cdn.example/h.jpg",
    visibility: "public", expires_at: FUTURE, deleted_at: null, archived_at: null, ...over,
  };
}

let close: () => Promise<void> = async () => {};
afterEach(async () => { await close(); });

interface PreviewItem { id: string; entityType: string; entityId: string; title: string | null; coverUrl: string | null }

async function previews(tables: Record<string, FakeTable>, token: string): Promise<PreviewItem[]> {
  _setTestClient(makeClient(tables), true);
  fromCalls = [];
  const srv = createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  srv.unref();
  close = () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
  const { port } = srv.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/users/me/collections/${COL}/items`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, "the collection itself is the viewer's own and must still load");
  const body = await res.json() as { items: PreviewItem[] };
  return body.items;
}

describe("collection preview of a saved Memory — the §23 read gate decides", () => {
  it("the owner's own private Memory previews its title (intended case)", async () => {
    const t = baseTables(OWNER, "memory", M_ID);
    t.memories = { rows: [memoryRow({ visibility: "only_me" })] };
    const items = await previews(t, "owner-token");
    assert.equal(items[0].title, "Sunset at the old harbour");
  });

  it("another person's PUBLIC Memory previews its title (intended case)", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow()] };
    const items = await previews(t, "saver-token");
    assert.equal(items[0].title, "Sunset at the old harbour");
  });

  it("an only_me Memory saved by someone else shows NO title, and the row is kept", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow({ visibility: "only_me" })] };
    const items = await previews(t, "saver-token");
    assert.equal(items.length, 1);
    assert.equal(items[0].entityId, M_ID);
    assert.equal(items[0].title, null);
    assert.equal(items[0].coverUrl, null);
  });

  it("a PUBLIC Memory whose owner HID it from the saver shows no title (the hide list is read)", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow({ hidden_user_ids: [SAVER] })] };
    assert.equal((await previews(t, "saver-token"))[0].title, null);
  });

  it("friends_only previews only for a MUTUAL follower", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow({ visibility: "friends_only" })] };
    t.user_follows = { rows: [{ follower_id: OWNER, following_id: SAVER }] };
    assert.equal((await previews(t, "saver-token"))[0].title, null, "one-way follow is not friends");
    await close();
    t.user_follows = { rows: [{ follower_id: OWNER, following_id: SAVER }, { follower_id: SAVER, following_id: OWNER }] };
    assert.equal((await previews(t, "saver-token"))[0].title, "Sunset at the old harbour");
  });

  it("a PUBLIC Memory whose owner blocked the saver shows no title", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow()] };
    t.blocks = { rows: [{ blocker_id: OWNER, blocked_id: SAVER }] };
    assert.equal((await previews(t, "saver-token"))[0].title, null);
  });

  it("a PUBLIC Memory whose owner the SAVER blocked shows no title (both directions)", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow()] };
    t.blocks = { rows: [{ blocker_id: SAVER, blocked_id: OWNER }] };
    assert.equal((await previews(t, "saver-token"))[0].title, null);
  });

  it("an UNREADABLE blocks table withholds the title (fail closed)", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow()] };
    t.blocks = { rows: [], failSelect: true };
    assert.equal((await previews(t, "saver-token"))[0].title, null);
  });

  it("a DELETED public Memory shows no title", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow({ state: "deleted" })] };
    assert.equal((await previews(t, "saver-token"))[0].title, null);
  });

  it("the owner's own DELETED Memory shows no title either (GET /memories/:id answers not_found to its owner too)", async () => {
    const t = baseTables(OWNER, "memory", M_ID);
    t.memories = { rows: [memoryRow({ state: "deleted" })] };
    assert.equal((await previews(t, "owner-token"))[0].title, null);
  });

  it("an UNREADABLE memories table shows no title rather than failing the page", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow()], failSelect: true };
    const items = await previews(t, "saver-token");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, null);
  });
});

describe("collection preview of a saved Highlight — the single-Highlight routes' gate decides", () => {
  it("an active PUBLIC Highlight previews caption and media (intended case)", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow()] };
    const items = await previews(t, "saver-token");
    assert.equal(items[0].title, "Night market crawl");
    assert.equal(items[0].coverUrl, "https://cdn.example/h.jpg");
  });

  it("a PRIVATE Highlight saved by someone else serves neither caption nor media URL", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow({ visibility: "private" })] };
    const items = await previews(t, "saver-token");
    assert.equal(items.length, 1);
    assert.equal(items[0].title, null);
    assert.equal(items[0].coverUrl, null);
  });

  it("an EXPIRED Highlight serves no media URL", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow({ expires_at: PAST })] };
    assert.equal((await previews(t, "saver-token"))[0].coverUrl, null);
  });

  it("a DELETED Highlight serves no media URL", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow({ deleted_at: PAST })] };
    assert.equal((await previews(t, "saver-token"))[0].coverUrl, null);
  });

  it("a PUBLIC Highlight whose owner blocked the saver serves nothing", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow()] };
    t.blocks = { rows: [{ blocker_id: OWNER, blocked_id: SAVER }] };
    const items = await previews(t, "saver-token");
    assert.equal(items[0].title, null);
    assert.equal(items[0].coverUrl, null);
  });

  it("a PUBLIC Highlight whose owner the SAVER blocked serves nothing (both directions)", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow()] };
    t.blocks = { rows: [{ blocker_id: SAVER, blocked_id: OWNER }] };
    const items = await previews(t, "saver-token");
    assert.equal(items[0].title, null);
    assert.equal(items[0].coverUrl, null);
  });

  it("an UNREADABLE blocks table serves nothing (fail closed)", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow()] };
    t.blocks = { rows: [], failSelect: true };
    assert.equal((await previews(t, "saver-token"))[0].coverUrl, null);
  });

  it("circle_only previews only for a circle member", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow({ visibility: "circle_only" })] };
    assert.equal((await previews(t, "saver-token"))[0].coverUrl, null);
    await close();
    t.circle_memberships = { rows: [{ user_id: OWNER, other_id: SAVER }] };
    assert.equal((await previews(t, "saver-token"))[0].coverUrl, "https://cdn.example/h.jpg");
  });
});

// ── verifier F5: a fixed number of reads, whatever the page holds ──────────────

function pageOf(memories: number, highlights: number): Record<string, FakeTable> {
  const t = baseTables(SAVER, "memory", M_ID);
  const items: Row[] = [];
  const mRows: Row[] = [];
  const hRows: Row[] = [];
  const owners = ["22222222-2222-2222-2222-22222222220a", "22222222-2222-2222-2222-22222222220b", "22222222-2222-2222-2222-22222222220c"];
  for (let i = 0; i < memories; i++) {
    const id = `a0000000-0000-0000-0000-${String(1000 + i).padStart(12, "0")}`;
    mRows.push(memoryRow({ id, owner_id: owners[i % owners.length] }));
    items.push({ id: `im${i}`, collection_id: COL, entity_type: "memory", entity_id: id, saved_at: `2026-10-01T00:${String(i % 60).padStart(2, "0")}:00Z` });
  }
  for (let i = 0; i < highlights; i++) {
    const id = `b0000000-0000-0000-0000-${String(1000 + i).padStart(12, "0")}`;
    hRows.push(highlightRow({ id, owner_id: owners[i % owners.length] }));
    items.push({ id: `ih${i}`, collection_id: COL, entity_type: "highlight", entity_id: id, saved_at: `2026-10-02T00:${String(i % 60).padStart(2, "0")}:00Z` });
  }
  t.collection_items = { rows: items };
  t.memories = { rows: mRows };
  t.highlights = { rows: hRows };
  return t;
}

describe("collection preview — reads do not scale with the page (verifier F5)", () => {
  it("2 + 2 saved items and 20 + 20 saved items cost the SAME number of reads", async () => {
    const small = await previews(pageOf(2, 2), "saver-token");
    const smallCalls = fromCalls.length;
    await close();
    const large = await previews(pageOf(20, 20), "saver-token");
    const largeCalls = fromCalls.length;
    assert.equal(small.length, 4);
    assert.equal(large.length, 40);
    assert.ok(large.every((i) => i.title !== null), "control: every public row previews");
    assert.equal(largeCalls, smallCalls, `reads grew with the page: ${smallCalls} -> ${largeCalls} (${fromCalls.join(", ")})`);
    assert.ok(largeCalls <= 16, `a 40-item page made ${largeCalls} reads: ${fromCalls.join(", ")}`);
  });
});

// ── decideHighlightViewAccessMany answers what decideHighlightViewAccess answers ─

describe("the batched Highlight verdict is the single verdict, row by row", () => {
  // Delta verification N2 (2026-10-06): the §11 control, the §10 consent, the
  // `trip_only` rung and an unreadable circle read had no row here, and three
  // mutants of the batched verdict (withheld -> ok, sharesTrip always true,
  // unreadable circle read as membership) survived the whole file.
  it("public, private, expired, deleted, archived, circle member/non-member, trip_only shared/not, §11 KEEP_PRIVATE_FOREVER, §10 consent_share=false, blocked either way, own, missing", async () => {
    const OTHER = "33333333-3333-3333-3333-333333333333";
    const BLOCKER = "44444444-4444-4444-4444-444444444444";
    const BLOCKED = "55555555-5555-5555-5555-555555555555";
    const CIRCLE = "66666666-6666-6666-6666-666666666666";
    const TRIPMATE = "77777777-7777-7777-7777-777777777777";
    const TRIP = "88888888-8888-8888-8888-888888888888";
    const id = (n: number) => `b0000000-0000-0000-0000-${String(2000 + n).padStart(12, "0")}`;
    const rows: Row[] = [
      highlightRow({ id: id(1), owner_id: OTHER }),
      highlightRow({ id: id(2), owner_id: OTHER, visibility: "private" }),
      highlightRow({ id: id(3), owner_id: OTHER, expires_at: PAST }),
      highlightRow({ id: id(4), owner_id: OTHER, deleted_at: PAST }),
      highlightRow({ id: id(5), owner_id: OTHER, archived_at: PAST }),
      highlightRow({ id: id(6), owner_id: CIRCLE, visibility: "circle_only" }),
      highlightRow({ id: id(7), owner_id: OTHER, visibility: "circle_only" }),
      highlightRow({ id: id(8), owner_id: BLOCKER }),
      highlightRow({ id: id(9), owner_id: BLOCKED }),
      highlightRow({ id: id(10), owner_id: SAVER, visibility: "private" }),
      highlightRow({ id: id(11), owner_id: TRIPMATE, visibility: "trip_only" }),
      highlightRow({ id: id(12), owner_id: OTHER, visibility: "trip_only" }),
      highlightRow({ id: id(13), owner_id: OTHER }),
      highlightRow({ id: id(14), owner_id: OTHER }),
    ];
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows };
    t.blocks = { rows: [{ blocker_id: BLOCKER, blocked_id: SAVER }, { blocker_id: SAVER, blocked_id: BLOCKED }] };
    t.circle_memberships = { rows: [{ user_id: CIRCLE, other_id: SAVER }] };
    t.trips = { rows: [{ id: TRIP, owner_id: TRIPMATE }] };
    t.trip_members = {
      rows: [
        { trip_id: TRIP, user_id: SAVER, role: "member", status: "accepted" },
        { trip_id: TRIP, user_id: TRIPMATE, role: "owner", status: "accepted" },
      ],
    };
    t.highlight_resurfacing_preferences = {
      rows: [{ id: "r1", owner_id: OTHER, control: "KEEP_PRIVATE_FOREVER", subject_type: "highlight", subject_id: id(13) }],
    };
    t.highlight_projection_policies = {
      rows: [{ id: "p1", highlight_id: id(14), owner_id: OTHER, consent_share: false }],
    };
    const sc = makeClient(t) as unknown as Parameters<typeof decideHighlightViewAccess>[0];
    const ids = [...rows.map((r) => r.id as string), id(99)];
    const many = await decideHighlightViewAccessMany(sc, SAVER, ids);
    const summary = (v: Awaited<ReturnType<typeof decideHighlightViewAccess>> | undefined) =>
      v === undefined ? "absent" : v.ok ? "ok" : `${v.code}:${v.reason}`;
    const expected: Record<string, string> = {};
    const actual: Record<string, string> = {};
    for (const h of ids) {
      expected[h] = summary(await decideHighlightViewAccess(sc, SAVER, h));
      actual[h] = summary(many.get(h));
    }
    assert.deepEqual(actual, expected);
    // and the ladder is not vacuous on this fixture:
    assert.equal(expected[id(1)], "ok");
    assert.equal(expected[id(6)], "ok");
    assert.equal(expected[id(10)], "ok");
    assert.equal(expected[id(8)], "not_found:blocked");
    assert.equal(expected[id(9)], "not_found:blocked");
    assert.equal(expected[id(7)], "not_found:invisible");
    assert.equal(expected[id(99)], "not_found:missing");
    assert.equal(expected[id(11)], "ok", "trip_only, on a shared accepted trip");
    assert.equal(expected[id(12)], "not_found:invisible", "trip_only, no shared trip");
    assert.equal(expected[id(13)], "not_found:withheld", "§11 KEEP_PRIVATE_FOREVER on this Highlight");
    assert.equal(expected[id(14)], "not_found:withheld", "§10 consent_share = false on this Highlight");
  });

  it("an UNREADABLE circle_memberships read: a circle_only row is refused in both forms, a public one is not", async () => {
    const CIRCLE = "66666666-6666-6666-6666-666666666666";
    const id = (n: number) => `b0000000-0000-0000-0000-${String(4000 + n).padStart(12, "0")}`;
    const rows: Row[] = [
      highlightRow({ id: id(1), owner_id: CIRCLE, visibility: "circle_only" }),
      highlightRow({ id: id(2), owner_id: CIRCLE }),
    ];
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows };
    // The saver IS in the owner's circle — the read that would say so fails.
    t.circle_memberships = { rows: [{ user_id: CIRCLE, other_id: SAVER }], failSelect: true };
    const sc = makeClient(t) as unknown as Parameters<typeof decideHighlightViewAccess>[0];
    const many = await decideHighlightViewAccessMany(sc, SAVER, rows.map((r) => r.id as string));
    for (const r of rows) {
      const one = await decideHighlightViewAccess(sc, SAVER, r.id as string);
      const m = many.get(r.id as string);
      assert.deepEqual(m?.ok ? "ok" : m && `${m.code}:${m.reason}`, one.ok ? "ok" : `${one.code}:${one.reason}`, String(r.id));
    }
    const circleRow = many.get(id(1));
    assert.equal(circleRow?.ok, false, "an unreadable circle read is never membership");
    assert.equal(circleRow && !circleRow.ok && circleRow.reason, "invisible");
    assert.equal(many.get(id(2))?.ok, true);
  });

  it("an unreadable blocks read refuses every row the viewer does not own, in both forms", async () => {
    const t = baseTables(SAVER, "highlight", H_ID);
    t.highlights = { rows: [highlightRow(), highlightRow({ id: "b0000000-0000-0000-0000-000000003000", owner_id: SAVER })] };
    t.blocks = { rows: [], failSelect: true };
    const sc = makeClient(t) as unknown as Parameters<typeof decideHighlightViewAccess>[0];
    const many = await decideHighlightViewAccessMany(sc, SAVER, [H_ID, "b0000000-0000-0000-0000-000000003000"]);
    const one = await decideHighlightViewAccess(sc, SAVER, H_ID);
    assert.equal(one.ok, false);
    assert.equal(!one.ok && one.reason, "blocks_unreadable");
    const m = many.get(H_ID);
    assert.equal(m?.ok, false);
    assert.equal(m && !m.ok && m.reason, "blocks_unreadable");
    assert.equal(many.get("b0000000-0000-0000-0000-000000003000")?.ok, true, "the viewer's own row needs no blocks read");
  });
});

// ── verifier F4: a withheld preview is LOGGED, not silent ─────────────────────

describe("collection preview — an unreadable table is logged when its previews are withheld", () => {
  it("memories unreadable: the page still loads, previews are null, and one error line names the type", async () => {
    const t = baseTables(SAVER, "memory", M_ID);
    t.memories = { rows: [memoryRow()], failSelect: true };
    _setTestClient(makeClient(t), true);
    const errors: Array<{ obj: unknown; msg: string }> = [];
    const bare = express();
    bare.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
      Object.assign(req, { log: { error: (obj: unknown, msg: string) => { errors.push({ obj, msg }); }, info: () => {}, warn: () => {} } });
      next();
    });
    bare.use("/api", collectionsRouter);
    const srv = createServer(bare);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    srv.unref();
    close = () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
    const { port } = srv.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/users/me/collections/${COL}/items`, {
      headers: { Authorization: "Bearer saver-token" },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { items: PreviewItem[] };
    assert.equal(body.items[0]?.title, null);
    const line = errors.find((e) => /preview read failed/.test(e.msg));
    assert.ok(line, `no error line for the withheld previews: ${JSON.stringify(errors)}`);
    assert.equal((line.obj as { type?: string }).type, "memory");
  });
});

