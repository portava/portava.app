/**
 * census-compass §34 (census-discovery §111, lane W11-X2 round 14, D-W11X2-105): a Compass tool never
 * offers a candidate that skipped block/mute filtering or the COMPASS_% safety gate.
 *
 * At /compass/ask a failed `blocks` or `user_mutes` read makes `getCompassProfile` throw ("failing
 * closed"). The route caught it and handed `null` to every tool, and:
 *   - `rankToolCandidates` answered `null` for a null profile (and for a thrown pipeline), which
 *     `applyToolRanking` reads as "unranked: serve the raw list" — so `search_places`, `search_events`
 *     and `get_group_recommendation` offered rows no safety gate had seen (`ranked: false`);
 *   - `get_circle_activity` built its filter from an EMPTY hidden set, so a blocked member's handle
 *     was served;
 *   - `refreshHiddenUsers` over a null profile synthesised a profile from the block and mute lists
 *     alone, and the pipeline ranked on it — its safe-return hold and age default were invented;
 *   - a failed refresh became "Tool execution failed", which tells the model nothing it can say.
 * A check meant to fail closed failed open. Every path now answers "could not check" instead.
 *
 *   PU1  search_places, profile null → no candidate, and the tool says it could not check
 *   PU2  search_events, profile null, the block and mute lists readable → no candidate ranked on a
 *        synthesised profile; the tool says it could not check
 *   PU3  get_group_recommendation, profile null, lists readable → no recommendation on a synthesised profile
 *   PU4  get_circle_activity, profile null, lists readable → the lists are read, the blocked member is hidden
 *   PU5  get_circle_activity, profile null, the block read fails → no member served; "could not check"
 *   PU6  search_events / get_group_recommendation, profile null, the block read fails → "could not check",
 *        never "Tool execution failed"
 *   PU7  the pipeline throws (a real profile) → no raw candidate; the tool says it could not check
 *   PR1  /compass/ask, the blocks read fails throughout → the model is handed no search_places candidate
 *   PR2  /compass/ask, the profile's blocks read fails and the tool-time reads recover → still no
 *        candidate ranked without the profile
 *   PUc  CONTROL: a real profile, every read healthy → candidates offered, ranked; the blocked member hidden
 *   PRc  CONTROL: a healthy /compass/ask → the model is handed the ranked candidates
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER, TOKEN, DB_ERR, type Call } from "./helpers/compassReadWorld.js";

const BLOCKED = "b1000000-0000-4000-a000-0000000000b1";
const FRIEND = "f1000000-0000-4000-a000-0000000000f1";
const HOST = "e1000000-0000-4000-a000-0000000000e1";
const eqCall = (calls: Call[], col: string) => calls.some(([k, a]) => k === "eq" && a[0] === col);
const inCall = (calls: Call[], col: string) => calls.some(([k, a]) => k === "in" && a[0] === col);
const limitOf = (calls: Call[]) => { const c = calls.find(([k]) => k === "limit"); return c ? Number(c[1][0]) : Infinity; };
const realProfile = () => ({ userId: VIEWER, currentCity: "Paris", blockedUserIds: [BLOCKED], blockerUserIds: [], mutedUserIds: [], interests: ["music"] }) as unknown as CompassProfile;
const UNCHECKED = /could not check/i;

const places = Array.from({ length: 3 }, (_, i) => ({ id: `11111111-1111-4111-a111-00000000000${i}`, name: `Place ${i}`, blurb: null, category: "food", primary_category: "food", city: "Paris", rating: 4, saved_count: 0, verified: true, status: "active" }));
const events = Array.from({ length: 3 }, (_, i) => ({ id: `ee000000-0000-4000-a000-00000000000${i}`, title: `Event ${i}`, description: null, city: "Paris", country: "FR", starts_at: new Date(Date.now() + 86_400_000 + i * 60_000).toISOString(), category: "music", host_id: HOST, state: "open", visibility: "public", max_attendees: null, going_count: 0, age_min: null, verified_only: false }));

/** `blocksDown()` decides, per read, whether the blocks read fails — so a case can fail the profile's read and not the tool's. */
function world(blocksDown: () => boolean) {
  return compassWorld({
    answer: (t, calls, single) => {
      if (t === "blocks") {
        if (blocksDown()) return { data: null, error: DB_ERR };
        return eqCall(calls, "blocker_id") ? { data: [{ blocked_id: BLOCKED }], error: null } : { data: [], error: null };
      }
      if (t === "user_mutes") return { data: [], error: null };
      if (t === "discovery_places") return { data: places.slice(0, limitOf(calls)), error: null };
      if (t === "events") return { data: events.slice(0, limitOf(calls)), error: null };
      if (t === "circles" && eqCall(calls, "owner_id")) return { data: [{ id: "c1", name: "Porto crew", owner_id: VIEWER }], error: null };
      if (t === "circle_memberships" && inCall(calls, "user_id")) return { data: [{ user_id: VIEWER, other_id: BLOCKED, status: "pending" }, { user_id: VIEWER, other_id: FRIEND, status: "pending" }], error: null };
      if (t === "circle_memberships" && eqCall(calls, "user_id")) return { data: [{ other_id: FRIEND, status: "pending" }], error: null };
      if (t === "circle_memberships") return { data: [], error: null };
      if (t === "profiles" && inCall(calls, "id")) return { data: [{ id: VIEWER, handle: "me", interests: ["music"] }, { id: BLOCKED, handle: "blocked" }, { id: FRIEND, handle: "friend", interests: ["music"] }], error: null };
      if (t === "compass_conversations" && single) return { data: { id: "cc000000-0000-4000-a000-000000000001" }, error: null };
      return undefined;
    },
  });
}
const run = async (w: ReturnType<typeof compassWorld>, profile: CompassProfile | null, tool: string, args: Record<string, unknown> = {}) =>
  (await executeCompassTool(w.client as any, VIEWER, profile, tool, args)) as Record<string, any>;
