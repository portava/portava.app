/**
 * feedReads — census-media §47: the reads the media and post feeds make for
 * counts and the viewer's own state answer "could not read" as itself.
 *
 *   FR1  a read that RESOLVES an error is { ok: false }, never an empty set or 0
 *   FR2  a server whose row cap is BELOW the page size is paged through by key,
 *        not taken as the end (the count each page carries says rows remain)
 *   FR3  a page that comes back empty while its count says rows remain is a CUT
 *        read, not the rows gathered so far
 *   FR4  a page that repeats a key already read is a cut read
 *   FR5  a read past maxRows is a cut read
 *   FR6  without a count, a short page is the last (and a full one is not)
 *   FR7  countRowsPerId counts exactly past 1,000 rows and gives every id an
 *        entry; an error on a LATER page fails the whole count
 *   FR8  the REAL supabase-js client pages by key: order=id.asc, id=gt.<last>,
 *        limit, Prefer count=exact — and gathers every row over several pages
 *   FR9  viewerRowIds / readWholeColumn / exactCount: failure is { ok: false }
 *   FR10 FailedSources names each source once and spreads to {} when healthy
 *   FR11 with a plain first read: a whole answer (count == rows) is ONE request
 *   FR12 with a plain first read: a cut answer (rows < count) is read again by key
 *   FR13 with a plain first read and no count: short is whole; a full page is not
 *   FR14 with a plain first read: its error fails the read
 *
 * Run: node --import tsx/esm --test src/test/feedReads.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readWhole,
  countRowsPerId,
  viewerRowIds,
  readWholeColumn,
  exactCount,
  known,
  FailedSources,
  WHOLE_READ_CUT,
  type KeyedPage,
} from "../lib/feedReads.js";
import { makeOracle } from "./helpers/postgrestOracle.js";

const pad = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

/** A keyed table served the way PostgREST serves it, with a row cap. */
function servedTable(rows: Array<{ id: string }>, opts: { cap?: number; withCount?: boolean } = {}) {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pages: Array<string | null> = [];
  const page: KeyedPage = async (after, size) => {
    pages.push(after);
    const remaining = sorted.filter((r) => after === null || r.id > after);
    const served = remaining.slice(0, Math.min(size, opts.cap ?? Infinity));
    return { data: served, error: null, count: opts.withCount === false ? null : remaining.length };
  };
  return { page, pages };
}

