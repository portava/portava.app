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
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

type Row = Record<string, any>;
interface FakeTable { rows: Row[]; failSelect?: boolean }

const SAVER = "11111111-1111-1111-1111-111111111111";
const OWNER = "22222222-2222-2222-2222-222222222222";
const COL = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const M_ID = "a0000000-0000-0000-0000-000000000001";
const H_ID = "b0000000-0000-0000-0000-000000000001";

const FUTURE = new Date(Date.now() + 6 * 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();

function makeClient(tables: Record<string, FakeTable>) {
  const db: Record<string, FakeTable> = { ...tables };
  function chain(name: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let one = false;
    const obj: any = {
      select() { return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      gte(c: string, v: any) { filters.push((r) => r[c] >= v); return obj; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return obj; },
      not(c: string, op: string, v: any) { if (op === "is") filters.push((r) => (r[c] ?? null) !== v); return obj; },
      order() { return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { one = true; return run(); },
      single() { one = true; return run(); },
      then(f: any, r: any) { return run().then(f, r); },
    };
    async function run(): Promise<{ data: any; error: any }> {
      const t = db[name] ?? { rows: [] };
      if (t.failSelect) return { data: null, error: { message: `${name} unreadable`, code: "XX000" } };
      let rows = t.rows.filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: one ? (rows[0] ?? null) : rows, error: null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: null }),
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

async function previews(tables: Record<string, FakeTable>, token: string): Promise<any[]> {
  _setTestClient(makeClient(tables), true);
  const srv = createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  srv.unref();
  close = () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
  const { port } = srv.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/api/users/me/collections/${COL}/items`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, "the collection itself is the viewer's own and must still load");
  const body = await res.json() as { items: any[] };
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

describe("collection preview of a saved Highlight — GET /highlights/:id's gate decides", () => {
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
