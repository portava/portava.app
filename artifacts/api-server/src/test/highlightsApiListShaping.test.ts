/**
 * §4 / §5 / §12 — the lifetime and lifecycle fields must be on EVERY list read,
 * not on two of the four.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §3.5 `Highlight.lifetime_class` and `Highlight.lifecycle_state` are fields of
 *        the record, not of one screen.
 *   §5   the Highlight lifecycle — HIDDEN is a state, and HIDDEN → EXPIRED is
 *        legal while HIDDEN → ACTIVE is not, so a client cannot guess which one
 *        an un-hidden Highlight lands in.
 *   §12  "Pinned/manual order always outranks automatic ordering."
 *
 * THE DEFECT THIS SUITE WAS WRITTEN AGAINST, reported by lane HM-CLIENT and
 * re-measured here before a line was changed.
 *
 *   `GET /users/:id/highlights` and `GET /highlights/active` both end their map
 *   with `...describeLifetimeFields(h, <projection>.classProjected)`.
 *   `GET /highlights/archived` answered `{ highlights: rows }` — the RAW
 *   PostgREST rows — and `GET /highlights/following-feed` pushed an object with
 *   author/counts and no lifetime fields at all.
 *
 *   Measured consequence on the archive screen: `pinnedAt` is `undefined` even
 *   when `pinned_at` is populated, and no lifetime or lifecycle field is
 *   readable, because the payload is snake_case and carries NO PROVENANCE.
 *   HM-CLIENT deliberately refused to fall back to the snake_case columns, and
 *   that refusal is correct: without `lifetimeProvenance` a client cannot tell
 *   "the owner chose LIVE" from "nobody assigned a class" from "this deployment
 *   cannot hold one", so the fallback would invent a distinction the server is
 *   the only thing that can make.
 *
 * WHY PROVENANCE IS THE ASSERTION AND NOT THE VALUE. A suite that checked only
 * `lifetimeClass` would pass against a route that emitted `null` for all three
 * of those cases. Every case below asserts the provenance field too, because
 * that is the field that distinguishes them — and `describeLifetimeFields`
 * returns `{}` wholesale when the class columns are not projected, so a client
 * that sees the key at all knows the deployment can answer.
 *
 * THE FALSE-GREEN RULE, APPLIED
 * =============================
 *   * Case 1 and case 2 are PAIRED with case 3, which asserts the two reads
 *     that ALREADY shaped their rows still do. If shaping broke everywhere,
 *     case 3 goes red and the suite cannot be read as "all four are fine".
 *   * The archived case asserts `lifecycleState === "HIDDEN"` specifically, not
 *     merely that the key exists. An archived Highlight is the one row whose
 *     derived state is NOT "ACTIVE", so a route that hard-coded ACTIVE — the
 *     easy wrong answer — fails here and nowhere else.
 *   * The pin case asserts `pinnedAt` round-trips a REAL timestamp, because
 *     `pinnedAt: null` is what the defect already produced by accident.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightsApiListShaping.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startApp, call, fixtureTables, highlight, VIEWER, OWNER, FUTURE,
} from "./highlightsSpecHarness.js";

const H_ARCHIVED_PINNED = "30000000-0000-4000-8000-0000000000a1";
const H_FEED = "30000000-0000-4000-8000-0000000000a2";

const PINNED_AT = "2026-03-01T12:00:00.000Z";
const ARCHIVED_AT = "2026-02-01T00:00:00.000Z";

/** The five keys §3.5 and §5 put on a Highlight, as this server names them. */
const SHAPED_KEYS = [
  "lifetimeClass", "lifetimeProvenance",
  "lifecycleState", "lifecycleProvenance",
  "pinnedAt",
] as const;

function tables() {
  const t = fixtureTables();
  t.highlights = [
    // OWNER's, archived AND pinned — the row the archive screen renders.
    highlight(H_ARCHIVED_PINNED, OWNER, {
      archived_at: ARCHIVED_AT, pinned_at: PINNED_AT,
      lifetime_class: "TRIP", lifecycle_state: null,
    }),
    // OWNER's, live and pinned — reaches VIEWER's following-feed and profile read.
    highlight(H_FEED, OWNER, {
      expires_at: FUTURE, pinned_at: PINNED_AT,
      lifetime_class: "DAY", lifecycle_state: null,
    }),
  ];
  return t;
}

