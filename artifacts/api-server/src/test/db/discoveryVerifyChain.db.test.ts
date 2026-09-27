/**
 * discoveryVerifyChain.db.test.ts — census-discovery §59 (verification lane
 * P12), DC-26's one cross-lane class: `12` "recommendation → behavior →
 * attribution", the H5 skeleton §54.11 specified and nobody owned.
 *
 * THE CHAIN, each hop through the code that ships, on a real PostgreSQL 16
 * carrying the whole migration chain (scripts/local-db/up.sh):
 *
 *   SERVE     GET /api/discovery (routes/discovery.ts, signed in) — the ids on
 *             the RESPONSE are P3's contract (lib/discoveryRecommendationRecord),
 *             and lib/discoveryServeLog writes one rank_events row per item.
 *   OUTCOME   POST /api/rank-events/outcome { recommendation_id } — the route
 *             reads the viewer's own exposure and binds it with
 *             `bindOutcomeToExposure` (P3), then compare-and-sets it to `save`.
 *   ATTRIBUTE resolveServedRecommendation + recordCreatorAttribution (P10,
 *             services/creators/CreatorAttributionService.ts) under a PUBLISHED
 *             rule version, into creator_attributions, whose 3386 trigger
 *             `ca_recommendation_is_served` refuses an id no exposure carries.
 *
 * Every hop runs the REAL `@supabase/supabase-js` client over `bridge()`
 * (./discoveryVerifyBridge.ts):
 * an injected fetch that turns each PostgREST request into one SQL statement
 * run by psql as service_role (the API's service client), so every CHECK,
 * unique index and trigger the chain carries is the database's, not a fake's.
 * served_at therefore comes back in PostgreSQL's `+00:00` spelling, as it does
 * from PostgREST.
 *
 * FLAGS ARE NEVER WRITTEN. `feature_flags` reads are answered from an in-memory
 * VALUES list (the creatorLedgerPsqlClient convention); the harness rows stay
 * as their migrations seeded them, and V0 asserts that.
 *
 *   V1  the chain: the served id is stored, the save moves THAT row, the
 *       attribution carries THAT id, under the published test rule version
 *   V2  another viewer's id: the outcome is refused (404) and moves nothing;
 *       the binding refuses; no attribution is written
 *   V3  an unknown (well-formed, never served) id: refused at every hop, and
 *       the database refuses it too, from a writer that bypasses the service
 *   V4  an anonymous serve's ids: on the response, never in rank_events, never
 *       bindable by anyone — including a signed-in viewer quoting them
 *   V5  retries: a replayed outcome is `duplicate` and moves nothing; a
 *       replayed attribution is `replayed` and writes no second row
 *   V6  LIMIT, pinned: the database checks EXISTENCE, not ownership (3386's
 *       header says so) — a writer that bypasses the service CAN link another
 *       viewer's id; only the service's binding stops it
 *   V7  DEFECT, pinned (DV-37): the KEYLESS outcome path, retried after the
 *       same item was served twice, moves the second exposure as well
 *   V0  the flag rows were never touched
 *
 * The rule version is a clearly named TEST FIXTURE, published in before() and
 * deleted in after() with every row this suite created.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import pino from "pino";
import { HAVE_DB, exec, rows, scalar, seedUser } from "./localDb.js";
import { bridge, lit, type Bridge } from "./discoveryVerifyBridge.js";
import { _setTestClient } from "../../lib/http.js";
import { _setTestServiceClient } from "../../lib/supabase.js";
import discoveryRouter, {
  _setTestDbPlacesOverride, _injectTestCacheEntry, _clearTestCacheEntry, _clearTestCompassCache,
  type DiscoveryPlace,
} from "../../routes/discovery.js";
import rankEventsRouter, { _resetRecommendationIdSchemaLatch } from "../../routes/rankEvents.js";
import { invalidateServeLogFlagCache, _resetServeRequestTableLatch } from "../../lib/discoveryServeLog.js";
import { invalidateDiscoveryEngineModeCache } from "../../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../../compass/flags.js";
import { isRecommendationId } from "../../lib/discoveryRecommendationRecord.js";
import {
  recordCreatorAttribution,
  resolveServedRecommendation,
} from "../../services/creators/CreatorAttributionService.js";

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

const RULE_VERSION = "creator-rules/discovery-creator/v959";
const RULE_NOTE = "TEST FIXTURE (census-discovery §59 verification suite, P12) — not a production rule; deleted after the suite";
const FLAGS = {
  discovery_serve_log_enabled: { enabled: true },
  creator_attribution_enabled: { enabled: true },
};
const KEY = "lisbon:for_you:10";
const Q = "destination=Lisbon&lat=38.72&lng=-9.14";

let alice = "", bob = "", creator = "";
const users: string[] = [];
const placeIds = [randomUUID(), randomUUID(), randomUUID()];
let server: Server | null = null;
let base = "";
let b: Bridge;

// No network: Overpass and Nominatim fail at once; cache A is seeded per case.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("network blocked");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

function places(): DiscoveryPlace[] {
  return placeIds.map((id, i) => ({
    id: `db/${id}`, name: `p12-place-${i}`, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1 + i, lat: 38.72, lng: -9.14, tags: [],
    address: "Lisbon", website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null, savedCount: 10 - i,
  }) as DiscoveryPlace);
}

function reset(): void {
  invalidateServeLogFlagCache();
  invalidateDiscoveryEngineModeCache();
  invalidateFlagsCache();
  _resetRecommendationIdSchemaLatch();
  _resetServeRequestTableLatch();
  _clearTestCompassCache();
  _clearTestCacheEntry(KEY);
  _setTestDbPlacesOverride(async () => []);
  _injectTestCacheEntry(KEY, places());
}

async function serve(token: string | null): Promise<{ status: number; ids: string[]; items: string[]; body: any }> {
  reset();
  const res = await _originalFetch(`${base}/api/discovery?${Q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await res.json() as any;
  const list = (body?.places ?? []) as any[];
  return { status: res.status, ids: list.map((p) => p.recommendationId), items: list.map((p) => p.id), body };
}

async function outcome(token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await _originalFetch(`${base}/api/rank-events/outcome`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** The serve-log and analytics writes land AFTER the response. Poll; never guess. */
async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 400));

