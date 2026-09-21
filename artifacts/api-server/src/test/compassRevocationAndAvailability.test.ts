/**
 * compassRevocationAndAvailability — the three ungated, production-path defects
 * census-compass §13 found against Compass's own roadmap and the v2 upgrade,
 * each pinned by the sentence its census row makes false.
 *
 *   A. CPH-12 / CPV2-07 — Phase 12's *"ends cleanly"*. `runLiveCheck` read the
 *      session ONCE and then performed a rolling-context rebuild, a full Sense
 *      evaluation, a settings read and a dedupe read per candidate before
 *      delivering. A traveller who pressed Stop during that window was still
 *      notified, and the tick then wrote fresh context back onto the row it had
 *      just ended — the update filtered on `id` and `user_id` with no
 *      `status = 'active'` predicate. Both halves are pinned here, in both
 *      directions: the stop suppresses, and an UNSTOPPED session still delivers
 *      (without that control the suppression case passes vacuously).
 *
 *   B. CPH-11 / CPV2-06 — Phase 11's *"permissions honored"*. Same race in
 *      `runSense`: the permission snapshot is read once at the top and every
 *      gate in the delivery loop consults it, so a presence switch to `passive`
 *      or a category turned off mid-run lost the race with its own send.
 *
 *   C. CX-06 / CPV2-05 — *"partial source outage preserves unaffected content
 *      with accurate availability"*. Every Compass Home section failure
 *      collapsed to the value a genuine empty result produces, so "nobody is
 *      around" and "presence is down" were the same bytes. The cases pin BOTH
 *      readings — an unreadable source reports `unavailable`, an authorized
 *      empty one reports `ok` — because a flag that says "unavailable" whenever
 *      a section is null would be no more honest than the null was.
 *
 * Every assertion here was watched fail before the fix; the mutations that
 * proved it are recorded in census-compass §13.7.
 *
 * Runtime: node:test + node:assert. No real DB, no network.
 * Run: node --import tsx/esm --test src/test/compassRevocationAndAvailability.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";

import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { runLiveCheck } from "../compass/CompassLiveEngine.js";
import { runSense } from "../compass/CompassSenseEngine.js";
import compassHomeRouter, {
  HOME_SECTIONS,
  _clearCompassHomeCache,
  _setTestHourUtc,
} from "../routes/compassHome.js";

const USER_ID = "00000000-0000-0000-0000-000000000001";

type Row = Record<string, unknown>;

/* ── Fake Supabase client ─────────────────────────────────────────────────────
 * Chainable, with real eq/neq/in/gte/lte/gt filtering and mutating
 * insert/upsert/update — the same shape compass-live.test.ts uses, plus two
 * hooks this file needs and that one does not:
 *
 *   onRead(table)  fires on every terminal read of `table`. It is how a
 *                  revocation is made to land MID-RUN deterministically: the
 *                  hook mutates the store while the engine is between awaits,
 *                  which is exactly what a traveller pressing Stop does.
 *   failTables     makes a table's reads resolve `{ data: null, error }`,
 *                  modelling a dependency outage rather than an empty table.
 */
let idCounter = 0;

