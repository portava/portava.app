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
 *                   that person's ring; the page's created_at cursor is
 *                   derived BEFORE the regroup, so reordering inside a group
 *                   cannot make the cursor skip a row (asserted below)
 *   archived        the owner's archive list, archived_at order kept within
 *                   each partition
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

  it("the bounded feed's cursor is the last row of the UNREORDERED page — a pin cannot make it skip", async () => {
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
    // The page is the first two by created_at (A, B); C is NOT pulled forward
    // onto this page by its pin, and the cursor continues after B.
    assert.deepEqual(group.highlights.map((h: any) => h.id).sort(), [A, B].sort());
    assert.ok(typeof r.body.nextCursor === "string" && r.body.nextCursor.length > 0, "a full page carries a cursor");
    const next = await call(app, "GET", `/api/highlights/following-feed?limit=2&cursor=${encodeURIComponent(r.body.nextCursor)}`, VIEWER);
    const group2 = (next.body.users as any[]).find((u) => u.userId === OWNER);
    assert.deepEqual(group2.highlights.map((h: any) => h.id), [C], "the next page continues with exactly the row after the cursor");
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