describe("readWhole (census-media §47)", () => {
  it("FR1 — a resolved error is { ok: false }, never the empty answer", async () => {
    const r = await readWhole(async () => ({ data: null, error: { message: "boom", code: "57014" } }), (x: any) => x.id);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.message, "boom");
      assert.equal(r.error.code, "57014");
    }
  });

  it("FR2 — a row cap below the page size is paged through by key", async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => ({ id: pad(i + 1) }));
    const t = servedTable(rows, { cap: 1_000 });
    const r = await readWhole(t.page, (x: any) => x.id, { pageSize: 5_000 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.length, 2_500);
    assert.deepEqual(t.pages, [null, pad(1_000), pad(2_000)]);
  });

  it("FR3 — an empty page while rows remain is a cut read", async () => {
    let n = 0;
    const r = await readWhole(async () => {
      n++;
      return n === 1
        ? { data: [{ id: pad(1) }], error: null, count: 3 }
        : { data: [], error: null, count: 2 };
    }, (x: any) => x.id, { pageSize: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, WHOLE_READ_CUT);
  });

  it("FR4 — a page that repeats a key already read is a cut read, caught on that page", async () => {
    let pages = 0;
    const r = await readWhole(async () => { pages++; return { data: [{ id: pad(1) }], error: null, count: 5 }; }, (x: any) => x.id, { pageSize: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, WHOLE_READ_CUT);
    assert.equal(pages, 2, "the repeat is refused on the page that repeats, not 100,000 rows later");
  });

  it("FR5 — a read past maxRows is a cut read, not the rows so far", async () => {
    const t = servedTable(Array.from({ length: 50 }, (_, i) => ({ id: pad(i + 1) })));
    const r = await readWhole(t.page, (x: any) => x.id, { pageSize: 10, maxRows: 25 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, WHOLE_READ_CUT);
  });

  it("FR6 — with no count, a short page is the last and a full page is not", async () => {
    const t = servedTable(Array.from({ length: 10 }, (_, i) => ({ id: pad(i + 1) })), { withCount: false });
    const r = await readWhole(t.page, (x: any) => x.id, { pageSize: 4 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.length, 10);
    assert.equal(t.pages.length, 3, "4 + 4 + 2: the third, short, page ends it");
  });
});

/** A thenable query builder over rows, with the PostgREST row cap, for countRowsPerId. */
function cappedClient(tables: Record<string, any[]>, opts: { cap?: number; failOnPage?: number } = {}) {
  let pageNo = 0;
  return {
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let order: string | null = null;
      let limit = Infinity;
      let wantCount = false;
      const b: any = {
        select(_c: string, o?: any) { wantCount = o?.count === "exact"; return b; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
        eq(col: string, v: any) { filters.push((r) => r[col] === v); return b; },
        gt(col: string, v: any) { filters.push((r) => String(r[col]) > String(v)); return b; },
        is(col: string, v: any) { filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return b; },
        order(col: string) { order = col; return b; },
        limit(n: number) { limit = n; return b; },
        then(onF: any, onR: any) {
          pageNo++;
          if (opts.failOnPage === pageNo) {
            return Promise.resolve({ data: null, error: { message: "page failed", code: "57014" }, count: null }).then(onF, onR);
          }
          let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (order) rows = [...rows].sort((a, c) => (a[order!] < c[order!] ? -1 : a[order!] > c[order!] ? 1 : 0));
          const count = rows.length;
          rows = rows.slice(0, Math.min(limit, opts.cap ?? 1_000));
          return Promise.resolve({ data: rows, error: null, count: wantCount ? count : null }).then(onF, onR);
        },
      };
      return b;
    },
  };
}

describe("countRowsPerId / viewerRowIds / readWholeColumn / exactCount (census-media §47)", () => {
  const POST_A = pad(9_001);
  const POST_B = pad(9_002);
  const POST_C = pad(9_003);
  // 1,700 stamps on A and 300 on B: 2,000 rows, past the 1,000-row cap.
  const stamps = [
    ...Array.from({ length: 1_700 }, (_, i) => ({ id: pad(i + 1), entity_id: POST_A, entity_type: "post" })),
    ...Array.from({ length: 300 }, (_, i) => ({ id: pad(5_000 + i), entity_id: POST_B, entity_type: "post" })),
    { id: pad(8_000), entity_id: POST_B, entity_type: "media" },
  ];

  it("FR7 — counts exactly past 1,000 rows, and every asked id has an entry", async () => {
    const sc = cappedClient({ content_stamps: stamps });
    const r = await countRowsPerId(sc, "content_stamps", "entity_id", [POST_A, POST_B, POST_C], (q) => q.eq("entity_type", "post"));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.get(POST_A), 1_700);
      assert.equal(r.value.get(POST_B), 300, "the media-typed stamp is scoped out");
      assert.equal(r.value.get(POST_C), 0, "no rows is a measured 0 — only because the read succeeded");
    }
  });

  it("FR7 — an error on a LATER page fails the whole count", async () => {
    const sc = cappedClient({ content_stamps: stamps }, { failOnPage: 2 });
    const r = await countRowsPerId(sc, "content_stamps", "entity_id", [POST_A, POST_B], (q) => q.eq("entity_type", "post"));
    assert.equal(r.ok, false, "1,000 rows read and then a failure is not a count of 1,000");
  });

  it("FR9 — viewerRowIds: the viewer's rows, and a failure is { ok: false }", async () => {
    const VIEWER = pad(7);
    const saves = [
      { id: pad(1), user_id: VIEWER, post_id: POST_A },
      { id: pad(2), user_id: pad(8), post_id: POST_B },
    ];
    const ok = await viewerRowIds(cappedClient({ post_saves: saves }), "post_saves", "post_id", [POST_A, POST_B], (q) => q.eq("user_id", VIEWER));
    assert.deepEqual(ok.ok ? [...ok.value] : null, [POST_A]);
    const bad = await viewerRowIds(cappedClient({ post_saves: saves }, { failOnPage: 1 }), "post_saves", "post_id", [POST_A], (q) => q.eq("user_id", VIEWER));
    assert.equal(bad.ok, false);
    const none = await viewerRowIds(cappedClient({}, { failOnPage: 1 }), "post_saves", "post_id", [], (q) => q);
    assert.equal(none.ok, true, "no ids asks nothing, so nothing can fail");
  });

  it("FR9 — readWholeColumn reads a follow graph past the cap", async () => {
    const VIEWER = pad(7);
    const follows = Array.from({ length: 1_234 }, (_, i) => ({ follower_id: VIEWER, following_id: pad(20_000 + i) }));
    const r = await readWholeColumn(cappedClient({ user_follows: follows }), "user_follows", "following_id", (q) => q.eq("follower_id", VIEWER));
    assert.equal(r.ok ? r.value.length : -1, 1_234);
  });

  it("FR9 — exactCount: a failure or a missing count is { ok: false }, never 0", async () => {
    assert.deepEqual(await exactCount(Promise.resolve({ count: 4, error: null })), { ok: true, value: 4 });
    assert.equal((await exactCount(Promise.resolve({ count: null, error: { message: "x" } }))).ok, false);
    assert.equal((await exactCount(Promise.resolve({ count: null, error: null }))).ok, false);
  });

  it("FR10 — FailedSources names each source once; healthy spreads to {}", () => {
    const warned: string[] = [];
    const f = new FailedSources({ warn: (_o, m) => warned.push(String(m)) }, "test");
    assert.deepEqual(f.body(), {});
    assert.equal(known({ ok: true, value: 3 }, f, "a"), 3);
    assert.equal(known({ ok: false, error: { message: "x" } }, f, "post_saves"), null);
    known({ ok: false, error: { message: "y" } }, f, "post_saves");
    assert.deepEqual(f.body(), { failedSources: ["post_saves"] });
    assert.equal(warned.length, 2, "each failure is logged");
  });
});