function makeFakeClient(
  store: Record<string, Row[]> = {},
  opts: { onRead?: (table: string) => void; failTables?: Set<string> } = {},
) {
  const failTables = opts.failTables ?? new Set<string>();

  function tbl(name: string): Row[] {
    if (!store[name]) store[name] = [];
    return store[name]!;
  }

  function builder(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _limit: number | null = null;
    let _lastWritten: Row[] | null = null;
    let _pendingUpdate: Row | null = null;

    function rows(): Row[] {
      let out = tbl(tableName).filter((r) => filters.every((f) => f(r)));
      if (_limit !== null) out = out.slice(0, _limit);
      return out;
    }
    function applyPendingUpdate(): void {
      if (!_pendingUpdate) return;
      for (const r of tbl(tableName)) {
        if (filters.every((f) => f(r))) Object.assign(r, _pendingUpdate);
      }
      _lastWritten = null;
      _pendingUpdate = null;
    }
    function settle(): { data: Row[] | null; error: unknown } {
      applyPendingUpdate();
      if (_lastWritten === null) opts.onRead?.(tableName);
      if (failTables.has(tableName) && _lastWritten === null) {
        return { data: null, error: { message: `${tableName} unavailable` } };
      }
      return { data: _lastWritten ?? rows(), error: null };
    }

    const passthrough = new Set([
      "select", "order", "or", "like", "ilike", "not", "is",
      "contains", "overlaps", "range", "textSearch", "filter", "match",
    ]);

    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (resolve: Function) => resolve(settle());
        }
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            const r = settle();
            const first = (r.data ?? [])[0] ?? null;
            return Promise.resolve({
              data: first,
              error: r.error ?? (first ? null : prop === "single" ? { code: "PGRST116" } : null),
            });
          };
        }
        if (prop === "limit") return (n: number) => { _limit = n; return b; };
        if (prop === "eq")  return (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; };
        if (prop === "neq") return (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; };
        if (prop === "in")  return (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; };
        if (prop === "gte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") >= String(v)); return b; };
        if (prop === "lte") return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") <= String(v)); return b; };
        if (prop === "gt")  return (k: string, v: any) => { filters.push((r) => String(r[k] ?? "") > String(v)); return b; };
        if (prop === "insert") {
          return (payload: Row | Row[]) => {
            const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
              id: `gen-${++idCounter}`, created_at: new Date().toISOString(), ...r,
            }));
            tbl(tableName).push(...arr);
            _lastWritten = arr;
            return b;
          };
        }
        if (prop === "upsert") {
          return (payload: Row | Row[], o?: { onConflict?: string }) => {
            const key = o?.onConflict ?? "id";
            const arr = Array.isArray(payload) ? payload : [payload];
            for (const r of arr) {
              const existing = tbl(tableName).find((e) => e[key] === r[key]);
              if (existing) Object.assign(existing, r);
              else tbl(tableName).push({ ...r });
            }
            _lastWritten = arr;
            return b;
          };
        }
        if (prop === "update") return (payload: Row) => { _pendingUpdate = { ...payload }; return b; };
        if (prop === "delete") return () => b;
        if (passthrough.has(prop)) return () => b;
        return () => b;
      },
    });
    return b;
  }

  return {
    fakeClient: {
      from: (name: string) => builder(name),
      auth: {
        getUser: (token: string) =>
          token === "valid-token"
            ? Promise.resolve({ data: { user: { id: USER_ID } }, error: null })
            : Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
      },
    } as any,
    store,
  };
}

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const TODAY = new Date().toISOString().slice(0, 10);
const BASE_MS = new Date(`${TODAY}T08:00:00.000Z`).getTime();

function atHour(h: number, m = 0): string {
  return new Date(BASE_MS + ((h - 8) * 60 + m) * 60_000).toISOString();
}

/** A trip in progress with one plan item 15 min out — a `live_next_up` candidate. */
function seedLiveWorld(store: Record<string, Row[]>, sessionStatus = "active"): void {
  store.feature_flags = [{ flag: "COMPASS_ENABLED", enabled: true }];
  store.trips = [{ id: "trip-1", owner_id: USER_ID, destination_city: "Cebu City", status: "active" }];
  store.trip_members = [];
  store.weather_cache = [{
    destination: "cebu city",
    date_key: `${TODAY}:${TODAY}`,
    fetched_at: new Date().toISOString(),
    brief_summary: "seeded",
    forecasts_json: [{ date: TODAY, weatherCode: 45, summary: "Foggy", maxTempC: 30, minTempC: 24, precipMm: 1 }],
  }];
  store.trip_plan_items = [{
    id: "item-1", trip_id: "trip-1", title: "Gallery walk",
    starts_at: atHour(8, 15), status: "planned", day_date: TODAY, removed_at: null,
  }];
  store.compass_live_sessions = [{
    id: "sess-1", user_id: USER_ID, status: sessionStatus,
    started_at: atHour(7), ended_at: null,
    context: { recentEvents: [] }, checks_run: 0, nudges_delivered: 0,
    last_check_at: null, summary: null,
  }];
  store.compass_sense_nudges = [];
  store.notifications = [];
}

/* ── A. Live: stop during an in-flight tick ───────────────────────────────── */