const missing = (obj: any) => SHAPED_KEYS.filter((k) => !(k in (obj ?? {})));

// ── 1. GET /highlights/archived ──────────────────────────────────────────────

describe("GET /highlights/archived — the owner's archive is shaped like every other list", () => {
  it("carries all five §3.5/§5 fields, with provenance", async () => {
    const app = await startApp({ tables: tables() });
    try {
      const r = await call(app, "GET", "/api/highlights/archived", OWNER);
      assert.equal(r.status, 200);
      const [h] = r.body.highlights;
      assert.ok(h, "the owner's archived Highlight was not returned at all");
      assert.deepEqual(missing(h), [],
        `the archive read is still emitting raw rows; missing ${missing(h).join(", ")}`);
    } finally { await app.close(); }
  });

  it("`pinnedAt` round-trips the REAL timestamp — §12's manual order is renderable here", async () => {
    const app = await startApp({ tables: tables() });
    try {
      const r = await call(app, "GET", "/api/highlights/archived", OWNER);
      const [h] = r.body.highlights;
      assert.equal(h.pinnedAt, PINNED_AT,
        "pinnedAt is not the stored pinned_at — this is the defect HM-CLIENT measured");
    } finally { await app.close(); }
  });

  it("reports HIDDEN, not ACTIVE — an archived Highlight is the one row whose state differs", async () => {
    const app = await startApp({ tables: tables() });
    try {
      const r = await call(app, "GET", "/api/highlights/archived", OWNER);
      const [h] = r.body.highlights;
      assert.equal(h.lifecycleState, "HIDDEN");
      assert.equal(h.lifecycleProvenance, "derived",
        "nothing writes highlights.lifecycle_state, so the state MUST be marked derived");
      assert.equal(h.lifetimeClass, "TRIP");
      assert.equal(h.lifetimeProvenance, "stored");
    } finally { await app.close(); }
  });
});

// ── 2. GET /highlights/following-feed ────────────────────────────────────────

describe("GET /highlights/following-feed — the grouped feed is shaped too", () => {
  it("every Highlight inside every user group carries all five fields", async () => {
    const app = await startApp({ tables: tables() });
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200);
      const all = (r.body.users ?? []).flatMap((u: any) => u.highlights ?? []);
      assert.ok(all.length > 0, "the feed returned nothing; this assertion needs a live fixture");
      for (const h of all) {
        assert.deepEqual(missing(h), [],
          `feed highlight ${h.id} is unshaped; missing ${missing(h).join(", ")}`);
      }
    } finally { await app.close(); }
  });

  it("and its `pinnedAt` is the real one, so §12's order is renderable client-side", async () => {
    const app = await startApp({ tables: tables() });
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      const all = (r.body.users ?? []).flatMap((u: any) => u.highlights ?? []);
      const pinned = all.find((h: any) => h.id === H_FEED);
      assert.ok(pinned, "the pinned Highlight is not in the feed");
      assert.equal(pinned.pinnedAt, PINNED_AT);
      assert.equal(pinned.lifecycleState, "PINNED",
        "a live pinned Highlight derives PINNED — see describeHighlightLifecycle");
    } finally { await app.close(); }
  });
});

// ── 3. PAIRED — the two reads that already shaped their rows still do ────────

describe("the two reads that were already correct are still correct", () => {
  it("GET /users/:id/highlights and GET /highlights/active both stay shaped", async () => {
    // Without this, a change that stripped shaping from ALL FOUR reads would
    // leave cases 1 and 2 red for a reason nobody would look for here.
    const app = await startApp({ tables: tables() });
    try {
      const profile = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.equal(profile.status, 200);
      const [p] = profile.body.highlights;
      assert.ok(p, "the profile read returned nothing");
      assert.deepEqual(missing(p), []);
      assert.equal(p.pinnedAt, PINNED_AT);

      const active = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(active.status, 200);
      const [a] = active.body.highlights;
      assert.ok(a, "the active feed returned nothing");
      assert.deepEqual(missing(a), []);
    } finally { await app.close(); }
  });
});
