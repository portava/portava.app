/**
 * GET /passport/:userId/contributions — the §20 reputation endpoint.
 *
 * `PassportReputationService` had a library test; the ROUTE in front of it had
 * none, so nothing demonstrated that the ledger read is scoped to the traveller
 * in the path, that a blocked relationship gets nothing, or that no raw
 * moderation-shaped data escapes.
 *
 * §20 privacy rules the route must not break:
 *   • only positive aggregate counts + a derived level + expertise labels leave
 *     the service — never a raw event row, a source id, or a report-against
 *     count (§10, §34 "not a public moderation record");
 *   • a blocked / unavailable relationship gets `{ contributions: null,
 *     restricted: true }` — never a partial summary;
 *   • paid / sponsored contributions never inflate a factual count.
 *
 * The ownership test carries a POSITIVE CONTROL: the other traveller's ledger
 * rows ARE reachable at their own path, so their absence from the first
 * response is the user filter and not an unrelated exclusion.
 *
 * MUTATION PROOFS (each performed, each RED):
 *   • remove the `isBlocked || isUnavailable` guard → the blocked test RED;
 *   • change `buildReputationSummary(sc, targetId)` to use the viewer id → the
 *     ownership test RED.
 *
 * Run: node --import tsx/esm --test src/test/passportContributionsRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import passportRouter from "../routes/passport.js";

const ALICE = "aaaaaaaa-1111-4111-8111-111111111111";
const BOB = "bbbbbbbb-2222-4222-8222-222222222222";
const MALLORY = "cccccccc-3333-4333-8333-333333333333";

const TOKENS: Record<string, string> = {
  "alice-token": ALICE,
  "bob-token": BOB,
  "mallory-token": MALLORY,
};

/** Alice: 3 Da Nang pulse reports + 1 gem + 1 paid report that must not count. */
const LEDGER = [
  { user_id: ALICE, event_type: "pulse_contribution", metadata: { city: "Da Nang", category: "nightlife" }, created_at: "2026-01-01" },
  { user_id: ALICE, event_type: "pulse_contribution", metadata: { city: "Da Nang", category: "nightlife" }, created_at: "2026-01-02" },
  { user_id: ALICE, event_type: "pulse_contribution", metadata: { city: "Da Nang", category: "food" }, created_at: "2026-01-03" },
  { user_id: ALICE, event_type: "hidden_gem_verified", metadata: { city: "Da Nang", category: "food" }, created_at: "2026-01-04" },
  { user_id: ALICE, event_type: "pulse_contribution", metadata: { paid: true, city: "Da Nang", category: "nightlife" }, created_at: "2026-01-05" },
  // Bob's own rows — the control for the ownership test.
  { user_id: BOB, event_type: "hidden_gem_verified", metadata: { city: "Bangkok", category: "events" }, created_at: "2026-02-01" },
  { user_id: BOB, event_type: "hidden_gem_verified", metadata: { city: "Bangkok", category: "events" }, created_at: "2026-02-02" },
];

function db() {
  const client = makePassportDb({
    profiles: [
      { id: ALICE, handle: "alice", username: "alice", display_name: "Alice", account_status: "active", created_at: "2023-01-01" },
      { id: BOB, handle: "bob", username: "bob", display_name: "Bob", account_status: "active", created_at: "2023-01-01" },
      { id: MALLORY, handle: "mallory", username: "mallory", display_name: "Mallory", account_status: "active", created_at: "2023-01-01" },
    ],
    passport_contribution_events: LEDGER,
    // Mallory has blocked Alice. `.or()` in the fake does not narrow, so this
    // single row is only consulted on a viewer/target pair query.
    blocks: [{ blocker_id: MALLORY, blocked_id: ALICE }],
  });
  client.auth = {
    getUser: async (token: string) => {
      const id = TOKENS[token];
      return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad token" } };
    },
  };
  return client;
}

describe("GET /passport/:userId/contributions", () => {
  let server: http.Server;
  let baseUrl = "";

  before(async () => {
    _setTestClient(db(), true);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
    app.use("/", passportRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  function get(path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("returns the §20 summary for a traveller, with paid contributions excluded", async () => {
    const r = await get(`/passport/${ALICE}/contributions`);
    assert.equal(r.status, 200);
    const c = r.json.contributions;
    assert.equal(c.userId, ALICE);
    assert.equal(c.acceptedReports, 3, "the paid pulse report must not count");
    assert.equal(c.hiddenGems, 1);
    assert.equal(c.totalContributions, 4);
    assert.deepEqual(c.cityExpertise, ["Da Nang"]);
    assert.equal(c.levelLabel, "New Contributor");
  });

  it("reads the ledger of the traveller in the PATH — with a positive control", async () => {
    const alice = await get(`/passport/${ALICE}/contributions`, { authorization: "Bearer bob-token" });
    assert.equal(alice.json.contributions.userId, ALICE);
    assert.equal(alice.json.contributions.hiddenGems, 1, "Bob's two gems must not appear on Alice's card");

    // POSITIVE CONTROL — Bob's rows are real and reachable at his own path, so
    // the count above is the user filter and not an empty fixture.
    const bob = await get(`/passport/${BOB}/contributions`, { authorization: "Bearer bob-token" });
    assert.equal(
      bob.json.contributions.hiddenGems,
      2,
      "control failed: Bob's ledger rows are invisible everywhere, so the first assertion proved nothing",
    );
  });

  it("resolves a handle as well as a uuid, to the same traveller", async () => {
    const byHandle = await get("/passport/alice/contributions");
    assert.equal(byHandle.status, 200);
    assert.equal(byHandle.json.contributions.userId, ALICE);
  });

  it("gives a blocked relationship nothing at all — never a partial summary", async () => {
    const r = await get(`/passport/${ALICE}/contributions`, { authorization: "Bearer mallory-token" });
    assert.equal(r.status, 200);
    assert.equal(r.json.contributions, null);
    assert.equal(r.json.restricted, true);

    // POSITIVE CONTROL — the same path, an unblocked viewer, does get a summary.
    const ok = await get(`/passport/${ALICE}/contributions`, { authorization: "Bearer bob-token" });
    assert.ok(ok.json.contributions, "control failed: nobody can read Alice's card, so the block proved nothing");
  });

  it("never leaks a raw ledger row, a source id, or moderation data", async () => {
    const r = await get(`/passport/${ALICE}/contributions`);
    const keys = Object.keys(r.json.contributions).sort();
    assert.deepEqual(keys, [
      "acceptedReports", "cityExpertise", "confirmations", "hiddenGems",
      "level", "levelLabel", "topExpertise", "totalContributions", "userId",
    ], "the §20 card is a fixed positive-aggregate shape — a new key here is a disclosure decision");
    const serialized = JSON.stringify(r.json);
    for (const leak of ["source_id", "sourceId", "event_type", "metadata", "reports_against", "moderation"]) {
      assert.ok(!serialized.includes(leak), `contributions response leaked ${leak}`);
    }
  });

  it("404s an unknown traveller rather than returning an empty card", async () => {
    const r = await get("/passport/nobodyatall/contributions");
    assert.equal(r.status, 404);
  });
});