describe("A. CPH-12 / CPV2-07 — a live session stopped mid-tick discloses nothing further", () => {
  it("CONTROL: an unstopped session still delivers its nudge", async () => {
    const { fakeClient, store } = makeFakeClient({});
    seedLiveWorld(store);
    const r = await runLiveCheck(fakeClient, USER_ID, { nowMs: BASE_MS, hourUtc: 8 });

    assert.equal(r.active, true);
    assert.ok(
      r.delivered.length >= 1,
      "control must deliver, or the suppression case below proves nothing",
    );
    assert.ok((store.notifications ?? []).length >= 1, "control must write a notification");
  });

  it("stop during the tick suppresses every remaining nudge with reason session_ended", async () => {
    // The stop lands on the first dedupe read — i.e. inside the delivery loop,
    // after the tick has already read the session and built its candidates.
    // That is precisely the window the defect lived in.
    let stopped = false;
    const store: Record<string, Row[]> = {};
    const { fakeClient } = makeFakeClient(store, {
      onRead: (table) => {
        if (table === "compass_sense_nudges" && !stopped) {
          stopped = true;
          const s = store.compass_live_sessions![0]!;
          s.status = "ended";
          s.ended_at = new Date(BASE_MS).toISOString();
        }
      },
    });
    seedLiveWorld(store);

    const r = await runLiveCheck(fakeClient, USER_ID, { nowMs: BASE_MS, hourUtc: 8 });

    assert.equal(stopped, true, "the fixture must actually have stopped the session mid-tick");
    assert.deepEqual(r.delivered, [], "a stopped session must deliver nothing");
    assert.ok(
      r.suppressed.some((s) => s.reason === "session_ended"),
      `expected a session_ended suppression, got ${JSON.stringify(r.suppressed)}`,
    );
    assert.equal(
      (store.notifications ?? []).length, 0,
      "no notification may be created for a session the traveller closed",
    );
  });

  it("the tick does not write context back onto the session it just ended", async () => {
    let stopped = false;
    const store: Record<string, Row[]> = {};
    const { fakeClient } = makeFakeClient(store, {
      onRead: (table) => {
        if (table === "compass_sense_nudges" && !stopped) {
          stopped = true;
          store.compass_live_sessions![0]!.status = "ended";
        }
      },
    });
    seedLiveWorld(store);

    await runLiveCheck(fakeClient, USER_ID, { nowMs: BASE_MS, hourUtc: 8 });

    const row = store.compass_live_sessions![0]!;
    assert.equal(row.status, "ended", "the session must stay ended");
    assert.equal(
      row.last_check_at, null,
      "an ended session must not be stamped with a later check — that resurrects a closed session",
    );
    assert.equal(row.checks_run, 0, "an ended session's check counter must not advance");
  });

  it("a session that is already ended before the tick is inert (unchanged behaviour)", async () => {
    const { fakeClient, store } = makeFakeClient({});
    seedLiveWorld(store, "ended");
    const r = await runLiveCheck(fakeClient, USER_ID, { nowMs: BASE_MS, hourUtc: 8 });
    assert.equal(r.active, false);
    assert.equal(r.evaluated, 0);
    assert.equal((store.notifications ?? []).length, 0);
  });
});

/* ── B. Sense: permission revoked during a run ────────────────────────────── */

describe("B. CPH-11 / CPV2-06 — a permission revoked mid-run stops the send", () => {
  function seedSenseWorld(store: Record<string, Row[]>): void {
    seedLiveWorld(store);
    delete store.compass_live_sessions;
    // `saved_event_starting` is the Sense signal with the fewest moving parts:
    // one save plus one public event inside the two-hour window.
    store.event_saves = [{ user_id: USER_ID, event_id: "ev-1" }];
    store.events = [{
      id: "ev-1", title: "Rooftop set", starts_at: atHour(9), state: "open",
      visibility: "public", city: "Cebu City", country: "PH", category: "music",
      host_id: "host-1", description: null,
    }];
    store.compass_sense_settings = [{
      user_id: USER_ID,
      presence_level: "active",
      categories: { timing: true, events: true, weather: true, circle: true, free_time: true },
    }];
  }

  it("CONTROL: an unchanged permission still delivers", async () => {
    const { fakeClient, store } = makeFakeClient({});
    seedSenseWorld(store);
    const r = await runSense(fakeClient, USER_ID, { nowMs: BASE_MS, hourUtc: 8 });
    assert.equal(r.presenceLevel, "active");
    assert.ok(
      r.delivered.length >= 1,
      "control must deliver, or the revocation case below proves nothing",
    );
  });

  it("switching to passive during the run suppresses with reason revoked_mid_run", async () => {
    let revoked = false;
    const store: Record<string, Row[]> = {};
    const { fakeClient } = makeFakeClient(store, {
      onRead: (table) => {
        if (table === "compass_sense_nudges" && !revoked) {
          revoked = true;
          store.compass_sense_settings![0]!.presence_level = "passive";
        }
      },
    });
    seedSenseWorld(store);

    const r = await runSense(fakeClient, USER_ID, { nowMs: BASE_MS, hourUtc: 8 });

    assert.equal(revoked, true, "the fixture must actually have revoked mid-run");
    assert.deepEqual(r.delivered, [], "a revoked presence must deliver nothing");
    assert.ok(
      r.suppressed.some((s) => s.reason === "revoked_mid_run"),
      `expected a revoked_mid_run suppression, got ${JSON.stringify(r.suppressed)}`,
    );
    assert.equal((store.notifications ?? []).length, 0, "no notification after revocation");
  });

  it("turning the category off during the run suppresses it too", async () => {
    let revoked = false;
    const store: Record<string, Row[]> = {};
    const { fakeClient } = makeFakeClient(store, {
      onRead: (table) => {
        if (table === "compass_sense_nudges" && !revoked) {
          revoked = true;
          store.compass_sense_settings![0]!.categories = {
            timing: false, events: false, weather: false, circle: false, free_time: false,
          };
        }
      },
    });
    seedSenseWorld(store);

    const r = await runSense(fakeClient, USER_ID, { nowMs: BASE_MS, hourUtc: 8 });

    assert.equal(revoked, true);
    assert.deepEqual(r.delivered, []);
    assert.ok(r.suppressed.some((s) => s.reason === "revoked_mid_run"));
  });
});

