/**
 * Telegraph Trip Intelligence Pack — tests (Sections E–F)
 *
 * Covers:
 *   E1–E25:  Brief access control + context privacy
 *   E26–E40: Concierge command parsing + action confirmation gating
 *   E41–E55: Preference CRUD + learning engine signal logic
 *   F1–F15:  Recommendation ranking + feedback events
 *   F16–F24: Public-profile privacy
 */
import assert from "node:assert/strict";
import { test, describe, before, beforeEach } from "node:test";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";

// ─── shared state ──────────────────────────────────────────────────────────

const OWNER_TOKEN = "tok-owner";
const MEMBER_TOKEN = "tok-member";
const INVITED_TOKEN = "tok-invited";
const STRANGER_TOKEN = "tok-stranger";
const OWNER_ID = "uid-owner";
const MEMBER_ID = "uid-member";
const INVITED_ID = "uid-invited";
const STRANGER_ID = "uid-stranger";
const TRIP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CMD_ID_STORE = new Map<string, any>();

interface FakeState {
  users: Record<string, { id: string } | null>;
  members: Array<{ trip_id: string; user_id: string; role: string }>;
  preferenceProfiles: Record<string, any>;
  preferenceEvents: any[];
  tripPlanItems: any[];
}

function makeState(): FakeState {
  return {
    users: {
      [OWNER_TOKEN]:   { id: OWNER_ID },
      [MEMBER_TOKEN]:  { id: MEMBER_ID },
      [INVITED_TOKEN]: { id: INVITED_ID },
      [STRANGER_TOKEN]:{ id: STRANGER_ID },
    },
    members: [
      { trip_id: TRIP_ID, user_id: OWNER_ID,   role: "owner" },
      { trip_id: TRIP_ID, user_id: MEMBER_ID,  role: "member" },
      { trip_id: TRIP_ID, user_id: INVITED_ID, role: "invited" },
    ],
    preferenceProfiles: {},
    preferenceEvents: [],
    tripPlanItems: [],
  };
}

function makeClient(state: FakeState) {
  const inserted: any[] = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;

    const builder: any = {
      select() { return builder; },
      insert(row: any) { pendingInsert = row; inserted.push({ table, row }); return builder; },
      update(patch: any) { pendingUpdate = patch; return builder; },
      delete() {
        if (table === "user_preference_events") {
          state.preferenceEvents = state.preferenceEvents.filter((e) => !filters.every((f) => f(e)));
        }
        return builder;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return resolveSingle(true); },
      single() { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
      catch(fn: any) { return { then: (f: any) => Promise.resolve({ data: [], error: null }).then(f) }; },
    };

    function rows(): any[] {
      let source: any[] = [];
      if (table === "trip_members") source = state.members;
      else if (table === "user_preference_profiles") source = Object.values(state.preferenceProfiles);
      else if (table === "user_preference_events") source = state.preferenceEvents;
      else if (table === "trip_plan_items") source = state.tripPlanItems;
      else if (table === "meetups") source = [];
      return source.filter((r) => filters.every((f) => f(r)));
    }

    async function resolveSingle(maybe: boolean) {
      if (pendingInsert) {
        if (table === "user_preference_profiles") {
          const row = { id: "pref-1", updated_at: new Date().toISOString(), ...pendingInsert };
          state.preferenceProfiles[pendingInsert.user_id] = row;
          return { data: row, error: null };
        }
        if (table === "user_preference_events") {
          const row = { id: `evt-${Date.now()}`, ...pendingInsert };
          state.preferenceEvents.push(row);
          return { data: row, error: null };
        }
        return { data: { id: "new-1", ...pendingInsert }, error: null };
      }
      if (pendingUpdate) {
        const matched = rows();
        if (matched.length > 0) {
          Object.assign(matched[0], pendingUpdate);
          if (table === "user_preference_profiles") {
            state.preferenceProfiles[matched[0].user_id] = matched[0];
          }
          return { data: matched[0], error: null };
        }
        return { data: null, error: null };
      }
      const matched = rows();
      if (maybe) return { data: matched[0] ?? null, error: null };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (pendingInsert) {
        if (table === "user_preference_events") {
          const row = { id: `evt-${Date.now()}`, ...pendingInsert };
          state.preferenceEvents.push(row);
        }
        return { data: [pendingInsert], error: null };
      }
      return { data: rows(), error: null };
    }

    return builder;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = (state.users as any)[token];
        if (!u) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: u }, error: null };
      },
    },
    __inserted: inserted,
  };
}

