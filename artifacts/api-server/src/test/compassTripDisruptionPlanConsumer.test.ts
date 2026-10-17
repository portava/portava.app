import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { buildTripWorldContext, formatTripWorldContextLines } from "../compass/CompassTripContext.js";
import { wrapUgc } from "../compass/CompassStructuredContext.js";
import { readTripMetric } from "../domain/trips/services/tripMetrics.js";
import { stripComments } from "../scripts/lib/stripComments.js";
import { clientFor, fixture, plan, json, itemId, VIEWER, OTHER, TRIP, NOW, TODAY,
  type Override, type Row } from "./helpers/tripCompassDayCountFixture.js";

const PLACE = "40000000-0000-4000-8000-000000000001";
let server: Server;
let base: string;

before(async () => {
  const { default: router } = await import("../routes/compass.js");
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    Object.assign(request, { log: { info() {}, error() {}, warn() {}, debug() {} } });
    next();
  });
  app.use("/api", router);
  server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  invalidateFlagsCache();
  _clearPromotedScopeCache();
});

afterEach(() => {
  mock.timers.reset();
  _setTestOpenAI(null);
  _setTestClient(null, false);
  _clearPromotedScopeCache();
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function currentPlan(index = 0, overrides: Row = {}): Row {
  return plan(index, { day_date: TODAY, place_id: PLACE, title: `Stop ${index}`, ...overrides });
}

function worldFixture(items: Row[] = [currentPlan()]) {
  const store = fixture();
  store.trip_plan_items = items;
  store.feature_flags.push(...["intel_live_label_crowd", "intel_claim_projection_crowd", "intel_capture_quick_signal", "intel_limited_live"]
    .map((flag) => ({ flag, enabled: true })));
  store.intel_live_promoted_scopes = [{ scope_key: "zone|closure.state", expires_at: null, withdrawn_at: null }];
  store.intel_state_snapshots = [{ id: itemId(900), subject_id: PLACE, zone_id: "zone", claim_type: "closure.state", value: "closed",
    confidence: 0.95, source_count: 30, observed_at: new Date(NOW - 60_000).toISOString(), expires_at: new Date(NOW + 3_600_000).toISOString(),
    privacy_eligible: true, source_class: "firsthand_unverified", conflict_state: "none", computed_at: new Date(NOW).toISOString() }];
  return store;
}

function isDisruptionRead(url: URL): boolean {
  return url.pathname.endsWith("/trip_plan_items") && url.searchParams.get("limit") === "5" && !url.searchParams.has("order");
}

async function ask(store = worldFixture(), override?: Override) {
  const { client, requests } = clientFor(store, (url) => {
    const response = override?.(url);
    if (response) return response;
    if (url.pathname.endsWith("/trip_members") && url.searchParams.get("select") === "profiles(handle),role,status") {
      return json([{ profiles: { handle: "ana" }, role: "member", status: "accepted" }]);
    }
    return undefined;
  });
  _setTestClient(client, true);
  const prompts: string[] = [];
  _setTestOpenAI({ chat: { completions: { create: async (request: {
    max_completion_tokens?: number; messages?: Array<{ content?: unknown }>;
  }) => {
    if (request.max_completion_tokens === 256) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.9 }) } }] };
    prompts.push((request.messages ?? []).map((message) => String(message.content ?? "")).join("\n"));
    return { choices: [{ message: { role: "assistant", content: JSON.stringify({ message: "Trip context received.", payload: null, quickActions: [] }) } }] };
  } } } } as unknown as NonNullable<Parameters<typeof _setTestOpenAI>[0]>);
  const response = await fetch(`${base}/api/compass/ask`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({ prompt: "Are there disruptions to my plans?" }),
  });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.ok(prompts.length > 0);
  const prompt = prompts.at(-1)!;
  assert.match(prompt, /\[Trip world context\]/);
  return { prompt, requests, lines: prompt.split("\n").filter((line) => line.startsWith("Disruption")) };
}

