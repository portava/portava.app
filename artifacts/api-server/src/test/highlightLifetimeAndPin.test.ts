/**
 * §4 / §5 / §12 — Highlight lifetime classes and pinning, end to end.
 *
 * Highlights/Memories Development Architecture Spec v1:
 *   §4  HighlightLifetime = LIVE | DAY | TRIP | SEASONAL | PERMANENT
 *   §5  the Highlight lifecycle, which includes PINNED
 *   §12 "Pinned/manual order always outranks automatic ordering"
 *
 * WHAT THE CENSUS RECORDED, AND WHICH HALF OF IT WAS STALE
 * -------------------------------------------------------
 * §O.3 moved H94–H97 (LIVE / DAY / TRIP / SEASONAL) from NOT-BUILT to
 * BUILT-BUT-WRONG when migration 2723 landed, and stated the remaining blocker
 * exactly: "nothing writes the column and HIGHLIGHT_COLUMNS does not project
 * it, so `describeHighlightLifetime` still answers `unavailable` on every live
 * read". H142/H143 (PIN / UNPIN) stayed NOT-BUILT on "no pin column in
 * production, no pin route, no pin in the client" — whose FIRST clause is stale
 * (`pinned_at` is in the 20260915 production snapshot) and whose other two were
 * true.
 *
 * H98 is the one that is not code. PERMANENT is not unimplemented, it is
 * structurally impossible while `expires_at` is NOT NULL, and migration
 * 2975_highlights_permanent_lifetime.sql is what changes that. This suite
 * therefore asserts the CODE is correct on both sides of that migration: the
 * create path refuses PERMANENT BY NAME when the database says no, and stores
 * it with a NULL expiry when the database allows it.
 *
 * THE ASSERTION MOST WORTH HAVING is that a NULL expiry does not make a
 * Highlight vanish. `new Date(null) > now` is `false` in JavaScript, silently,
 * because `new Date(null)` is the epoch — so the day the column became nullable
 * every PERMANENT Highlight would have been read as expired by
 * `isHighlightActive` and by the SQL predicate, with no error anywhere.
 *
 * Run: node --import tsx/esm --test src/test/highlightLifetimeAndPin.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startApp, call, fixtureTables, highlight, listIds, feedIds,
  VIEWER, OWNER, H_PUB, H_MINE, FUTURE,
} from "./highlightsSpecHarness.js";
import {
  describeHighlightLifetime,
  describeHighlightLifecycle,
  representableLifetimeClasses,
  HIGHLIGHT_LIFETIME_CLASSES,
} from "../services/highlights/highlightLifecycle.js";
import { pinnedFirst } from "../services/highlights/highlightRanking.js";
import { isHighlightActive } from "../lib/highlightPermissions.js";

const H_PERM = "30000000-0000-4000-8000-0000000000aa";
const H_PIN = "30000000-0000-4000-8000-0000000000bb";

/* ══════════════════════════════════════════════════════════════════════════
 * §4 — the class is STORED, and it is PROJECTED
 * ════════════════════════════════════════════════════════════════════════*/

