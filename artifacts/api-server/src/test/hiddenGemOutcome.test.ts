/**
 * hiddenGemOutcome — census-media §21, MD120: the §16.1 OUTCOME stage.
 *
 * A VERIFIED visit is linked to what the same visitor then reported about the
 * gem, and the gem detail carries the privacy-floored summary. Proved here:
 *   - the link: suspicious visits, reports before the visit, reports after the
 *     window and other people's reports link NOTHING;
 *   - the classes follow lib/hiddenGemState's own polarity sets;
 *   - the k-floor: fewer than OUTCOME_MIN_REPORTERS reporting visitors shows no
 *     number at all — not even the visitor count;
 *   - an unreadable table is "unreadable", never zero;
 *   - GET /hidden-gems/:id serves it, for a gem the caller may see.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/hiddenGemOutcome.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import {
  linkVisitOutcomes,
  summarizeGemOutcomes,
  readGemOutcomeSummary,
  outcomeClassOf,
  OUTCOME_WINDOW_MS,
  OUTCOME_MIN_REPORTERS,
} from "../services/hiddenGems/HiddenGemOutcomeService.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";

const GEM = "20000000-0000-4000-a000-000000000077";
const U = (n: number) => `10000000-0000-4000-a000-00000000000${n}`;
const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const at = (hoursAfterBase: number) => new Date(NOW - 10 * 86_400_000 + hoursAfterBase * 3_600_000).toISOString();

const visit = (user: string, h: number, suspicious = false) => ({ gem_id: GEM, user_id: user, visited_at: at(h), is_suspicious: suspicious });
const report = (user: string, type: string, h: number) => ({ gem_id: GEM, user_id: user, contribution_type: type, updated_at: at(h) });

describe("linkVisitOutcomes — what counts as the outcome of a visit", () => {
  it("links a verified visitor's report within the window after the visit", () => {
    const r = linkVisitOutcomes([visit(U(1), 0)], [report(U(1), "still_worth_it", 5)]);
    assert.equal(r.verifiedVisitors, 1);
    assert.deepEqual([...(r.outcomes.get(U(1))?.classes ?? [])], ["confirmed"]);
  });

  it("links NOTHING for a suspicious visit, a report before the visit, after the window, or by someone else", () => {
    const windowH = OUTCOME_WINDOW_MS / 3_600_000;
    const r = linkVisitOutcomes(
      [visit(U(1), 0, true), visit(U(2), 10), visit(U(3), 0), visit(U(4), 0)],
      [
        report(U(1), "still_here", 1), //            suspicious visit
        report(U(2), "still_here", 9), //            before the visit
        report(U(3), "closed", windowH + 1), //      after the window
        report(U(5), "still_here", 1), //            never visited
      ],
    );
    assert.equal(r.outcomes.size, 0);
    assert.equal(r.verifiedVisitors, 3, "the suspicious visit is not a verified visitor");
  });

  it("an unknown contribution type links nothing (never guessed into a class)", () => {
    const r = linkVisitOutcomes([visit(U(1), 0)], [report(U(1), "loved_it", 1)]);
    assert.equal(r.outcomes.size, 0);
  });

  it("classes follow the gem state's own polarity sets", () => {
    assert.equal(outcomeClassOf("still_here"), "confirmed");
    assert.equal(outcomeClassOf("still_worth_it"), "confirmed");
    assert.equal(outcomeClassOf("closed"), "degraded");
    assert.equal(outcomeClassOf("no_longer_hidden"), "degraded");
    assert.equal(outcomeClassOf("access_changed"), "degraded");
    assert.equal(outcomeClassOf("too_crowded"), "noted");
    assert.equal(outcomeClassOf("better_entrance"), "noted");
  });
});

describe("summarizeGemOutcomes — the privacy floor", () => {
  it(`below ${OUTCOME_MIN_REPORTERS} reporting visitors, NO number is shown — not even the visitor count`, () => {
    const s = summarizeGemOutcomes(
      linkVisitOutcomes([visit(U(1), 0), visit(U(2), 0), visit(U(3), 0)], [report(U(1), "still_here", 1), report(U(2), "closed", 1)]),
    );
    assert.deepEqual(s, { determined: false, reason: "below_threshold" });
  });

  it("at the floor: distinct visitors per class, day-precision last outcome", () => {
    const s = summarizeGemOutcomes(
      linkVisitOutcomes(
        [visit(U(1), 0), visit(U(1), 30), visit(U(2), 0), visit(U(3), 0), visit(U(4), 0)],
        [
          report(U(1), "still_here", 1),
          report(U(1), "still_worth_it", 31), // same visitor twice → one visitor
          report(U(2), "too_crowded", 2),
          report(U(2), "still_here", 2), //      one visitor, two classes
          report(U(3), "closed", 40),
        ],
      ),
    );
    assert.equal(s.determined, true);
    if (!s.determined) return;
    assert.equal(s.verifiedVisitors, 4);
    assert.equal(s.reportingVisitors, 3);
    assert.equal(s.confirmed, 2);
    assert.equal(s.degraded, 1);
    assert.equal(s.noted, 1);
    assert.equal(s.lastOutcomeDay, at(40).slice(0, 10));
    assert.equal(JSON.stringify(s).includes(U(1)), false, "no user id leaves the summary");
  });
});

describe("readGemOutcomeSummary — reads only verified visits, and says when it could not read", () => {
  const rows = () => ({
    hidden_gem_visits: [visit(U(1), 0), visit(U(2), 0), visit(U(3), 0), visit(U(4), 0, true)],
    hidden_gem_contributions: [report(U(1), "still_here", 1), report(U(2), "still_here", 1), report(U(3), "access_changed", 1), report(U(4), "still_here", 1)],
  });

  it("summarises the gem's verified visits", async () => {
    const s = await readGemOutcomeSummary(makeFailClosedClient({ rows: rows() }), GEM, NOW);
    assert.equal(s.determined, true);
    if (!s.determined) return;
    assert.deepEqual([s.reportingVisitors, s.confirmed, s.degraded], [3, 2, 1]);
  });

  it("an unreadable visits or contributions table is 'unreadable', never zero", async () => {
    for (const table of ["hidden_gem_visits", "hidden_gem_contributions"]) {
      const sc = makeFailClosedClient({ rows: rows(), failOn: (ctx) => (ctx.table === table ? { message: "down", code: "57P01" } : null) });
      assert.deepEqual(await readGemOutcomeSummary(sc, GEM, NOW), { determined: false, reason: "unreadable" }, table);
    }
  });
});

// ── Route: GET /api/hidden-gems/:id carries the summary ──────────────────────

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    }).on("error", reject);
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noop };
    req.log = noop;
    next();
  });
  app.use("/api", hiddenGemsRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

function gemDb(extra: Record<string, any[]> = {}, status = "active") {
  const recent = (h: number) => new Date(Date.now() - 48 * 3_600_000 + h * 3_600_000).toISOString();
  return makeFailClosedClient({
    rows: {
      feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }],
      hidden_gems: [{ id: GEM, name: "Quiet cove", status, sensitivity: "public", category: "nature", city: "Da Nang", country: "Vietnam", submitted_by: U(9) }],
      hidden_gem_visits: [1, 2, 3].map((n) => ({ gem_id: GEM, user_id: U(n), visited_at: recent(0), is_suspicious: false })),
      hidden_gem_contributions: [1, 2, 3].map((n) => ({ gem_id: GEM, user_id: U(n), contribution_type: n === 3 ? "closed" : "still_worth_it", updated_at: recent(2) })),
      ...extra,
    },
  });
}

describe("GET /api/hidden-gems/:id — the §16.1 OUTCOME on the gem", () => {
  it("serves the floored summary for a gem the caller may see", async () => {
    const db = gemDb();
    _setTestClient(db, true);
    _setTestServiceClient(db);
    const r = await get(`/api/hidden-gems/${GEM}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = r.body.gem.visitOutcomes;
    assert.equal(o.determined, true, JSON.stringify(o));
    assert.deepEqual([o.reportingVisitors, o.confirmed, o.degraded], [3, 2, 1]);
  });

  it("a pending gem is still 404 to a stranger — the outcome adds no way in", async () => {
    const db = gemDb({}, "pending");
    _setTestClient(db, true);
    _setTestServiceClient(db);
    const r = await get(`/api/hidden-gems/${GEM}`);
    assert.equal(r.status, 404);
    assert.equal(JSON.stringify(r.body).includes("visitOutcomes"), false);
  });

  it("unreadable visits → the gem still loads, and says the outcome is unreadable", async () => {
    const db = makeFailClosedClient({
      rows: {
        feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }],
        hidden_gems: [{ id: GEM, name: "Quiet cove", status: "active", sensitivity: "public", category: "nature", city: "Da Nang", country: "Vietnam", submitted_by: U(9) }],
      },
      failOn: (ctx) => (ctx.table === "hidden_gem_visits" ? { message: "down", code: "57P01" } : null),
    });
    _setTestClient(db, true);
    _setTestServiceClient(db);
    const r = await get(`/api/hidden-gems/${GEM}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.gem.visitOutcomes, { determined: false, reason: "unreadable" });
  });
});