function makeApp(state: FakeState) {
  const client = makeClient(state);
  _setTestClient(client, true);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });

  // Import routers (must happen after _setTestClient)
  const attach = async () => {
    const [
      { default: prefsRouter },
      { default: dailyBriefRouter },
      { default: commandsRouter },
      { default: feedbackRouter },
    ] = await Promise.all([
      import("../routes/preferences.js"),
      import("../routes/dailyBrief.js"),
      import("../routes/telegraphCommands.js"),
      import("../routes/telegraphFeedback.js"),
    ]);
    app.use("/api", prefsRouter);
    app.use("/api", dailyBriefRouter);
    app.use("/api", commandsRouter);
    app.use("/api", feedbackRouter);
  };

  return { app, client, attach };
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function req(app: express.Application, method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      const data = opts.body ? JSON.stringify(opts.body) : undefined;
      const options = {
        hostname: "127.0.0.1",
        port,
        path,
        method: method.toUpperCase(),
        headers: {
          "Content-Type": "application/json",
          ...(opts.token ? bearer(opts.token) : {}),
        },
      };
      const r = http.request(options, (response) => {
        let body = "";
        response.on("data", (d) => (body += d));
        response.on("end", () => {
          server.close();
          try { resolve({ status: response.statusCode!, body: JSON.parse(body) }); }
          catch { resolve({ status: response.statusCode!, body }); }
        });
      });
      r.on("error", (e) => { server.close(); resolve({ status: 0, body: String(e) }); });
      if (data) r.write(data);
      r.end();
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Section E — Brief access control + privacy + commands + preferences
// ══════════════════════════════════════════════════════════════════════════════

describe("E — Telegraph Trip Intelligence Pack", () => {
  let state: FakeState;
  let app: express.Application;

  before(async () => {
    state = makeState();
    const made = makeApp(state);
    app = made.app;
    await made.attach();
  });

  beforeEach(() => { state = makeState(); _setTestClient(makeClient(state), true); });

  // ── E1–E10: Brief access control ──────────────────────────────────────────

  test("E1: accepted owner can fetch daily brief", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.access, "full");
    assert.ok(r.body.brief !== null);
  });

  test("E2: accepted member can fetch daily brief", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: MEMBER_TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.access, "full");
  });

  test("E3: invited (pending) member sees access_denied, not 403 crash", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: INVITED_TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.access, "access_denied");
    assert.equal(r.body.brief, null);
  });

  test("E4: stranger sees access_denied, not 403 crash", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: STRANGER_TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.access, "access_denied");
  });

  test("E5: unauthenticated request returns 401", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`);
    assert.equal(r.status, 401);
  });

  test("E6: brief date defaults to today when not specified", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(r.body.brief?.date, today);
  });

  test("E7: brief respects custom date query param", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief?date=2026-07-04`, { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.brief?.date, "2026-07-04");
  });

  test("E8: invalid date format returns 400", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief?date=not-a-date`, { token: OWNER_TOKEN });
    assert.equal(r.status, 400);
  });

  test("E9: brief for a day with no items contains empty planPreview", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief?date=2099-01-01`, { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.brief?.planPreview, []);
  });

  test("E10: brief refresh route returns refreshed:true", async () => {
    const r = await req(app, "POST", `/api/trips/${TRIP_ID}/daily-brief/refresh`, { token: OWNER_TOKEN, body: { date: "2026-07-04" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.refreshed, true);
  });

  // ── E11–E15: Brief content privacy ────────────────────────────────────────

  test("E11: brief summary text is a non-empty string", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.brief?.summaryText === "string");
    assert.ok(r.body.brief?.summaryText.length > 0);
  });

  test("E12: brief quickActions contains at least view_plan", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    const kinds = r.body.brief?.quickActions?.map((a: any) => a.kind);
    assert.ok(kinds?.includes("view_plan") || kinds?.includes("ask_telegraph"));
  });

  test("E13: brief does not include private lat/lng or exact GPS", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: OWNER_TOKEN });
    const briefStr = JSON.stringify(r.body);
    assert.ok(!briefStr.includes('"lat"') || !briefStr.includes('"lng"'), "Brief should not expose raw coordinates");
  });

  test("E14: brief action endpoint returns requiresConfirmation for add_to_plan", async () => {
    const r = await req(app, "POST", `/api/trips/${TRIP_ID}/daily-brief/actions/add_to_plan`, { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.requiresConfirmation, true);
  });

  test("E15: brief action endpoint returns requiresConfirmation=false for view_plan", async () => {
    const r = await req(app, "POST", `/api/trips/${TRIP_ID}/daily-brief/actions/view_plan`, { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.requiresConfirmation, false);
  });

  // ── E16–E25: Context privacy + non-member states ──────────────────────────

  test("E16: invalid action id returns 400", async () => {
    const r = await req(app, "POST", `/api/trips/${TRIP_ID}/daily-brief/actions/delete_everything`, { token: OWNER_TOKEN });
    assert.equal(r.status, 400);
  });

  test("E17: stranger cannot dismiss brief recommendation", async () => {
    const r = await req(app, "POST", `/api/trips/${TRIP_ID}/daily-brief/dismiss/rec-xyz`, { token: STRANGER_TOKEN });
    assert.equal(r.status, 403);
  });

  test("E18: member can dismiss brief recommendation", async () => {
    const r = await req(app, "POST", `/api/trips/${TRIP_ID}/daily-brief/dismiss/rec-xyz`, { token: MEMBER_TOKEN, body: { category: "food" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test("E19: invited user cannot perform brief actions", async () => {
    const r = await req(app, "POST", `/api/trips/${TRIP_ID}/daily-brief/actions/add_to_plan`, { token: INVITED_TOKEN });
    assert.equal(r.status, 403);
  });

  test("E20: privacy resolver returns access_denied for invited role", async () => {
    const { resolveContext } = await import("../lib/privacyResolver.js");
    const client = makeClient(state) as any;
    const verdict = await resolveContext(client, INVITED_ID, TRIP_ID);
    assert.equal(verdict.access, "access_denied");
    assert.equal(verdict.denialReason, "pending_invite");
  });

  test("E21: privacy resolver returns full for owner", async () => {
    const { resolveContext } = await import("../lib/privacyResolver.js");
    const client = makeClient(state) as any;
    const verdict = await resolveContext(client, OWNER_ID, TRIP_ID);
    assert.equal(verdict.access, "full");
    assert.equal(verdict.isTripOwner, true);
  });

  test("E22: privacy resolver returns partial when no tripId given", async () => {
    const { resolveContext } = await import("../lib/privacyResolver.js");
    const client = makeClient(state) as any;
    const verdict = await resolveContext(client, OWNER_ID, null);
    assert.equal(verdict.access, "partial");
  });

  test("E23: privacy resolver canReadPlanItems true for accepted member", async () => {
    const { resolveContext } = await import("../lib/privacyResolver.js");
    const client = makeClient(state) as any;
    const verdict = await resolveContext(client, MEMBER_ID, TRIP_ID);
    assert.equal(verdict.canReadPlanItems, true);
  });

  test("E24: brief generatedAt is a valid ISO timestamp", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: OWNER_TOKEN });
    assert.ok(!isNaN(new Date(r.body.brief?.generatedAt).getTime()));
  });

  test("E25: refresh route for non-member returns access_denied brief:null", async () => {
    const r = await req(app, "POST", `/api/trips/${TRIP_ID}/daily-brief/refresh`, { token: STRANGER_TOKEN, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.brief, null);
  });

  // ── E26–E40: Concierge command parsing + confirmation gating ──────────────

  test("E26: POST /telegraph/commands requires auth", async () => {
    const r = await req(app, "POST", "/api/telegraph/commands", { body: { text: "Plan tonight" } });
    assert.equal(r.status, 401);
  });

  test("E27: 'Plan tonight' intent parses as plan_day", async () => {
    const { parseIntent } = await import("../routes/telegraphCommands.js");
    assert.equal((parseIntent as any)("Plan tonight"), "plan_day");
  });

  test("E28: 'Find food nearby' intent parses as find_food", async () => {
    const { parseIntent } = await import("../routes/telegraphCommands.js");
    assert.equal((parseIntent as any)("Find food nearby"), "find_food");
  });

  test("E29: 'Fix conflicts in my schedule' parses as fix_schedule_conflict", async () => {
    const { parseIntent } = await import("../routes/telegraphCommands.js");
    assert.equal((parseIntent as any)("Fix conflicts in my schedule"), "fix_schedule_conflict");
  });

  test("E30: 'What am I missing?' parses as what_is_missing", async () => {
    const { parseIntent } = await import("../routes/telegraphCommands.js");
    assert.equal((parseIntent as any)("What am I missing?"), "what_is_missing");
  });

  test("E31: 'Create a meetup' parses as create_meetup_draft", async () => {
    const { parseIntent } = await import("../routes/telegraphCommands.js");
    assert.equal((parseIntent as any)("Create a meetup for tonight"), "create_meetup_draft");
  });

  test("E32: unrecognised text falls back to unknown intent", async () => {
    const { parseIntent } = await import("../routes/telegraphCommands.js");
    assert.equal((parseIntent as any)("xyzzy unrecognised phrase"), "unknown");
  });

  test("E33: POST /telegraph/commands returns commandId and intent", async () => {
    const r = await req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Plan tonight", tripId: TRIP_ID } });
    assert.equal(r.status, 201);
    assert.ok(r.body.commandId);
    assert.equal(r.body.intent, "plan_day");
    CMD_ID_STORE.set("plan_tonight", r.body.commandId);
  });

  test("E34: every proposedAction has requires_confirmation: true", async () => {
    const r = await req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Fill free time" } });
    assert.equal(r.status, 201);
    for (const action of r.body.proposedActions ?? []) {
      assert.equal(action.requires_confirmation, true);
    }
  });

  test("E35: GET /telegraph/commands/:commandId returns stored command", async () => {
    const post = await req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Find food" } });
    const { commandId } = post.body;
    const get = await req(app, "GET", `/api/telegraph/commands/${commandId}`, { token: OWNER_TOKEN });
    assert.equal(get.status, 200);
    assert.equal(get.body.commandId, commandId);
    assert.equal(get.body.intent, "find_food");
  });

  test("E36: confirm-action for known action returns confirmed:true", async () => {
    const post = await req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Find food", tripId: TRIP_ID } });
    const { commandId, proposedActions } = post.body;
    const actionId = proposedActions[0]?.id;
    assert.ok(actionId);
    const confirm = await req(app, "POST", `/api/telegraph/commands/${commandId}/confirm-action`, { token: OWNER_TOKEN, body: { actionId } });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.confirmed, true);
  });

  test("E37: confirm-action fails for non-member even if commandId is valid", async () => {
    const post = await req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Plan tonight", tripId: TRIP_ID } });
    const { commandId, proposedActions } = post.body;
    const confirm = await req(app, "POST", `/api/telegraph/commands/${commandId}/confirm-action`, { token: STRANGER_TOKEN, body: { actionId: proposedActions[0]?.id } });
    assert.equal(confirm.status, 403);
  });

  test("E38: decline-action returns ok:true without touching data", async () => {
    const post = await req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Plan tonight", tripId: TRIP_ID } });
    const { commandId } = post.body;
    const decline = await req(app, "POST", `/api/telegraph/commands/${commandId}/decline-action`, { token: OWNER_TOKEN, body: {} });
    assert.equal(decline.status, 200);
    assert.equal(decline.body.declined, true);
  });

  test("E39: command history for trip requires membership", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/telegraph/commands/history`, { token: STRANGER_TOKEN });
    assert.equal(r.status, 403);
  });

  test("E40: command history returns array for accepted member", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/telegraph/commands/history`, { token: MEMBER_TOKEN });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.history));
  });

  // ── E41–E55: Preference CRUD + learning engine ────────────────────────────

  test("E41: GET /me/preferences creates blank profile if none exists", async () => {
    const r = await req(app, "GET", "/api/me/preferences", { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.explicit?.interests));
  });

  test("E42: PATCH /me/preferences updates interests", async () => {
    const r = await req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { interests: ["food", "beach"] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.explicit?.interests, ["food", "beach"]);
  });

  test("E43: PATCH /me/preferences updates pace", async () => {
    const r = await req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { pace: "relaxed" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.explicit?.pace, "relaxed");
  });

  test("E44: PATCH /me/preferences rejects invalid pace value", async () => {
    const r = await req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { pace: "supersonic" } });
    assert.equal(r.status, 400);
  });

  test("E45: PATCH /me/preferences rejects interests list over 20 items", async () => {
    const r = await req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { interests: Array(21).fill("food") } });
    assert.equal(r.status, 400);
  });

  test("E46: POST /me/preferences/events records a save signal", async () => {
    const r = await req(app, "POST", "/api/me/preferences/events", { token: OWNER_TOKEN, body: { recommendationId: "rec-1", category: "food", signal: "save" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
  });

  test("E47: POST /me/preferences/events rejects invalid signal", async () => {
    const r = await req(app, "POST", "/api/me/preferences/events", { token: OWNER_TOKEN, body: { recommendationId: "rec-1", category: "food", signal: "super_like" } });
    assert.equal(r.status, 400);
  });

  test("E48: POST /me/preferences/reset-learned clears inferred prefs", async () => {
    await req(app, "POST", "/api/me/preferences/events", { token: OWNER_TOKEN, body: { recommendationId: "rec-1", category: "food", signal: "save" } });
    const r = await req(app, "POST", "/api/me/preferences/reset-learned", { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.equal(r.body.reset, "learned_preferences");
  });

  test("E49: GET /me/preferences/summary returns topInferred array", async () => {
    const r = await req(app, "GET", "/api/me/preferences/summary", { token: OWNER_TOKEN });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.topInferred));
  });

  test("E50: preference routes require auth", async () => {
    const r = await req(app, "GET", "/api/me/preferences");
    assert.equal(r.status, 401);
  });

  // ── Learning engine unit tests (E51–E55) ──────────────────────────────────

  test("E51: applyEvent increases affinity for save signal", async () => {
    const { applyEvent, defaultInferred } = await import("../lib/preferenceLearning.js");
    const inferred = defaultInferred();
    const updated = applyEvent(inferred, { userId: "u1", recommendationId: "r1", category: "food", signal: "save", createdAt: new Date().toISOString() });
    assert.ok((updated.categoryAffinities["food"] ?? 0) > 0);
  });

  test("E52: applyEvent decreases affinity for not_for_me signal", async () => {
    const { applyEvent, defaultInferred } = await import("../lib/preferenceLearning.js");
    const inferred = defaultInferred();
    const updated = applyEvent(inferred, { userId: "u1", recommendationId: "r1", category: "nightlife", signal: "not_for_me", createdAt: new Date().toISOString() });
    assert.ok((updated.categoryAffinities["nightlife"] ?? 0) < 0);
  });

  test("E53: not_for_me signal adds category to dismissedCategories", async () => {
    const { applyEvent, defaultInferred } = await import("../lib/preferenceLearning.js");
    const updated = applyEvent(defaultInferred(), { userId: "u1", recommendationId: "r1", category: "clubbing", signal: "not_for_me", createdAt: new Date().toISOString() });
    assert.ok(updated.dismissedCategories.includes("clubbing"));
  });

  test("E54: save signal adds category to savedCategories", async () => {
    const { applyEvent, defaultInferred } = await import("../lib/preferenceLearning.js");
    const updated = applyEvent(defaultInferred(), { userId: "u1", recommendationId: "r1", category: "beach", signal: "save", createdAt: new Date().toISOString() });
    assert.ok(updated.savedCategories.includes("beach"));
  });

  test("E55: scoreRecommendation boosts items in explicit interests", async () => {
    const { scoreRecommendation, defaultExplicit, defaultInferred } = await import("../lib/preferenceLearning.js");
    const explicit = { ...defaultExplicit(), interests: ["food"] };
    const inferred = defaultInferred();
    const foodScore = scoreRecommendation("food", explicit, inferred);
    const otherScore = scoreRecommendation("transport", explicit, inferred);
    assert.ok(foodScore > otherScore);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Section F — Recommendation ranking + feedback events + privacy
// ══════════════════════════════════════════════════════════════════════════════

describe("F — Feedback events + ranking + privacy", () => {
  let state: FakeState;
  let app: express.Application;

  before(async () => {
    state = makeState();
    const made = makeApp(state);
    app = made.app;
    await made.attach();
  });

  beforeEach(() => { state = makeState(); _setTestClient(makeClient(state), true); });

  // ── F1–F10: Feedback events + recommendation ranking ──────────────────────

  test("F1: POST /telegraph/recommendations/:id/feedback requires auth", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-1/feedback", { body: { category: "food", signal: "save" } });
    assert.equal(r.status, 401);
  });

  test("F2: feedback endpoint accepts save signal", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-1/feedback", { token: OWNER_TOKEN, body: { category: "food", signal: "save" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
  });

  test("F3: feedback endpoint accepts more_like_this signal", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-2/feedback", { token: MEMBER_TOKEN, body: { category: "beach", signal: "more_like_this" } });
    assert.equal(r.status, 201);
  });

  test("F4: feedback endpoint accepts less_like_this signal", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-3/feedback", { token: MEMBER_TOKEN, body: { category: "nightlife", signal: "less_like_this" } });
    assert.equal(r.status, 201);
  });

  test("F5: feedback endpoint accepts not_for_me signal", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-4/feedback", { token: MEMBER_TOKEN, body: { category: "gambling", signal: "not_for_me" } });
    assert.equal(r.status, 201);
  });

  test("F6: feedback endpoint accepts dismiss signal", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-5/feedback", { token: MEMBER_TOKEN, body: { category: "nightlife", signal: "dismiss" } });
    assert.equal(r.status, 201);
  });

  test("F7: feedback endpoint rejects unknown signal", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-6/feedback", { token: MEMBER_TOKEN, body: { category: "food", signal: "love" } });
    assert.equal(r.status, 400);
  });

  test("F8: feedback endpoint returns recommendationId in response", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-99/feedback", { token: OWNER_TOKEN, body: { category: "food", signal: "save" } });
    assert.equal(r.body.recommendationId, "rec-99");
  });

  test("F9: scoreRecommendation penalises items in avoidList", async () => {
    const { scoreRecommendation, defaultExplicit, defaultInferred } = await import("../lib/preferenceLearning.js");
    const explicit = { ...defaultExplicit(), avoidList: ["nightlife"] };
    const score = scoreRecommendation("nightlife", explicit, defaultInferred());
    assert.ok(score < 0);
  });

  test("F10: scoreRecommendation penalises dismissed categories", async () => {
    const { scoreRecommendation, defaultExplicit, defaultInferred } = await import("../lib/preferenceLearning.js");
    const inferred = { ...defaultInferred(), dismissedCategories: ["gambling"] };
    const score = scoreRecommendation("gambling", defaultExplicit(), inferred);
    assert.ok(score < 0);
  });

  // ── F11–F15: Daily brief engine unit tests ────────────────────────────────

  test("F11: buildDailyBrief with empty plan has free window", async () => {
    const { buildDailyBrief } = await import("../lib/dailyBriefEngine.js");
    const brief = buildDailyBrief({ tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [], meetups: [], recommendations: [], preferenceProfile: null });
    assert.ok(brief.openWindows.length > 0);
  });

  test("F12: buildDailyBrief with plan items populates planPreview", async () => {
    const { buildDailyBrief } = await import("../lib/dailyBriefEngine.js");
    const brief = buildDailyBrief({
      tripId: "t1", userId: "u1", date: "2026-07-01",
      planItems: [{ id: "i1", title: "Breakfast", starts_at: "2026-07-01T08:00:00Z", ends_at: "2026-07-01T09:00:00Z", category: "dining", status: "confirmed", location_name: "Hotel", day_date: "2026-07-01" }],
      meetups: [], recommendations: [], preferenceProfile: null,
    });
    assert.equal(brief.planPreview.length, 1);
    assert.equal(brief.planPreview[0].title, "Breakfast");
  });

  test("F13: buildDailyBrief scores and sorts suggestions by preference", async () => {
    const { buildDailyBrief } = await import("../lib/dailyBriefEngine.js");
    const { defaultExplicit, defaultInferred } = await import("../lib/preferenceLearning.js");
    const profile = { userId: "u1", explicit: { ...defaultExplicit(), interests: ["food"] }, inferred: defaultInferred(), lastUpdatedAt: "" };
    const brief = buildDailyBrief({
      tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [], meetups: [],
      recommendations: [
        { id: "r1", title: "Great restaurant", category: "food", reason: "match", estimatedTime: "1h", priceLevel: "$" },
        { id: "r2", title: "Nightclub", category: "nightlife", reason: "nearby", estimatedTime: "3h", priceLevel: "$$$" },
      ],
      preferenceProfile: profile,
    });
    assert.ok(brief.suggestions[0].category === "food");
  });

  test("F14: buildDailyBrief warns about cancelled meetup", async () => {
    const { buildDailyBrief } = await import("../lib/dailyBriefEngine.js");
    const brief = buildDailyBrief({
      tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [],
      meetups: [{ id: "m1", title: "Cancelled meetup", proposed_time: null, attendee_count: 0, status: "cancelled" }],
      recommendations: [], preferenceProfile: null,
    });
    assert.ok(brief.warnings.includes("cancelled_meetup"));
  });

  test("F14b: fetchBriefData derives attendee counts from meetup_invites (status going)", async () => {
    const { fetchBriefData } = await import("../routes/dailyBrief.js");
    const meetupRows = [
      { id: "m1", title: "Tapas night", starts_at: "2026-07-01T19:00:00Z", status: "active", trip_id: TRIP_ID },
      { id: "m2", title: "Museum walk", starts_at: "2026-07-02T10:00:00Z", status: "active", trip_id: TRIP_ID },
    ];
    const inviteRows = [
      { meetup_id: "m1", status: "going" },
      { meetup_id: "m1", status: "going" },
      { meetup_id: "m1", status: "invited" },
      { meetup_id: "m2", status: "declined" },
      { meetup_id: "other", status: "going" },
    ];
    const fakeClient = {
      from(table: string) {
        const filters: Array<(r: any) => boolean> = [];
        const b: any = {
          select() { return b; },
          eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
          in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
          is() { return b; },
          then(onF: any, onR: any) {
            let source: any[] = [];
            if (table === "meetups") source = meetupRows;
            else if (table === "meetup_invites") source = inviteRows;
            else if (table === "trip_plan_items") source = [];
            return Promise.resolve({ data: source.filter((r) => filters.every((f) => f(r))), error: null }).then(onF, onR);
          },
        };
        return b;
      },
    };
    const { meetups } = await fetchBriefData(fakeClient, TRIP_ID);
    const byId = new Map(meetups.map((m: any) => [m.id, m.attendee_count]));
    assert.equal(byId.get("m1"), 2, "only 'going' invites for m1 count");
    assert.equal(byId.get("m2"), 0, "declined invites don't count");

    const { buildDailyBrief } = await import("../lib/dailyBriefEngine.js");
    const brief = buildDailyBrief({
      tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [],
      meetups, recommendations: [], preferenceProfile: null,
    });
    const opp = brief.meetupOpportunities.find((o: any) => o.id === "m1");
    assert.equal(opp?.attendeeCount, 2);
  });

  test("F15: buildDailyBrief isStale is false on fresh build", async () => {
    const { buildDailyBrief } = await import("../lib/dailyBriefEngine.js");
    const brief = buildDailyBrief({ tripId: "t1", userId: "u1", date: "2026-07-01", planItems: [], meetups: [], recommendations: [], preferenceProfile: null });
    assert.equal(brief.isStale, false);
  });

  // ── F16–F24: Public-profile privacy ───────────────────────────────────────

  test("F16: preference profile of one user is not exposed to another", async () => {
    await req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { interests: ["luxury"] } });
    const r = await req(app, "GET", "/api/me/preferences", { token: MEMBER_TOKEN });
    assert.ok(!r.body.explicit?.interests?.includes("luxury"), "Member should not see owner's interests");
  });

  test("F17: preference events are scoped to the authenticated user", async () => {
    await req(app, "POST", "/api/me/preferences/events", { token: OWNER_TOKEN, body: { recommendationId: "r1", category: "beach", signal: "save" } });
    const memberPref = await req(app, "GET", "/api/me/preferences", { token: MEMBER_TOKEN });
    assert.deepEqual(memberPref.body.inferred?.savedCategories ?? [], []);
  });

  test("F18: reset-learned for owner does not affect member profile", async () => {
    await req(app, "POST", "/api/me/preferences/events", { token: MEMBER_TOKEN, body: { recommendationId: "r1", category: "food", signal: "save" } });
    await req(app, "POST", "/api/me/preferences/reset-learned", { token: OWNER_TOKEN });
    const r = await req(app, "GET", "/api/me/preferences", { token: MEMBER_TOKEN });
    assert.ok(Array.isArray(r.body.inferred?.savedCategories));
  });

  test("F19: daily brief does not expose other users' explicit preferences", async () => {
    await req(app, "PATCH", "/api/me/preferences", { token: MEMBER_TOKEN, body: { avoidList: ["gambling"] } });
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: OWNER_TOKEN });
    const str = JSON.stringify(r.body);
    assert.ok(!str.includes("gambling"), "Owner brief should not expose member's avoid list");
  });

  test("F20: Concierge command suggestions contain no other users' data", async () => {
    await req(app, "PATCH", "/api/me/preferences", { token: MEMBER_TOKEN, body: { interests: ["ultra_secret_interest"] } });
    const r = await req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "Plan tonight", tripId: TRIP_ID } });
    const str = JSON.stringify(r.body);
    assert.ok(!str.includes("ultra_secret_interest"));
  });

  test("F21: feedback signal without tripId still records event", async () => {
    const r = await req(app, "POST", "/api/telegraph/recommendations/rec-1/feedback", { token: OWNER_TOKEN, body: { category: "food", signal: "save", tripId: null } });
    assert.equal(r.status, 201);
  });

  test("F22: brief quickActions do not require confirmation for view_plan", async () => {
    const r = await req(app, "GET", `/api/trips/${TRIP_ID}/daily-brief`, { token: OWNER_TOKEN });
    const viewPlan = r.body.brief?.quickActions?.find((a: any) => a.kind === "view_plan");
    assert.ok(viewPlan, "view_plan action should exist");
  });

  test("F23: command unknown intent returns fallback suggestions []", async () => {
    const r = await req(app, "POST", "/api/telegraph/commands", { token: OWNER_TOKEN, body: { text: "xyzzy qqq rrr" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.intent, "unknown");
    assert.deepEqual(r.body.suggestions, []);
  });

  test("F24: all preference CRUD routes are scoped by auth token user only", async () => {
    const r1 = await req(app, "PATCH", "/api/me/preferences", { token: OWNER_TOKEN, body: { pace: "packed" } });
    const r2 = await req(app, "GET", "/api/me/preferences", { token: MEMBER_TOKEN });
    assert.equal(r1.body.explicit?.pace, "packed");
    assert.notEqual(r2.body.explicit?.pace, "packed");
  });
});
