import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { buildTripContextLines } from "../compass/CompassTripContext.js";
import {
  clientFor, fixture, plan, json, isDayCountRead, itemId, VIEWER, OTHER, TRIP, FOREIGN_TRIP, NOW, TODAY, TOMORROW,
  type Override, type Row,
} from "./helpers/tripCompassDayCountFixture.js";

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
});

afterEach(() => {
  mock.timers.reset();
  _setTestOpenAI(null);
  _setTestClient(null, false);
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ask(store = fixture(), override?: Override) {
  const { client, requests } = clientFor(store, override);
  _setTestClient(client, true);
  const prompts: string[] = [];
  _setTestOpenAI({ chat: { completions: { create: async (request: {
    max_completion_tokens?: number; messages?: Array<{ content?: unknown }>;
  }) => {
    if (request.max_completion_tokens === 256) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "question", confidence: 0.9 }) } }] };
    prompts.push((request.messages ?? []).map((message) => String(message.content ?? "")).join("\n"));
    return { choices: [{ message: { role: "assistant", content: JSON.stringify({ message: "Here is the trip context.", payload: null, quickActions: [] }) } }] };
  } } } } as unknown as NonNullable<Parameters<typeof _setTestOpenAI>[0]>);
  const response = await fetch(`${base}/api/compass/ask`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({ prompt: "What is planned for tomorrow?" }),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(prompts.length > 0, "the actual /ask main model must receive context");
  return { prompt: prompts.at(-1)!, requests, client };
}

function assertTodayPreserved(prompt: string): void {
  assert.match(prompt, /\[Trip context\]/);
  assert.match(prompt, /Active trip:/);
  assert.match(prompt, /Today's plan:.*Today's safe walk.*\(10:00\)/);
}