describe("the real supabase-js client pages by key (census-media §47)", () => {
  it("FR8 — order=id.asc, id=gt.<last>, limit and count=exact, over several pages", async () => {
    const POST = pad(9_100);
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: pad(i + 1), entity_id: POST, entity_type: "post" }));
    const o = makeOracle({ tables: { content_stamps: rows } });
    const page: KeyedPage = (after, size) => {
      let q = o.client.from("content_stamps").select("id, entity_id", { count: "exact" })
        .in("entity_id", [POST]).eq("entity_type", "post").order("id", { ascending: true }).limit(size);
      if (after !== null) q = q.gt("id", after);
      return q;
    };
    const r = await readWhole(page, (x: any) => x.id, { pageSize: 2 });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value.map((x: any) => x.id), rows.map((x) => x.id));
    assert.equal(o.requests(), 3, "2 + 2 + 1 rows: three requests");
    const second = o.log[1];
    assert.match(second.url, /order=id\.asc/);
    assert.match(second.url, new RegExp(`id=gt\\.${pad(2)}`));
    assert.match(second.url, /limit=2/);
    assert.match(String(second.prefer), /count=exact/);
  });

  it("FR8 — a resolved PostgREST error through the real client fails the read", async () => {
    const o = makeOracle({ tables: { content_stamps: [] }, failReads: { content_stamps: { code: "57014", message: "canceling statement" } } });
    const r = await countRowsPerId(o.client, "content_stamps", "entity_id", [pad(1)], (q) => q.eq("entity_type", "post"));
    assert.equal(r.ok, false);
  });
});

describe("readWhole with a plain first read (census-media §47)", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: pad(i + 1) }));

  it("FR11 — a whole first answer is one request, and no keyed page is asked", async () => {
    let keyed = 0;
    const r = await readWhole(async () => { keyed++; return { data: [], error: null, count: 0 }; }, (x: any) => x.id, {
      first: async () => ({ data: rows(40), error: null, count: 40 }),
    });
    assert.equal(r.ok ? r.value.length : -1, 40);
    assert.equal(keyed, 0);
  });

  it("FR12 — a cut first answer (1,000 of 1,700) is read again by key, exactly", async () => {
    const all = rows(1_700);
    const t = servedTable(all, { cap: 1_000 });
    const r = await readWhole(t.page, (x: any) => x.id, {
      first: async () => ({ data: all.slice(0, 1_000), error: null, count: 1_700 }),
    });
    assert.equal(r.ok ? r.value.length : -1, 1_700);
    assert.deepEqual(t.pages, [null, pad(1_000)], "keyed paging restarts from the first key");
  });

  it("FR13 — no count: a short first answer is whole; a full one is not trusted", async () => {
    const short = await readWhole(async () => { throw new Error("must not page"); }, (x: any) => x.id, {
      first: async () => ({ data: rows(10), error: null }),
    });
    assert.equal(short.ok ? short.value.length : -1, 10);
    const all = rows(1_200);
    const t = servedTable(all, { cap: 1_000 });
    const full = await readWhole(t.page, (x: any) => x.id, {
      first: async () => ({ data: all.slice(0, 1_000), error: null }),
    });
    assert.equal(full.ok ? full.value.length : -1, 1_200);
  });

  it("FR14 — an error on the first read fails the read, reported as that error", async () => {
    const r = await readWhole(async () => ({ data: [], error: null, count: 0 }), (x: any) => x.id, {
      first: async () => ({ data: null, error: { message: "boom", code: "57014" } }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.message, "boom", "the PostgREST error itself — not a cut");
      assert.equal(r.error.code, "57014");
    }
  });
});