describe("§4 a lifetime class chosen at creation is stored and comes back on the read", () => {
  it("POST /highlights stores the class the caller named", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        mediaUrl: "https://example.invalid/a.jpg", mediaType: "image/jpeg",
        lifetimeClass: "TRIP",
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const stored = app.tables.highlights.find((h: any) => h.owner_id === VIEWER && h.lifetime_class === "TRIP");
      assert.ok(stored, "the class must reach the row");
      assert.ok(stored.expires_at, "a TRIP Highlight still expires — §12 gives the classes behaviour, not durations");
    } finally { await app.close(); }
  });

  it("a Highlight created WITHOUT a class has none — no class is invented", async () => {
    // `highlightLifecycle.ts`'s header: nothing in §12 assigns hour boundaries
    // to the classes, so bucketing `expiresInHours` into one would be invented
    // product policy wearing the spec's vocabulary.
    const app = await startApp();
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        mediaUrl: "https://example.invalid/a.jpg", mediaType: "image/jpeg", expiresInHours: 24,
      });
      assert.equal(r.status, 201);
      const stored = app.tables.highlights.find((h: any) => h.media_url === "https://example.invalid/a.jpg");
      assert.equal(stored.lifetime_class, undefined, "no class must be written when none was chosen");
    } finally { await app.close(); }
  });

  it("the profile read reports the class WITH its provenance", async () => {
    const t = fixtureTables();
    t.highlights.find((h: any) => h.id === H_MINE)!.lifetime_class = "SEASONAL";
    const app = await startApp({ tables: t });
    try {
      const r = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      assert.equal(r.status, 200);
      const row = (r.body.highlights as any[]).find((h) => h.id === H_MINE);
      assert.equal(row.lifetimeClass, "SEASONAL");
      // The provenance travels with the value: "the owner chose SEASONAL",
      // "nobody has assigned a class" and "this deployment cannot hold one" are
      // three different things for a client to render.
      assert.equal(row.lifetimeProvenance, "stored");
    } finally { await app.close(); }
  });

  it("a row with no class reports `unavailable`, not a guess", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      const row = (r.body.highlights as any[]).find((h) => h.id === H_MINE);
      assert.equal(row.lifetimeClass, null);
      assert.equal(row.lifetimeProvenance, "unavailable");
    } finally { await app.close(); }
  });

  it("GET /highlights/lifetime-classes offers §12's five with its own words", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/lifetime-classes", VIEWER);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.classes.map((c: any) => c.cls), [...HIGHLIGHT_LIFETIME_CLASSES]);
      const permanent = r.body.classes.find((c: any) => c.cls === "PERMANENT");
      // PERMANENT needs 2975's nullable expires_at, which no read on this
      // connection can see. Named rather than silently offered or withheld.
      assert.equal(permanent.mayNotBeStorable, true);
      assert.equal(r.body.classes.find((c: any) => c.cls === "DAY").mayNotBeStorable, false);
    } finally { await app.close(); }
  });

  it("refuses a class that is not one of §4's five", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        mediaUrl: "https://example.invalid/a.jpg", mediaType: "image/jpeg", lifetimeClass: "FOREVER_AND_EVER",
      });
      assert.equal(r.status, 400);
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §4 PERMANENT — the one class that needs migration 2975
 * ════════════════════════════════════════════════════════════════════════*/