describe("CT02 tomorrow day count through actual /compass/ask", () => {
  it("consumes tomorrow independently and sends only its count to the model", async () => {
    const { prompt, requests } = await ask();
    assertTodayPreserved(prompt);
    assert.match(prompt, /Tomorrow: 1 planned item\(s\)\./);
    assert.doesNotMatch(prompt, /Tomorrow secret/);
    const count = requests.filter(({ url }) => isDayCountRead(url));
    assert.equal(count.length, 1);
    assert.equal(count[0]!.url.searchParams.get("status"), "neq.cancelled");
    assert.equal(count[0]!.url.searchParams.get("removed_at"), "is.null");
    assert.equal(count[0]!.url.searchParams.has("order"), false);
    assert.equal(count[0]!.method, "GET");
    assert.ok(requests.some(({ url }) => url.pathname.endsWith("/trips") && url.searchParams.get("select") === "version"));
  });

  for (const total of [0, 1, 49, 50, 51]) {
    it(`preserves the unordered fifty-row scan for ${total} tomorrow rows`, async () => {
      const store = fixture();
      store.trip_plan_items = [store.trip_plan_items[0]!, ...Array.from({ length: total }, (_, index) => plan(index))];
      const { prompt } = await ask(store);
      assertTodayPreserved(prompt);
      if (total) assert.match(prompt, new RegExp(`Tomorrow: ${Math.min(total, 50)} planned item`));
      else assert.doesNotMatch(prompt, /Tomorrow:|tomorrow is (clear|empty)/i);
    });
  }

  it("counts after privacy, without refilling fifty hidden rows from the visible fifty-first", async () => {
    const store = fixture();
    store.trip_plan_items = [store.trip_plan_items[0]!, ...Array.from({ length: 51 }, (_, index) => plan(index, { privacy_scope: index < 50 ? "private" : "crew" }))];
    const { prompt, requests } = await ask(store);
    assertTodayPreserved(prompt);
    assert.doesNotMatch(prompt, /Tomorrow:/);
    assert.equal(requests.filter(({ url }) => isDayCountRead(url)).length, 1);
  });

  it("retains all eight noncancelled canonical statuses and excludes removed, undated and foreign plans", async () => {
    const store = fixture();
    const statuses = ["draft", "proposed", "tentative", "confirmed", "in_progress", "done", "moved", "cancelled", "skipped"];
    store.trip_plan_items = [store.trip_plan_items[0]!, ...statuses.map((status, index) => plan(index, { status })),
      plan(20, { removed_at: "2026-08-01T00:00:00Z" }), plan(21, { trip_id: FOREIGN_TRIP }), plan(22, { day_date: null })];
    assert.match((await ask(store)).prompt, /Tomorrow: 8 planned item/);
  });

  for (const [label, response] of [
    ["null", null], ["object", {}], ["string", "rows"], ["null row", [plan(), null]],
    ["invalid id", [plan(), plan(1, { id: "not-a-uuid" })]],
    ["padded id", [plan(), plan(1, { id: ` ${itemId(1)}` })]],
    ["foreign trip", [plan(), plan(1, { trip_id: FOREIGN_TRIP })]],
    ["different day", [plan(), plan(1, { day_date: TODAY })]],
    ["missing creator", [plan(), plan(1, { creator_id: undefined })]],
    ["unknown scope", [plan(), plan(1, { privacy_scope: "mystery" })]],
    ["unknown status", [plan(), plan(1, { status: "unexpected" })]],
    ["padded status", [plan(), plan(1, { status: " confirmed " })]],
    ["cancelled row", [plan(), plan(1, { status: "cancelled" })]],
    ["removed row", [plan(), plan(1, { removed_at: "2026-08-01T00:00:00Z" })]],
    ["bad hidden row", [plan(), plan(1, { privacy_scope: "private", location_is_private: "false" })]],
    ["duplicate rows", [plan(), plan()]],
    ["oversized response", Array.from({ length: 51 }, (_, index) => plan(index))],
  ] as const) {
    it(`omits only tomorrow's claim on ${label}, without counting a valid prefix`, async () => {
      const { prompt } = await ask(fixture(), (url) => isDayCountRead(url) ? json(response) : undefined);
      assertTodayPreserved(prompt);
      assert.doesNotMatch(prompt, /Tomorrow:|tomorrow is (clear|empty)|Tomorrow secret/i);
    });
  }

  for (const mode of ["returned error", "transport error"] as const) {
    it(`preserves today's context on tomorrow's ${mode}`, async () => {
      const { prompt } = await ask(fixture(), (url) => {
        if (!isDayCountRead(url)) return undefined;
        if (mode === "transport error") throw new Error("fixture network unavailable");
        return json({ message: "unread", code: "XX000" }, 400);
      });
      assertTodayPreserved(prompt);
      assert.doesNotMatch(prompt, /Tomorrow:/);
    });
  }

  for (const target of ["feature_flags", "trip_private_anchor_shares", "trip_plan_item_audience", "trip_members"] as const) {
    it(`omits tomorrow's incomplete count when ${target} access is unread`, async () => {
      const store = fixture();
      store.feature_flags.push({ flag: "trip_private_anchor_sharing_enabled", enabled: true }, { flag: "trip_plan_selected_participants_enabled", enabled: true });
      store.trip_private_anchor_shares = [{ trip_id: TRIP, plan_item_id: itemId(0), owner_id: OTHER, member_id: VIEWER }];
      store.trip_plan_item_audience = [{ trip_id: TRIP, plan_item_id: itemId(0), member_id: VIEWER }];
      let tomorrowRead = false;
      const { prompt } = await ask(store, (url) => {
        if (isDayCountRead(url)) tomorrowRead = true;
        return tomorrowRead && url.pathname.endsWith(`/${target}`) ? json({ message: "unread", code: "XX000" }, 400) : undefined;
      });
      assertTodayPreserved(prompt);
      assert.doesNotMatch(prompt, /Tomorrow:/);
    });
  }

  it("counts visible private-anchor slots, but not another author's hidden plan", async () => {
    const store = fixture();
    store.trip_plan_items = [store.trip_plan_items[0]!, plan(0, { location_is_private: true }),
      plan(1, { location_is_private: null }), plan(2, { privacy_scope: "private" }),
      plan(3, { privacy_scope: "private", creator_id: VIEWER }), plan(4, { privacy_scope: null })];
    const { prompt } = await ask(store);
    assertTodayPreserved(prompt);
    assert.match(prompt, /Tomorrow: 3 planned item/);
    assert.doesNotMatch(prompt, /Tomorrow secret/);
  });

  for (const state of ["valid", "flag off", "revoked", "viewer left"] as const) {
    it(`honors the existing selected audience: ${state}`, async () => {
      const store = fixture();
      store.trip_plan_items[1]!.privacy_scope = "selected_participants";
      store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: state !== "flag off" });
      store.trip_plan_item_audience = state === "revoked" ? [] : [{ trip_id: TRIP, plan_item_id: itemId(0), member_id: VIEWER }];
      if (state === "viewer left") store.trip_members[0]!.status = "left";
      const { prompt } = await ask(store);
      assertTodayPreserved(prompt);
      assert.equal(prompt.includes("Tomorrow: 1 planned item(s)."), state === "valid");
    });
  }

  it("omits the count when a malformed audience response would silently hide a selected plan", async () => {
    const store = fixture();
    store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
    store.trip_plan_items.push(plan(1, { privacy_scope: "selected_participants" }));
    store.trip_plan_item_audience = [{ trip_id: TRIP, plan_item_id: itemId(1), member_id: VIEWER }];
    const control = await ask(structuredClone(store));
    assert.match(control.prompt, /Tomorrow: 2 planned item/);
    let tomorrowRead = false;
    const { prompt } = await ask(store, (url) => {
      if (isDayCountRead(url)) tomorrowRead = true;
      return tomorrowRead && url.pathname.endsWith("/trip_plan_item_audience") ? json(null) : undefined;
    });
    assertTodayPreserved(prompt);
    assert.doesNotMatch(prompt, /Tomorrow:/);
  });

  for (const malformed of ["null", "padded owner id"] as const) {
    it(`refuses ${malformed} membership instead of restoring a departed owner's selected-plan access`, async () => {
      const store = fixture();
      store.trip_members[0]!.status = "left";
      store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
      store.trip_plan_items.push(plan(1, { privacy_scope: "selected_participants" }));
      store.trip_plan_item_audience = [{ trip_id: TRIP, plan_item_id: itemId(1), member_id: VIEWER }];
      const control = await ask(structuredClone(store));
      assert.match(control.prompt, /Tomorrow: 1 planned item/);
      let tomorrowRead = false;
      const { prompt } = await ask(store, (url) => {
        if (isDayCountRead(url)) tomorrowRead = true;
        if (!tomorrowRead || !url.pathname.endsWith("/trip_members") || url.searchParams.get("select") !== "user_id,status,role") return undefined;
        return json(malformed === "null" ? null : store.trip_members.map((row) => row.user_id === VIEWER ? { ...row, user_id: ` ${VIEWER}` } : row));
      });
      assertTodayPreserved(prompt);
      assert.doesNotMatch(prompt, /Tomorrow:/);
    });
  }

  for (const role of ["owner", "member"] as const) {
    for (const order of ["accepted-first", "departed-first"] as const) {
      it(`omits tomorrow on conflicting duplicate membership for ${role}, ${order}`, async () => {
        const store = fixture();
        store.trips[0]!.owner_id = role === "owner" ? VIEWER : OTHER;
        store.trip_members[0]!.role = role;
        store.trip_members[0]!.status = "left";
        store.trip_members[1]!.role = role === "owner" ? "member" : "owner";
        store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
        store.trip_plan_items.push(plan(1, { privacy_scope: "selected_participants" }));
        store.trip_plan_item_audience = [{ trip_id: TRIP, plan_item_id: itemId(1), member_id: VIEWER }];
        const control = await ask(structuredClone(store));
        assert.match(control.prompt, /Tomorrow: 1 planned item/);
        let tomorrowRead = false;
        const { prompt } = await ask(store, (url) => {
          if (isDayCountRead(url)) tomorrowRead = true;
          if (!tomorrowRead || !url.pathname.endsWith("/trip_members") || url.searchParams.get("select") !== "user_id,status,role") return undefined;
          const departed = store.trip_members[0]!;
          const accepted = { ...departed, status: "accepted" };
          return json([store.trip_members[1], ...(order === "accepted-first" ? [accepted, departed] : [departed, accepted])]);
        });
        assertTodayPreserved(prompt);
        assert.doesNotMatch(prompt, /Tomorrow:/);
      });
    }
  }

  for (const [timezone, today, tomorrow] of [["Asia/Taipei", "2026-08-06", "2026-08-07"], ["invalid-zone", TODAY, TOMORROW]] as const) {
    it(`keeps trip-local tomorrow and timezone fallback for ${timezone}`, async () => {
      const store = fixture();
      store.trips[0]!.timezone = timezone;
      store.trip_plan_items = [plan(0, { day_date: tomorrow })];
      const { prompt, requests } = await ask(store);
      assert.match(prompt, /Tomorrow: 1 planned item/);
      assert.equal(requests.filter(({ url }) => isDayCountRead(url, tomorrow)).length, 1);
      assert.ok(requests.some(({ url }) => url.pathname.endsWith("/trip_plan_items") && url.searchParams.get("day_date") === `eq.${today}` && url.searchParams.get("limit") === "5"));
    });
  }

  it("still reads tomorrow on the trip's last active day and is independent of eleven today items", async () => {
    const store = fixture();
    store.trips[0]!.end_date = TODAY;
    store.trip_plan_items = [...Array.from({ length: 11 }, (_, index) => plan(index + 100, { day_date: TODAY, title: `Today ${index}` })), plan(0)];
    const { prompt, requests } = await ask(store);
    assert.match(prompt, /Tomorrow: 1 planned item/);
    const todayRead = requests.find(({ url }) => url.pathname.endsWith("/trip_plan_items") && url.searchParams.get("limit") === "5");
    assert.equal(todayRead?.url.searchParams.get("order"), "starts_at.asc,sort_order.asc");
    assert.doesNotMatch(prompt, /Today 5/);
  });

  it("retains current-trip selection and does not read a count for an upcoming trip", async () => {
    const store = fixture();
    store.trips[0]!.status = "upcoming";
    store.trips[0]!.start_date = "2026-08-07";
    const { prompt, requests } = await ask(store);
    assert.match(prompt, /Upcoming trip:/);
    assert.doesNotMatch(prompt, /Tomorrow:/);
    assert.equal(requests.some(({ url }) => isDayCountRead(url)), false);
  });

  it("leaves live-session suppression intact in the real ask route", async () => {
    const store = fixture();
    store.compass_live_sessions = [{ id: itemId(800), user_id: VIEWER, status: "active", started_at: new Date(NOW).toISOString(), context: { city: "Cebu", recentEvents: [] } }];
    const { prompt, requests } = await ask(store);
    assert.match(prompt, /Live session: ACTIVE/);
    assert.doesNotMatch(prompt, /\[Trip context\]|Tomorrow:/);
    assert.equal(requests.some(({ url }) => isDayCountRead(url)), false);
  });

  it("retains the existing 1200-character block budget without moving tomorrow ahead of today", async () => {
    const store = fixture();
    store.trip_plan_items[0]!.title = "Long today title ".repeat(90);
    const { prompt, client } = await ask(store);
    assert.match(prompt, /Active trip:/);
    assert.doesNotMatch(prompt, /Tomorrow:/);
    const lines = await buildTripContextLines(client, VIEWER);
    assert.equal(lines.length, 1);
    assert.ok(lines.join("\n").length < 1200);
  });
});