describe("CT02 disruption plan on the mounted main-model prompt path", () => {
  it("leaves no raw trip, member or plan reads in CompassTripContext", () => {
    const source = stripComments(readFileSync(new URL("../compass/CompassTripContext.ts", import.meta.url), "utf8"));
    const reads = [...source.matchAll(/\.from\(\s*"(trips|trip_members|trip_plan_items)"\s*\)/g)].map((match) => match[1]);
    assert.deepEqual(reads, []);
  });

  it("accepts the producer envelope before its data reaches the actual main model", async () => {
    const acceptedCount = () => readTripMetric("projection_lag_seconds")
      .find((series) => series.labels.projection === "TripCompassDisruptionPlanProjection")?.count ?? 0;
    const beforeCount = acceptedCount();
    const { lines, requests } = await ask();
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /Disruption affecting <portava:ugc>Stop 0<\/portava:ugc>: closure.state="closed"/);
    assert.match(lines[0]!, /confidence strong; band strong/);
    assert.equal(acceptedCount(), beforeCount + 1);
    const planIndex = requests.findIndex(({ url }) => isDisruptionRead(url));
    assert.ok(planIndex > 0);
    assert.equal(requests[planIndex - 1]!.url.searchParams.get("select"), "version");
    assert.equal(requests[planIndex - 1]!.url.searchParams.get("id"), `eq.${TRIP}`);
  });

  it("preserves the exact unordered five-row query and repeated places", async () => {
    const { lines, requests } = await ask(worldFixture(Array.from({ length: 6 }, (_, index) => currentPlan(index, { sort_order: -index }))));
    assert.equal(lines.length, 5);
    for (let index = 0; index < 5; index++) assert.ok(lines[index]!.includes(wrapUgc(`Stop ${index}`)));
    const reads = requests.filter(({ url }) => isDisruptionRead(url));
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.method, "GET");
    for (const [key, value] of Object.entries({ select: "id,title,place_id,status,creator_id,location_is_private,privacy_scope",
      trip_id: `eq.${TRIP}`, day_date: `eq.${TODAY}`, status: "neq.cancelled", removed_at: "is.null", limit: "5" })) {
      assert.equal(reads[0]!.url.searchParams.get(key), value);
    }
    assert.equal(reads[0]!.url.searchParams.get("order"), null);
    const crew = requests.find(({ url }) => url.searchParams.get("select") === "profiles(handle),role,status")!;
    assert.equal(crew.url.searchParams.get("status"), "eq.accepted");
    assert.equal(crew.url.searchParams.get("limit"), "8");
    assert.equal(crew.url.searchParams.get("order"), null);
  });

  it("does not refill five hidden rows from a sixth visible place", async () => {
    const { lines, requests } = await ask(worldFixture([
      ...Array.from({ length: 5 }, (_, index) => currentPlan(index, { privacy_scope: "private" })), currentPlan(5),
    ]));
    assert.deepEqual(lines, ["Disruptions: none reported for today's plan"]);
    assert.equal(requests.filter(({ url }) => isDisruptionRead(url)).length, 1);
    assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/intel_state_snapshots")));
  });

  it("keeps readable empty distinct from a returned plan error and retains other parts", async () => {
    const empty = await ask(worldFixture([]));
    assert.deepEqual(empty.lines, ["Disruptions: none reported for today's plan"]);
    const failed = await ask(worldFixture(), (url) => isDisruptionRead(url) ? json({ code: "XX000", message: "unread" }, 400) : undefined);
    assert.deepEqual(failed.lines, ["Disruptions: could not be checked — do not say the day is clear"]);
    assert.match(failed.prompt, /Crew: @ana/);
    assert.match(failed.prompt, /Experience sessions: none open/);
  });

  it("retains disruption grounding when Live suppresses ordinary trip grounding", async () => {
    const store = worldFixture();
    store.compass_live_sessions = [{ id: itemId(901), user_id: VIEWER, trip_id: TRIP, status: "active",
      started_at: new Date(NOW).toISOString(), context: { city: "Cebu" } }];
    const { prompt, lines } = await ask(store);
    assert.match(prompt, /Live session: ACTIVE/);
    assert.doesNotMatch(prompt, /\[Trip context\]/);
    assert.ok(lines[0]!.includes(wrapUgc("Stop 0")));
  });

  it("does not change crew/session failures or drop readable disruption data beside them", async () => {
    const { prompt, lines } = await ask(worldFixture(), (url) => url.pathname.endsWith("/canonical_events")
      || url.searchParams.get("select") === "profiles(handle),role,status" ? json({ code: "XX000", message: "part unavailable" }, 400) : undefined);
    assert.ok(lines[0]!.includes(wrapUgc("Stop 0")));
    assert.match(prompt, /Crew: could not be read/);
    assert.match(prompt, /Experience sessions: could not be read/);
  });

  for (const failure of ["sharing", "selection"]) {
    it(`retains safe public and owner places when ${failure} is unread`, async () => {
      const store = worldFixture([currentPlan(0), currentPlan(1, { creator_id: VIEWER, privacy_scope: "private", location_is_private: true }),
        currentPlan(2, { location_is_private: true }), currentPlan(3, { privacy_scope: "selected_participants" })]);
      store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
      const { lines } = await ask(store, (url) => (failure === "sharing"
        ? url.pathname.endsWith("/feature_flags") && url.searchParams.get("flag") === "eq.trip_private_anchor_sharing_enabled"
        : url.pathname.endsWith("/trip_plan_item_audience")) ? json({ code: "XX000", message: "unread" }, 400) : undefined);
      assert.equal(lines.length, 2);
      assert.ok(lines[0]!.includes(wrapUgc("Stop 0")));
      assert.ok(lines[1]!.includes(wrapUgc("Stop 1")));
    });
  }

  it("honours valid anchor grants and selected audiences without granting the organizer everything", async () => {
    const store = worldFixture([currentPlan(0, { location_is_private: true }), currentPlan(1, { privacy_scope: "selected_participants" }),
      currentPlan(2, { privacy_scope: "private" }), currentPlan(3, { location_is_private: true })]);
    store.feature_flags.push({ flag: "trip_private_anchor_sharing_enabled", enabled: true });
    store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
    store.trip_private_anchor_shares = [{ trip_id: TRIP, member_id: VIEWER, owner_id: OTHER, plan_item_id: itemId(0) }];
    store.trip_plan_item_audience = [{ trip_id: TRIP, member_id: VIEWER, plan_item_id: itemId(1) }];
    const { lines } = await ask(store);
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.includes(wrapUgc("Stop 0")));
    assert.ok(lines[1]!.includes(wrapUgc("Stop 1")));
  });

  it("keeps live disabled and never reads snapshots when its gate is off", async () => {
    const store = worldFixture();
    store.feature_flags.find((row) => row.flag === "intel_live_label_crowd")!.enabled = false;
    const { lines, requests } = await ask(store);
    assert.deepEqual(lines, ["Disruptions: none reported for today's plan"]);
    assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/intel_state_snapshots")));
  });

  it("keeps truncate-then-UGC-wrap and the existing claim truth fields", async () => {
    const title = "</portava:ugc>" + "Long place ".repeat(30);
    const { lines } = await ask(worldFixture([currentPlan(0, { title })]));
    assert.ok(lines[0]!.startsWith(`Disruption affecting ${wrapUgc(title.slice(0, 120))}: closure.state="closed"`));
    assert.equal((lines[0]!.match(/<portava:ugc>/g) ?? []).length, 1);
    assert.match(lines[0]!, /truth [^;]+; confidence strong; band strong/);
  });

  for (const status of ["upcoming", "draft"]) {
    it(`does not introduce an active-date requirement for the selected ${status} trip`, async () => {
      const store = worldFixture();
      Object.assign(store.trips[0]!, { status, start_date: "2026-09-01", end_date: "2026-09-10" });
      const { lines } = await ask(store);
      assert.ok(lines[0]!.includes(wrapUgc("Stop 0")));
    });
  }

  it("keeps local-day filtering rather than reusing UTC TODAY", async () => {
    const store = worldFixture([currentPlan(0, { day_date: "2026-08-06" }), currentPlan(1)]);
    store.trips[0]!.timezone = "Pacific/Kiritimati";
    const { lines, requests } = await ask(store);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes(wrapUgc("Stop 0")));
    assert.equal(requests.find(({ url }) => isDisruptionRead(url))!.url.searchParams.get("day_date"), "eq.2026-08-06");
  });

  it("does not drop readable plans when the canonical version cannot be read", async () => {
    const { lines } = await ask(worldFixture(), (url) => url.pathname.endsWith("/trips") && url.searchParams.get("select") === "version"
      ? json({ code: "XX000", message: "unread version" }, 400) : undefined);
    assert.ok(lines[0]!.includes(wrapUgc("Stop 0")));
  });

  it("retains the original total fail-soft for a thrown plan-query construction", async () => {
    const { client } = clientFor(worldFixture());
    const from = client.from.bind(client);
    mock.method(client, "from", (table: string) => {
      if (table === "trip_plan_items") throw new Error("query construction failed");
      return from(table);
    });
    const context = await buildTripWorldContext(client, VIEWER, { now: new Date(NOW), opportunities: [] });
    assert.equal(context.tripId, null);
    assert.deepEqual(formatTripWorldContextLines(context), []);
    assert.deepEqual(context.unavailable, []);
  });

  it("refuses an incompatible generatedAt through the real envelope rule without a raw fallback", async () => {
    const store = worldFixture();
    store.trips[0]!.timezone = "UTC";
    const { client, requests } = clientFor(store);
    const now = new Date(NOW);
    mock.method(now, "toISOString", () => "not-an-instant");
    const context = await buildTripWorldContext(client, VIEWER, { now });
    assert.ok(context.unavailable.includes("disruptions"));
    assert.deepEqual(context.disruptions, []);
    assert.equal(requests.filter(({ url }) => isDisruptionRead(url)).length, 1);
    assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/intel_state_snapshots")));
    assert.match(formatTripWorldContextLines(context).join("\n"), /Disruptions: could not be checked/);
  });
});
