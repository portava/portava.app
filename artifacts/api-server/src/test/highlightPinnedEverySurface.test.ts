/**
 * §12 "Pinned/manual order always outranks automatic ordering" — on every
 * surface that orders a person's Highlights. Census H100.
 *
 * §Q.6 recorded the gap in the census's own words: "`pinnedFirst` runs on ONE
 * of the four read surfaces, the profile. `GET /highlights/active`,
 * `/highlights/following-feed` and `/highlights/archived` do not apply it."
 * /highlights/active has since gained §12 ranking (rankHighlightRows, which
 * partitions pinned first). This suite pins the other two:
 *
 *   following-feed  within each person's group — the group is what plays as
 *                   that person's ring; the page's cursor is derived BEFORE
 *                   the regroup, so reordering inside a group cannot make the
 *                   cursor skip a row (asserted below)
 *   archived        the owner's archive list, archived_at order kept within
 *                   each partition
 *
 * And across a PAGE BOUNDARY (census H100, lane R wave 2): a pin used to lead
 * only inside the rows a surface had already fetched — the bounded feed's
 * page, the archive's `.limit(200)`, /active's `limit * 5` window. The pin is
 * now in each query's own order, and the harness honours `.order()` and
 * `.limit()`, so these cases are about what the QUERY returns, not about the
 * fixture's array order.
 *
 * Run: node --import tsx/esm --test src/test/highlightPinnedEverySurface.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, call, fixtureTables, highlight, VIEWER, OWNER, type App } from "./highlightsSpecHarness.js";

const A = "40000000-0000-4000-8000-00000000000a";
const B = "40000000-0000-4000-8000-00000000000b";
const C = "40000000-0000-4000-8000-00000000000c";
const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

function tablesWith(rows: Array<Record<string, unknown>>) {
  const t = fixtureTables();
  t.highlights = rows;
  return t;
}

describe("§12 pinned-first on the following-feed and the archive (H100)", () => {
  it("the following-feed plays a person's pinned Highlight first, then the rest in created_at order", async () => {
    app = await startApp({
      tables: tablesWith([
        highlight(A, OWNER, { created_at: at(1), pinned_at: null, lifetime_class: null, lifecycle_state: null }),
        highlight(B, OWNER, { created_at: at(2), pinned_at: null, lifetime_class: null, lifecycle_state: null }),
        highlight(C, OWNER, { created_at: at(3), pinned_at: "2026-01-02T00:00:00.000Z", lifetime_class: null, lifecycle_state: null }),
      ]),
    });
    const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const group = (r.body.users as any[]).find((u) => u.userId === OWNER);
    assert.ok(group, "the owner's group is on the feed");
    assert.deepEqual(group.highlights.map((h: any) => h.id), [C, A, B]);
  });

  it("with no pin, the feed keeps its created_at order exactly", async () => {
    app = await startApp({
      tables: tablesWith([
        highlight(A, OWNER, { created_at: at(1), pinned_at: null, lifetime_class: null, lifecycle_state: null }),
        highlight(B, OWNER, { created_at: at(2), pinned_at: null, lifetime_class: null, lifecycle_state: null }),
      ]),
    });
    const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
    const group = (r.body.users as any[]).find((u) => u.userId === OWNER);
    assert.deepEqual(group.highlights.map((h: any) => h.id), [A, B]);
  });

  // Restated for H100 (lead's wave-2 order, item 5). This case used to assert
  // that the pinned C was NOT pulled onto page one — the very gap census H100
  // holds the row at W for. What it protected is kept and widened: the cursor
  // continues with exactly the rows after the page, none skipped and none
  // repeated, across every page.
  it("the bounded feed leads with the pin across the page boundary, and its cursor neither skips nor repeats a row", async () => {
    app = await startApp({
      tables: (() => {
        const t = tablesWith([
          highlight(A, OWNER, { created_at: at(1), pinned_at: null, lifetime_class: null, lifecycle_state: null }),
          highlight(B, OWNER, { created_at: at(2), pinned_at: null, lifetime_class: null, lifecycle_state: null }),
          highlight(C, OWNER, { created_at: at(3), pinned_at: "2026-01-02T00:00:00.000Z", lifetime_class: null, lifecycle_state: null }),
        ]);
        t.feature_flags = [{ flag: "highlights_feed_bounded_enabled", enabled: true }];
        return t;
      })(),
    });
    const r = await call(app, "GET", "/api/highlights/following-feed?limit=2", VIEWER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const group = (r.body.users as any[]).find((u) => u.userId === OWNER);
    // Page one is the pin, then the oldest unpinned — C, A — not A, B.
    assert.deepEqual(group.highlights.map((h: any) => h.id), [C, A]);
    assert.ok(typeof r.body.nextCursor === "string" && r.body.nextCursor.length > 0, "a full page carries a cursor");
    const next = await call(app, "GET", `/api/highlights/following-feed?limit=2&cursor=${encodeURIComponent(r.body.nextCursor)}`, VIEWER);
    const group2 = (next.body.users as any[]).find((u) => u.userId === OWNER);
    assert.deepEqual(group2.highlights.map((h: any) => h.id), [B], "the next page continues with exactly the row after the cursor");
  });

  it("the bounded feed pages THROUGH the pins: a cursor taken on a pin continues past ties, then into the unpinned rows, each row once", async () => {
    const P1 = "40000000-0000-4000-8000-0000000000a1";
    const P2 = "40000000-0000-4000-8000-0000000000a2";
    const P3 = "40000000-0000-4000-8000-0000000000a3";
    const U1 = "40000000-0000-4000-8000-0000000000b1";
    const U2 = "40000000-0000-4000-8000-0000000000b2";
    const PIN_1 = "2026-01-02T00:00:00.000Z";
    const PIN_2 = "2026-01-03T00:00:00.000Z";
    app = await startApp({
      tables: (() => {
        const t = tablesWith([
          highlight(U1, OWNER, { created_at: at(1), pinned_at: null, lifetime_class: null, lifecycle_state: null }),
          highlight(U2, OWNER, { created_at: at(2), pinned_at: null, lifetime_class: null, lifecycle_state: null }),
          highlight(P2, OWNER, { created_at: at(6), pinned_at: PIN_2, lifetime_class: null, lifecycle_state: null }),
          // P3 ties P2 on pinned_at: the cursor must continue past the tie, not skip it
          highlight(P3, OWNER, { created_at: at(7), pinned_at: PIN_2, lifetime_class: null, lifecycle_state: null }),
          highlight(P1, OWNER, { created_at: at(5), pinned_at: PIN_1, lifetime_class: null, lifecycle_state: null }),
        ]);
        t.feature_flags = [{ flag: "highlights_feed_bounded_enabled", enabled: true }];
        return t;
      })(),
    });
    const seen: string[] = [];
    const pages: string[][] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const r = await call(app, "GET", `/api/highlights/following-feed?limit=2${q}`, VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const g = ((r.body.users ?? []) as any[]).find((u) => u.userId === OWNER);
      const ids: string[] = g ? g.highlights.map((h: any) => h.id) : [];
      pages.push(ids);
      seen.push(...ids);
      cursor = typeof r.body.nextCursor === "string" ? r.body.nextCursor : null;
      if (!cursor) break;
    }
    assert.deepEqual(pages, [[P1, P2], [P3, U1], [U2]], "pins first (earliest pin first, ties by created_at), then the unpinned rows oldest-first");
    assert.deepEqual([...seen].sort(), [P1, P2, P3, U1, U2].sort(), "every row exactly once");
  });

  it("a cursor that is not a well-formed pinned key is refused, never spliced into the filter", async () => {
    app = await startApp({
      tables: (() => {
        const t = tablesWith([highlight(A, OWNER, { created_at: at(1), pinned_at: null, lifetime_class: null, lifecycle_state: null })]);
        t.feature_flags = [{ flag: "highlights_feed_bounded_enabled", enabled: true }];
        return t;
      })(),
    });
    for (const bad of [
      "pinned:2026-01-02T00:00:00.000Z,owner_id.neq.x|2026-01-01T00:00:00.000Z|40000000-0000-4000-8000-00000000000a",
      "pinned:2026-01-02T00:00:00.000Z|2026-01-01T00:00:00.000Z|not-a-uuid",
      "pinned:only-two|parts",
    ]) {
      const r = await call(app, "GET", `/api/highlights/following-feed?limit=2&cursor=${encodeURIComponent(bad)}`, VIEWER);
      assert.equal(r.status, 400, bad);
    }
  });

  it("the archive lists a pinned archived Highlight first, then archived_at order", async () => {
    app = await startApp({
      tables: tablesWith([
        highlight(A, VIEWER, { archived_at: "2026-02-03T00:00:00.000Z", pinned_at: null, lifetime_class: null, lifecycle_state: null }),
        highlight(B, VIEWER, { archived_at: "2026-02-02T00:00:00.000Z", pinned_at: "2026-01-05T00:00:00.000Z", lifetime_class: null, lifecycle_state: null }),
        highlight(C, VIEWER, { archived_at: "2026-02-01T00:00:00.000Z", pinned_at: null, lifetime_class: null, lifecycle_state: null }),
      ]),
    });
    const r = await call(app, "GET", "/api/highlights/archived", VIEWER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body.highlights as any[]).map((h) => h.id), [B, A, C]);
  });
});

describe("§12 pins inside the window: the archive's limit and /active's candidate window (H100)", () => {
  it("a pinned archived Highlight OLDER than the 200 most recently archived still leads the archive", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 201; i++) {
      const id = `41000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      rows.push(highlight(id, VIEWER, { archived_at: new Date(Date.UTC(2026, 1, 1, 0, 0, 0) + (i + 1) * 60_000).toISOString(), pinned_at: null, lifetime_class: null, lifecycle_state: null }));
    }
    const PINNED_OLD = "41000000-0000-4000-8000-0000000fffff";
    rows.push(highlight(PINNED_OLD, VIEWER, { archived_at: "2026-01-15T00:00:00.000Z", pinned_at: "2026-01-20T00:00:00.000Z", lifetime_class: null, lifecycle_state: null }));
    app = await startApp({ tables: tablesWith(rows) });
    const r = await call(app, "GET", "/api/highlights/archived", VIEWER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = (r.body.highlights as any[]).map((h) => h.id);
    assert.equal(ids.length, 200, "the archive is still a 200-row read");
    assert.equal(ids[0], PINNED_OLD, "the pin is inside the read, and first");
  });

  it("/active: an older pinned Highlight outside the newest `limit * 5` rows is still on the page, first", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) {
      const id = `42000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      rows.push(highlight(id, OWNER, { created_at: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(), pinned_at: null, lifetime_class: null, lifecycle_state: null }));
    }
    const PINNED_OLD = "42000000-0000-4000-8000-0000000fffff";
    rows.push(highlight(PINNED_OLD, OWNER, { created_at: "2026-01-01T00:00:00.000Z", pinned_at: "2026-01-01T12:00:00.000Z", lifetime_class: null, lifecycle_state: null }));
    app = await startApp({ tables: tablesWith(rows) });
    const r = await call(app, "GET", "/api/highlights/active?limit=1", VIEWER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = (r.body.highlights as any[]).map((h) => h.id);
    assert.equal(ids[0], PINNED_OLD, `the pin leads /active even though five newer rows fill the window: ${JSON.stringify(ids)}`);
  });
});
