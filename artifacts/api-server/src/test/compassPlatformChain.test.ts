/**
 * census-compass CCL-05 / CCL-06 / CX-10 / CX-11 — `/compass/ask` consumes the
 * shared platform layer.
 *
 * `docs/specs/upgrades-v2/01-COMPASS-v2.md:13`: authorized request → EXISTING
 * context assembly → shared world/experience/forecast/opportunity projections
 * → EXISTING decision/ranking owner → grounded explanation. Before this suite
 * every stage existed as an object and the chain did not: `/compass/ask`
 * imported one symbol from Home (a time-of-day helper, on the cache key),
 * `compass/` imported lib/contextKernel from nowhere, and nothing under
 * `compass/` was downstream of lib/opportunityEngine.
 *
 * Each block is proven by a value that can ONLY come from the shared module:
 *   CCL-06  a canary event title Home's projection read (`events`), under the
 *           projection header, and "could not be read" when that read fails;
 *   CX-10   the kernel's day part for the offset the request declared, and
 *           the kernel's own unknown-context list;
 *   CX-11   the engine's `go_now` kind for a place the feed named, only with
 *           `opportunity_engine_enabled` ON — and NO world value on the prompt;
 *   CCL-05  all three under one model turn, after the existing ranker's line.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 the Home projection block removed from /ask            → red
 *   M2 an unavailable Home source rendered as absent           → red
 *   M3 the kernel block removed from /ask                      → red
 *   M4 the opportunity block ignores the flag                  → red
 *   M5 refusals dropped from the opportunity block             → red
 *   (the world-value guard mirrors routes/opportunities.ts and is NOT
 *   mutation-detectable here: nothing the engine emits carries a world value,
 *   so removing the guard changes no output. It is defence in depth, stated.)
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassPlatformChain.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { _clearCompassHomeCache } from "../routes/compassHome.js";
import { dayPartOf, localHourFrom } from "../lib/contextKernel.js";
import { FORBIDDEN_WORLD_VALUE_KEYS } from "../lib/opportunityEngine.js";
import { HOME_PROJECTION_HEADER, KERNEL_HEADER, OPPORTUNITY_HEADER } from "../compass/CompassPlatformContext.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ALICE = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const CONV_ID = "cccc0000-cccc-4ccc-8ccc-000000000001";
const PLACE_ID = "88888888-bbbb-4bbb-8bbb-888888888888";
const CANARY = "CCL06-PROJECTION-CANARY";
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

function snapshot(subject: string) {
  return {
    id: `snap-${subject.slice(0, 8)}`,
    subject_id: subject, zone_id: null, claim_type: "crowd.level", value: { level: "busy" },
    confidence: 0.85, source_count: 30, observed_at: iso(-3), expires_at: iso(27),
    privacy_eligible: true, conflict_state: "none", source_class: "firsthand_unverified", computed_at: iso(-3),
  };
}

interface FakeState {
  opportunityFlag?: boolean;
  /** Tables whose from() throws (error-path testing). */
  throwTables?: string[];
  /** Tables whose reads resolve with an error (a failed read, not a thrown one). */
  errorTables?: string[];
  withPlace?: boolean;
  /** Omit the Live gate flag rows, closing the world read (readable: false). */
  liveGatesOpen?: boolean;
  /** Seed no live snapshot for the place (no evidence, a refusal not a silence). */
  withSnapshots?: boolean;
}

