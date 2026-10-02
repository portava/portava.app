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
import { getTrailModules, trailTrending, encodeMemberCursor } from "../services/trails/TrailService.js";
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

// ── §86 follow-up (the independent verifier's findings at de2ae1ca0) ──────────
//
// F1–F6: `02` §10's five clauses on GET …/trending's OWN path, and D-W10T-15 —
// every item any list holds back (any clause, the per-module creator cap, the
// page-wide bound) is counted under its place and reachable from a "more" route.
// G1–G3: DV-13's claims the verifier found unpinned. H1–H3: DV-23's service
// wiring (post text, media kind, place) on both modules paths. Each was run RED
// against de2ae1ca0 first (§86.13).

const saves = (itemId: string, n = 8): Row[] => Array.from({ length: n }, (_, i) => ({
  id: `sv-${itemId}-${i}`, surface: "discovery", item_id: itemId, outcome: "save", served_at: rel(H + i), outcome_at: rel(H),
}));
const EXPLORATION = { flag: "discovery_trail_exploration_enabled", enabled: true };

describe("F — §86 follow-up: all five §10 clauses on GET …/trending, and nothing held back is unreachable", () => {
  it("F1 clause 1 (content similarity): two near-identical posts both surging — trending serves one; the other is held and listed", async () => {
    const t = "rooftop bar sunset view over the river tonight";
    const posts = [postRow(P(1), U(2), { content: t }), postRow(P(2), U(3), { content: `${t}!` }), postRow(P(3), U(4), { content: "night market street food stalls" })];
    const db = makeRulesDb({
      profiles: profiles(6), trails: [trailRow(T)], posts,
      content_trails: posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(i + 2), created_at: rel((i + 1) * H) })),
      rank_events: posts.flatMap((p) => saves(p.id)),
    });
    const r = await trailTrending(db, T, Date.now(), { viewerId: U(6) });
    assert.deepEqual(r.items.map((i) => i.sourceId).sort(), [P(1), P(3)].sort());
    assert.deepEqual((r.heldBackUnplaced ?? []).map((i) => i.sourceId), [P(2)]);
  });

  it("F2 clause 1 (place): a venue post and the place member of that venue are ONE cluster on trending; the count is served", async () => {
    const posts = [2, 3, 4].map((n) => postRow(P(n), U(n), { canonical_place_id: CP(1) }));
    const db = makeRulesDb({
      profiles: profiles(8), trails: [trailRow(T)], posts,
      content_trails: [
        memberRow({ source_type: "place", source_id: PL(1), contributor_id: U(1), created_at: rel(H) }),
        ...posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(i + 2), created_at: rel((i + 2) * H) })),
      ],
      places: [{ id: CP(1), name: "Sky Bar", latitude: 13.7215, longitude: 100.5165 }],
      discovery_places: [{ id: PL(1), submitted_by: U(1), name: "Sky Bar", lat: 13.7220, lng: 100.5168 }],
      rank_events: [...saves(`db/${PL(1)}`), ...posts.flatMap((p) => saves(p.id))],
    });
    _setTestClient(db as any, true);
    const r = await call("GET", `/v1/discovery/trails/${T}/trending`, U(8));
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 2, "four items about one venue: two served");
    assert.deepEqual(r.body.moreFromThisPlace, { [PL(1)]: 2 }, "counted under the place MEMBER, and serialised");
  });

  it("F3 clause 3 (media): 22 photos and 2 videos surging equally — the trending list of 20 carries the videos", async () => {
    const photos = Array.from({ length: 22 }, (_, i) => postRow(P(10 + i), U(10 + i), { content: `photo number ${i} words w${i} x${i}` }));
    const videos = [postRow(P(40), U(40), { primary_media_type: "video", content: "video alpha beta gamma" }), postRow(P(41), U(41), { primary_media_type: "video", content: "video delta epsilon zeta" })];
    const all = [...photos, ...videos];
    const db = makeRulesDb({
      profiles: profiles(45), trails: [trailRow(T)], posts: all,
      content_trails: all.map((p, i) => memberRow({ source_id: p.id, contributor_id: p.author_id, created_at: rel((i + 1) * H) })),
      rank_events: all.flatMap((p) => saves(p.id)),
    });
    const r = await trailTrending(db, T, Date.now(), { viewerId: U(1) });
    assert.equal(r.items.length, 20);
    assert.ok(r.items.some((i) => i.sourceId === P(40)) && r.items.some((i) => i.sourceId === P(41)), "the waiting videos take slots");
  });

  it("F4 clause 4 (viewpoints): one author's two surging posts about one place — one on trending, one counted under the place", async () => {
    const posts = [postRow(P(1), U(2), { canonical_place_id: CP(1), content: "first take on the bar" }), postRow(P(2), U(2), { canonical_place_id: CP(1), content: "second visit different words" })];
    const db = makeRulesDb({
      profiles: profiles(4), trails: [trailRow(T)], posts, places: [{ id: CP(1), name: "Bar", latitude: null, longitude: null }],
      content_trails: posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(2), created_at: rel((i + 1) * H) })),
      rank_events: posts.flatMap((p) => saves(p.id)),
    });
    const r = await trailTrending(db, T, Date.now(), { viewerId: U(4) });
    assert.equal(r.items.length, 1);
    assert.deepEqual(r.moreFromThisPlace, { [CP(1)]: 1 });
  });

  it("F5 clause 5: trending's held items are listed by GET …/places/:placeId/more (key `trending`) and GET …/more, count = list", async () => {
    const posts = [2, 3, 4, 5].map((n) => postRow(P(n), U(n), { canonical_place_id: CP(1) }));
    const db = makeRulesDb({
      profiles: profiles(8), trails: [trailRow(T)], posts, places: [{ id: CP(1), name: "Venue", latitude: null, longitude: null }],
      content_trails: posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(i + 2), content_state: "growing", created_at: rel((i + 1) * H) })),
      rank_events: posts.flatMap((p) => saves(p.id)),
    });
    _setTestClient(db as any, true);
    const tr = await call("GET", `/v1/discovery/trails/${T}/trending`, U(8));
    const n = tr.body.moreFromThisPlace[CP(1)];
    assert.equal(n, 2);
    const byPlace = await call("GET", `/v1/discovery/trails/${T}/places/${CP(1)}/more`, U(8));
    const listed = byPlace.body.modules.find((m: any) => m.key === "trending").items;
    assert.equal(listed.length, n);
    for (const it of listed) assert.ok(!tr.body.items.some((s: any) => s.id === it.id));
    const all = await call("GET", `/v1/discovery/trails/${T}/more`, U(8));
    assert.equal(all.status, 200);
    assert.equal(all.body.lists.find((l: any) => l.key === "trending").byPlace[CP(1)].length, n);
  });

  it("F6 modules: an item held by the per-module CREATOR cap, and every item the PAGE BOUND removes, is counted and listed", async () => {
    // One author, eight posts, one venue for three of them; two others with one post each. The page bound
    // empties the author's later modules (the verifier's evergreen case); nothing it removes may vanish.
    const mine = Array.from({ length: 8 }, (_, i) => postRow(P(10 + i), U(2), { canonical_place_id: i < 3 ? CP(1) : null, content: `author post ${i} words a${i} b${i}` }));
    const others = [postRow(P(30), U(3)), postRow(P(31), U(4))];
    const db = makeRulesDb({
      profiles: profiles(6), trails: [trailRow(T)], posts: [...mine, ...others], places: [{ id: CP(1), name: "Venue", latitude: null, longitude: null }],
      content_trails: [
        ...mine.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(2), content_state: i < 4 ? "just_arrived" : "evergreen", created_at: rel((i + 1) * H) })),
        ...others.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(3 + i), created_at: rel((i + 20) * H) })),
      ],
    });
    _setTestClient(db as any, true);
    const mods = await call("GET", `/v1/discovery/trails/${T}/modules`, U(6));
    const more = await call("GET", `/v1/discovery/trails/${T}/more`, U(6));
    const served = new Set<string>(mods.body.modules.flatMap((m: any) => m.items.map((i: any) => i.sourceId)));
    const held = new Set<string>(more.body.lists.flatMap((l: any) => [...Object.values(l.byPlace).flat(), ...l.unplaced].map((i: any) => i.sourceId)));
    for (const p of [...mine, ...others]) assert.ok(served.has(p.id) || held.has(p.id), `${p.id.slice(-2)} is neither served nor listed`);
    const ja = mods.body.modules.find((m: any) => m.key === "just_arrived");
    const heldAtVenue = more.body.lists.find((l: any) => l.key === "just_arrived")?.byPlace[CP(1)] ?? [];
    assert.equal(ja.moreFromThisPlace[CP(1)] ?? 0, heldAtVenue.length, "a creator-capped item with a place is counted, and the count is the list");
    assert.ok(heldAtVenue.length >= 1, "the author's third venue post is held by the creator cap and counted under the venue");
  });
});