const exposures = (user: string) => rows<{ id: string; item_id: string; position: number; outcome: string; recommendation_id: string; feature_rid: string; served_at: string }>(
  `SELECT id, item_id, position, outcome, recommendation_id, features->>'recommendationId' AS feature_rid, served_at FROM public.rank_events WHERE user_id = '${user}' AND surface = 'discovery' AND outcome <> 'analytics' ORDER BY position`);
const rowsCarrying = (rid: string) => rows<{ user_id: string; outcome: string }>(
  `SELECT user_id, outcome FROM public.rank_events WHERE recommendation_id = ${lit(rid)} ORDER BY outcome`);
const attributionsFor = (subject: string) => rows<{ id: string; recommendation_id: string | null; rule_version: string; attribution_basis: string; beneficiary_user_id: string; idempotency_key: string }>(
  `SELECT id, recommendation_id, rule_version, attribution_basis, beneficiary_user_id, idempotency_key FROM public.creator_attributions WHERE subject_id = '${subject}' ORDER BY computed_at`);

function seamInput(subject: string) {
  return {
    creatorType: "discovery_creator" as const, subjectId: subject, valueEventId: null, beneficiaryUserId: creator,
    weight: 0, confidence: 0.5, grossRevenueMinor: 0, provisionalShareMinor: 0, fraudHold: false, fraudHoldReason: null,
  };
}