describe("§4 PERMANENT is stored with NO expiry, and refused by name when it cannot be", () => {
  it("stores a PERMANENT Highlight with expires_at NULL", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        mediaUrl: "https://example.invalid/perm.jpg", mediaType: "image/jpeg", lifetimeClass: "PERMANENT",
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const stored = app.tables.highlights.find((h: any) => h.media_url === "https://example.invalid/perm.jpg");
      assert.equal(stored.expires_at, null, "a PERMANENT Highlight is one with no expiry");
      assert.equal(stored.lifetime_class, "PERMANENT");
    } finally { await app.close(); }
  });

  it("REFUSES BY NAME when the database rejects the NULL expiry — it does not quietly store a 24h one", async () => {
    // The silent fallback is the defect worth naming: a Highlight the user
    // asked to keep forever, stored with an expiry, is a promise broken with a
    // 201 — and `describeHighlightLifetime` would grade that row `invalid`
    // anyway. 23502 is what a database without migration 2975 answers.
    const app = await startApp({ writeError: { highlights: { code: "23502", message: 'null value in column "expires_at" violates not-null constraint' } } });
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        mediaUrl: "https://example.invalid/perm.jpg", mediaType: "image/jpeg", lifetimeClass: "PERMANENT",
      });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
      assert.ok(
        app.errors.some((e) => /2975/.test(e.msg)),
        "the log must name the migration that would make PERMANENT storable",
      );
    } finally { await app.close(); }
  });

  it("names the migration in its capability answer rather than leaving a reader to discover it", async () => {
    const cap = representableLifetimeClasses({ lifetimeClassColumn: true, expiresAtNullable: false });
    assert.ok(!cap.representable.includes("PERMANENT"));
    assert.equal(cap.unrepresentable[0].cls, "PERMANENT");
    assert.match(cap.unrepresentable[0].why, /NOT NULL/);
    const withMigration = representableLifetimeClasses({ lifetimeClassColumn: true, expiresAtNullable: true });
    assert.deepEqual([...withMigration.representable], [...HIGHLIGHT_LIFETIME_CLASSES]);
    assert.equal(withMigration.unrepresentable.length, 0);
  });

  it("a CHECK violation on a PERMANENT create is refused the same way", async () => {
    // 2723 applied, 2975's constraint absent or different: 23514.
    const app = await startApp({ writeError: { highlights: { code: "23514", message: "violates check constraint" } } });
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        mediaUrl: "https://example.invalid/perm.jpg", mediaType: "image/jpeg", lifetimeClass: "PERMANENT",
      });
      assert.equal(r.body.error, "feature_disabled");
    } finally { await app.close(); }
  });

  it("a NON-permanent create is NOT swallowed by that branch", async () => {
    // Without this, "refuse 23502 when permanent" could be written as "refuse
    // 23502", and every unrelated constraint failure would be reported to the
    // user as a missing feature.
    const app = await startApp({ writeError: { highlights: { code: "23502", message: "some other column" } } });
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        mediaUrl: "https://example.invalid/a.jpg", mediaType: "image/jpeg", lifetimeClass: "DAY",
      });
      assert.equal(r.body.error, "db_error");
    } finally { await app.close(); }
  });

  it("a class on a database without 2723 is refused by name too", async () => {
    const app = await startApp({ writeError: { highlights: { code: "PGRST204", message: "Could not find the 'lifetime_class' column" } } });
    try {
      const r = await call(app, "POST", "/api/highlights", VIEWER, {
        mediaUrl: "https://example.invalid/a.jpg", mediaType: "image/jpeg", lifetimeClass: "TRIP",
      });
      assert.equal(r.body.error, "feature_disabled");
      assert.ok(app.errors.some((e) => /2723/.test(e.msg)));
    } finally { await app.close(); }
  });

  it("a PERMANENT Highlight does NOT vanish from the feeds", async () => {
    // THE ASSERTION THIS SUITE EXISTS FOR. `new Date(null) > now` is `false`
    // in JavaScript — silently, because `new Date(null)` is the epoch — and the
    // SQL `expires_at > now` is NULL-blind for the same shape of reason. Before
    // the `.or()` predicate and the `isHighlightActive` null branch, every
    // PERMANENT Highlight would have disappeared from every surface the moment
    // 2975 landed, with no error anywhere.
    const t = fixtureTables();
    t.highlights.push(highlight(H_PERM, VIEWER, { expires_at: null, lifetime_class: "PERMANENT" }));
    const app = await startApp({ tables: t });
    try {
      const profile = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      assert.ok(listIds(profile.body).has(H_PERM), "a permanent Highlight must appear on its owner's profile");

      const feed = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(feedIds(feed.body).has(H_PERM), "a permanent Highlight must appear on the feed");

      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.ok(listIds(active.body).has(H_PERM), "a permanent Highlight must appear on the active list");
    } finally { await app.close(); }
  });

  it("an EXPIRED Highlight still does not appear — the null branch is not a hole", async () => {
    // Without this, "treat null as active" could be satisfied by not filtering
    // on expiry at all, which would put every expired Highlight back on every
    // feed.
    const t = fixtureTables();
    t.highlights.push(highlight("30000000-0000-4000-8000-0000000000cc", VIEWER, {
      expires_at: "2020-01-01T00:00:00.000Z",
    }));
    const EXPIRED = "30000000-0000-4000-8000-0000000000cc";
    const app = await startApp({ tables: t });
    try {
      const profile = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      assert.ok(!listIds(profile.body).has(EXPIRED), "expired must not reach the profile");
      const feed = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.ok(!feedIds(feed.body).has(EXPIRED), "expired must not reach the feed");
      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.ok(!listIds(active.body).has(EXPIRED), "expired must not reach the active list");
    } finally { await app.close(); }
  });

  it("isHighlightActive treats a null expiry as active and a past expiry as not", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    assert.equal(isHighlightActive({ id: "x", owner_id: "o", visibility: "public", expires_at: null, deleted_at: null, archived_at: null }, now), true);
    assert.equal(isHighlightActive({ id: "x", owner_id: "o", visibility: "public", expires_at: "2020-01-01T00:00:00.000Z", deleted_at: null, archived_at: null }, now), false);
    // A permanent Highlight is still deletable and still archivable — §21's
    // three columns stay three separate questions.
    assert.equal(isHighlightActive({ id: "x", owner_id: "o", visibility: "public", expires_at: null, deleted_at: "2026-01-01T00:00:00.000Z", archived_at: null }, now), false);
    assert.equal(isHighlightActive({ id: "x", owner_id: "o", visibility: "public", expires_at: null, deleted_at: null, archived_at: "2026-01-01T00:00:00.000Z" }, now), false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §5 / §12 — PIN and UNPIN
 * ════════════════════════════════════════════════════════════════════════*/

describe("§12 pin and unpin", () => {
  it("POST /highlights/:id/pin stores pinned_at on the owner's Highlight", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_MINE}/pin`, VIEWER);
      assert.equal(r.status, 200);
      assert.ok(r.body.pinnedAt);
      assert.ok(app.tables.highlights.find((h: any) => h.id === H_MINE).pinned_at);
    } finally { await app.close(); }
  });

  it("DELETE /highlights/:id/pin clears it — a pin a user cannot undo is a trap", async () => {
    const app = await startApp();
    try {
      await call(app, "POST", `/api/highlights/${H_MINE}/pin`, VIEWER);
      const r = await call(app, "DELETE", `/api/highlights/${H_MINE}/pin`, VIEWER);
      assert.equal(r.status, 200);
      assert.equal(r.body.pinnedAt, null);
      assert.equal(app.tables.highlights.find((h: any) => h.id === H_MINE).pinned_at, null);
    } finally { await app.close(); }
  });

  it("refuses to pin somebody else's Highlight, with the same answer as one that does not exist", async () => {
    const app = await startApp();
    try {
      const notMine = await call(app, "POST", `/api/highlights/${H_PUB}/pin`, VIEWER);
      const notThere = await call(app, "POST", `/api/highlights/30000000-0000-4000-8000-0000000000ff/pin`, VIEWER);
      assert.equal(notMine.status, 404);
      assert.deepEqual(notMine.body, notThere.body);
      assert.equal(app.tables.highlights.find((h: any) => h.id === H_PUB).pinned_at, undefined);
    } finally { await app.close(); }
  });

  it("does NOT write lifecycle_state — §5 has no PINNED→ACTIVE edge, so a stored PINNED could never be undone", async () => {
    const app = await startApp();
    try {
      await call(app, "POST", `/api/highlights/${H_MINE}/pin`, VIEWER);
      const row = app.tables.highlights.find((h: any) => h.id === H_MINE);
      assert.equal(row.lifecycle_state, undefined);
      // The same answer without the illegal claim: PINNED is DERIVED from the
      // column that records the fact.
      const described = describeHighlightLifecycle(row);
      assert.equal(described.state, "PINNED");
      assert.equal(described.provenance, "derived");
    } finally { await app.close(); }
  });

  it("a pinned Highlight is served AHEAD of an unpinned one, whatever the query order was", async () => {
    // §12: "Pinned/manual order always outranks automatic ordering."
    const t = fixtureTables();
    // H_PIN is appended LAST, so whatever order the store returns, it is not
    // first. The positive control below reads that order rather than assuming
    // one — the harness's `order()` is a no-op, and a control that asserted a
    // sort the fake does not perform would fail for the wrong reason.
    t.highlights.push(highlight(H_PIN, VIEWER));
    const app = await startApp({ tables: t });
    try {
      const before = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      const orderBefore = (before.body.highlights as any[]).map((h) => h.id);
      assert.notEqual(orderBefore[0], H_PIN, "positive control: unpinned, it is not first");
      assert.ok(orderBefore.includes(H_PIN));

      await call(app, "POST", `/api/highlights/${H_PIN}/pin`, VIEWER);
      const after = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      const orderAfter = (after.body.highlights as any[]).map((h) => h.id);
      assert.equal(orderAfter[0], H_PIN, "the pinned Highlight must outrank every unpinned one");
      // And the unpinned half keeps the order it arrived in.
      assert.deepEqual(orderAfter.slice(1), orderBefore.filter((id) => id !== H_PIN));
    } finally { await app.close(); }
  });

  it("pinnedFirst is STABLE for the unpinned half", async () => {
    // A partition that reordered the automatic half would silently replace the
    // surface's chosen ordering with nothing.
    const rows = [
      { id: "a", pinned_at: null }, { id: "b", pinned_at: null },
      { id: "c", pinned_at: "2026-02-01T00:00:00.000Z" },
      { id: "d", pinned_at: null }, { id: "e", pinned_at: "2026-01-01T00:00:00.000Z" },
    ];
    assert.deepEqual(pinnedFirst(rows).map((r) => r.id), ["e", "c", "a", "b", "d"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * The two describe* functions, on the shapes the routes now produce
 * ════════════════════════════════════════════════════════════════════════*/

describe("§4 / §5 description is stored-or-unknown, never inferred", () => {
  it("a PERMANENT row with an expiry is INVALID, not PERMANENT", async () => {
    const d = describeHighlightLifetime({ lifetime_class: "PERMANENT", expires_at: FUTURE });
    assert.equal(d.provenance, "invalid");
    assert.equal(d.cls, null);
  });

  it("a PERMANENT row with no expiry derives ACTIVE rather than reporting no state", async () => {
    // Before this, `expires_at == null` meant "no expires_at to derive from",
    // so the one class migration 2975 exists to enable would have been the one
    // class with no describable lifecycle state.
    const d = describeHighlightLifecycle({ expires_at: null, deleted_at: null, archived_at: null });
    assert.equal(d.state, "ACTIVE");
    assert.equal(d.provenance, "derived");
  });

  it("an UNPROJECTED expires_at is still `unavailable` — absent is not null", async () => {
    const d = describeHighlightLifecycle({ deleted_at: null, archived_at: null });
    assert.equal(d.state, null);
    assert.equal(d.provenance, "unavailable");
  });

  it("archive still wins over a pin: §5 puts HIDDEN downstream of PINNED", async () => {
    const d = describeHighlightLifecycle({
      pinned_at: "2026-01-01T00:00:00.000Z",
      archived_at: "2026-02-01T00:00:00.000Z",
      expires_at: FUTURE, deleted_at: null,
    });
    assert.equal(d.state, "HIDDEN");
  });

  it("a soft-deleted row is out of the §5 machine even when pinned", async () => {
    const d = describeHighlightLifecycle({
      pinned_at: "2026-01-01T00:00:00.000Z",
      deleted_at: "2026-02-01T00:00:00.000Z",
      archived_at: null, expires_at: FUTURE,
    });
    assert.equal(d.provenance, "out_of_machine");
  });
});