function makeClient(state: FakeState = {}) {
  const db: Record<string, any[]> = {
    feature_flags: [
      { flag: "COMPASS_ENABLED", enabled: true },
      ...(state.liveGatesOpen === false ? [] : LIVE_GATES_OPEN),
      ...(state.opportunityFlag === undefined ? [] : [{ flag: "opportunity_engine_enabled", enabled: state.opportunityFlag }]),
    ],
    compass_conversations: [],
    compass_conversation_messages: [],
    compass_user_preferences: [],
    user_hashtag_follows: [],
    profiles: [{ id: ALICE, current_city: "Da Nang", display_name: "Alice" }],
    // The profile's currentCity comes from here (CompassProfileService); it is
    // what the hydrator's place read and Home's event read filter on.
    user_location_state: [{ user_id: ALICE, city: "Da Nang", country: "VN" }],
    trips: [], trip_members: [], trip_plan_items: [], blocks: [], user_follows: [],
    events: [{
      id: "ev-1", title: CANARY, city: "Da Nang", country: "VN", starts_at: iso(180), category: "music",
      host_id: "host-1", state: "open", visibility: "public",
    }],
    discovery_places: state.withPlace === false ? [] : [{
      id: PLACE_ID, city: "Da Nang", name: "Han Market", category: "market", status: "active", rating: 4.5,
      created_at: iso(-10_000), submitted_by: null, latitude: 16.0678, longitude: 108.2208,
    }],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }],
    intel_state_snapshots: state.withPlace === false || state.withSnapshots === false ? [] : [snapshot(PLACE_ID)],
    notifications: [],
    notification_preferences: [],
  };
  const throwTables = new Set(state.throwTables ?? []);
  const errorTables = new Set(state.errorTables ?? []);

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];
    let insertPayload: any = null;
    const failed = errorTables.has(table);
    const b: any = {
      select: (_c?: string) => b,
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      is: (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      ilike: (col: string, pat: string) => {
        const re = new RegExp("^" + pat.replace(/%/g, ".*") + "$", "i");
        filtered = filtered.filter((r) => re.test(String(r[col] ?? "")));
        return b;
      },
      like: () => b, or: () => b, not: () => b, gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      contains: () => b, limit: () => b, order: () => b,
      maybeSingle: () => Promise.resolve(failed ? { data: null, error: { message: `${table} unreadable` } } : { data: filtered[0] ?? null, error: null }),
      single: () => {
        if (insertPayload !== null) {
          const row = { id: CONV_ID, ...(insertPayload as object), created_at: new Date().toISOString(), last_active_at: new Date().toISOString() };
          db[table] = db[table] ?? []; db[table].push(row);
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then: (res: any) => res(failed ? { data: null, error: { message: `${table} unreadable` }, count: null } : { data: filtered, error: null, count: filtered.length }),
      update: () => b,
    };
    b.insert = (payload: any) => {
      insertPayload = payload;
      const row = { id: `row_${Math.random()}`, ...((Array.isArray(payload) ? payload[0] : payload) as object), created_at: new Date().toISOString() };
      db[table] = db[table] ?? []; db[table].push(row);
      return { ...b, select: () => ({ ...b, single: () => Promise.resolve({ data: row, error: null }) }) };
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (throwTables.has(table)) throw new Error(`fake client: ${table} unavailable`);
      return builder(table, db[table] ?? []);
    },
    auth: {
      getUser: async (token: string) =>
        token === "test-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "not authed" } },
    },
  } as any;
}

interface Capture { mainMessages: any[] | null }
function capturingOpenAI(capture: Capture) {
  return {
    chat: { completions: { create: async (opts: any) => {
      if (opts.max_completion_tokens === 256) return { choices: [{ message: { content: JSON.stringify({ intent: "conversation", confidence: 0.9 }), role: "assistant" } }] };
      capture.mainMessages = opts.messages;
      return { choices: [{ message: { content: JSON.stringify({ message: "ok", payload: null, quickActions: [] }), role: "assistant" } }] };
    } } },
  };
}
const joined = (m: any[] | null) => (m ?? []).map((x: any) => String(x.content ?? "")).join("\n");

let app: Express; let server: Server; let port: number;
before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, error() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as any).port;
});
after(() => { server.close(); _setTestClient(null as any, false); _setTestOpenAI(null); });
beforeEach(() => { invalidateFlagsCache(); _clearPromotedScopeCache(); _clearCompassHomeCache(); });
afterEach(() => _setTestOpenAI(null));

async function askWith(state: FakeState, body: Record<string, unknown> = {}): Promise<string> {
  _setTestClient(makeClient(state), true);
  const capture: Capture = { mainMessages: null };
  _setTestOpenAI(capturingOpenAI(capture) as any);
  const r = await fetch(`http://127.0.0.1:${port}/api/compass/ask`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({ prompt: "what should I do right now?", ...body }),
  });
  assert.equal(r.status, 200);
  assert.ok(capture.mainMessages, "the model was not called");
  return joined(capture.mainMessages);
}