describe("G — DV-13's claims, pinned (the verifier found them unpinned)", () => {
  it("G1 the per-module cap of 2 holds where the page-wide bound alone would allow more", async () => {
    const mine = [0, 1, 2].map((i) => postRow(P(10 + i), U(2), { content: `mine ${i} words m${i} n${i}` }));
    const others = Array.from({ length: 12 }, (_, i) => postRow(P(30 + i), U(10 + i), { content: `other ${i} words o${i} q${i}` }));
    const all = [...mine, ...others];
    const db = makeRulesDb({
      profiles: profiles(25), trails: [trailRow(T)], posts: all,
      content_trails: all.map((p, i) => memberRow({ source_id: p.id, contributor_id: p.author_id, content_state: i < 3 || i % 2 ? "just_arrived" : "evergreen", created_at: rel((i + 1) * H) })),
    });
    const r = await getTrailModules(db, T, { viewerId: U(1), pageSize: 8 });
    for (const m of r.modules) {
      const n = m.items.filter((i) => mine.some((p) => p.id === i.sourceId)).length;
      assert.ok(n <= MAX_PER_CONTRIBUTOR_PER_PAGE, `${m.key}: ${n} of one creator's items`);
    }
    const ja = r.modules.find((m) => m.key === "just_arrived")!;
    assert.equal(ja.items.filter((i) => mine.some((p) => p.id === i.sourceId)).length, 2, "exactly the cap: the third is held back");
    assert.equal((ja.heldBackUnplaced ?? []).filter((i) => mine.some((p) => p.id === i.sourceId)).length, 1);
  });

  it("G2 the page-wide bound holds on the flag-ON path too", async () => {
    const mine = Array.from({ length: 8 }, (_, i) => postRow(P(10 + i), U(2), { content: `author flag on ${i} words f${i} g${i}` }));
    const others = [postRow(P(30), U(3)), postRow(P(31), U(4))];
    const states = ["just_arrived", "just_arrived", "evergreen", "evergreen", "growing", "growing", "featured", "featured"];
    const db = makeRulesDb({
      profiles: profiles(6), trails: [trailRow(T)], feature_flags: [EXPLORATION], posts: [...mine, ...others],
      content_trails: [
        ...mine.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(2), content_state: states[i], created_at: rel((i + 1) * H), content_state_changed_at: rel(H) })),
        ...others.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(3 + i), created_at: rel((i + 20) * H) })),
      ],
      trail_member_exposures: [],
    });
    const r = await getTrailModules(db, T, { viewerId: U(6), pageSize: 8 });
    assert.ok(r.modules.some((m) => m.key === "hidden_gems"), "the flag-on path ran");
    const distinct = new Set(r.modules.flatMap((m) => m.items.map((i) => i.sourceId)));
    const n = [...distinct].filter((id) => mine.some((p) => p.id === id)).length;
    assert.ok(n <= Math.max(MAX_PER_CONTRIBUTOR_PER_PAGE, Math.floor(distinct.size * TRAIL_PAGE_CREATOR_SHARE)), `${n} of ${distinct.size}`);
  });

  it("G3 creator-less items are never trimmed by the page bound, however many there are", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, sourceType: "place", sourceId: `pl${i}` }));
    const modules = [{ key: "a", items: [...items.slice(0, 3), { id: "c1", sourceType: "post", sourceId: "p1" }] }, { key: "b", items: [...items.slice(3), { id: "c2", sourceType: "post", sourceId: "p2" }] }];
    const removed = creatorPageBoundRemovals(modules, (id) => (id.startsWith("c") ? `creator-${id}` : null));
    assert.equal(removed.size, 0);
  });
});

