/**
 * `trip_add` on the rank_events funnel ladder — node:test
 *
 * WHAT THIS PINS
 * ==============
 * Migration 2894 admits `trip_add` to the `rank_events.outcome` CHECK. The
 * vocabulary is the easy half; the ladder is the half that can silently destroy
 * data, because `rank_events` is a MUTABLE-STATE table — an outcome UPDATEs the
 * impression row in place, and whatever rung the new outcome sits on decides
 * which EXISTING outcomes it is allowed to overwrite.
 *
 * The ladder, before and after:
 *
 *   before   impression 0 · tap 1 · save/join/rsvp 2 · attended 3
 *   after    impression 0 · tap 1 · save/join/rsvp 2 · trip_add 3 · attended 4
 *
 * ABOVE save — `04` §8's chain is `impression → place_open → save → trip_add`.
 * At rung 2 a trip add arriving after a save would find no upgradable row and
 * 404, so the one transition the chain exists to measure would be the one it
 * loses.
 *
 * BELOW attended — `attended` is "I went", `trip_add` is "I plan to". A planning
 * signal able to overwrite a confirmed visit destroys the strongest fact the
 * funnel carries.
 *
 * NOT COMPARABLE TO join / rsvp — those are commitments made TO SOMEBODY ELSE.
 * `attended` may overwrite an `rsvp` because attending CONTAINS it; adding the
 * same item to your own itinerary does not. So `trip_add`'s upgradable set is
 * narrowed by hand to (impression, tap, save), exactly as `dismiss`'s is, and
 * the refusal is symmetric — a later join/rsvp cannot overwrite a trip_add.
 *
 * Run: node --import tsx/esm --test src/test/rankEventsTripAddOutcome.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { upgradableOutcomesFor, compassStageFor, exposureColumns } from "../routes/rankEvents.js";

const ALICE_ID   = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const ITEM_ID    = "db/11111111-1111-4111-8111-111111111111";
const SESSION_ID = "5e550000-0000-0000-0000-000000000001";

/** Every value the route's zod enum accepts, post-2894. */
const CLIENT_OUTCOMES = ["tap", "save", "join", "rsvp", "attended", "dismiss", "trip_add"] as const;

// ── A. The ladder, as a pure function ────────────────────────────────────────

describe("A. trip_add's place on the funnel ladder", () => {
  it("is ABOVE save: a trip add upgrades impression, tap and save", () => {
    assert.deepEqual(
      [...upgradableOutcomesFor("trip_add")].sort(),
      ["impression", "save", "tap"],
      "04 §8's chain is impression → place_open → save → trip_add; a trip add after a save must land",
    );
  });

  it("is BELOW attended: attended still upgrades a trip_add row", () => {
    assert.ok(
      upgradableOutcomesFor("attended").includes("trip_add"),
      "'I went' is further than 'I plan to go' and must be able to overwrite it",
    );
  });

  it("MUTATION GUARD: trip_add can NEVER overwrite a rung above it", () => {
    // The mutation this kills: giving trip_add a rung >= attended's (or listing
    // attended in its upgradable set). A trip add would then overwrite a
    // confirmed visit with a plan to make one — the funnel's strongest positive
    // fact, replaced by a weaker one, with no trace that it ever existed.
    const up = upgradableOutcomesFor("trip_add");
    assert.equal(up.includes("attended"), false, "a plan must never overwrite a confirmed visit");
    for (const o of up) {
      assert.ok(
        ["impression", "tap", "save"].includes(o),
        `trip_add must not be able to consume a '${o}' row`,
      );
    }
  });

  it("is NOT comparable to join / rsvp, in both directions", () => {
    assert.equal(
      upgradableOutcomesFor("trip_add").includes("join"), false,
      "a join is a commitment to somebody else's plan; a trip add does not subsume it",
    );
    assert.equal(
      upgradableOutcomesFor("trip_add").includes("rsvp"), false,
      "an rsvp tells a host you are coming; a trip add does not subsume it",
    );
    assert.equal(upgradableOutcomesFor("join").includes("trip_add"), false);
    assert.equal(upgradableOutcomesFor("rsvp").includes("trip_add"), false);
  });

  it("only outcomes strictly above trip_add may consume a trip_add row", () => {
    for (const o of CLIENT_OUTCOMES) {
      if (o === "attended") continue;
      assert.equal(
        upgradableOutcomesFor(o).includes("trip_add"), false,
        `'${o}' must not be able to overwrite a recorded trip_add`,
      );
    }
  });

  it("leaves the dismiss rule exactly as 2297 left it", () => {
    assert.deepEqual(upgradableOutcomesFor("dismiss"), ["impression"]);
    for (const o of CLIENT_OUTCOMES) {
      assert.equal(
        upgradableOutcomesFor(o).includes("dismiss"), false,
        `'${o}' must not be able to overwrite a recorded negative`,
      );
    }
  });

  it("every upgradable set is a subset of the values a row may hold", () => {
    const storable = ["impression", ...CLIENT_OUTCOMES];
    for (const o of CLIENT_OUTCOMES) {
      for (const u of upgradableOutcomesFor(o)) {
        assert.ok(storable.includes(u), `${o} names '${u}', which no row can hold`);
      }
      assert.equal(
        upgradableOutcomesFor(o).includes(o), false,
        `${o} must not upgrade a row that already holds it — a duplicate is a 404, not a rewrite`,
      );
    }
  });
});

// ── B. The Compass stage ─────────────────────────────────────────────────────

