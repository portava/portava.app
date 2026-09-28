/**
 * census-media §35 (MD197) — GET /v1/media/contributors/:contributorId/reputation
 * reads the CALLER'S OWN reputation only.
 *
 * WHAT WAS WRONG. The route took any account id from the path and any place id
 * from the query, and answered with that account's §25 reputation, computed from
 * its intel_observations. Since migration 3002 those rows are keyed by rotating
 * contributor tokens, so the service first ran 3310's account -> tokens bridge
 * for the NAMED account — whose contract (lib/intelConsent
 * readOwnContributorIdentities) is that the caller's authorization already
 * established the account id. The route established none. `placeExpertise` is
 * min(accepted observations at the place, 8) / 8, so any signed-in caller could
 * read how many accepted reports a named person had made AT A NAMED PLACE: where
 * that person has been. Whether other people may see a contributor's §25 trust at
 * all is the owner's MD197 question (census-media §35); until it is answered the
 * route discloses nothing new.
 *
 * Driven over HTTP through the real router, requireUser and the real
 * MediaContributorReputationService, against an in-memory client that records
 * every table read and every RPC. Each request opens its own connection
 * (`agent: false`, census-media §28.12).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { resetContributorIdentityShapeMemo } from "../lib/intelConsent.js";
import { readContributorReputation } from "../services/media/MediaContributorReputationService.js";
import mediaViewRequestRouter from "../routes/mediaViewRequest.js";

const SELF = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PLACE = "33333333-3333-4333-8333-333333333333";
const TOKENS: Record<string, string[]> = {
  [SELF]: ["aaaaaaaa-0000-4000-8000-00000000000a"],
  [OTHER]: ["bbbbbbbb-0000-4000-8000-00000000000b"],
};

interface Log { reads: string[]; rpcs: Array<{ fn: string; args: any }> }

function makeClient(log: Log) {
  const tables: Record<string, any[]> = {
    profiles: [
      { id: SELF, account_status: "active" },
      { id: OTHER, account_status: "active" },
    ],
    intel_observations: [
      // SELF: two accepted reports at PLACE.
      { actor_id: TOKENS[SELF]![0], subject_id: PLACE, claim_type: "crowd.level", moderation_state: "allowed" },
      { actor_id: TOKENS[SELF]![0], subject_id: PLACE, claim_type: "queue.wait", moderation_state: "allowed" },
      // OTHER: three accepted reports at PLACE — what the old route disclosed.
      { actor_id: TOKENS[OTHER]![0], subject_id: PLACE, claim_type: "crowd.level", moderation_state: "allowed" },
      { actor_id: TOKENS[OTHER]![0], subject_id: PLACE, claim_type: "queue.wait", moderation_state: "allowed" },
      { actor_id: TOKENS[OTHER]![0], subject_id: PLACE, claim_type: "vibe.state", moderation_state: "allowed" },
    ],
    intel_state_snapshots: [],
    trips: [],
    trip_members: [],
    places: [{ id: PLACE, city: "Da Nang" }],
  };
  function builder(name: string) {
    let rows = [...(tables[name] ?? [])];
    const b: any = {
      select() { return b; },
      eq(k: string, v: unknown) { rows = rows.filter((r) => r[k] === v); return b; },
      in(k: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[k])); return b; },
      limit(n: number) { rows = rows.slice(0, n); return b; },
      order() { return b; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "no rows" } }); },
      then(res: (r: any) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve({ data: rows, error: null }).then(res, rej);
      },
    };
    return b;
  }
  return {
    auth: { getUser: async () => ({ data: { user: { id: SELF } }, error: null }) },
    from(name: string) {
      log.reads.push(name);
      return builder(name);
    },
    async rpc(fn: string, args: any) {
      log.rpcs.push({ fn, args });
      if (fn === "intel_consented_contributor_tokens") return { data: [], error: null };
      if (fn === "intel_contributor_tokens_for_actor") return { data: TOKENS[args?.p_actor_id] ?? [], error: null };
      return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    },
  };
}

let server: http.Server;
let port = 0;
let log: Log;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", agent: false, headers: { authorization: "Bearer test-token" } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let body: any = raw;
          try { body = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", mediaViewRequestRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  log = { reads: [], rpcs: [] };
  resetContributorIdentityShapeMemo();
  _setTestClient(makeClient(log), true);
});

const tokenRpcsFor = (id: string) =>
  log.rpcs.filter((c) => c.fn === "intel_contributor_tokens_for_actor" && c.args?.p_actor_id === id).length;

describe("MD197 — a contributor's reputation is read only by that contributor", () => {
  it("CONTROL: the data the old route disclosed is really there — the service computes OTHER's count at PLACE", async () => {
    const rep = await readContributorReputation(makeClient(log), { contributorId: OTHER, subjectId: PLACE });
    assert.equal(rep.placeExpertise, 3 / 8, "three accepted reports at PLACE: placeExpertise = 3/8");
    assert.equal(tokenRpcsFor(OTHER), 1, "computing it resolves OTHER's rotating tokens");
  });

  it("another account's reputation is refused, and nothing about that account is resolved or read", async () => {
    const res = await get(`/api/v1/media/contributors/${OTHER}/reputation?subjectId=${PLACE}`);
    assert.equal(res.status, 403);
    assert.equal(res.body?.error, "forbidden");
    assert.equal(res.body?.reputation, undefined, "no reputation object, not even an empty one");
    assert.equal(tokenRpcsFor(OTHER), 0, "OTHER's rotating tokens must not be resolved");
    assert.deepEqual(log.rpcs, [], "no contributor-identity RPC at all");
    assert.ok(!log.reads.includes("intel_observations"), "no contribution row is read");
    assert.ok(!log.reads.includes("intel_state_snapshots"));
    assert.ok(!log.reads.includes("trips") && !log.reads.includes("trip_members"), "no journey is read for OTHER either");
  });

  it("without a place it is refused too — reliability and live accuracy are the same account's rows", async () => {
    const res = await get(`/api/v1/media/contributors/${OTHER}/reputation`);
    assert.equal(res.status, 403);
    assert.deepEqual(log.rpcs, []);
    assert.ok(!log.reads.includes("intel_observations"));
  });

  it("the caller's own reputation is still served, resolved in the safe direction", async () => {
    const res = await get(`/api/v1/media/contributors/${SELF}/reputation?subjectId=${PLACE}`);
    assert.equal(res.status, 200);
    assert.equal(res.body?.reputation?.basis, "intelligence_trust");
    assert.equal(res.body?.reputation?.placeExpertise, 2 / 8, "SELF's own two accepted reports at PLACE");
    assert.equal(tokenRpcsFor(SELF), 1);
    assert.equal(tokenRpcsFor(OTHER), 0);
  });

  it("a malformed id is still a 400, before any identity question", async () => {
    const res = await get(`/api/v1/media/contributors/not-a-uuid/reputation`);
    assert.equal(res.status, 400);
    assert.deepEqual(log.rpcs, []);
  });
});