describe("H — DV-23's service wiring on both modules paths (text, media kind, place)", () => {
  const photosAndVideos = () => {
    const photos = Array.from({ length: 8 }, (_, i) => postRow(P(10 + i), U(10 + i), { content: `distinct photo ${i} words q${i} z${i}` }));
    const vids = [postRow(P(30), U(30), { primary_media_type: "video", content: "video one alpha beta" }), postRow(P(31), U(31), { primary_media_type: "video", content: "video two gamma delta" })];
    return [...photos, ...vids];
  };
  const nearDup = () => {
    const t = "rooftop bar sunset view over the river";
    return [postRow(P(40), U(20), { content: t }), postRow(P(41), U(21), { content: `${t}!` }), postRow(P(42), U(22), { content: "street food night market" })];
  };
  const venue = () => [2, 3, 4, 5].map((n) => postRow(P(50 + n), U(n), { canonical_place_id: CP(1), content: `venue take ${n} words v${n} y${n}` }));
  for (const [label, flags] of [["flag OFF", []], ["flag ON", [EXPLORATION]]] as const) {
    it(`H ${label}: the post's media kind, text and place reach §10's pass through getTrailModules`, async () => {
      const run = async (posts: Row[], extra: Row = {}) => {
        const db = makeRulesDb({
          profiles: profiles(35), trails: [trailRow(T)], feature_flags: [...flags], posts, trail_member_exposures: [],
          content_trails: posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: p.author_id, created_at: rel((i + 1) * H) })),
          ...extra,
        });
        return (await getTrailModules(db, T, { viewerId: U(1), pageSize: 8 })).modules.find((m) => m.key === "just_arrived")!;
      };
      const media = await run(photosAndVideos());
      assert.ok(media.items.some((i) => i.sourceId === P(30)) && media.items.some((i) => i.sourceId === P(31)), "H1 media kind wired");
      const text = await run(nearDup());
      assert.deepEqual(text.items.map((i) => i.sourceId).sort(), [P(40), P(42)].sort(), "H2 post text wired");
      const place = await run(venue(), { places: [{ id: CP(1), name: "Venue", latitude: null, longitude: null }] });
      assert.equal(place.items.length, 2, "H3 place wired");
      assert.deepEqual(place.moreFromThisPlace, { [CP(1)]: 2 });
    });
  }
});

