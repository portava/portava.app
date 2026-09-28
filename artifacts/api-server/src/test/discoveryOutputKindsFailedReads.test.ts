/**
 * census-discovery §101 (lane W11-X2 round 5; DV-83, §100.11 finding 3) — the
 * output-kinds producer answers a failed read as UNAVAILABLE, never as an
 * empty or complete list. Register D-W11X2-33.
 *
 * `materialiseCandidates` records every read it could not make in
 * `failedReads`: `discovery_places`, `blocks`, `profiles.standing` and the
 * canonical `places`. `rankEmergingForViewer` refused only the first. A failed
 * blocks or standing read drops every authored row (fail closed, as it must);
 * a failed canonical read drops every canonical candidate. Either way the kind
 * answered `empty` (or a shorter `ranked`) and the route sent 200 with
 * `items: []` — a list that says "nothing emerging here" about a city whose
 * candidates were never all read. Every failed read that can remove or add a
 * row now makes the answer `unavailable`, which the route already sends as 503
 * degraded_unavailable with its reason, and the rail already renders as its
 * failed-read state (§100, D-W11X2-27). The envelope has no partial form, and
 * the rows it would carry are exactly the ones a failed eligibility read could
 * not clear, so partial is not offered.
 *
 *   OK-P1  a failed blocks read over the only (authored) candidate: not `empty` (the verifier's probe)
 *   OK-P2  a failed canonical `places` read: not `empty` (the verifier's probe)
 *   U1     a failed blocks read: `unavailable`, reason `blocks`, no items
 *   U2     a failed canonical read: `unavailable`, reason `places`
 *   U3     a failed standing read: `unavailable`, reason `profiles.standing`
 *   U4     a failed blocks read beside rows it could not touch: still `unavailable`, never a shorter `ranked`
 *   R1     the route: a failed blocks read is 503 degraded_unavailable / `blocks`, never 200 with `items: []`
 *   C1     CONTROL: no failed read — `ranked`, the candidate served
 *   C2     CONTROL: blocks erroring but no authored candidate — blocks is never read, so nothing failed: `ranked`
 *   C3     CONTROL: the route with no failure is 200 with the candidate
 *   F1     flag OFF: the route's 404 body is byte-identical with and without the failing read (nothing is read)
 *
 * CONTROLLED DATA. Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryOutputKindsFailedReads.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { rankEmergingForViewer } from "../lib/discoveryCandidates/outputKinds.js";
import outputKindsRouter from "../routes/discoveryOutputKinds.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { invalidateRankDesignFlagCache } from "../lib/discoveryRankFlags.js";
import { makeFakeCandidateDb, flagRow, type Row } from "./helpers/fakeCandidateDb.js";
import { NOW, P, VIEWER, AUTHOR_FOLLOWED, viewer, world } from "./helpers/candidateWorld.js";

beforeEach(() => { invalidateDiscoveryModifiersFlagCache(); invalidateServeLogFlagCache(); invalidateRankDesignFlagCache(); _resetStopConditionsForTest(); });

const CANON = "99999999-9999-4999-8999-999999999999";

/** The emerging candidate, authored — so the blocks and standing reads are owed. */
function authoredWorld(kindsOn = true): Record<string, Row[]> {
  const w = world(); w["feature_flags"] = kindsOn ? [flagRow("discovery_output_kinds_enabled", true)] : [];
  for (const r of w["discovery_places"]!) if (r["id"] === P.EMERGING) r["submitted_by"] = AUTHOR_FOLLOWED;
  return w;
}

/** The emerging candidate is a canonical `places` row only. */
function canonicalWorld(): Record<string, Row[]> {
  const w = world(); w["feature_flags"] = [flagRow("discovery_output_kinds_enabled", true)];
  const run = w["place_momentum"]![0]!["computed_at"];
  w["place_momentum"] = [{ place_id: `db/${CANON}`, trend_state: "emerging", recent_rate: 9, computed_at: run }];
  w["places"] = [...(w["places"] ?? []), { id: CANON, city: "Miami", name: "canon", category: "food", status: "active", merged_into_place_id: null, lat: 25.7, lng: -80.2 }];
  return w;
}