describe("CCL-06 — Compass consumes Home's server-built projection", () => {
  it("the projection header and a value only Home's `events` read could have produced reach the model", async () => {
    const ctx = await askWith({});
    assert.ok(ctx.includes(HOME_PROJECTION_HEADER), ctx);
    assert.ok(ctx.includes(CANARY), "Home's server-built projection must reach the /ask model context");
    assert.match(ctx, /Time of day: (morning|afternoon|evening|night); context: /);
  });

  it("a source Home could not read is SAID to be unreadable, never left out", async () => {
    const ctx = await askWith({ errorTables: ["events"] });
    assert.ok(ctx.includes(HOME_PROJECTION_HEADER));
    assert.ok(!ctx.includes(CANARY));
    assert.ok(ctx.includes("Starting soon: could not be read"), ctx);
  });

  it("routes/compass.ts imports the ONE builder Home's route uses (no second implementation)", () => {
    const route = strip(readFileSync(join(SRC, "routes", "compass.ts"), "utf8"));
    assert.match(route, /import \{ buildCompassHomeProjection \} from "\.\/compassHome\.js"/);
    assert.match(route, /buildCompassHomeProjection\(sc, user\.id/);
    const home = strip(readFileSync(join(SRC, "routes", "compassHome.ts"), "utf8"));
    assert.match(home, /const projection = await buildCompassHomeProjection\(sc, user\.id/);
  });
});

describe("CX-10 — Compass consumes lib/contextKernel", () => {
  it("the kernel's day part for the offset THIS request declared, and its own unknown-context list, reach the model", async () => {
    const offset = 540;
    const ctx = await askWith({}, { tzOffsetMinutes: offset });
    assert.ok(ctx.includes(KERNEL_HEADER), ctx);
    const expected = dayPartOf(localHourFrom(Date.now(), offset));
    assert.ok(ctx.includes(`Day part: ${expected};`), `expected day part ${expected} in:\n${ctx}`);
    assert.ok(ctx.includes("unknown contexts: trip, social, experience"), ctx);
  });

  it("the place the existing ranker named is a kernel subject with the live layer's reading", async () => {
    const ctx = await askWith({});
    assert.ok(ctx.includes(`Subject ${PLACE_ID}: crowd busy;`), ctx);
    assert.ok(ctx.includes("live intelligence readable: yes"));
  });

  it("with the Live gates closed the world is reported as unreadable, not empty", async () => {
    const ctx = await askWith({ liveGatesOpen: false });
    assert.ok(ctx.includes("live intelligence readable: no"), ctx);
    assert.ok(ctx.includes(`Subject ${PLACE_ID}: crowd: could not look;`), ctx);
  });

  it("CX-02: a declared §8 intent mode reaches the kernel as the shared crowd preference, and an off-vocabulary one is no mode", async () => {
    const quiet = await askWith({}, { intentMode: "Quiet " });
    assert.ok(quiet.includes("Intent mode: Quiet (crowd preference: quiet)"), quiet);
    const tonight = await askWith({}, { intentMode: "tonight" });
    assert.ok(tonight.includes("Intent mode: Tonight (crowd preference: none)"), tonight);
    const off = await askWith({}, { intentMode: "dinner" });
    assert.ok(!off.includes("Intent mode:"), off);
  });

  it("CX-02 on shared intelligence: with the opportunity engine ON, a QUIET intent turns the busy place's GO NOW into a refusal — the same engine, one declared preference", async () => {
    const social = await askWith({ opportunityFlag: true }, { intentMode: "social" });
    assert.ok(social.includes(`go_now \u2014 subject ${PLACE_ID}`), social);
    const quiet = await askWith({ opportunityFlag: true }, { intentMode: "quiet" });
    assert.ok(!quiet.includes(`go_now \u2014 subject ${PLACE_ID}`), quiet);
    assert.match(quiet, new RegExp(`Refused ${PLACE_ID}: no_opportunity \\(SKIP\\)`));
  });

  it("compass/ imports lib/contextKernel (the import the row said existed nowhere)", () => {
    const mod = strip(readFileSync(join(SRC, "compass", "CompassPlatformContext.ts"), "utf8"));
    assert.match(mod, /from "\.\.\/lib\/contextKernel\.js"/);
    assert.match(mod, /assembleContextKernel\(/);
    const route = strip(readFileSync(join(SRC, "routes", "compass.ts"), "utf8"));
    assert.match(route, /assembleAskKernel\(sc, user\.id, topPlaceIds/);
  });
});

describe("CX-11 — Compass is downstream of lib/opportunityEngine, behind its pilot flag", () => {
  it("flag ABSENT (production's state): no opportunity block, and /ask is otherwise unchanged", async () => {
    const ctx = await askWith({});
    assert.ok(!ctx.includes(OPPORTUNITY_HEADER), ctx);
  });

  it("flag OFF: the same", async () => {
    const ctx = await askWith({ opportunityFlag: false });
    assert.ok(!ctx.includes(OPPORTUNITY_HEADER));
  });

  it("flag ON: the engine's `go_now` for the ranker's place, in the engine's own vocabulary — and no world value on the prompt", async () => {
    const ctx = await askWith({ opportunityFlag: true });
    assert.ok(ctx.includes(OPPORTUNITY_HEADER), ctx);
    assert.ok(ctx.includes(`go_now — subject ${PLACE_ID}`), ctx);
    assert.match(ctx, /decision GO_NOW \(/);
    const block = ctx.slice(ctx.indexOf(OPPORTUNITY_HEADER));
    for (const key of FORBIDDEN_WORLD_VALUE_KEYS) {
      assert.ok(!new RegExp(`\\b${key}\\b`).test(block), `world value "${key}" reached the prompt through the opportunity block`);
    }
  });

  it("flag ON, no live evidence for the place: the refusal is carried, not rendered as nothing happening", async () => {
    const ctx = await askWith({ opportunityFlag: true, withSnapshots: false });
    assert.ok(ctx.includes(OPPORTUNITY_HEADER), ctx);
    assert.match(ctx, new RegExp(`Refused ${PLACE_ID}: (no_opportunity|live_intelligence_unavailable)`));
  });

  it("the flag is read by its literal name (check-flag-polarity) in the route", () => {
    const route = strip(readFileSync(join(SRC, "routes", "compass.ts"), "utf8"));
    assert.match(route, /isPlatformFlagEnabled\(sc, "opportunity_engine_enabled"\)/);
  });
});

describe("CCL-05 — the chain, under one model turn", () => {
  it("authorized request → Home context → shared kernel → shared opportunities → the existing ranker's line, in one context", async () => {
    const ctx = await askWith({ opportunityFlag: true });
    const iRanker = ctx.indexOf("Verified nearby places");
    const iHome = ctx.indexOf(HOME_PROJECTION_HEADER);
    const iKernel = ctx.indexOf(KERNEL_HEADER);
    const iOpp = ctx.indexOf(OPPORTUNITY_HEADER);
    assert.ok(iRanker >= 0, "existing decision/ranking owner missing");
    assert.ok(iHome > iRanker && iKernel > iHome && iOpp > iKernel, `order: ranker ${iRanker}, home ${iHome}, kernel ${iKernel}, opp ${iOpp}`);
    // One turn: every block sits inside the single user message the model receives.
    const userMessages = (await (async () => { _setTestClient(makeClient({ opportunityFlag: true }), true); const c: Capture = { mainMessages: null }; _setTestOpenAI(capturingOpenAI(c) as any); await fetch(`http://127.0.0.1:${port}/api/compass/ask`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" }, body: JSON.stringify({ prompt: "hi" }) }); return c.mainMessages ?? []; })()).filter((m: any) => m.role === "user");
    assert.equal(userMessages.length, 1);
    for (const h of [HOME_PROJECTION_HEADER, KERNEL_HEADER, OPPORTUNITY_HEADER]) assert.ok(String(userMessages[0].content).includes(h), h);
  });
});