// ── §86.14 round 2 (the verifier's re-run at 8dcbb5acc) ────────────────────────
//
// J1–J2: the page-full cutoff — a candidate the page had no room for is held,
// counted under its place and listed (D-W10T-16), on /modules and on trending.
// J3: the "more" routes are the VIEWER's view — a block, a private post, an
// archived Trail. J4: a Trail past the 500-member window stays reachable
// through a bounded cursor (D-W10T-17). Each was run RED at 8dcbb5acc.

const everyListed = (body: any): Set<string> =>
  new Set<string>((body.lists ?? []).flatMap((l: any) => [...(Object.values(l.byPlace) as any[]).flat(), ...l.unplaced]).map((x: any) => x.sourceId));

describe("J — §86.14: past the page, the viewer's view, and past the member window", () => {
  it("J1 /modules: posts about a place that arrive after the page is full are counted under it and listed (the verifier's P5)", async () => {
    const posts = [
      ...[0, 1].map((i) => postRow(P(10 + i), U(10 + i), { canonical_place_id: PL(1) })),
      ...[2, 3, 4, 5, 6, 7].map((i) => postRow(P(10 + i), U(10 + i), { canonical_place_id: PL(10 + i) })),
      ...[8, 9, 10, 11].map((i) => postRow(P(10 + i), U(10 + i), { canonical_place_id: PL(1) })),
    ];
    const db = makeRulesDb({ profiles: profiles(40), trails: [trailRow(T)], posts, content_trails: posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: U(10 + i), created_at: rel((i + 1) * H) })) });
    _setTestClient(db as any, true);
    const mods = await call("GET", `/v1/discovery/trails/${T}/modules`, U(2));
    const ja = mods.body.modules.find((m: any) => m.key === "just_arrived");
    assert.equal(ja.items.length, 8);
    assert.equal(ja.moreFromThisPlace[PL(1)], 4, "the four later posts about PL1 are counted");
    const byPlace = await call("GET", `/v1/discovery/trails/${T}/places/${PL(1)}/more`, U(2));
    assert.equal(byPlace.body.modules.find((m: any) => m.key === "just_arrived").items.length, 4);
    const all = await call("GET", `/v1/discovery/trails/${T}/more`, U(2));
    const served = new Set<string>(mods.body.modules.flatMap((m: any) => m.items.map((i: any) => i.sourceId)));
    const listed = everyListed(all.body);
    assert.deepEqual(posts.filter((p) => !served.has(p.id) && !listed.has(p.id)).map((p) => p.id), [], "nothing is unreachable");
  });

  it("J2 trending: of 24 equally surging posts the list of 20 serves 20; the four past it are counted and listed", async () => {
    const posts = Array.from({ length: 24 }, (_, i) => postRow(P(10 + i), U(10 + i), { canonical_place_id: i >= 22 ? CP(1) : null, content: `trend post ${i} words t${i} u${i}` }));
    const db = makeRulesDb({
      profiles: profiles(40), trails: [trailRow(T)], posts, places: [{ id: CP(1), name: "Venue", latitude: null, longitude: null }],
      content_trails: posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: p.author_id, content_state: "growing", created_at: rel((i + 1) * H) })),
      rank_events: posts.flatMap((p) => saves(p.id)),
    });
    _setTestClient(db as any, true);
    const tr = await call("GET", `/v1/discovery/trails/${T}/trending`, U(1));
    assert.equal(tr.body.items.length, 20);
    assert.deepEqual(tr.body.moreFromThisPlace, { [CP(1)]: 2 }, "the two venue posts past the list are counted and served as a count");
    const all = await call("GET", `/v1/discovery/trails/${T}/more`, U(1));
    const t = all.body.lists.find((l: any) => l.key === "trending");
    assert.equal(t.byPlace[CP(1)].length, 2);
    assert.equal(t.unplaced.length, 2);
  });

  it("J3 both \"more\" routes are the viewer's view: a blocked author and a private post are never listed; an archived Trail is 404", async () => {
    const VIEWER = U(2), BLOCKED = U(20), PRIV = U(21);
    const posts = [
      postRow(P(50), U(30), { canonical_place_id: CP(1) }), postRow(P(51), U(31), { canonical_place_id: CP(1) }),
      postRow(P(52), BLOCKED, { canonical_place_id: CP(1) }), postRow(P(53), PRIV, { canonical_place_id: CP(1), visibility: "private" }),
      postRow(P(54), U(32), { canonical_place_id: CP(1) }),
    ];
    const mk = () => makeRulesDb({
      profiles: profiles(40), trails: [trailRow(T)], posts, places: [{ id: CP(1), name: "Venue", latitude: null, longitude: null }],
      content_trails: posts.map((p, i) => memberRow({ source_id: p.id, contributor_id: p.author_id, created_at: rel((i + 1) * H) })),
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }], rank_events: posts.flatMap((p) => saves(p.id)),
    });
    _setTestClient(mk() as any, true);
    const other = await call("GET", `/v1/discovery/trails/${T}/more`, U(3));
    assert.ok(everyListed(other.body).has(P(52)), "control: to someone else, the blocked author's post is held and listed");
    for (const l of ["just_arrived", "trending"]) assert.ok(other.body.lists.find((x: any) => x.key === l)?.byPlace[CP(1)]?.some((i: any) => i.sourceId === P(52)), `control: ${l} holds it`);
    const mine = await call("GET", `/v1/discovery/trails/${T}/more`, VIEWER);
    const minePlace = await call("GET", `/v1/discovery/trails/${T}/places/${CP(1)}/more`, VIEWER);
    const placeListed = new Set<string>(minePlace.body.modules.flatMap((m: any) => m.items.map((i: any) => i.sourceId)));
    for (const [label, set] of [["/more", everyListed(mine.body)], ["/places/:placeId/more", placeListed], ["/more (other)", everyListed(other.body)]] as const) {
      assert.ok(!set.has(P(53)), `${label}: a private post is never listed`);
      if (label !== "/more (other)") assert.ok(!set.has(P(52)), `${label}: the author the viewer blocked is never listed`);
    }
    assert.ok(everyListed(mine.body).has(P(54)), "the viewer still sees the rest");
    _setTestClient(makeRulesDb({ profiles: profiles(40), trails: [trailRow(T, { lifecycle_status: "archived" })], content_trails: [], posts: [] }) as any, true);
    assert.equal((await call("GET", `/v1/discovery/trails/${T}/more`, VIEWER)).status, 404);
    assert.equal((await call("GET", `/v1/discovery/trails/${T}/places/${CP(1)}/more`, VIEWER)).status, 404);
  });

  it("J4 past the 500-member window: /more returns a cursor, and the cursor page lists the older members — the viewer's view, a tie at the edge included", async () => {
    const VIEWER = U(2), BLOCKED = U(20);
    const hex = (n: number) => n.toString(16).padStart(12, "0");
    const pl = (n: number) => `77777777-7777-4777-8777-${hex(n)}`;
    // 505 members, newest first. Rows 499 and 500 share one created_at (the window's edge is a tie);
    // row 499 carries the larger id, so the continuation must take row 500 from the tie.
    const rows = Array.from({ length: 505 }, (_, i) => memberRow({
      id: i === 499 ? "66666666-6666-4666-8666-ffffffffffff" : i === 500 ? "66666666-6666-4666-8666-000000000001" : `66666666-6666-4666-8666-${hex(100000 + i)}`,
      source_type: "place", source_id: pl(i), contributor_id: null,
      created_at: new Date(Date.parse("2026-09-01T00:00:00Z") - (i >= 500 ? i - 1 : i) * 60_000).toISOString(),
    }));
    const blockedPost = postRow(P(90), BLOCKED, { canonical_place_id: CP(1) });
    rows[503] = memberRow({ id: `66666666-6666-4666-8666-${hex(100503)}`, source_type: "post", source_id: blockedPost.id, contributor_id: BLOCKED, created_at: rows[503]!.created_at });
    // §86.15: the tied pair is SEEDED smaller-id first, so only readMembers' `.order("id")` puts row 499 (larger id)
    // inside the window; without that tiebreak the window would end on row 500 and row 499 would be skipped.
    const seeded = [...rows.slice(0, 499), rows[500]!, rows[499]!, ...rows.slice(501)];
    const db = makeRulesDb({ profiles: profiles(40), trails: [trailRow(T)], content_trails: seeded, posts: [blockedPost], places: [{ id: CP(1), name: "V", latitude: null, longitude: null }], blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }] });
    _setTestClient(db as any, true);
    const first = await call("GET", `/v1/discovery/trails/${T}/more`, U(3));
    assert.equal(typeof first.body.next, "string", "the window is full: a cursor to the older members");
    const page = await call("GET", `/v1/discovery/trails/${T}/more?cursor=${encodeURIComponent(first.body.next)}`, U(3));
    assert.equal(page.status, 200);
    assert.equal(page.body.next, null, "five older members fit one page");
    const older = everyListed(page.body);
    assert.deepEqual([500, 501, 502, 504].map((i) => older.has(pl(i))), [true, true, true, true], "every member past the window, the edge tie included");
    assert.ok(older.has(P(90)), "control: someone else is listed the blocked author's post");
    const mods = await call("GET", `/v1/discovery/trails/${T}/modules`, U(3));
    const served = new Set<string>(mods.body.modules.flatMap((m: any) => m.items.map((i: any) => i.sourceId)));
    const firstListed = everyListed(first.body);
    const missing = rows.map((r) => r.source_id as string).filter((s) => !served.has(s) && !firstListed.has(s) && !older.has(s));
    assert.deepEqual(missing, [], "all 505 members are served or reachable");
    const mine = await call("GET", `/v1/discovery/trails/${T}/more?cursor=${encodeURIComponent(first.body.next)}`, VIEWER);
    assert.ok(!everyListed(mine.body).has(P(90)), "the cursor page is the viewer's view too");
    const placePage = await call("GET", `/v1/discovery/trails/${T}/places/${CP(1)}/more?cursor=${encodeURIComponent(first.body.next)}`, U(3));
    assert.deepEqual(placePage.body.modules.map((m: any) => [m.key, m.items.map((i: any) => i.sourceId)]), [["beyond_window", [P(90)]]]);
    assert.equal((await call("GET", `/v1/discovery/trails/${T}/more?cursor=not-a-cursor`, U(3))).status, 400);
  });
});