describe("§101 — output kinds: a failed read is unavailable, never an empty or shorter list (DV-83)", () => {
  it("OK-P1 emerging: blocks read fails over the only (authored) candidate -> must be 'unavailable', not 'empty'", async () => {
    const w = world(); w["feature_flags"] = [flagRow("discovery_output_kinds_enabled", true)];
    for (const r of w["discovery_places"]!) if (r["id"] === P.EMERGING) r["submitted_by"] = AUTHOR_FOLLOWED;
    const ok = await rankEmergingForViewer(makeFakeCandidateDb(structuredClone(w)), viewer(), { nowMs: NOW });
    assert.equal(ok.status, "ranked", "control: without the failure the candidate is served");
    const r = await rankEmergingForViewer(makeFakeCandidateDb(w, { erroring: ["blocks"] }), viewer(), { nowMs: NOW });
    assert.notEqual(r.status, "empty", `blocks read failed but status=${r.status}, items=${r.items.length}`);
  });

  it("OK-P2 emerging: canonical places read fails for a candidate absent from discovery_places -> must not be 'empty'", async () => {
    const w = world(); w["feature_flags"] = [flagRow("discovery_output_kinds_enabled", true)];
    const run = w["place_momentum"]![0]!["computed_at"];
    w["place_momentum"] = [{ place_id: `db/${CANON}`, trend_state: "emerging", recent_rate: 9, computed_at: run }];
    w["places"] = [...(w["places"] ?? []), { id: CANON, city: "Miami", name: "canon", category: "food", status: "active", merged_into_place_id: null, lat: 25.7, lng: -80.2 }];
    const ctl = await rankEmergingForViewer(makeFakeCandidateDb(structuredClone(w)), viewer(), { nowMs: NOW });
    assert.equal(ctl.status, "ranked", `control: canonical candidate served without failure (got ${ctl.status})`);
    const r = await rankEmergingForViewer(makeFakeCandidateDb(w, { erroring: ["places"] }), viewer(), { nowMs: NOW });
    assert.notEqual(r.status, "empty", `places read failed but status=${r.status}`);
  });

  it("U1 a failed blocks read: unavailable, reason `blocks`, no items", async () => {
    const r = await rankEmergingForViewer(makeFakeCandidateDb(authoredWorld(), { erroring: ["blocks"] }), viewer(), { nowMs: NOW });
    assert.equal(r.status, "unavailable");
    assert.equal(r.unavailable, "blocks");
    assert.deepEqual(r.items, []);
    assert.equal(r.rankedBy, "none");
  });

  it("U2 a failed canonical read: unavailable, reason `places`", async () => {
    const r = await rankEmergingForViewer(makeFakeCandidateDb(canonicalWorld(), { erroring: ["places"] }), viewer(), { nowMs: NOW });
    assert.equal(r.status, "unavailable");
    assert.equal(r.unavailable, "places");
  });

  it("U3 a failed standing read: unavailable, reason `profiles.standing`", async () => {
    const r = await rankEmergingForViewer(makeFakeCandidateDb(authoredWorld(), { erroring: ["profiles"] }), viewer(), { nowMs: NOW });
    assert.equal(r.status, "unavailable");
    assert.equal(r.unavailable, "profiles.standing");
  });

  it("U4 a failed blocks read beside rows it could not touch: still unavailable, never a shorter `ranked`", async () => {
    const w = authoredWorld();
    const run = w["place_momentum"]![0]!["computed_at"];
    w["place_momentum"]!.push({ place_id: `db/${P.NEW_PLACE}`, trend_state: "emerging", recent_rate: 2, computed_at: run });  // unauthored: the blocks read cannot remove it
    const ctl = await rankEmergingForViewer(makeFakeCandidateDb(structuredClone(w)), viewer(), { nowMs: NOW });
    assert.equal(ctl.status, "ranked"); assert.equal(ctl.items.length, 2, "control: both candidates served without the failure");
    const r = await rankEmergingForViewer(makeFakeCandidateDb(w, { erroring: ["blocks"] }), viewer(), { nowMs: NOW });
    assert.equal(r.status, "unavailable", `a failed blocks read answered ${r.status} with ${r.items.length} of 2`);
  });

  it("C1 CONTROL no failed read: ranked, the candidate served", async () => {
    const r = await rankEmergingForViewer(makeFakeCandidateDb(authoredWorld()), viewer(), { nowMs: NOW });
    assert.equal(r.status, "ranked");
    assert.deepEqual(r.items.map((x) => x.place.id), [`db/${P.EMERGING}`]);
  });

  it("C2 CONTROL blocks erroring but no authored candidate: blocks is never read, so nothing failed", async () => {
    const w = world(); w["feature_flags"] = [flagRow("discovery_output_kinds_enabled", true)];
    const r = await rankEmergingForViewer(makeFakeCandidateDb(w, { erroring: ["blocks"] }), viewer(), { nowMs: NOW });
    assert.equal(r.status, "ranked");
  });
});

// ── The route ────────────────────────────────────────────────────────────────

const TOK = "tok-kinds-failed-reads";
const asServiceClient = (c: object) => c as unknown as Parameters<typeof _setTestServiceClient>[0];
function serve(w: Record<string, Row[]>, erroring: string[] = []) {
  const d = makeFakeCandidateDb(w, { erroring });
  const client = Object.assign(d, { auth: { getUser: async (t: string) => (t === TOK ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid token" } }) } });
  _setTestServiceClient(asServiceClient(client)); _setTestClient(client, true);
  return d;
}

let server: Server;
let base = "";
before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(outputKindsRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

async function get(path: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOK}` } });
  return { status: res.status, raw: await res.text() };
}
const EMERGING = "/v1/discovery/recommendations/emerging_discoveries?destination=Miami";

describe("§101 — the route states the failed read (DV-83)", () => {
  it("R1 a failed blocks read is 503 degraded_unavailable / `blocks`, never 200 with `items: []`", async () => {
    serve(authoredWorld(), ["blocks"]);
    const r = await get(EMERGING);
    assert.equal(r.status, 503, r.raw);
    const body = JSON.parse(r.raw);
    assert.equal(body.error?.code ?? body.code ?? body.error, "degraded_unavailable", r.raw);
    assert.match(r.raw, /"reason":"blocks"/);
    assert.equal(body.items, undefined, "no list travels with the refusal");
  });

  it("C3 CONTROL the route with no failure is 200 with the candidate", async () => {
    serve(authoredWorld());
    const r = await get(EMERGING);
    assert.equal(r.status, 200, r.raw);
    const body = JSON.parse(r.raw);
    assert.deepEqual(body.items.map((x: any) => x.place.id), [`db/${P.EMERGING}`]);
  });

  it("F1 flag OFF: the 404 body is byte-identical with and without the failing read", async () => {
    serve(authoredWorld(false));
    const off = await get(EMERGING);
    serve(authoredWorld(false), ["blocks", "places"]);  // not `profiles`: requireUser reads the viewer's standing there, before the flag
    const offFailing = await get(EMERGING);
    assert.equal(off.status, 404);
    assert.equal(offFailing.status, 404);
    assert.equal(offFailing.raw, off.raw);
  });
});