describe("DC-26 — recommendation → behaviour → attribution, across lanes, on a real database (census-discovery §59)", { skip: !HAVE_DB }, () => {
  let flagRowsBefore = "";
  let servedA: { ids: string[]; items: string[] } = { ids: [], items: [] };

  before(async () => {
    alice = seedUser("p12alice"); bob = seedUser("p12bob"); creator = seedUser("p12creator");
    users.push(alice, bob, creator);
    flagRowsBefore = scalar(`SELECT COALESCE(json_agg(t ORDER BY flag), '[]'::json)::text FROM (SELECT flag, enabled, metadata FROM public.feature_flags WHERE flag IN ('discovery_serve_log_enabled','creator_attribution_enabled','DISCOVERY_ENGINE_MODE')) t`) ?? "";
    exec(`INSERT INTO public.creator_rule_versions (creator_type, rule_version, params, effective_from, note) VALUES ('discovery_creator', ${lit(RULE_VERSION)}, '{}'::jsonb, now() - interval '1 second', ${lit(RULE_NOTE)});`);
    b = bridge({ flags: FLAGS, tokens: { "alice-token": alice, "bob-token": bob } });
    _setTestClient(b.client, true);
    _setTestServiceClient(b.client);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
    app.use("/api", discoveryRouter);
    app.use("/api", rankEventsRouter);
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server!.address() as any).port}`;
  });

  after(async () => {
    globalThis.fetch = _originalFetch;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    _clearTestCacheEntry(KEY);
    _setTestDbPlacesOverride(null);
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
    const u = users.map(lit).join(",");
    exec(
      `DELETE FROM public.creator_attributions WHERE beneficiary_user_id IN (${u});\n` +
      `DELETE FROM public.rank_events WHERE user_id IN (${u});\n` +
      `DELETE FROM public.recommendations WHERE user_id IN (${u}) OR item_ids && ARRAY[${placeIds.map((p) => lit(`db/${p}`)).join(",")}]::text[];\n` +
      `DELETE FROM public.creator_rule_versions WHERE rule_version = ${lit(RULE_VERSION)};\n` +
      `DELETE FROM public.profiles WHERE id IN (${u});\n` +
      `DELETE FROM auth.users WHERE id IN (${u});`,
    );
  });

  test("V1. the chain: a signed-in serve's id is stored, a save binds to THAT row, and the attribution carries THAT id under a published rule", async () => {
    const r = await serve("alice-token");
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    assert.equal(r.ids.length, 3, "every served item carries an id on the response");
    assert.ok(r.ids.every(isRecommendationId), `P3's shape: ${JSON.stringify(r.ids)}`);
    servedA = { ids: r.ids, items: r.items };
    const stored = await until(() => exposures(alice), (x) => x.length >= 3);
    assert.equal(stored.length, 3, "one rank_events impression per served item");
    for (const row of stored) {
      assert.equal(row.recommendation_id, r.ids[row.position], `position ${row.position}: the stored column is the response's id`);
      assert.equal(row.feature_rid, r.ids[row.position], "and features.recommendationId is the same token");
      assert.equal(row.item_id, r.items[row.position]);
      assert.equal(row.outcome, "impression");
    }

    const saved = await outcome("alice-token", { item_id: r.items[0], surface: "discovery", outcome: "save", recommendation_id: r.ids[0] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body, { ok: true });
    const moved = exposures(alice).find((x) => x.position === 0)!;
    assert.equal(moved.outcome, "save", "the bound exposure is the row that moved");
    assert.equal(moved.recommendation_id, r.ids[0], "and it still carries the served id");
    assert.deepEqual(exposures(alice).filter((x) => x.position !== 0).map((x) => x.outcome), ["impression", "impression"], "no other row moved");
    await until(() => rowsCarrying(r.ids[0]!), (x) => x.length >= 2);
    assert.deepEqual(rowsCarrying(r.ids[0]!).map((x) => [x.user_id === alice, x.outcome]), [[true, "analytics"], [true, "save"]],
      "the analytics row shares the exposure's id; both are the viewer's");

    const occurredAt = scalar(`SELECT outcome_at FROM public.rank_events WHERE id = '${moved.id}'`)!;
    const bound = await resolveServedRecommendation(b.client, { viewerUserId: alice, recommendationId: r.ids[0], itemId: r.items[0], occurredAt: new Date(occurredAt).toISOString() });
    assert.equal(bound.ok, true, JSON.stringify(bound));
    if (!bound.ok) return;
    assert.equal(bound.value.exposureRowId, moved.id, "bound to the exposure the save moved — never the analytics row that shares its id");
    assert.equal(bound.value.recommendationId, r.ids[0]);

    const subject = placeIds[0]!;
    const rec = await recordCreatorAttribution(b.client, { ...seamInput(subject), recommendation: bound.value });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    const got = attributionsFor(subject);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.recommendation_id, r.ids[0], "the creator_attributions row carries the served id");
    assert.equal(got[0]!.rule_version, RULE_VERSION, "recorded under the version in force — the published test fixture");
    assert.equal(got[0]!.beneficiary_user_id, creator);
    assert.equal(got[0]!.attribution_basis, "seam_no_producer", "discovery_creator has no value-event producer (07 §2): a seam, honestly");
    assert.deepEqual(b.unmodelled, [], `every request on the chain was modelled:\n${b.unmodelled.join("\n")}`);
  });

  test("V2. another viewer's id: the outcome is refused and moves nothing, the binding refuses, and no attribution is written", async () => {
    assert.equal(servedA.ids.length, 3, "precondition: V1 served alice");
    const bobServe = await serve("bob-token");
    assert.equal(bobServe.status, 200);
    await until(() => exposures(bob), (x) => x.length >= 3);
    const aliceRid = servedA.ids[1]!;
    const before = exposures(alice).find((x) => x.position === 1)!;
    const stolen = await outcome("bob-token", { item_id: servedA.items[1], surface: "discovery", outcome: "save", recommendation_id: aliceRid });
    assert.equal(stolen.status, 404, JSON.stringify(stolen.body));
    await settle();
    assert.equal(exposures(alice).find((x) => x.position === 1)!.outcome, before.outcome, "alice's row did not move");
    assert.deepEqual(rowsCarrying(aliceRid).map((x) => [x.user_id === alice, x.outcome]), [[true, "impression"]], "no analytics row, no row of bob's, carries alice's id");
    assert.equal(exposures(bob).find((x) => x.position === 1)!.outcome, "impression", "and bob's own exposure of the same item did not move either");

    const cross = await resolveServedRecommendation(b.client, { viewerUserId: bob, recommendationId: aliceRid, itemId: servedA.items[1], occurredAt: new Date().toISOString() });
    assert.deepEqual([cross.ok, !cross.ok && cross.reason], [false, "recommendation_not_found"], "another viewer's id binds nothing, and does not say whose it is");
    assert.equal(attributionsFor(placeIds[1]!).length, 0, "no attribution exists for the subject");
  });

  test("V3. an unknown, well-formed id: 404 at the route, refused by the binding, and refused by the database from any writer", async () => {
    const unknown = "P12unknownXXXXXXXXXXXX";
    assert.equal(isRecommendationId(unknown), true, "precondition: the id is well-formed, so only binding can refuse it");
    const o = await outcome("alice-token", { item_id: servedA.items[2], surface: "discovery", outcome: "save", recommendation_id: unknown });
    assert.equal(o.status, 404, JSON.stringify(o.body));
    const r = await resolveServedRecommendation(b.client, { viewerUserId: alice, recommendationId: unknown, occurredAt: new Date().toISOString() });
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "recommendation_not_found"]);
    const direct = await b.client.from("creator_attributions").insert({
      creator_type: "discovery_creator", subject_kind: "place", subject_id: placeIds[2], value_event: "save_to_trip",
      value_event_id: null, attribution_basis: "seam_no_producer", beneficiary_user_id: creator,
      rule_version: RULE_VERSION, idempotency_key: `p12-v3-${randomUUID()}`, recommendation_id: unknown,
    }).select().single();
    assert.equal(direct.error?.code, "23503", JSON.stringify(direct.error));
    assert.match(String(direct.error?.message), /names no served exposure/);
    assert.equal(attributionsFor(placeIds[2]!).length, 0);
  });

  test("V4. an anonymous serve's ids are on the response and nowhere in rank_events — no viewer can bind them", async () => {
    const anon = await serve(null);
    assert.equal(anon.status, 200);
    assert.equal(anon.ids.length, 3, "an anonymous serve still stamps every item (hop 1)");
    assert.ok(anon.ids.every(isRecommendationId));
    assert.ok(anon.ids.every((id) => !servedA.ids.includes(id)), "the anonymous ids are not the signed-in viewer's");
    const anonRequests = () => Number(scalar(`SELECT count(*) FROM public.recommendations WHERE user_id IS NULL AND item_ids && ARRAY[${anon.items.map(lit).join(",")}]::text[]`));
    assert.equal(await until(anonRequests, (n) => n >= 1), 1, "the anonymous serve is recorded as ONE per-request row (3376), with no viewer");
    await settle();
    assert.equal(Number(scalar(`SELECT count(*) FROM public.rank_events WHERE recommendation_id IN (${anon.ids.map(lit).join(",")})`)), 0,
      "an anonymous serve writes NO exposure row (3376's design)");
    const o = await outcome("alice-token", { item_id: anon.items[0], surface: "discovery", outcome: "save", recommendation_id: anon.ids[0] });
    assert.equal(o.status, 404, "a signed-in viewer quoting an anonymous id binds nothing");
    const r = await resolveServedRecommendation(b.client, { viewerUserId: alice, recommendationId: anon.ids[0], itemId: anon.items[0] });
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "recommendation_not_found"]);
    const direct = await b.client.from("creator_attributions").insert({
      creator_type: "discovery_creator", subject_kind: "place", subject_id: placeIds[0], value_event: "save_to_trip",
      value_event_id: null, attribution_basis: "seam_no_producer", beneficiary_user_id: creator,
      rule_version: RULE_VERSION, idempotency_key: `p12-v4-${randomUUID()}`, recommendation_id: anon.ids[0],
    }).select().single();
    assert.equal(direct.error?.code, "23503", "the database refuses an anonymous id: no exposure row carries it");
  });

  test("V5. retries: a replayed save is `duplicate` and moves nothing; a replayed attribution is `replayed` and writes no second row", async () => {
    const rid = servedA.ids[0]!;
    const again = await outcome("alice-token", { item_id: servedA.items[0], surface: "discovery", outcome: "save", recommendation_id: rid });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true, duplicate: true });
    await settle();
    assert.deepEqual(rowsCarrying(rid).map((x) => x.outcome), ["analytics", "save"], "still one exposure and one analytics row");

    const bound = await resolveServedRecommendation(b.client, { viewerUserId: alice, recommendationId: rid, itemId: servedA.items[0] });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    const replay = await recordCreatorAttribution(b.client, { ...seamInput(placeIds[0]!), recommendation: bound.value });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.ok && replay.replayed, true, "the retry is answered as the replay it is");
    const got = attributionsFor(placeIds[0]!);
    assert.equal(got.length, 1, "no second attribution");
    assert.equal(got[0]!.recommendation_id, rid);
  });

  test("V6. LIMIT, pinned: the database checks that an id was SERVED, not WHOSE — a writer that bypasses the service can link another viewer's id", async () => {
    // 3386's header states this: ownership needs the converting viewer, which
    // creator_attributions does not store, so it is the SERVICE's binding (V2)
    // that refuses another viewer's id. This pins the boundary so a reader of
    // §59 cannot mistake the trigger for an ownership check.
    const aliceRid = servedA.ids[2]!;
    const subject = randomUUID();
    const direct = await b.client.from("creator_attributions").insert({
      creator_type: "discovery_creator", subject_kind: "place", subject_id: subject, value_event: "save_to_trip",
      value_event_id: null, attribution_basis: "seam_no_producer", beneficiary_user_id: creator,
      rule_version: RULE_VERSION, idempotency_key: `p12-v6-${randomUUID()}`, recommendation_id: aliceRid,
    }).select().single();
    assert.equal(direct.error, null, `existence, not ownership: ${JSON.stringify(direct.error)}`);
    assert.equal(attributionsFor(subject).length, 1);
  });

  test("V7. DEFECT, pinned (DV-37): a KEYLESS outcome retried after a second serve of the same item moves a SECOND exposure", async () => {
    // The legacy path — no recommendation_id, no session_id — picks "the most
    // recent upgradable row for (viewer, item, surface)". Compare-and-set makes
    // two racing reports move ONE row (E2E O8b), but a sequential retry finds
    // the NEXT upgradable exposure of the same item and moves it too: one tap of
    // "not interested", two dismisses, two negative signals.
    const item = servedA.items[1]!;
    const again = await serve("alice-token");
    assert.equal(again.status, 200);
    await until(() => exposures(alice).filter((x) => x.item_id === item).length, (n) => n >= 2);
    const exposuresOfItem = () => exposures(alice).filter((x) => x.item_id === item);
    assert.equal(exposuresOfItem().length, 2, "precondition: the viewer holds two exposures of one item");
    const body = { item_id: item, surface: "discovery", outcome: "dismiss" };
    const first = await outcome("alice-token", body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const retry = await outcome("alice-token", body);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body, { ok: true }, "the retry is answered as a NEW outcome, not a duplicate");
    assert.deepEqual(exposuresOfItem().map((x) => x.outcome).sort(), ["dismiss", "dismiss"],
      "two exposures moved for one user action — the keyless outcome path is not idempotent where retried");
  });

  test("V0. the flag rows were never written, every request was modelled, and the only refusals were the provoked ones", () => {
    const after = scalar(`SELECT COALESCE(json_agg(t ORDER BY flag), '[]'::json)::text FROM (SELECT flag, enabled, metadata FROM public.feature_flags WHERE flag IN ('discovery_serve_log_enabled','creator_attribution_enabled','DISCOVERY_ENGINE_MODE')) t`) ?? "";
    assert.equal(after, flagRowsBefore);
    assert.deepEqual(b.unmodelled, [], `every request the suite issued was modelled:\n${b.unmodelled.join("\n")}`);
    // The database refused exactly what V3, V4 and V5 provoked, and nothing on
    // the serve, outcome or attribution path failed silently behind a 200.
    assert.deepEqual(b.failed.map((f) => /:: (\S+)/.exec(f)?.[1]), ["23503", "23503", "23505"], b.failed.join("\n"));
    assert.ok(!b.log.some((l) => l.path.startsWith("/rest/v1/feature_flags") && l.method !== "GET" && l.method !== "HEAD"));
  });
});