// ── §86.15 round 3 ─────────────────────────────────────────────────────────────

describe("K — §86.15: a cursor is strict, bounded in time, and never opens an archived or unknown Trail", () => {
  const raw = (c: string, i = "66666666-6666-4666-8666-000000000001") => Buffer.from(JSON.stringify({ c, i }), "utf8").toString("base64url");
  const seed = (state = "active") => makeRulesDb({
    profiles: profiles(4), trails: [trailRow(T, { lifecycle_status: state })],
    content_trails: [memberRow({ source_type: "place", source_id: PL(1), contributor_id: null, created_at: rel(D) })],
  });
  it("K1 a lenient timestamp (\"1\", \"2026\", \"2026-09-28 junk\") and a future one are 400 on both routes, never a database error", async () => {
    _setTestClient(seed() as any, true);
    for (const c of ["1", "2026", "2026-09-28 junk", new Date(Date.now() + 86_400_000).toISOString()]) {
      for (const path of [`/v1/discovery/trails/${T}/more`, `/v1/discovery/trails/${T}/places/${PL(1)}/more`]) {
        const r = await call("GET", `${path}?cursor=${encodeURIComponent(raw(c))}`, U(2));
        assert.equal(r.status, 400, `${c} on ${path}: ${JSON.stringify(r.body)}`);
      }
    }
    const ok = await call("GET", `/v1/discovery/trails/${T}/more?cursor=${encodeURIComponent(encodeMemberCursor({ created_at: rel(0), id: "66666666-6666-4666-8666-ffffffffffff" }))}`, U(2));
    assert.equal(ok.status, 200, "control: a cursor the server minted is accepted");
  });
  it("K2 a valid cursor on an archived Trail, or an unknown one, is 404 — never its members", async () => {
    const cursor = encodeURIComponent(encodeMemberCursor({ created_at: rel(0), id: "66666666-6666-4666-8666-ffffffffffff" }));
    _setTestClient(seed("archived") as any, true);
    for (const path of [`/v1/discovery/trails/${T}/more`, `/v1/discovery/trails/${T}/places/${PL(1)}/more`]) {
      assert.equal((await call("GET", `${path}?cursor=${cursor}`, U(2))).status, 404, `archived: ${path}`);
    }
    _setTestClient(seed() as any, true);
    assert.equal((await call("GET", `/v1/discovery/trails/${T2}/more?cursor=${cursor}`, U(2))).status, 404, "unknown Trail");
  });
});