const said = (r: Record<string, any>) => `${r.info ?? ""} ${r.error ?? ""}`;

beforeEach(() => { invalidateFlagsCache(); clearCompassProfileCache(); });

describe("a Compass tool never offers a candidate that skipped block/mute filtering or the safety gate (census-compass §34)", () => {
  it("PUc CONTROL: a real profile, every read healthy → candidates offered and ranked; the blocked member hidden", async () => {
    const w = world(() => false);
    const p = await run(w, realProfile(), "search_places", { query: "place" });
    assert.ok(p.candidates.length > 0 && p.ranked === true, JSON.stringify(p));
    const e = await run(w, realProfile(), "search_events", {});
    assert.ok(e.candidates.length > 0 && e.ranked === true, JSON.stringify(e));
    const c = await run(w, realProfile(), "get_circle_activity");
    assert.equal(c.circles.length, 1, JSON.stringify(c));
    assert.ok(!JSON.stringify(c).includes("@blocked"), JSON.stringify(c));
    const g = await run(w, realProfile(), "get_group_recommendation", { circleName: "Porto crew", kind: "places" });
    assert.ok(g.candidates.length > 0, JSON.stringify(g));
  });
  it("PU1 search_places, profile null → no candidate, and the tool says it could not check", async () => {
    const r = await run(world(() => false), null, "search_places", { query: "place" });
    assert.deepEqual(r.candidates, [], `rows no safety gate saw were offered: ${JSON.stringify(r)}`);
    assert.match(said(r), UNCHECKED, JSON.stringify(r));
  });
  it("PU2 search_events, profile null, lists readable → nothing ranked on a synthesised profile", async () => {
    const r = await run(world(() => false), null, "search_events", {});
    assert.deepEqual(r.candidates, [], `ranked on a profile made of the block lists alone: ${JSON.stringify(r)}`);
    assert.match(said(r), UNCHECKED, JSON.stringify(r));
  });
  it("PU3 get_group_recommendation, profile null, lists readable → no recommendation on a synthesised profile", async () => {
    const r = await run(world(() => false), null, "get_group_recommendation", { circleName: "Porto crew", kind: "places" });
    assert.ok(!r.candidates || r.candidates.length === 0, JSON.stringify(r));
    assert.match(said(r), UNCHECKED, JSON.stringify(r));
  });
  it("PU4 get_circle_activity, profile null, lists readable → the lists are read and the blocked member is hidden", async () => {
    const r = await run(world(() => false), null, "get_circle_activity");
    assert.ok(!JSON.stringify(r).includes("@blocked"), `a blocked member was served over an empty hidden set: ${JSON.stringify(r)}`);
    assert.equal(r.circles.length, 1, JSON.stringify(r));
    assert.ok(JSON.stringify(r).includes("@friend"), JSON.stringify(r));
  });
  it("PU5 get_circle_activity, profile null, the block read fails → no member served, and 'could not check'", async () => {
    const r = await run(world(() => true), null, "get_circle_activity");
    assert.ok(!JSON.stringify(r).includes("@blocked") && !JSON.stringify(r).includes("@friend"), `members served over an unread block list: ${JSON.stringify(r)}`);
    assert.match(said(r), UNCHECKED, JSON.stringify(r));
  });
  it("PU6 search_events and get_group_recommendation, profile null, the block read fails → 'could not check', never 'Tool execution failed'", async () => {
    for (const [tool, args] of [["search_events", {}], ["get_group_recommendation", { circleName: "Porto crew", kind: "events" }]] as const) {
      const r = await run(world(() => true), null, tool, args);
      assert.ok(!r.candidates || r.candidates.length === 0, JSON.stringify(r));
      assert.doesNotMatch(said(r), /Tool execution failed/, `${tool}: ${JSON.stringify(r)}`);
      assert.match(said(r), UNCHECKED, `${tool}: ${JSON.stringify(r)}`);
    }
  });
  it("PU7 the pipeline throws over a real profile → no raw candidate, and the tool says it could not check", async () => {
    const throwing = realProfile() as any;
    Object.defineProperty(throwing, "categoryWeights", { enumerable: true, get() { throw new Error("pipeline input unreadable"); } });
    for (const [tool, args] of [["search_places", { query: "place" }], ["search_events", {}]] as const) {
      const r = await run(world(() => false), throwing, tool, args);
      assert.deepEqual(r.candidates, [], `${tool}: a thrown pipeline served the raw list: ${JSON.stringify(r)}`);
      assert.match(said(r), UNCHECKED, `${tool}: ${JSON.stringify(r)}`);
    }
  });
});