/* ── C. Home: an outage is not an empty result ────────────────────────────── */

const homeApp = express();
homeApp.use(express.json());
homeApp.use((req: any, _res: any, next: any) => { req.log = pino({ level: "silent" }); next(); });
homeApp.use("/api", compassHomeRouter);

let server: Server;
let base: string;

before(async () => {
  server = createServer(homeApp);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  _setTestHourUtc(null);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});
beforeEach(() => {
  invalidateFlagsCache();
  _clearCompassHomeCache();
  _setTestHourUtc(14); // afternoon — tonightVibe is not attempted
});

async function getHome() {
  const r = await fetch(`${base}/api/compass/home`, {
    headers: { Authorization: "Bearer valid-token" },
  });
  return { status: r.status, json: (await r.json()) as any };
}

function seedHomeWorld(store: Record<string, Row[]>): void {
  store.feature_flags = [{ flag: "COMPASS_ENABLED", enabled: true }];
  store.profiles = [{ id: USER_ID, name: "Traveller" }];
  // `currentCity` is resolved from user_location_state, not profiles
  // (CompassProfileService reads locState.city).
  store.user_location_state = [{ user_id: USER_ID, city: "Cebu City", country: "PH" }];
  store.events = [];
}

describe("C. CX-06 / CPV2-05 — Home reports availability per section", () => {
  it("a genuinely empty source reports ok, not unavailable", async () => {
    const { fakeClient, store } = makeFakeClient({});
    seedHomeWorld(store);
    _setTestClient(fakeClient, true);

    const r = await getHome();
    assert.equal(r.status, 200);
    assert.equal(r.json.startingSoon, null, "no events seeded");
    assert.equal(
      r.json.sources.startingSoon, "ok",
      "an empty events table is an answer, not an outage — reporting it unavailable would be no more honest than the old null",
    );
    assert.equal(r.json.degraded, false);
    for (const k of HOME_SECTIONS) {
      assert.ok(["ok", "unavailable"].includes(r.json.sources[k]), `${k} must carry an availability`);
    }
  });

  it("an unreadable source reports unavailable while the others stay ok", async () => {
    const { fakeClient, store } = makeFakeClient({}, { failTables: new Set(["events"]) });
    seedHomeWorld(store);
    _setTestClient(fakeClient, true);

    const r = await getHome();
    assert.equal(r.status, 200);
    assert.equal(r.json.startingSoon, null, "the value is still null — nothing is fabricated");
    assert.equal(
      r.json.sources.startingSoon, "unavailable",
      "a failed events read must be distinguishable from an empty calendar",
    );
    assert.equal(r.json.degraded, true);
    // The unaffected content survives: the outage is scoped to its own section.
    assert.equal(r.json.compassEnabled, true);
    assert.equal(r.json.fallback, false);
    assert.equal(r.json.city, "Cebu City");
    assert.equal(r.json.sources.weatherWindow, "ok");
  });

  it("a degraded payload is not cached, so a recovered source is visible on the next open", async () => {
    const failing = new Set(["events"]);
    const { fakeClient, store } = makeFakeClient({}, { failTables: failing });
    seedHomeWorld(store);
    _setTestClient(fakeClient, true);

    const first = await getHome();
    assert.equal(first.json.degraded, true);

    // The source recovers. If the degraded payload had been cached, this open
    // would still report the outage for the rest of the TTL.
    failing.delete("events");
    const second = await getHome();
    assert.equal(second.json.degraded, false, "a recovered source must not be masked by a cached outage");
    assert.equal(second.json.sources.startingSoon, "ok");
  });
});

