/**
 * census-discovery §86 (lane W10-T) — Trails' product rules, each a decision in
 * docs/architecture/discovery-decision-register.md, section W10-T:
 *
 *   R1  E-11      what "stale" means (D-W10T-5)
 *   R2  DC-05     new_creator_exposure is an EXPOSURE share (D-W10T-7)
 *   R3  DC-05     the geographic cell (D-W10T-7)
 *   R4  DV-13     one creator across the whole Trail page (D-W10T-2)
 *   R5–R7 DV-23   media, viewpoints, content similarity (D-W10T-4, E-11)
 *   S1–S3         the same rules through getTrailModules, with a fake database
 *   S4  DV-23     "more from this place" returns exactly what it counts
 *   S5  DV-13     the page bound through the service
 *   S6  DV-24     who may declare a relationship, and what is navigable (D-W10T-8)
 *   S7  DC-20     who may attach; a stranger's suggestion waits for the owner (D-W10T-9)
 *   S8  DV-74     a trend integrity review in force reaches GET …/trending
 *
 * Every case was run RED against a658174a4 (the lane's base) before the code
 * existed; §86.8 lists them.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import {
  computeTrailHealth, isTrailStaleObject, newCreatorExposureShare, trailGeoCell, creatorPageBoundRemovals,
  diversifyTrailModule, MAX_PER_CONTRIBUTOR_PER_PAGE, TRAIL_PAGE_CREATOR_SHARE,
} from "../lib/discoveryTrailHealth.js";
import { getTrailModules, trailTrending } from "../services/trails/TrailService.js";
import { makeRulesDb, type Row } from "./helpers/fakeTrailRulesDb.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const H = 3_600_000, D = 24 * H;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const rel = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const U = (n: number) => `11111111-1111-4111-8111-1111111111${String(n).padStart(2, "0")}`;
const T = "22222222-2222-4222-8222-222222222201";
const T2 = "22222222-2222-4222-8222-222222222202";
const T3 = "22222222-2222-4222-8222-222222222203";
const P = (n: number) => `55555555-5555-4555-8555-5555555555${String(n).padStart(2, "0")}`;
const PL = (n: number) => `33333333-3333-4333-8333-3333333333${String(n).padStart(2, "0")}`;
const CP = (n: number) => `77777777-7777-4777-8777-7777777777${String(n).padStart(2, "0")}`;

const trailRow = (id: string, over: Row = {}): Row => ({
  id, slug: `slug-${id.slice(-4)}`, title: `Trail ${id.slice(-4)}`, description: null, destination: "bangkok",
  place_scope: null, parent_trail_id: null, lifecycle_status: "active", created_by: U(1),
  created_at: rel(D), updated_at: rel(D), ...over,
});
let mseq = 0;
const memberRow = (over: Row): Row => ({
  id: `66666666-6666-4666-8666-${String(++mseq).padStart(12, "0")}`, trail_id: T, source_type: "post", source_id: P(1),
  relationship: "supporting", signal: null, source: "user", confidence: 0.8, contributor_id: U(1),
  content_state: "just_arrived", created_at: rel(H), ...over,
});
const postRow = (id: string, author: string, over: Row = {}): Row => ({
  id, author_id: author, visibility: "public", status: "active", post_status: "published", deleted_at: null, tombstoned_at: null,
  publish_at: null, trip_id: null, canonical_place_id: null, location_place_id: null, primary_media_type: "photo", media_type: null,
  content: `post ${id.slice(-2)} unique words ${id}`, ...over,
});
const profiles = (n: number) => Array.from({ length: n }, (_, i) => ({ id: U(i + 1), account_status: "active", role: "user" }));

// ── pure rules ───────────────────────────────────────────────────────────────

describe("R1 — E-11: stale means out of rotation, or old and not durable (D-W10T-5)", () => {
  it("an evergreen or featured member is never stale by age; an old growing one is; an archived one always is", () => {
    assert.equal(isTrailStaleObject({ content_state: "evergreen", created_at: at(200 * D) }, NOW), false);
    assert.equal(isTrailStaleObject({ content_state: "featured", created_at: at(200 * D) }, NOW), false);
    assert.equal(isTrailStaleObject({ content_state: "growing", created_at: at(200 * D) }, NOW), true);
    assert.equal(isTrailStaleObject({ content_state: "archived_from_active_rotation", created_at: at(H) }, NOW), true);
    assert.equal(isTrailStaleObject({ content_state: "just_arrived", created_at: at(H) }, NOW), false);
  });
  it("§11's stale_object_ratio uses the same predicate", () => {
    const h = computeTrailHealth({
      members: [
        { source_id: "a", contributor_id: "x", confidence: 0.9, content_state: "evergreen", created_at: at(200 * D) },
        { source_id: "b", contributor_id: "y", confidence: 0.9, content_state: "growing", created_at: at(200 * D) },
      ],
      reportCount: 0, nowMs: NOW,
    });
    assert.equal(h.metrics.stale_object_ratio, 0.5);
  });
});

describe("R2 — DC-05: new_creator_exposure is an EXPOSURE share (D-W10T-7)", () => {
  const members = [
    { source_id: "old1", contributor_id: "veteran", confidence: 0.9, content_state: "growing", created_at: at(90 * D) },
    { source_id: "old2", contributor_id: "veteran", confidence: 0.9, content_state: "growing", created_at: at(2 * D) },
    { source_id: "new1", contributor_id: "newcomer", confidence: 0.9, content_state: "just_arrived", created_at: at(3 * D) },
  ];
  it("impressions on the members of contributors new to the Trail, over impressions on attributed members", () => {
    assert.equal(newCreatorExposureShare(members, { old1: 30, old2: 50, new1: 20 }, NOW), 0.2);
    // A membership share would read 1/2 here (one of two contributors has one member): the exposure share does not.
    assert.equal(newCreatorExposureShare(members, { old1: 0, old2: 0, new1: 5 }, NOW), 1);
  });
  it("unmeasured — null — without impressions, and when nothing attributed was ever shown", () => {
    assert.equal(newCreatorExposureShare(members, null, NOW), null);
    assert.equal(newCreatorExposureShare(members, {}, NOW), null);
    const h = computeTrailHealth({ members, reportCount: 0, nowMs: NOW, impressionsBySource: { old1: 30, old2: 50, new1: 20 } });
    assert.equal(h.metrics.new_creator_exposure, 0.2);
    assert.ok(!h.unmeasured.includes("new_creator_exposure"));
  });
});

describe("R3 — DC-05: the geographic cell (D-W10T-7)", () => {
  it("is the Map's degree grid at zoom 14: ~100 m apart is one cell, ~5 km apart is not; bad input is null", () => {
    const a = trailGeoCell(13.7563, 100.5018), b = trailGeoCell(13.7568, 100.5021), c = trailGeoCell(13.80, 100.55);
    assert.ok(a && a.startsWith("14/"));
    assert.equal(a, b);
    assert.notEqual(a, c);
    for (const bad of [[null, 100], [91, 0], ["x", 1], [undefined, 1]] as const) assert.equal(trailGeoCell(bad[0], bad[1]), null);
  });
});

describe("R4 — DV-13: one creator across the whole Trail page (D-W10T-2)", () => {
  const it2 = (id: string, src: string) => ({ id, sourceType: "post", sourceId: src });
  it("a creator holding more than max(2, ⌊page/3⌋) distinct items is trimmed from the tail, to a fixed point", () => {
    const modules = [
      { key: "a", items: [it2("r1", "p1"), it2("r2", "p2"), it2("x1", "q1")] },
      { key: "b", items: [it2("r3", "p3"), it2("r4", "p4"), it2("y1", "q2")] },
      { key: "c", items: [it2("r5", "p5"), it2("r6", "p6")] },
    ];
    const creator = (id: string) => (id.startsWith("r") ? "dominant" : id.startsWith("x") ? "x" : "y");
    const removed = creatorPageBoundRemovals(modules, creator);
    const kept = modules.flatMap((m) => m.items).filter((i) => !removed.has(i.id));
    const mine = kept.filter((i) => i.id.startsWith("r")).length;
    assert.ok(mine <= Math.max(MAX_PER_CONTRIBUTOR_PER_PAGE, Math.floor(kept.length * TRAIL_PAGE_CREATOR_SHARE)), `dominant holds ${mine} of ${kept.length}`);
    assert.deepEqual([...removed].sort(), ["r3", "r4", "r5", "r6"], "the earliest modules keep theirs; the tail is trimmed");
    assert.ok(kept.some((i) => i.id === "x1") && kept.some((i) => i.id === "y1"), "other creators are never trimmed by one creator's bound");
  });
  it("the same content in two modules is ONE item; a creator-less item is never trimmed", () => {
    const modules = [{ key: "a", items: [it2("r1", "p1"), it2("r2", "p2")] }, { key: "b", items: [it2("r1b", "p1"), it2("n1", "z")] }];
    const removed = creatorPageBoundRemovals(modules, (id) => (id.startsWith("r") ? "c" : null));
    assert.equal(removed.size, 0);
  });
});

describe("R5–R7 — DV-23: §10's five clauses on one module (D-W10T-4, E-11)", () => {
  const item = (id: string, over: Partial<{ placeId: string | null; contributorId: string | null; mediaType: string | null; text: string | null }> = {}) =>
    ({ id, placeId: null, contributorId: id, mediaType: "photo", text: null, ...over });
  it("R5 media diversity is work-conserving: a waiting video gets a slot; a one-type page is never cut", () => {
    const photos = Array.from({ length: 8 }, (_, i) => item(`ph${i}`));
    const videos = [item("v1", { mediaType: "video" }), item("v2", { mediaType: "video" })];
    const d = diversifyTrailModule([...photos, ...videos], { pageSize: 8 });
    assert.equal(d.page.length, 8);
    assert.deepEqual(d.page.filter((i) => i.mediaType === "video").map((i) => i.id), ["v1", "v2"]);
    assert.equal(diversifyTrailModule(photos, { pageSize: 8 }).page.length, 8, "one media type: no cap applies");
  });
  it("R6 one viewpoint per (creator, place): the same person's second take on a place is held back and COUNTED for that place", () => {
    const d = diversifyTrailModule([
      item("a1", { contributorId: "alice", placeId: "pl" }), item("a2", { contributorId: "alice", placeId: "pl" }),
      item("b1", { contributorId: "bob", placeId: "pl" }),
    ], { pageSize: 8 });
    assert.deepEqual(d.page.map((i) => i.id), ["a1", "b1"]);
    assert.deepEqual(d.suppressed, [{ id: "a2", reason: "viewpoint_cap" }]);
    assert.deepEqual(d.moreFromThisPlace, { pl: 1 });
    assert.deepEqual(d.heldBackByPlace, { pl: ["a2"] });
  });
  it("R7 near-duplicate TEXT is one content: held back, and counted for its place when it has one", () => {
    const t = "rooftop bar sunset view over the river";
    const d = diversifyTrailModule([
      item("x", { contributorId: "x", text: t }), item("y", { contributorId: "y", text: `${t}!` }),
      item("z", { contributorId: "z", text: "street food night market" }),
    ], { pageSize: 8 });
    assert.deepEqual(d.page.map((i) => i.id), ["x", "z"]);
    assert.deepEqual(d.suppressed, [{ id: "y", reason: "near_duplicate" }]);
    const withPlace = diversifyTrailModule([item("x", { text: t, placeId: "pl" }), item("y", { text: t, placeId: "pl" })], { pageSize: 8 });
    assert.deepEqual(withPlace.heldBackByPlace, { pl: ["y"] });
  });
});

// ── through the service ─────────────────────────────────────────────────────

describe("S1–S3 — the rules through getTrailModules", () => {
  it("S1 a post's canonical venue is linked to the discovery_places MEMBER of that venue (same name, within 1.5 km)", async () => {
    const posts = [P(1), P(2), P(3)].map((id, i) => postRow(id, U(i + 2), { canonical_place_id: CP(1) }));
    const db = makeRulesDb({
      profiles: profiles(6), trails: [trailRow(T)],
      content_trails: [
        memberRow({ source_type: "place", source_id: PL(1), contributor_id: U(1) }),
        ...posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(i + 2) })),
      ],
      posts, places: [{ id: CP(1), name: "Sky Bar", latitude: 13.7215, longitude: 100.5165 }],
      discovery_places: [{ id: PL(1), submitted_by: U(1), name: "Sky  Bar", lat: 13.7225, lng: 100.5170 }],
    });
    const r = await getTrailModules(db, T, { viewerId: U(6), nowMs: Date.now(), pageSize: 8 });
    const ja = r.modules.find((m) => m.key === "just_arrived")!;
    assert.equal(ja.items.length, 2, "four items about ONE venue: two served (MAX_PER_PLACE_PER_PAGE)");
    assert.deepEqual(ja.moreFromThisPlace, { [PL(1)]: 2 }, "the rest counted under the place MEMBER, not the canonical id");
  });

  it("S2 geographic_diversity is computed from the members' places; S3 new_creator_exposure from rank_events", async () => {
    const db = makeRulesDb({
      profiles: profiles(4), trails: [trailRow(T)],
      content_trails: [
        memberRow({ source_type: "place", source_id: PL(1), contributor_id: U(2), created_at: rel(90 * D) }),
        memberRow({ source_type: "place", source_id: PL(2), contributor_id: U(3), created_at: rel(2 * D) }),
      ],
      discovery_places: [
        { id: PL(1), submitted_by: U(2), name: "A", lat: 13.7563, lng: 100.5018 },
        { id: PL(2), submitted_by: U(3), name: "B", lat: 13.80, lng: 100.55 },
      ],
      rank_events: [
        ...Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, surface: "discovery", item_id: `db/${PL(1)}`, outcome: "impression", served_at: rel(H + i), outcome_at: null })),
        { id: "b0", surface: "search", item_id: PL(2), outcome: "impression", served_at: rel(H), outcome_at: null },
      ],
    });
    const r = await getTrailModules(db, T, { viewerId: U(4), pageSize: 8 });
    assert.equal(r.health!.metrics.geographic_diversity, 1, "two places, two cells");
    assert.equal(r.health!.metrics.new_creator_exposure, 0.25, "one of four impressions went to the contributor new to the Trail");
  });
});

// ── over HTTP ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); server.listen(0, "127.0.0.1"); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });
async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("S4 — DV-23: GET …/places/:placeId/more returns exactly the items each module counts", () => {
  it("per module, the list length IS moreFromThisPlace[placeId], and every listed item is one the module did not serve", async () => {
    const posts = [2, 3, 4, 5].map((n) => postRow(P(n), U(n), { canonical_place_id: PL(1) }));
    const db = makeRulesDb({
      profiles: profiles(8), trails: [trailRow(T)],
      content_trails: [
        memberRow({ source_type: "place", source_id: PL(1), contributor_id: U(1) }),
        ...posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(i + 2), content_state: i % 2 ? "evergreen" : "just_arrived" })),
      ],
      posts, places: [{ id: PL(1), name: "Venue", latitude: 13.7, longitude: 100.5 }],
    });
    _setTestClient(db as any, true);
    const mods = await call("GET", `/v1/discovery/trails/${T}/modules`, U(8));
    assert.equal(mods.status, 200);
    const more = await call("GET", `/v1/discovery/trails/${T}/places/${PL(1)}/more`, U(8));
    assert.equal(more.status, 200);
    let counted = 0;
    for (const m of mods.body.modules) {
      const n = m.moreFromThisPlace[PL(1)] ?? 0;
      counted += n;
      const listed = more.body.modules.find((x: any) => x.key === m.key)?.items ?? [];
      assert.equal(listed.length, n, `module ${m.key}: counted ${n}, listed ${listed.length}`);
      for (const it of listed) assert.ok(!m.items.some((s: any) => s.id === it.id), "a held-back item is not also served by that module");
    }
    assert.ok(counted > 0, "the fixture holds items back");
    assert.ok(!JSON.stringify(mods.body).includes("heldBackByPlace"), "the list is never part of the modules payload");
  });
});

describe("S5 — DV-13: the page-wide bound through the service", () => {
  it("one author with eight posts, two others with one each: the author holds at most max(2, ⌊page/3⌋) distinct items", async () => {
    const mine = Array.from({ length: 8 }, (_, i) => postRow(P(10 + i), U(2), { content: `author post number ${i} distinct words ${i}` }));
    const others = [postRow(P(30), U(3)), postRow(P(31), U(4))];
    const db = makeRulesDb({
      profiles: profiles(6), trails: [trailRow(T)],
      content_trails: [
        ...mine.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(5), content_state: i < 4 ? "just_arrived" : "evergreen", created_at: rel((i + 1) * H) })),
        ...others.map((p) => memberRow({ source_id: p.id, contributor_id: U(5) })),
      ],
      posts: [...mine, ...others],
    });
    const r = await getTrailModules(db, T, { viewerId: U(6), pageSize: 8 });
    const distinct = new Map<string, string>();
    for (const m of r.modules) for (const it of m.items) distinct.set(it.sourceId, it.sourceId);
    const authorItems = [...distinct.keys()].filter((id) => mine.some((p) => p.id === id)).length;
    assert.ok(authorItems <= Math.max(MAX_PER_CONTRIBUTOR_PER_PAGE, Math.floor(distinct.size * TRAIL_PAGE_CREATOR_SHARE)), `${authorItems} of ${distinct.size}`);
    assert.ok(distinct.has(P(30)) && distinct.has(P(31)), "both other creators are on the page");
  });
});

describe("S6 — DV-24: who may declare a relationship, and what is navigable (D-W10T-8)", () => {
  const seed = () => makeRulesDb({
    profiles: profiles(4),
    trails: [trailRow(T, { created_by: U(1) }), trailRow(T2, { created_by: U(1), slug: "two" }), trailRow(T3, { created_by: U(2), slug: "three" })],
    trail_edges: [],
  });
  it("the creator of BOTH declares it navigable (201 accepted); of ONE proposes it (202 pending, not navigable); anyone else 403", async () => {
    const db = seed();
    _setTestClient(db as any, true);
    const both = await call("POST", `/v1/discovery/trails/${T}/relations`, U(1), { toTrailId: T2, edgeType: "related" });
    assert.equal(both.status, 201);
    assert.equal(both.body.reviewState, "accepted");
    const one = await call("POST", `/v1/discovery/trails/${T}/relations`, U(1), { toTrailId: T3, edgeType: "seasonal_variant" });
    assert.equal(one.status, 202);
    assert.equal(one.body.reviewState, "pending");
    const stranger = await call("POST", `/v1/discovery/trails/${T}/relations`, U(3), { toTrailId: T2, edgeType: "geographic_sub" });
    assert.equal(stranger.status, 403);
    const child = await call("POST", `/v1/discovery/trails/${T}/relations`, U(1), { toTrailId: T2, edgeType: "child" });
    assert.equal(child.status, 400, "`child` is declared by the proposal that names its parent");
    const related = await call("GET", `/v1/discovery/trails/${T}/related`, U(4));
    assert.deepEqual(related.body.related.map((e: any) => [e.trail.id, e.edgeType]), [[T2, "related"]], "the pending edge is not navigable");
    (db.tables.trail_edges.find((e) => e.to_trail_id === T3)!).review_state = "accepted"; // what trail_admin_review_edge writes
    const after = await call("GET", `/v1/discovery/trails/${T3}/related`, U(4));
    assert.deepEqual(after.body.related.map((e: any) => [e.trail.id, e.edgeType, e.direction]), [[T, "seasonal_variant", "in"]], "accepted: navigable from the other side too");
  });
});

describe("S7 — DC-20: who may attach, and a stranger's suggestion waits (D-W10T-9)", () => {
  const seed = () => makeRulesDb({
    profiles: profiles(4), trails: [trailRow(T, { created_by: U(1) })], content_trails: [],
    posts: [postRow(P(1), U(2))], places: [{ id: CP(1), name: "Canon", latitude: null, longitude: null }],
  });
  it("attach: the author may; the Trail's creator may for authorless content; a stranger is refused not_content_owner and nothing is written", async () => {
    const db = seed();
    _setTestClient(db as any, true);
    const stranger = await call("POST", `/v1/discovery/trails/${T}/content`, U(3), { labels: [{ sourceType: "post", sourceId: P(1), relationship: "primary" }] });
    assert.equal(stranger.status, 409);
    assert.equal(stranger.body.error, "content_refused");
    assert.equal(stranger.body.contentRefusals[0].reason, "not_content_owner");
    assert.equal(db.tables.content_trails.length, 0, "the post's single primary slot is untouched");
    const trailCreator = await call("POST", `/v1/discovery/trails/${T}/content`, U(1), { labels: [{ sourceType: "post", sourceId: P(1), relationship: "supporting" }] });
    assert.equal(trailCreator.status, 409, "curating a Trail does not make someone else's post yours");
    const author = await call("POST", `/v1/discovery/trails/${T}/content`, U(2), { labels: [{ sourceType: "post", sourceId: P(1), relationship: "primary" }] });
    assert.equal(author.status, 201);
    const place = await call("POST", `/v1/discovery/trails/${T}/content`, U(1), { labels: [{ sourceType: "place", sourceId: CP(1), relationship: "supporting" }] });
    assert.equal(place.status, 201, "an authorless canonical place: the Trail's creator curates it");
    const placeStranger = await call("POST", `/v1/discovery/trails/${T}/content`, U(3), { labels: [{ sourceType: "place", sourceId: CP(1), relationship: "signal", signal: "food" }] });
    assert.equal(placeStranger.status, 409);
  });
  it("suggest: a stranger's suggestion is PENDING for the author (202), spends no budget, is served by nothing; the author accepts or declines", async () => {
    const db = seed();
    _setTestClient(db as any, true);
    const s = await call("POST", `/v1/discovery/trails/${T}/suggestions`, U(3), { labels: [{ sourceType: "post", sourceId: P(1), relationship: "primary" }] });
    assert.equal(s.status, 202);
    assert.equal(s.body.suggested, 1);
    assert.equal(db.tables.content_trails.length, 0, "not a membership: §4's budget is not spent");
    assert.equal(db.tables.trail_content_suggestions[0].owner_id, U(2));
    const mods = await call("GET", `/v1/discovery/trails/${T}/modules`, U(4));
    assert.equal(mods.body.modules.flatMap((m: any) => m.items).length, 0, "a pending suggestion is served by nothing");
    assert.equal((await call("GET", "/v1/discovery/trail-suggestions/pending", U(3))).body.suggestions.length, 0, "the suggester sees nothing to decide");
    const pending = await call("GET", "/v1/discovery/trail-suggestions/pending", U(2));
    assert.equal(pending.body.suggestions.length, 1);
    assert.ok(!JSON.stringify(pending.body).includes(U(3)), "who suggested it is not disclosed");
    const id = pending.body.suggestions[0].id;
    assert.equal((await call("POST", `/v1/discovery/trail-suggestions/${id}/accept`, U(3))).status, 404, "not yours: the same answer as unknown");
    const acc = await call("POST", `/v1/discovery/trail-suggestions/${id}/accept`, U(2));
    assert.equal(acc.status, 200);
    assert.equal(acc.body.state, "accepted");
    assert.equal(db.tables.content_trails.length, 1);
    assert.equal(Number(db.tables.content_trails[0]!.confidence), 0.4, "accepted at the suggestion confidence");
    assert.equal((await call("POST", `/v1/discovery/trail-suggestions/${id}/decline`, U(2))).status, 409, "already accepted");
  });
  it("the author's own suggestion is a membership at once, as before", async () => {
    const db = seed();
    _setTestClient(db as any, true);
    const s = await call("POST", `/v1/discovery/trails/${T}/suggestions`, U(2), { labels: [{ sourceType: "post", sourceId: P(1), relationship: "supporting" }] });
    assert.equal(s.status, 201);
    assert.equal(db.tables.content_trails.length, 1);
    assert.equal((db.tables.trail_content_suggestions ?? []).length, 0);
  });
  it("without 3488 a stranger's suggestion FAILS CLOSED (503) rather than spending the owner's budget", async () => {
    const db = makeRulesDb({ profiles: profiles(4), trails: [trailRow(T)], content_trails: [], posts: [postRow(P(1), U(2))] }, { missing: ["trail_content_suggestions"] });
    _setTestClient(db as any, true);
    const s = await call("POST", `/v1/discovery/trails/${T}/suggestions`, U(3), { labels: [{ sourceType: "post", sourceId: P(1), relationship: "primary" }] });
    assert.equal(s.status, 503);
    assert.equal(db.tables.content_trails.length, 0);
  });
});

describe("S8 — DV-74: a trend integrity review in force reaches GET …/trending", () => {
  const seed = (reviews: Row[], opts: { erroring?: string[] } = {}) => makeRulesDb({
    profiles: profiles(3), trails: [trailRow(T)],
    content_trails: [memberRow({ source_type: "place", source_id: PL(1), contributor_id: null })],
    discovery_places: [{ id: PL(1), submitted_by: null }],
    rank_events: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, surface: "discovery", item_id: `db/${PL(1)}`, outcome: "save", served_at: rel(H + i), outcome_at: rel(H) })),
    trend_integrity_reviews: reviews,
  }, opts);
  it("suppressed: a measured false with no items; cleared (newer): trending again; unreadable: null, never a claim", async () => {
    const live = await trailTrending(seed([]), T, Date.now(), { viewerId: U(3) });
    assert.ok((live.momentum ?? 0) > 0 && live.items.length === 1, "the fixture trends");
    const sup = await trailTrending(seed([{ subject_kind: "trail", subject_id: T, verdict: "suppressed", created_at: rel(H) }]), T, Date.now(), { viewerId: U(3) });
    assert.equal(sup.momentum, 0);
    assert.deepEqual(sup.items, []);
    assert.equal(sup.trendSuppressed, true);
    const cleared = await trailTrending(seed([
      { subject_kind: "trail", subject_id: T, verdict: "suppressed", created_at: rel(2 * H) },
      { subject_kind: "trail", subject_id: T, verdict: "cleared", created_at: rel(H) },
    ]), T, Date.now(), { viewerId: U(3) });
    assert.ok((cleared.momentum ?? 0) > 0);
    _setTestClient(seed([], { erroring: ["trend_integrity_reviews"] }) as any, true);
    const unread = await call("GET", `/v1/discovery/trails/${T}/trending`, U(3));
    assert.equal(unread.body.trending, null);
    assert.deepEqual(unread.body.items, []);
  });
});