describe("B. trip_add on the Compass outcome chain", () => {
  it("MUTATION GUARD: a trip add is 'saved', never the 'went' fallthrough", () => {
    // The mutation this kills: letting trip_add fall through the ternary to
    // "went". The Compass chain is viewed → saved → went, and "went" asserts the
    // traveller WAS THERE. A plan to go, recorded as a visit, is the same class
    // of fabrication as counting a dismiss as a visit — which is why 'dismiss'
    // is excluded from this call at all.
    assert.equal(compassStageFor("trip_add"), "saved");
  });

  it("leaves every other mapping where it was", () => {
    assert.equal(compassStageFor("tap"), "viewed");
    assert.equal(compassStageFor("save"), "saved");
    assert.equal(compassStageFor("join"), "went");
    assert.equal(compassStageFor("rsvp"), "went");
    assert.equal(compassStageFor("attended"), "went");
  });
});

// ── C. The route, end to end ─────────────────────────────────────────────────

interface UpdateCapture { table: string; patch: Record<string, any>; filterVal: any }

/** Every `.select(...)` list the route asked `rank_events` for. */
const selectLists: string[] = [];

function makeClient(rows: Array<Record<string, any>>, updateCaptures: UpdateCapture[]) {
  const db: Record<string, any[]> = {
    profiles:    [{ id: ALICE_ID, account_status: "active" }],
    rank_events: rows,
  };

  function builder(table: string, src: any[]) {
    let filtered = [...src];
    const b: any = {
      select: () => builder(table, src),
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      order: (col: string, o?: { ascending?: boolean }) => {
        const dir = (o?.ascending ?? true) ? 1 : -1;
        filtered = [...filtered].sort((x, y) => (x[col] < y[col] ? -dir : x[col] > y[col] ? dir : 0));
        return b;
      },
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: [...filtered], error: null }),
    };
    return b;
  }

  return {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => ({
      select: (cols?: string) => { if (table === "rank_events" && typeof cols === "string") selectLists.push(cols); return builder(table, db[table] ?? []); },
      update: (patch: Record<string, any>) => ({
        eq: (col: string, val: any) => {
          db[table] = (db[table] ?? []).map((r) => (r[col] === val ? { ...r, ...patch } : r));
          updateCaptures.push({ table, patch, filterVal: val });
          return Promise.resolve({ data: null, error: null });
        },
      }),
      insert: () => Promise.resolve({ data: null, error: null }),
      upsert: () => Promise.resolve({ data: null, error: null }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

function row(id: string, outcome: string) {
  return {
    id, user_id: ALICE_ID, item_id: ITEM_ID, item_kind: "place",
    surface: "discovery", outcome, position: 0, features: {},
    served_at: "2026-09-01T00:00:00.000Z", session_id: SESSION_ID, outcome_at: null,
  };
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => srv.close(() => res(undefined))),
      });
    });
  });
}

async function makeApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { default: rankEventsRouter } = await import("../routes/rankEvents.js");
  app.use("/api", rankEventsRouter);
  return app;
}

describe("C. POST /api/rank-events/outcome accepts trip_add and respects the ladder", async () => {
  let url: string;
  let close: () => Promise<void>;
  let captures: UpdateCapture[];

  const post = (outcome: string) =>
    fetch(`${url}/api/rank-events/outcome`, {
      method: "POST",
      headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" },
      body: JSON.stringify({ item_id: ITEM_ID, surface: "discovery", outcome, session_id: SESSION_ID }),
    });

  before(async () => {
    ({ url, close } = await startServer(await makeApp()));
  });
  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("upgrades a row that is already at 'save' — the chain's last transition", async () => {
    captures = [];
    _setTestClient(makeClient([row("r-save", "save")], captures) as any, true);
    const r = await post("trip_add");
    assert.equal(r.status, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0]!.patch.outcome, "trip_add");
    assert.ok(typeof captures[0]!.patch.outcome_at === "string");
  });

  it("404s against a row already at 'attended' and writes NOTHING", async () => {
    captures = [];
    _setTestClient(makeClient([row("r-att", "attended")], captures) as any, true);
    const r = await post("trip_add");
    assert.equal(r.status, 404, "a plan must not consume a confirmed visit");
    assert.equal(captures.length, 0, "a refused upgrade must not write");
  });

  it("404s against a row already at 'rsvp' — trip_add does not subsume it", async () => {
    captures = [];
    _setTestClient(makeClient([row("r-rsvp", "rsvp")], captures) as any, true);
    const r = await post("trip_add");
    assert.equal(r.status, 404);
    assert.equal(captures.length, 0);
  });

  it("lets 'attended' upgrade a row already at 'trip_add'", async () => {
    captures = [];
    _setTestClient(makeClient([row("r-trip", "trip_add")], captures) as any, true);
    const r = await post("attended");
    assert.equal(r.status, 200);
    assert.equal(captures[0]!.patch.outcome, "attended");
  });

  it("404s a 'save' reported after a trip_add — the funnel never downgrades", async () => {
    captures = [];
    _setTestClient(makeClient([row("r-trip2", "trip_add")], captures) as any, true);
    const r = await post("save");
    assert.equal(r.status, 404);
    assert.equal(captures.length, 0);
  });

  // The handler writes the exposure select list out as TWO whole chains so that
  // check:write-path-columns can resolve it — a `.select` built by a call is a
  // blind spot in the one check that compares a read list against the live
  // schema. That duplicates a decision `exposureColumns()` also makes, so this
  // pins the two together: a column added to one and not the other is caught
  // here rather than by a PGRST100 in production.
  it("selects exactly the list exposureColumns() names", () => {
    assert.ok(selectLists.length > 0, "the outcome handler must have issued a select");
    for (const list of selectLists) {
      assert.equal(list, exposureColumns(), "the inlined select list drifted from exposureColumns()");
    }
    assert.ok(exposureColumns().includes("recommendation_id"), "the un-latched list carries 2891's column");
  });
});