/* ── D. The intent classifier is given the turns it needs to resolve a pronoun ── */

/**
 * D. C1-02 — `compass-phase1-spec.md:22` fixes the classifier's input as
 * "last user message + last 2 turns". The shipped call passed the message
 * ALONE, with `history` already loaded nine lines above it and not used, so the
 * router was asked to classify a pronoun with no antecedent. The standing
 * evaluation set's own second and third questions — "What did you mean?" and
 * "Which one is closer?" — are precisely that case, so this is not a
 * theoretical gap: it is two of the nine queries Compass is measured on.
 *
 * These cases assert the CONTRACT (what reaches the model), not the model's
 * answer. What a real model infers from the context is an integration question
 * a deterministic test cannot settle, and pretending otherwise would be the
 * mock-certifies-provider mistake the framing document names.
 */
describe("D. C1-02 — the classifier receives the last two turns", () => {
  async function captureClassifierMessages(
    message: string,
    turns: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<any[]> {
    const { classify } = await import("../services/compass/CompassIntentClassifier.js");
    const { _setTestOpenAI } = await import("../lib/openai.js");
    let seen: any[] = [];
    _setTestOpenAI({
      chat: {
        completions: {
          create: async (req: any) => {
            seen = req.messages;
            return { choices: [{ message: { role: "assistant", content: '{"intent":"question","confidence":0.9}' } }] };
          },
        },
      },
    } as any);
    try {
      await classify(message, turns);
    } finally {
      _setTestOpenAI(null);
    }
    return seen;
  }

  it("sends the prior turns as real messages, in order, with their roles preserved", async () => {
    const msgs = await captureClassifierMessages("Which one is closer?", [
      { role: "user", content: "What should I do in Cebu?" },
      { role: "assistant", content: "Two options: Temple of Leah, and Sirao Garden." },
    ]);

    assert.equal(msgs[0].role, "system", "the system rule stays first");
    // The antecedent must be present AND attributed: "which one is closer"
    // resolves against the ASSISTANT turn that listed the options, so a
    // transcript flattened into one user string would lose what makes it work.
    const assistantTurn = msgs.find((m: any) => m.role === "assistant");
    assert.ok(assistantTurn, "the assistant turn carrying the options must reach the classifier");
    assert.match(assistantTurn.content, /Sirao Garden/);
    assert.equal(
      msgs[msgs.length - 1].content, "Which one is closer?",
      "the message being classified is last",
    );
  });

  it("sends at most two turns, keeping the most recent", async () => {
    const { CLASSIFIER_CONTEXT_TURNS } = await import("../services/compass/CompassIntentClassifier.js");
    assert.equal(CLASSIFIER_CONTEXT_TURNS, 2, "the spec fixes this at two");

    const msgs = await captureClassifierMessages("Add the second one.", [
      { role: "user", content: "OLDEST — must be dropped" },
      { role: "assistant", content: "middle turn" },
      { role: "user", content: "most recent turn" },
    ]);

    const context = msgs.slice(1, -1);
    assert.equal(context.length, 2, `expected exactly 2 context turns, got ${context.length}`);
    assert.ok(
      !JSON.stringify(context).includes("OLDEST"),
      "the third-oldest turn must not reach the classifier — this is a bounded context, not a transcript",
    );
    assert.equal(context[1].content, "most recent turn");
  });

  it("with no history the call is unchanged — system + message only", async () => {
    const msgs = await captureClassifierMessages("What should I do in Cebu?", []);
    assert.equal(msgs.length, 2, "a first turn must not gain empty context entries");
    assert.equal(msgs[0].role, "system");
    assert.equal(msgs[1].content, "What should I do in Cebu?");
  });

  it("an empty-content turn is dropped rather than sent as a blank message", async () => {
    const msgs = await captureClassifierMessages("I'm tired.", [
      { role: "assistant", content: "" },
      { role: "user", content: "real turn" },
    ]);
    const context = msgs.slice(1, -1);
    assert.equal(context.length, 1);
    assert.equal(context[0].content, "real turn");
  });
});
