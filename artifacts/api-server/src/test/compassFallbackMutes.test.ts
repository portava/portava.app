/**
 * census-compass §35 — a user the viewer MUTED is never served by the Compass
 * fallback feed, and a failed `user_mutes` read never serves them unfiltered.
 *
 * getCompassProfile throws (fail closed) when `user_mutes` cannot be read. GET
 * /compass/feed and GET /compass/feed/section/:section catch that throw and
 * serve buildFallbackFeed, which read `blocks` and never `user_mutes`, with
 * `mutedUserIds: []` in its safety profile — so the safety filter's mute rule
 * could never fire there, over a failed read OR a healthy one (the
 * COMPASS_FALLBACK_MODE_ENABLED path). The /compass/ask tool
 * `get_circle_activity` had the same shape: handed no profile (the ask route's
 * profile read failed), it named circle members from an EMPTY hidden set.
 *
 * FAIL cases were seen RED on main cd9a11d92 before the fix. CONTROL cases pin
 * the healthy answers; `H*` cases pin healthy bodies byte-for-byte (sha256),
 * captured on main before the fix.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "ab000000-0000-4000-a000-000000000035";
const TOKEN = "tok-compass-s35";
const MUTED = "a0000000-0000-4000-a000-0000000000a1";
const BLOCKED = "b0000000-0000-4000-a000-0000000000b1";
const POST = "d0000000-0000-4000-a000-0000000000d1";
const CIRCLE = "c0000000-0000-4000-a000-0000000000c1";
const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };

type Call = [string, unknown[]];
interface Opts {
  mutes?: "muted" | "none" | "fail";
  blocksFail?: boolean;
  fallbackMode?: boolean;
  blocked?: boolean;
}
function world(o: Opts = {}) {
  const mutes = o.mutes ?? "muted";
  function builder(table: string) {
    const calls: Call[] = [];
    const eqArg = (col: string) => calls.find(([k, a]) => k === "eq" && a[0] === col)?.[1][1];
    const has = (m: string) => calls.some(([k]) => k === m);
    const answer = (single: boolean): { data: unknown; error: unknown } => {
      if (table === "profiles" && calls.find(([k]) => k === "select")?.[1][0] === "account_status") return { data: { account_status: "active" }, error: null };
      if (table === "feature_flags") {
        if (has("like")) return { data: [{ flag: "COMPASS_ENABLED", enabled: true }, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }], error: null };
        const f = eqArg("flag");
        if (f === "COMPASS_FEED_ENABLED") return { data: { enabled: true }, error: null };
        if (f === "COMPASS_FALLBACK_MODE_ENABLED") return { data: { enabled: o.fallbackMode === true }, error: null };
        return { data: null, error: null };
      }
      if (table === "user_mutes") return mutes === "fail" ? { data: null, error: DB_ERR } : { data: mutes === "muted" ? [{ muted_id: MUTED }] : [], error: null };
      if (table === "blocks") {
        if (o.blocksFail) return { data: null, error: DB_ERR };
        if (o.blocked && eqArg("blocker_id") === VIEWER) return { data: [{ blocked_id: BLOCKED }], error: null };
        return { data: [], error: null };
      }
      if (table === "user_location_state") return { data: { city: "Paris", country: "FR" }, error: null };
      if (table === "posts") {
        return { data: [
          { id: POST, author_id: MUTED, content: "MUTED-AUTHOR-POST", like_count: 99, comment_count: 1, post_status: "published", publish_eligible_at: null, visibility: "public", status: "active", created_at: "2026-09-29T00:00:00.000Z", city: "Paris" },
        ], error: null };
      }
      if (table === "circles") return { data: eqArg("owner_id") === VIEWER ? [{ id: CIRCLE, name: "Lisbon crew", owner_id: VIEWER }] : [], error: null };
      if (table === "circle_memberships") {
        if (eqArg("other_id") === VIEWER) return { data: [], error: null };
        return { data: [{ user_id: VIEWER, other_id: MUTED, status: "accepted" }, { user_id: VIEWER, other_id: BLOCKED, status: "accepted" }], error: null };
      }
      if (table === "profiles" && has("in")) return { data: [{ id: MUTED, handle: "mutedmember" }, { id: BLOCKED, handle: "blockedmember" }], error: null };
      return { data: single ? null : [], error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer(true));
        return (...args: unknown[]) => { calls.push([prop, args]); return b; };
      },
    });
    return b;
  }
  return {
    auth: { getUser: async (tok: string) => (tok === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}
const pin = (s: string) => createHash("sha256").update(s).digest("hex");

describe("census-compass §35: muted authors never reach the Compass fallback feed", () => {
  let base = ""; let server: Server;
  before(async () => {
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; n(); });
    app.use("/api", compassRouter);
    server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(() => { server.close(); });
  beforeEach(() => { invalidateFlagsCache(); clearCompassProfileCache(); clearL1Cache(); });
  const get = async (o: Opts, path: string) => {
    _setTestClient(world(o) as any, true);
    const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: r.status, body: await r.text() };
  };

  it("MU0 CONTROL: healthy reads, muted → /compass/feed does not serve the muted author's post", async () => {
    const r = await get({}, "/compass/feed");
    assert.equal(r.status, 200); assert.ok(!r.body.includes("MUTED-AUTHOR-POST"), r.body.slice(0, 600));
  });
  it("MU0b CONTROL: healthy reads, NOT muted → the post is served (the world reaches the feed)", async () => {
    const r = await get({ mutes: "none" }, "/compass/feed");
    assert.ok(r.body.includes("MUTED-AUTHOR-POST"), r.body.slice(0, 600));
  });
  it("MU1 /compass/feed, the user_mutes read FAILS → the muted author's post is not served; safety tools only, and the reason says why", async () => {
    const r = await get({ mutes: "fail" }, "/compass/feed");
    assert.ok(!r.body.includes("MUTED-AUTHOR-POST"), `a failed mute read served the muted author: ${r.status} ${r.body.slice(0, 600)}`);
    const j = JSON.parse(r.body);
    assert.equal(j.fallback, true); assert.equal(j.fallbackReason, "build_error+mute_list_unavailable");
    assert.deepEqual(j.sections.map((s: any) => s.name), ["safety_tools"]); assert.deepEqual(j.safeItems, []);
  });
  it("MU2 /compass/feed/section/for_you, the user_mutes read FAILS → safeItems carry no user content", async () => {
    const r = await get({ mutes: "fail" }, "/compass/feed/section/for_you");
    assert.ok(!r.body.includes("MUTED-AUTHOR-POST"), `a failed mute read served the muted author: ${r.status} ${r.body.slice(0, 600)}`);
    assert.deepEqual(JSON.parse(r.body).safeItems, []);
  });
  it("FM0 CONTROL: fallback mode ON, healthy reads, NOT muted → the fallback serves the post (the world reaches the fallback)", async () => {
    const r = await get({ fallbackMode: true, mutes: "none" }, "/compass/feed");
    assert.ok(r.body.includes("MUTED-AUTHOR-POST"), r.body.slice(0, 600));
  });
  it("FM1 fallback mode ON, healthy reads, muted → the fallback does not serve the muted author's post", async () => {
    const r = await get({ fallbackMode: true }, "/compass/feed");
    assert.equal(r.status, 200);
    assert.ok(!r.body.includes("MUTED-AUTHOR-POST"), `the fallback ignored a healthy mute: ${r.body.slice(0, 600)}`);
    assert.equal(JSON.parse(r.body).fallbackReason, "fallback_mode_enabled");
  });
  it("FM1b fallback mode ON, section route, muted → safeItems do not carry the muted author's post", async () => {
    const r = await get({ fallbackMode: true }, "/compass/feed/section/for_you");
    assert.ok(!r.body.includes("MUTED-AUTHOR-POST"), r.body.slice(0, 600));
  });
  it("FM2 fallback mode ON, the user_mutes read FAILS → safety tools only, reason mute_list_unavailable", async () => {
    const r = await get({ fallbackMode: true, mutes: "fail" }, "/compass/feed");
    const j = JSON.parse(r.body);
    assert.ok(!r.body.includes("MUTED-AUTHOR-POST"), r.body.slice(0, 600));
    assert.equal(j.fallbackReason, "fallback_mode_enabled+mute_list_unavailable");
    assert.deepEqual(j.sections.map((s: any) => s.name), ["safety_tools"]);
  });
  it("FB2 CONTROL: fallback mode ON, the blocks read FAILS → reason stays block_list_unavailable (unchanged)", async () => {
    const r = await get({ fallbackMode: true, blocksFail: true, mutes: "none" }, "/compass/feed");
    assert.equal(JSON.parse(r.body).fallbackReason, "fallback_mode_enabled+block_list_unavailable");
  });
  it("H1 healthy fallback-mode body, nobody muted: byte-identical to main", async () => {
    const r = await get({ fallbackMode: true, mutes: "none" }, "/compass/feed");
    assert.equal(r.status, 200); assert.equal(pin(r.body), "a4179936491961bdd58aea94273a7301eed42c045053606de7ebf7af96516d40", r.body);
  });
  it("H2 healthy fallback-mode section body, nobody muted: byte-identical to main", async () => {
    const r = await get({ fallbackMode: true, mutes: "none" }, "/compass/feed/section/for_you");
    assert.equal(r.status, 200); assert.equal(pin(r.body), "27aad171f1ed09b815aac102f5450c00d84dc81139c039b227c79379faa0b9f3", r.body);
  });

  // ── /compass/ask: get_circle_activity (the ask route's null-profile path) ──
  it("AC0 CONTROL: get_circle_activity with a healthy profile naming the mute and the block → neither is named", async () => {
    const sc = world({ blocked: true }) as any;
    const profile = { userId: VIEWER, blockedUserIds: [BLOCKED], blockerUserIds: [], mutedUserIds: [MUTED] } as any;
    const out = JSON.stringify(await executeCompassTool(sc, VIEWER, profile, "get_circle_activity", {}));
    assert.ok(out.includes("Lisbon crew"), out); assert.ok(!out.includes("mutedmember") && !out.includes("blockedmember"), out);
  });
  it("AC0b CONTROL: nobody hidden → both members are named (the world reaches the tool)", async () => {
    const sc = world({ mutes: "none" }) as any;
    const profile = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as any;
    const out = JSON.stringify(await executeCompassTool(sc, VIEWER, profile, "get_circle_activity", {}));
    assert.ok(out.includes("mutedmember") && out.includes("blockedmember"), out);
  });
  it("AC1 get_circle_activity with NO profile (the ask profile read failed) and user_mutes unreadable → the muted member is not named", async () => {
    const sc = world({ mutes: "fail" }) as any;
    const out = JSON.stringify(await executeCompassTool(sc, VIEWER, null, "get_circle_activity", {}));
    assert.ok(!out.includes("mutedmember"), `a failed mute read named the muted member: ${out}`);
  });
  it("AC2 get_circle_activity with NO profile, healthy reads → the muted and the blocked member are not named", async () => {
    const sc = world({ blocked: true }) as any;
    const out = JSON.stringify(await executeCompassTool(sc, VIEWER, null, "get_circle_activity", {}));
    assert.ok(out.includes("Lisbon crew"), out);
    assert.ok(!out.includes("mutedmember") && !out.includes("blockedmember"), `an absent profile un-hid the hidden members: ${out}`);
  });
});