describe("/compass/ask over a profile that could not be read (census-compass §34)", () => {
  let base = ""; let server: Server;
  before(async () => {
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; n(); });
    app.use("/api", compassRouter);
    server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(() => { server.close(); _setTestOpenAI(null); });
  /** The model calls `tool` once; the result it is handed is returned. */
  async function askTool(blocksDown: () => boolean, onModelCall: () => void, tool: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const toolResults: any[] = [];
    _setTestOpenAI({ chat: { completions: { create: async (opts: any) => {
      const msgs: any[] = opts.messages ?? [];
      if (!JSON.stringify(msgs).includes("You are Compass")) return { choices: [{ message: { role: "assistant", content: "{}" } }] };
      onModelCall();
      const toolMsg = msgs.find((m) => m.role === "tool");
      if (toolMsg) { toolResults.push(JSON.parse(toolMsg.content)); return { choices: [{ message: { role: "assistant", content: "ok" } }] }; }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } }] };
    } } } } as any);
    _setTestClient(world(blocksDown).client as any, true);
    const r = await fetch(`${base}/compass/ask`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "what's good tonight?" }) });
    assert.equal(r.status, 200);
    assert.equal(toolResults.length, 1, "the tool ran once and its result reached the model");
    return toolResults[0];
  }
  it("PRc CONTROL: a healthy ask → the model is handed ranked candidates", async () => {
    const r = await askTool(() => false, () => {}, "search_places", { query: "place" });
    assert.ok(r.candidates.length > 0 && r.ranked === true, JSON.stringify(r));
  });
  it("PR1 the blocks read fails throughout → the model is handed no search_places candidate, and 'could not check'", async () => {
    const r = await askTool(() => true, () => {}, "search_places", { query: "place" });
    assert.deepEqual(r.candidates, [], `a failed block read failed OPEN: ${JSON.stringify(r)}`);
    assert.match(said(r), UNCHECKED, JSON.stringify(r));
  });
  it("PR2 the profile's blocks read fails and the tool-time reads recover → still no candidate ranked without the profile", async () => {
    let down = true;
    for (const [tool, args] of [["search_places", { query: "place" }], ["search_events", {}]] as const) {
      down = true;
      const r = await askTool(() => down, () => { down = false; }, tool, args);
      assert.deepEqual(r.candidates, [], `${tool}: ${JSON.stringify(r)}`);
      assert.match(said(r), UNCHECKED, `${tool}: ${JSON.stringify(r)}`);
    }
  });
});
