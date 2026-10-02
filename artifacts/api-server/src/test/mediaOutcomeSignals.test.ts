/**
 * mediaOutcomeSignals — census-media §21: the §44 outcome signals and §45
 * north-star transitions that had a NAME and no PRODUCER.
 *
 *   MD374 / MD376 — Visual opportunity opened / Hidden Gem opened: client
 *                   signals the batch endpoint now forwards.
 *   MD381 — Invite sent: written by the invite route, only for an invite sent
 *           from a media item that is an approved contribution to that Moment.
 *   MD382 — Experience completed: a route saved FROM MEDIA was completed.
 *   MD383 — Contribution submitted / accepted: gem submission & observation;
 *           admin approval, attributed to the submitter.
 *   MD385 — Postcard created: at the Postcard write.
 *   MD214 / MD399 — Real-world arrival where safely measurable: a traveller's
 *           own check-in (route stop arrived, verified gem visit), attributed
 *           only when their own media-originated action explains it.
 *   MD400 — Media → Contribution: only when the contributor acted from a
 *           media item AT the gem's place.
 *
 * Server-only signals are proven NOT forgeable through the client batch.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/mediaOutcomeSignals.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findMediaOrigin,
  recordMediaArrivalIfAttributable,
  recordExperienceCompletionIfAttributable,
  recordGemContributionSignal,
  recordGemAcceptedSignal,
  recordMediaInviteIfAttributable,
  recordPostcardCreatedSignal,
  MEDIA_SERVER_OUTCOME_SIGNAL_TYPES,
} from "../lib/mediaAnalytics.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const PLACE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MEDIA = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const GEM = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const ROUTE = "99999999-9999-9999-9999-999999999999";
const STOP = "88888888-8888-8888-8888-888888888888";
const MOMENT = "77777777-7777-7777-7777-777777777777";

type Dataset = Record<string, any[]>;

function read(r: any, col: string): unknown {
  if (col.includes("->>")) {
    const [base, key] = col.split("->>");
    return r?.[base]?.[key];
  }
  return r?.[col];
}

/** A filtering fake that RECORDS writes and returns them for `.select().single()` chains. */
function makeSc(data: Dataset) {
  const inserted: Array<{ table: string; row: any }> = [];
  const builder = (table: string): any => {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "upsert" | "update" = "select";
    let payload: any = null;
    let limitN: number | null = null;
    const rows = () => {
      if (op === "insert" || op === "upsert") {
        const list = Array.isArray(payload) ? payload : [payload];
        return list.map((r: any, i: number) => ({ id: r.id ?? `${table}-${inserted.length}-${i}`, ...r }));
      }
      let out = (data[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (op === "update") out = out.map((r) => Object.assign(r, payload));
      return limitN === null ? out : out.slice(0, limitN);
    };
    const settle = () => {
      if (op === "insert" || op === "upsert") {
        for (const r of rows()) { inserted.push({ table, row: r }); (data[table] ??= []).push(r); }
      }
    };
    const b: any = {
      select() { return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      upsert(p: any) { op = "upsert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      eq(col: string, val: any) { filters.push((r) => String(read(r, col)) === String(val)); return b; },
      neq(col: string, val: any) { filters.push((r) => String(read(r, col)) !== String(val)); return b; },
      in(col: string, val: any[]) { const v = val.map(String); filters.push((r) => v.includes(String(read(r, col)))); return b; },
      gte(col: string, val: any) { filters.push((r) => String(read(r, col) ?? "") >= String(val)); return b; },
      gt() { return b; }, lte() { return b; }, lt() { return b; },
      is(col: string, val: any) { filters.push((r) => (read(r, col) ?? null) === val); return b; },
      like(col: string, val: any) { const pre = String(val).replace(/%$/, ""); filters.push((r) => String(read(r, col) ?? "").startsWith(pre)); return b; },
      not() { return b; }, or() { return b; }, order() { return b; }, range() { return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { const r = rows(); settle(); return Promise.resolve({ data: r[0] ?? null, error: null }); },
      single() { const r = rows(); settle(); return Promise.resolve({ data: r[0] ?? null, error: null }); },
      then(onF: any, onR: any) { const r = rows(); settle(); return Promise.resolve({ data: r, error: null, count: r.length }).then(onF, onR); },
    };
    return b;
  };
  const sc: any = {
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ data: null, error: { message: "no rpc" } }),
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
  };
  sc.inserted = inserted;
  return sc;
}

const ANALYTICS_ON = { flag: "MEDIA_ANALYTICS_ENABLED", enabled: true };
const tick = () => new Promise((r) => setTimeout(r, 30));
const mediaEvents = (sc: any) => sc.inserted.filter((w: any) => w.table === "media_events").map((w: any) => w.row);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function originEvent(o: Record<string, unknown> = {}) {
  return { event_type: "media_trip_add", payload: { viewer_id: VIEWER, media_id: MEDIA, place_id: PLACE, ...o }, occurred_at: ago(60_000) };
}

// ── attribution ──────────────────────────────────────────────────────────────

describe("findMediaOrigin — only the viewer's OWN media-originated action, inside the window", () => {
  it("finds a place origin and a route-plan origin", async () => {
    const sc = makeSc({ media_events: [originEvent(), { event_type: "media_route", payload: { viewer_id: VIEWER, media_id: MEDIA, route_plan_id: ROUTE }, occurred_at: ago(60_000) }] });
    assert.deepEqual(await findMediaOrigin(sc, { userId: VIEWER, placeId: PLACE }), { mediaId: MEDIA, placeId: PLACE });
    assert.equal((await findMediaOrigin(sc, { userId: VIEWER, routePlanId: ROUTE }))?.mediaId, MEDIA);
  });

  it("another viewer's action, an old action, and a non-origin event (a like) attribute nothing", async () => {
    const sc = makeSc({
      media_events: [
        originEvent({ viewer_id: OTHER }),
        { ...originEvent(), occurred_at: ago(60 * 86_400_000) },
        { event_type: "like", payload: { viewer_id: VIEWER, media_id: MEDIA, place_id: PLACE }, occurred_at: ago(60_000) },
      ],
    });
    assert.equal(await findMediaOrigin(sc, { userId: VIEWER, placeId: PLACE }), null);
  });
});

describe("MD214 / MD399 — a media ARRIVAL is a check-in the traveller made, explained by their own media action", () => {
  it("records media_arrival when attributable, and nothing when not", async () => {
    const yes = makeSc({ feature_flags: [ANALYTICS_ON], media_events: [originEvent()] });
    recordMediaArrivalIfAttributable(yes, { userId: VIEWER, placeId: PLACE, source: "gem_visit" });
    await tick();
    const arrivals = mediaEvents(yes).filter((e: any) => e.event_type === "media_arrival");
    assert.equal(arrivals.length, 1);
    assert.equal(arrivals[0].payload.media_id, MEDIA);
    assert.equal(arrivals[0].payload.lat, undefined, "no coordinate ever rides an arrival");

    const no = makeSc({ feature_flags: [ANALYTICS_ON], media_events: [] });
    recordMediaArrivalIfAttributable(no, { userId: VIEWER, placeId: PLACE, source: "gem_visit" });
    await tick();
    assert.equal(mediaEvents(no).length, 0, "no media origin → no media arrival");
  });
});

describe("MD382 — experience completed", () => {
  it("records experience_complete for a route saved from media, not for any other route", async () => {
    const sc = makeSc({ feature_flags: [ANALYTICS_ON], media_events: [{ event_type: "media_route", payload: { viewer_id: VIEWER, media_id: MEDIA, route_plan_id: ROUTE }, occurred_at: ago(60_000) }] });
    recordExperienceCompletionIfAttributable(sc, { userId: VIEWER, routePlanId: ROUTE });
    recordExperienceCompletionIfAttributable(sc, { userId: VIEWER, routePlanId: "00000000-0000-0000-0000-000000000000" });
    await tick();
    const done = mediaEvents(sc).filter((e: any) => e.event_type === "experience_complete");
    assert.equal(done.length, 1);
    assert.equal(done[0].payload.route_plan_id, ROUTE);
  });
});

describe("MD383 / MD400 — contribution submitted / accepted, and Media → Contribution", () => {
  it("every gem contribution records contribution_submit; media_contribution only for media AT the gem's place", async () => {
    const sc = makeSc({
      feature_flags: [ANALYTICS_ON],
      hidden_gems: [{ id: GEM, canonical_place_id: PLACE }],
      posts: [{ id: MEDIA, canonical_place_id: PLACE, status: "active" }, { id: "elsewhere", canonical_place_id: "other-place", status: "active" }],
    });
    recordGemContributionSignal(sc, { userId: VIEWER, gemId: GEM, kind: "still_worth_it" });
    recordGemContributionSignal(sc, { userId: VIEWER, gemId: GEM, kind: "closed", originMediaId: MEDIA });
    recordGemContributionSignal(sc, { userId: VIEWER, gemId: GEM, kind: "too_crowded", originMediaId: "elsewhere" });
    await tick();
    const ev = mediaEvents(sc);
    assert.equal(ev.filter((e: any) => e.event_type === "contribution_submit").length, 3);
    const ns = ev.filter((e: any) => e.event_type === "media_contribution");
    assert.equal(ns.length, 1, "only the media that is actually at the gem counts as Media → Contribution");
    assert.equal(ns[0].payload.media_id, MEDIA);
  });

  it("an accepted gem is credited to its SUBMITTER, not the approving admin", async () => {
    const sc = makeSc({ feature_flags: [ANALYTICS_ON] });
    recordGemAcceptedSignal(sc, { submitterId: OTHER, gemId: GEM });
    await tick();
    const acc = mediaEvents(sc).find((e: any) => e.event_type === "contribution_accept");
    assert.equal(acc?.payload.viewer_id, OTHER);
  });
});

describe("MD381 — invite sent, from a media item in that Moment", () => {
  it("records invite_sent only when the media is an APPROVED contribution to the Moment", async () => {
    const sc = makeSc({
      feature_flags: [ANALYTICS_ON],
      shared_moment_contributions: [
        { moment_id: MOMENT, post_id: MEDIA, status: "approved" },
        { moment_id: MOMENT, post_id: "pending-post", status: "pending" },
      ],
    });
    recordMediaInviteIfAttributable(sc, { inviterId: VIEWER, momentId: MOMENT, originMediaId: MEDIA });
    recordMediaInviteIfAttributable(sc, { inviterId: VIEWER, momentId: MOMENT, originMediaId: "pending-post" });
    recordMediaInviteIfAttributable(sc, { inviterId: VIEWER, momentId: MOMENT, originMediaId: null });
    await tick();
    const inv = mediaEvents(sc).filter((e: any) => e.event_type === "invite_sent");
    assert.equal(inv.length, 1);
    assert.equal(inv[0].payload.media_id, MEDIA);
  });
});

describe("MD385 — Postcard created", () => {
  it("records postcard_create keyed by the postcard's own post id", async () => {
    const sc = makeSc({ feature_flags: [ANALYTICS_ON] });
    recordPostcardCreatedSignal(sc, { userId: VIEWER, postId: MEDIA });
    await tick();
    assert.equal(mediaEvents(sc).find((e: any) => e.event_type === "postcard_create")?.payload.media_id, MEDIA);
  });

  it("the Postcard writer calls it where the passport_postcards row is written", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../routes/postcards.ts"), "utf8");
    const at = src.indexOf("recordPostcardCreatedSignal(sc, { userId: user.id, postId });");
    assert.ok(at > 0, "postcards.ts records the signal");
    const ins = src.lastIndexOf(".from('passport_postcards')\n        .insert(", at);
    assert.ok(ins > 0 && at - ins < 2500, "…inside the branch that just inserted the Postcard row");
  });
});

// ── the client batch cannot forge a server-only outcome ──────────────────────

async function serve(router: any, sc: any): Promise<{ url: string; server: Server }> {
  const express = (await import("express")).default;
  _setTestClient(sc, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { info() {}, error() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", router);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, server };
}

let open: Server | null = null;
afterEach(() => { open?.close(); open = null; _clearTestClient(); _setTestServiceClient(null as any); });

describe("MD374 / MD376 — the batch forwards the two CLIENT outcome signals and refuses the server-only ones", () => {
  it("accepts visual_opportunity_open and gem_open; drops every server-only outcome name", async () => {
    const sc = makeSc({ feature_flags: [ANALYTICS_ON], profiles: [{ id: VIEWER, account_status: "active" }] });
    const { default: router } = await import("../routes/mediaAnalyticsBatch.js");
    const s = await serve(router, sc);
    open = s.server;
    const events = [
      { type: "visual_opportunity_open", payload: { place_id: PLACE, surface: "world_now" } },
      { type: "gem_open", payload: { gem_id: GEM, surface: "gems_lens" } },
      ...MEDIA_SERVER_OUTCOME_SIGNAL_TYPES.map((type) => ({ type, payload: {} })),
    ];
    const res = await fetch(`${s.url}/api/media/analytics/batch`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: JSON.stringify({ events }) });
    const body: any = await res.json();
    assert.equal(body.accepted, 2, "exactly the two client signals");
    await tick();
    const types = mediaEvents(sc).map((e: any) => e.event_type).sort();
    assert.deepEqual(types, ["gem_open", "visual_opportunity_open"]);
    assert.equal(mediaEvents(sc).find((e: any) => e.event_type === "gem_open").payload.gem_id, GEM);
  });
});

// ── route wiring: the producers actually run where the outcome is committed ──

describe("wiring — the route plan routes and the invite route produce their signals", () => {
  it("MD382: completing a media-saved route records experience_complete", async () => {
    const sc = makeSc({
      feature_flags: [ANALYTICS_ON],
      profiles: [{ id: VIEWER, account_status: "active" }],
      route_plans: [{ id: ROUTE, owner_user_id: VIEWER, status: "active", accepted_at: ago(3_600_000), accepted_by_user_id: VIEWER }],
      media_events: [{ event_type: "media_route", payload: { viewer_id: VIEWER, media_id: MEDIA, route_plan_id: ROUTE }, occurred_at: ago(60_000) }],
    });
    _setTestServiceClient(sc);
    const { default: router } = await import("../routes/routePlan.js");
    const s = await serve(router, sc);
    open = s.server;
    const res = await fetch(`${s.url}/api/route-plans/${ROUTE}/complete`, { method: "POST", headers: { Authorization: "Bearer t" } });
    assert.equal(res.status, 200);
    await tick();
    assert.ok(mediaEvents(sc).some((e: any) => e.event_type === "experience_complete" && e.payload.route_plan_id === ROUTE));
  });

  it("MD214: marking a stop of a media-saved route ARRIVED records media_arrival; marking it skipped does not", async () => {
    const data = () => ({
      feature_flags: [ANALYTICS_ON],
      profiles: [{ id: VIEWER, account_status: "active" }],
      route_plans: [{ id: ROUTE, owner_user_id: VIEWER, trip_id: null }],
      route_stops: [{ id: STOP, route_plan_id: ROUTE, checkpoint_status: "pending" }],
      media_events: [{ event_type: "media_route", payload: { viewer_id: VIEWER, media_id: MEDIA, route_plan_id: ROUTE }, occurred_at: ago(60_000) }],
    });
    const { default: router } = await import("../routes/routePlan.js");
    for (const [status, expected] of [["arrived", 1], ["skipped", 0]] as const) {
      const sc = makeSc(data());
      _setTestServiceClient(sc);
      const s = await serve(router, sc);
      try {
        const res = await fetch(`${s.url}/api/route-plans/${ROUTE}/stops/${STOP}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: JSON.stringify({ checkpointStatus: status }) });
        assert.equal(res.status, 200, `PATCH ${status}`);
        await tick();
        assert.equal(mediaEvents(sc).filter((e: any) => e.event_type === "media_arrival").length, expected, status);
      } finally {
        s.server.close();
      }
    }
  });

  it("MD383 / MD400: POST /hidden-gems/:id/contribute records contribution_submit, and media_contribution for media at the gem", async () => {
    const sc = makeSc({
      feature_flags: [ANALYTICS_ON, { flag: "hidden_gems_enabled", enabled: true }],
      profiles: [{ id: VIEWER, account_status: "active" }],
      hidden_gems: [{ id: GEM, status: "active", submitted_by: OTHER, canonical_place_id: PLACE }],
      hidden_gem_contributions: [],
      posts: [{ id: MEDIA, canonical_place_id: PLACE, status: "active" }],
    });
    const { default: router } = await import("../routes/hiddenGems.js");
    const s = await serve(router, sc);
    open = s.server;
    const res = await fetch(`${s.url}/api/hidden-gems/${GEM}/contribute`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: JSON.stringify({ contributionType: "still_worth_it", originMediaId: MEDIA }) });
    assert.equal(res.status, 200, await res.text());
    await tick();
    const ev = mediaEvents(sc);
    assert.ok(ev.some((e: any) => e.event_type === "contribution_submit" && e.payload.gem_id === GEM && e.payload.contribution_type === "still_worth_it"));
    assert.ok(ev.some((e: any) => e.event_type === "media_contribution" && e.payload.media_id === MEDIA));
  });

  it("the other committed-outcome producers sit on the success path of their routes", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const gems = readFileSync(resolve(here, "../routes/hiddenGems.ts"), "utf8");
    // A submission: after the 201.
    assert.match(gems, /res\.status\(201\)\.json\(\{ ok: true, gem: safe \}\); recordGemContributionSignal\(sc, \{ userId: user\.id, gemId: String\(\(gem as any\)\.id\), kind: "gem_submission" \}\);/);
    // An arrival: only a verified, NON-suspicious visit.
    assert.match(gems, /if \(result\.ok && !result\.isSuspicious\) recordGemArrivalIfAttributable\(sc, \{ userId: user\.id, gemId: req\.params\.id \}\);/);
    // An acceptance: only an APPROVED verification, credited to the submitter.
    assert.match(gems, /if \(parsed\.data\.result === "approved" && gemRow && \(gemRow as any\)\.submitted_by\) \{\n    recordGemAcceptedSignal\(sc, \{ submitterId: String\(\(gemRow as any\)\.submitted_by\), gemId: req\.params\.id \}\);/);
    const route = readFileSync(resolve(here, "../routes/routePlan.ts"), "utf8");
    // Media → Route: a route saved from media carries its plan id.
    assert.match(route, /recordMediaEvent\("media_route", \{ media_id: originMediaId, viewer_id: user\.id, route_plan_id: planId/);
  });

  it("MD381: the invite route records invite_sent for an invite sent from the Moment's own media", async () => {
    const sc = makeSc({
      feature_flags: [ANALYTICS_ON, ...["shared_moments_enabled", "external_places_enabled", "live_places_enabled", "place_days_enabled"].map((flag) => ({ flag, enabled: true }))],
      profiles: [{ id: VIEWER, account_status: "active" }],
      shared_moments: [{ id: MOMENT, owner_id: VIEWER, status: "active" }],
      shared_moment_memberships: [{ moment_id: MOMENT, user_id: VIEWER, role: "owner", status: "accepted" }],
      shared_moment_contributions: [{ moment_id: MOMENT, post_id: MEDIA, status: "approved" }],
      blocks: [],
    });
    const { default: router } = await import("../routes/sharedMoments.js");
    const s = await serve(router, sc);
    open = s.server;
    const res = await fetch(`${s.url}/api/shared-moments/${MOMENT}/invites`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: JSON.stringify({ userId: OTHER, originMediaId: MEDIA }) });
    if (res.status === 404) {
      // The Shared Moments capability chain is its own lane's; if it is not
      // satisfiable by this fake the route never reaches the write. Say so.
      assert.fail(`shared moments route refused before the invite (${res.status}): ${await res.text()}`);
    }
    assert.equal(res.status, 201);
    await tick();
    assert.ok(mediaEvents(sc).some((e: any) => e.event_type === "invite_sent" && e.payload.media_id === MEDIA));
  });
});
