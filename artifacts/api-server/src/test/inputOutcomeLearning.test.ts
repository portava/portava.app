/**
 * §45 OUTCOME LEARNING — the whole server path, under the owner's decisions
 * OD-INPUT-1 (explicit opt-in, off by default, purpose-limited, separated from
 * core assistance) and OD-INPUT-2 (per-user outcome counters: 30 days, then
 * delete). Census G320, G370, G5, G14, G322, G323.
 *
 * What is driven: the REAL router (consent GET/PUT, outcome POST, the §44
 * ingest, the suggest gateway) over a fake Supabase client that APPLIES writes,
 * logs every read by table, and can be told to fail a table. The SQL itself
 * (3780's consent re-check inside input_record_outcome, the CHECKs, the grants)
 * is NOT exercised here — no Postgres on this machine; that is CI's live-DB tier.
 *
 * Run: node --import tsx/esm --test src/test/inputOutcomeLearning.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { searchKey, normalizeLocationName } from "../lib/canonicalLocations.js";
import {
  INPUT_OUTCOME_DISCLOSURE_VERSION,
  INPUT_OUTCOME_FLAG,
  INPUT_OUTCOME_RETENTION_DAYS,
  readOutcomeMemory,
  outcomeWindowStartDay,
  runInputOutcomeRetentionSweep,
} from "../lib/inputAssistance/outcomeLearning.js";
import { boostFor, withOutcomes, type SelectionMemory } from "../lib/inputAssistance/personalization.js";
import { INPUT_OUTCOME_TASKS } from "../lib/inputAssistance/outcomeLearning.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USER_A = "aa000000-0000-4000-a000-0000000000a1";
const USER_B = "bb000000-0000-4000-a000-0000000000b2";
const A_TOK = "tok-a";
const B_TOK = "tok-b";

// ── Fake Supabase client ──────────────────────────────────────────────────────
interface FakeState {
  [table: string]: any;
  __reads?: string[];
  __fail?: Record<string, boolean>;
  __rpc?: Array<{ name: string; args: any }>;
  __absent?: Record<string, boolean>;
}

function makeFakeClient(state: FakeState) {
  state.__reads ??= [];
  state.__rpc ??= [];
  const fail = (t: string) => !!state.__fail?.[t];
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === A_TOK
          ? { data: { user: { id: USER_A } }, error: null }
          : tok === B_TOK
            ? { data: { user: { id: USER_B } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } },
    },
    rpc: async (name: string, args: any) => {
      state.__rpc!.push({ name, args });
      if (fail(`rpc:${name}`)) return { data: null, error: { message: "boom" } };
      // Models 3780: both functions re-check the FLAG and the CONSENT in the database.
      const flagOn = !!(state.feature_flags ?? []).find((f: any) => f.flag === INPUT_OUTCOME_FLAG && f.enabled === true);
      const consented = (uid: string) => {
        const c = (state.input_outcome_consent ?? []).find((r: any) => r.user_id === uid);
        return !!c && c.enabled === true && !c.withdrawn_at && !!c.consent_version;
      };
      if (name === "input_outcome_memory") {
        if (!flagOn || !consented(args.p_user_id)) return { data: { active: false }, error: null };
        const by = new Map<string, any>();
        for (const r of state.input_outcome_counters ?? []) {
          if (r.user_id !== args.p_user_id || r.context !== args.p_context || r.bucket_day < args.p_since) continue;
          const k = `${r.entity_type}\u0000${r.entity_id}`;
          const e = by.get(k) ?? { entity_type: r.entity_type, entity_id: r.entity_id, completed: 0 };
          e.completed += r.completed_count;
          by.set(k, e);
        }
        return { data: { active: true, counts: [...by.values()] }, error: null };
      }
      if (name === "input_record_outcome") {
        // Upsert-increment today's bucket, only with the flag on and a valid consent.
        if (!flagOn || !consented(args.p_user_id)) return { data: false, error: null };
        const rows = (state.input_outcome_counters ??= []);
        const day = new Date().toISOString().slice(0, 10);
        const hit = rows.find((r: any) =>
          r.user_id === args.p_user_id && r.context === args.p_context &&
          r.entity_type === args.p_entity_type && r.entity_id === args.p_entity_id && r.bucket_day === day);
        if (hit) hit.completed_count += 1;
        else rows.push({ user_id: args.p_user_id, context: args.p_context, entity_type: args.p_entity_type, entity_id: args.p_entity_id, bucket_day: day, completed_count: 1 });
        return { data: true, error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      let op: "select" | "delete" | "upsert" | "insert" = "select";
      let payload: any = null;
      let returning = false;
      const filters: Array<(r: any) => boolean> = [];
      let limitN = Infinity;
      const rowsOf = () => (state[table] ??= []) as any[];
      const run = () => {
        if (op === "select") {
          state.__reads!.push(table);
          if (state.__absent?.[table]) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } };
          if (fail(table)) return { data: null, error: { message: "boom" } };
          const out = rowsOf().filter((r) => filters.every((f) => f(r))).slice(0, limitN === Infinity ? undefined : limitN);
          return { data: out, error: null };
        }
        if (fail(`${op}:${table}`)) return { data: null, error: { message: "boom" } };
        if (op === "delete") {
          const keep: any[] = [];
          const gone: any[] = [];
          for (const r of rowsOf()) (filters.every((f) => f(r)) ? gone : keep).push(r);
          state[table] = keep;
          return { data: returning ? gone : null, error: null };
        }
        if (op === "insert") {
          rowsOf().push(...(Array.isArray(payload) ? payload : [payload]));
          return { data: null, error: null };
        }
        // upsert on user_id
        const existing = rowsOf().find((r) => r.user_id === payload.user_id);
        if (existing) Object.assign(existing, payload);
        else rowsOf().push({ enabled: false, consent_version: null, consented_at: null, withdrawn_at: null, ...payload });
        return { data: null, error: null };
      };
      const b: any = {
        select(_c?: string) { if (op === "delete") returning = true; return b; },
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
        neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
        in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
        not(c: string, o: string, v: any) { if (o === "is") filters.push((r) => r[c] !== v && r[c] != null); return b; },
        is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        ilike(c: string, pat: string) {
          const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[c] ?? ""))); return b;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/)).filter(Boolean) as RegExpMatchArray[];
          filters.push((r) => parts.some((m) => {
            const cell = String(r[m[1]!] ?? ""); const val = m[3]!;
            if (m[2]!.toLowerCase() === "ilike") return new RegExp("^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i").test(cell);
            if (m[2]!.toLowerCase() === "eq") return cell === val;
            return false;
          }));
          return b;
        },
        gte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] >= v); return b; },
        lt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] < v); return b; },
        lte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] <= v); return b; },
        gt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] > v); return b; },
        order() { return b; },
        range() { return b; },
        limit(n: number) { limitN = n; return b; },
        delete() { op = "delete"; return b; },
        insert(p: any) { op = "insert"; payload = p; return b; },
        upsert(p: any) { op = "upsert"; payload = p; return b; },
        maybeSingle() {
          const r = run();
          return Promise.resolve(r.error ? r : { data: (r.data as any[])[0] ?? null, error: null });
        },
        then(onF: any, onR: any) { return Promise.resolve(run()).then(onF, onR); },
      };
      return b;
    },
  };
}

function canonCity(name: string, id: string) {
  const key = searchKey(name);
  return {
    id, kind: "city", name, normalized_name: normalizeLocationName(name), search_key: key,
    display_name: `${name}, United States`, city: null, region: null, country: "United States",
    country_code: "US", postal_code: null, lat: null, lng: null, provider_ids: {}, aliases: [],
  };
}
const SANTA_ANA = canonCity("Santa Ana", "canon-santa-ana");
const SANTA_ROSA = canonCity("Santa Rosa", "canon-santa-rosa");

function selRow(user: string, entityId: string, count: number) {
  return {
    user_id: user, context: "city_picker", entity_type: "city", entity_id: entityId,
    query_key: "", label: null, selection_count: count, last_selected_at: "2026-10-01T00:00:00.000Z",
  };
}
const today = () => new Date().toISOString().slice(0, 10);
const flag = (on: boolean) => ({ flag: INPUT_OUTCOME_FLAG, enabled: on });
const consentRow = (user: string, over: Record<string, unknown> = {}) => ({
  user_id: user, enabled: true, consent_version: INPUT_OUTCOME_DISCLOSURE_VERSION,
  consented_at: "2026-10-01T00:00:00.000Z", withdrawn_at: null, ...over,
});

// ── Server ────────────────────────────────────────────────────────────────────
let base: string;
let server: Server;
let state: FakeState;
function setup(s: FakeState) { state = s; _setTestClient(makeFakeClient(state) as any, true); }

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", inputAssistanceRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); });

const call = (method: string, path: string, body?: unknown, tok: string | null = A_TOK) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ── 1. The opt-in (OD-INPUT-1) ────────────────────────────────────────────────

describe("outcome consent — explicit, off by default, server-stamped (OD-INPUT-1)", () => {
  it("is OFF for a user who was never asked, and says whether it is offered", async () => {
    setup({ feature_flags: [flag(false)] });
    const r = await call("GET", "/input-assistance/outcome-consent");
    assert.equal(r.status, 200);
    const b = (await r.json()) as any;
    assert.equal(b.available, false);
    assert.equal(b.enabled, false);
    assert.equal(b.currentDisclosureVersion, INPUT_OUTCOME_DISCLOSURE_VERSION);
    assert.equal(b.retentionDays, 30);
  });

  it("an ABSENT consent table (its migration not applied) is 'never consented' — 200, hidden — not an outage", async () => {
    // Structural, not a guess: a table that does not exist holds no one's
    // consent. This is what lets the row render for every signed-in person
    // (so anyone who opted in can always withdraw) without showing an error
    // everywhere before 3780 is applied. Every OTHER error stays a 503 (next).
    setup({ __absent: { input_outcome_consent: true } });
    const r = await call("GET", "/input-assistance/outcome-consent");
    assert.equal(r.status, 200);
    const b = (await r.json()) as any;
    assert.equal(b.enabled, false);
    assert.equal(b.available, false);
  });

  it("an UNREADABLE consent is a 503, never 'not consented'", async () => {
    setup({ feature_flags: [flag(true)], __fail: { input_outcome_consent: true } });
    const r = await call("GET", "/input-assistance/outcome-consent");
    assert.equal(r.status, 503);
  });

  it("a grant is REFUSED while the flag is off, and nothing is written", async () => {
    setup({ feature_flags: [flag(false)] });
    const r = await call("PUT", "/input-assistance/outcome-consent", { enabled: true, disclosureVersion: INPUT_OUTCOME_DISCLOSURE_VERSION });
    assert.equal(r.status, 404);
    assert.equal((state.input_outcome_consent ?? []).length, 0);
  });

  it("a grant naming a disclosure the server does not stamp is refused (409), nothing written", async () => {
    setup({ feature_flags: [flag(true)] });
    const r = await call("PUT", "/input-assistance/outcome-consent", { enabled: true, disclosureVersion: "input_outcome_learning_v0" });
    assert.equal(r.status, 409);
    assert.equal((state.input_outcome_consent ?? []).length, 0);
    const r2 = await call("PUT", "/input-assistance/outcome-consent", { enabled: true });
    assert.equal(r2.status, 409, "a grant that names no displayed disclosure is not a grant");
  });

  it("a grant is stamped by the SERVER — version and time are not the client's to supply", async () => {
    setup({ feature_flags: [flag(true)] });
    const r = await call("PUT", "/input-assistance/outcome-consent", {
      enabled: true, disclosureVersion: INPUT_OUTCOME_DISCLOSURE_VERSION,
      consentVersion: "forged", consentedAt: "1999-01-01T00:00:00.000Z",
    });
    assert.equal(r.status, 200);
    const row = state.input_outcome_consent[0];
    assert.equal(row.user_id, USER_A, "the row is keyed by the SESSION's user");
    assert.equal(row.enabled, true);
    assert.equal(row.consent_version, INPUT_OUTCOME_DISCLOSURE_VERSION);
    assert.notEqual(row.consented_at, "1999-01-01T00:00:00.000Z");
    assert.equal(row.withdrawn_at, null);
    assert.equal(((await r.json()) as any).enabled, true);
  });

  it("a withdrawal is accepted EVEN WITH THE FLAG OFF and deletes only this user's counters", async () => {
    setup({
      feature_flags: [flag(false)],
      input_outcome_consent: [consentRow(USER_A), consentRow(USER_B)],
      input_outcome_counters: [
        { user_id: USER_A, context: "city_picker", entity_type: "city", entity_id: "x", bucket_day: today(), completed_count: 2 },
        { user_id: USER_B, context: "city_picker", entity_type: "city", entity_id: "x", bucket_day: today(), completed_count: 1 },
      ],
    });
    const r = await call("PUT", "/input-assistance/outcome-consent", { enabled: false });
    assert.equal(r.status, 200);
    const b = (await r.json()) as any;
    assert.equal(b.enabled, false);
    assert.equal(b.countersErased, true);
    const a = state.input_outcome_consent.find((x: any) => x.user_id === USER_A);
    assert.equal(a.enabled, false);
    assert.ok(a.withdrawn_at, "the withdrawal is stamped");
    assert.deepEqual(state.input_outcome_counters.map((x: any) => x.user_id), [USER_B], "B's counters are B's");
  });

  it("a withdrawal whose counter delete fails still withdraws, and SAYS the erase failed", async () => {
    setup({
      feature_flags: [flag(true)],
      input_outcome_consent: [consentRow(USER_A)],
      input_outcome_counters: [{ user_id: USER_A, context: "city_picker", entity_type: "city", entity_id: "x", bucket_day: today(), completed_count: 1 }],
      __fail: { "delete:input_outcome_counters": true },
    });
    const r = await call("PUT", "/input-assistance/outcome-consent", { enabled: false });
    assert.equal(r.status, 200);
    const b = (await r.json()) as any;
    assert.equal(b.enabled, false);
    assert.equal(b.countersErased, false, "a failed erase is reported, not hidden");
  });
});

// ── 2. The outcome write (G320; OD-INPUT-1/2) ─────────────────────────────────

const OUTCOME = {
  context: "city_picker", fieldId: "geo.city", task: "trip_destinations_saved", ok: true,
  entities: [{ entityType: "city", entityId: SANTA_ROSA.id }],
};

describe("POST /input-assistance/outcome — only for a user who opted in, only what the field may remember", () => {
  it("records against the SESSION's user when the flag is on and consent is valid", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    const r = await call("POST", "/input-assistance/outcome", { ...OUTCOME, userId: USER_B });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, recorded: 1, failed: 0, refused: 0 });
    assert.equal(state.input_outcome_counters.length, 1);
    assert.equal(state.input_outcome_counters[0].user_id, USER_A, "a body-supplied userId is ignored");
  });

  it("is REFUSED (403) without consent, and nothing reaches the database write", async () => {
    setup({ feature_flags: [flag(true)] });
    const r = await call("POST", "/input-assistance/outcome", OUTCOME);
    assert.equal(r.status, 403);
    assert.equal(state.__rpc!.length, 0);
  });

  it("is REFUSED for a WITHDRAWN consent", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A, { enabled: false, withdrawn_at: "2026-10-02T00:00:00.000Z" })] });
    const r = await call("POST", "/input-assistance/outcome", OUTCOME);
    assert.equal(r.status, 403);
    assert.equal(state.__rpc!.length, 0);
  });

  it("is REFUSED for an inconsistent row — enabled but stamped withdrawn (fail closed)", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A, { withdrawn_at: "2026-10-02T00:00:00.000Z" })] });
    const r = await call("POST", "/input-assistance/outcome", OUTCOME);
    assert.equal(r.status, 403);
    assert.equal(state.__rpc!.length, 0);
  });

  it("is REFUSED (404) while the flag is off, even for a user who once opted in", async () => {
    setup({ feature_flags: [flag(false)], input_outcome_consent: [consentRow(USER_A)] });
    const r = await call("POST", "/input-assistance/outcome", OUTCOME);
    assert.equal(r.status, 404);
    assert.equal(state.__rpc!.length, 0);
  });

  it("an unreadable consent is a 503, not a refusal and not a write", async () => {
    setup({ feature_flags: [flag(true)], __fail: { input_outcome_consent: true } });
    const r = await call("POST", "/input-assistance/outcome", OUTCOME);
    assert.equal(r.status, 503);
    assert.equal(state.__rpc!.length, 0);
  });

  it("refuses a field whose policy keeps no per-user memory (the private-message composer)", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    const r = await call("POST", "/input-assistance/outcome", { ...OUTCOME, context: "telegraph_message", fieldId: undefined, entities: [{ entityType: "place", entityId: "p1" }] });
    assert.equal(r.status, 400);
    assert.equal(state.__rpc!.length, 0);
  });

  it("refuses an entity type the field's policy does not declare", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    const r = await call("POST", "/input-assistance/outcome", { ...OUTCOME, entities: [{ entityType: "user", entityId: USER_B }] });
    assert.equal(r.status, 400);
    assert.equal(state.__rpc!.length, 0);
  });

  it("refuses a task outside the closed vocabulary", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    const r = await call("POST", "/input-assistance/outcome", { ...OUTCOME, task: "liked_a_post" });
    assert.equal(r.status, 400);
  });

  it("a task that did NOT succeed credits nothing", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    const r = await call("POST", "/input-assistance/outcome", { ...OUTCOME, ok: false });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).recorded, 0);
    assert.equal(state.__rpc!.length, 0);
  });

  it("a write that fails is a retryable 503, never a 200 with recorded:0", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)], __fail: { "rpc:input_record_outcome": true } });
    const r = await call("POST", "/input-assistance/outcome", OUTCOME);
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as any).failed, 1);
  });
});

// ── 3. The shared §44 stream: the outcome event needs the opt-in too ──────────

function telemetryBatch() {
  const at = Date.now();
  return {
    sessionId: "sess-1",
    events: [
      { name: "suggestion_selected", fieldId: "geo.city", context: "city_picker", at, props: { suggestionType: "entity", source: "canonical" } },
      { name: "downstream_task_completed", fieldId: "geo.city", context: "city_picker", at, props: { task: "trip_destinations_saved", ok: true } },
    ],
  };
}

describe("§44 ingest — downstream_task_completed is admitted only for a caller who opted in (OD-INPUT-1)", () => {
  it("without consent the outcome event is REJECTED and the rest of the batch still lands", async () => {
    setup({ feature_flags: [flag(true)] });
    const r = await call("POST", "/input-assistance/telemetry", telemetryBatch());
    assert.equal(r.status, 200);
    const b = (await r.json()) as any;
    assert.equal(b.accepted, 1);
    assert.equal(b.rejected, 1);
    const names = (state.input_assistance_telemetry_events ?? []).map((x: any) => x.event_name);
    assert.deepEqual(names, ["suggestion_selected"]);
  });

  it("with consent and the flag on it lands — and the stored row still carries no account id", async () => {
    setup({ feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    const r = await call("POST", "/input-assistance/telemetry", telemetryBatch());
    assert.equal(r.status, 200);
    const stored = state.input_assistance_telemetry_events as any[];
    const outcome = stored.find((x) => x.event_name === "downstream_task_completed");
    assert.ok(outcome, "the consented outcome event is stored");
    assert.deepEqual(outcome.props, { task: "trip_destinations_saved", ok: true });
    assert.ok(!JSON.stringify(stored).includes(USER_A), "no account id anywhere in the stored rows");
  });

  it("an unreadable consent rejects the outcome event (an unknown consent is not a consent)", async () => {
    setup({ feature_flags: [flag(true)], __fail: { input_outcome_consent: true } });
    const r = await call("POST", "/input-assistance/telemetry", telemetryBatch());
    const b = (await r.json()) as any;
    assert.equal(b.rejected, 1);
  });

  it("a batch with no outcome event never reads consent at all", async () => {
    setup({ feature_flags: [flag(true)] });
    const batch = telemetryBatch();
    batch.events = batch.events.slice(0, 1);
    await call("POST", "/input-assistance/telemetry", batch);
    assert.ok(!state.__reads!.includes("input_outcome_consent"));
  });
});

// ── 4. The rank term (G5/G14/G322/G323) ──────────────────────────────────────

function memoryOf(entries: Array<[string, number]>): SelectionMemory {
  const byEntity = new Map<string, any>();
  for (const [id, total] of entries) {
    byEntity.set(`city:${id}`, { entityType: "city", entityId: id, total, byQuery: new Map(), lastSelectedAt: null, label: null });
  }
  return { byEntity, recentEntities: [...byEntity.values()], isEmpty: entries.length === 0 };
}

describe("the outcome term weighs a completed task against a bare acceptance", () => {
  it("WITHOUT outcome learning the formula is the original, byte for byte (separated from core assistance)", () => {
    const m = memoryOf([["a", 5], ["b", 2]]);
    assert.equal(boostFor(m, "city", "a", ""), Math.min(0.25, 0.03 * 5));
    assert.equal(boostFor(m, "city", "b", ""), Math.min(0.25, 0.03 * 2));
  });

  it("WITH it, picked-5-times-never-completed ranks BELOW picked-twice-completed-twice", () => {
    const m = withOutcomes(memoryOf([["a", 5], ["b", 2]]), new Map([["city:b", 2]]));
    const a = boostFor(m, "city", "a", "");
    const b = boostFor(m, "city", "b", "");
    assert.ok(b > a, `completed (${b}) must outrank merely accepted (${a})`);
    // and the acceptance-only reading of the same memory says the opposite
    const plain = memoryOf([["a", 5], ["b", 2]]);
    assert.ok(boostFor(plain, "city", "a", "") > boostFor(plain, "city", "b", ""));
  });

  it("is bounded by the same cap — outcomes cannot buy past MAX_BOOST", () => {
    const m = withOutcomes(memoryOf([["a", 1]]), new Map([["city:a", 1000]]));
    assert.equal(boostFor(m, "city", "a", ""), 0.25);
  });
});

/** A device whose opt-in gate is open sends the hint; the server still checks everything. */
function suggest(tok = A_TOK, hint = true) {
  return call("POST", "/input-assistance/suggest", { context: "city_picker", text: "sant", ...(hint ? { outcomeLearning: true } : {}) }, tok);
}
const conf = (body: any, id: string) => body.suggestions.find((s: any) => s.entityId === id)?.confidence;

describe("POST /suggest — outcome learning reaches the rank only for a consenting user with the flag on", () => {
  const base = () => ({
    canonical_locations: [SANTA_ANA, SANTA_ROSA],
    input_selection_history: [selRow(USER_A, SANTA_ANA.id, 5), selRow(USER_A, SANTA_ROSA.id, 2)],
    input_outcome_counters: [
      { user_id: USER_A, context: "city_picker", entity_type: "city", entity_id: SANTA_ROSA.id, bucket_day: today(), completed_count: 2 },
    ],
  });

  it("consent + flag: the city the user COMPLETED a trip with outranks the one they merely kept picking", async () => {
    setup({ ...base(), feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    const body = (await (await suggest()).json()) as any;
    assert.ok(conf(body, SANTA_ROSA.id) > conf(body, SANTA_ANA.id), JSON.stringify(body.suggestions.map((s: any) => [s.label, s.confidence])));
  });

  /** The acceptance-only confidences for the same fixture: a serve with no hint. */
  async function plainConfs(): Promise<[number, number]> {
    setup({ ...base(), feature_flags: [flag(false)] });
    _resetRateLimit();
    const b = (await (await suggest(A_TOK, false)).json()) as any;
    return [conf(b, SANTA_ANA.id), conf(b, SANTA_ROSA.id)];
  }

  it("no consent: acceptance-only, value for value", async () => {
    setup({ ...base(), feature_flags: [flag(true)] });
    const body = (await (await suggest()).json()) as any;
    assert.deepEqual([conf(body, SANTA_ANA.id), conf(body, SANTA_ROSA.id)], await plainConfs());
  });

  it("flag off: acceptance-only even for a user who opted in, value for value", async () => {
    setup({ ...base(), feature_flags: [flag(false)], input_outcome_consent: [consentRow(USER_A)] });
    const body = (await (await suggest()).json()) as any;
    assert.deepEqual([conf(body, SANTA_ANA.id), conf(body, SANTA_ROSA.id)], await plainConfs());
  });

  it("MEASURED COST (OD-INPUT-7): a hinted serve makes exactly ONE outcome round trip in every state; no hint makes none", async () => {
    // Round trips to the outcome store per personalised serve: the RPC calls
    // plus any direct reads of the three tables it covers.
    const outcomeTrips = () =>
      state.__rpc!.filter((c) => c.name === "input_outcome_memory").length +
      state.__reads!.filter((t) => ["feature_flags", "input_outcome_consent", "input_outcome_counters"].includes(t)).length;
    const states: Array<[string, FakeState, boolean, number]> = [
      ["no hint, opted in, flag on", { ...base(), feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] }, false, 0],
      ["hint, flag off", { ...base(), feature_flags: [flag(false)], input_outcome_consent: [consentRow(USER_A)] }, true, 1],
      ["hint, flag on, no consent", { ...base(), feature_flags: [flag(true)] }, true, 1],
      ["hint, flag on, consent (active)", { ...base(), feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] }, true, 1],
    ];
    for (const [label, st, hint, expected] of states) {
      setup(st);
      _resetRateLimit();
      assert.equal((await suggest(A_TOK, hint)).status, 200);
      assert.equal(outcomeTrips(), expected, `${label}: ${outcomeTrips()} outcome round trips`);
    }
  });

  it("NO HINT (every device that never opted in): no flag, consent or counter read at all — even for an opted-in user", async () => {
    // OD-INPUT-7's latency rule: the people who never opted in must not pay a
    // round trip for a feature they do not use. A missing hint only costs the
    // boost; it can never grant one.
    setup({ ...base(), feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    const body = (await (await suggest(A_TOK, false)).json()) as any;
    assert.ok(conf(body, SANTA_ANA.id) > conf(body, SANTA_ROSA.id), "acceptance-only without the hint");
    for (const t of ["feature_flags", "input_outcome_consent", "input_outcome_counters"]) {
      assert.ok(!state.__reads!.includes(t), `${t} was read without the hint`);
    }
    assert.equal(state.__rpc!.filter((c) => c.name === "input_outcome_memory").length, 0);
  });

  it("the HINT grants nothing: hinted, flag on, but no consent row → acceptance-only", async () => {
    setup({ ...base(), feature_flags: [flag(true)] });
    const body = (await (await suggest(A_TOK, true)).json()) as any;
    assert.ok(conf(body, SANTA_ANA.id) > conf(body, SANTA_ROSA.id));
  });

  it("another user's outcomes never move this user's rank", async () => {
    const s = base();
    s.input_outcome_counters[0].user_id = USER_B;
    setup({ ...s, feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A), consentRow(USER_B)] });
    const body = (await (await suggest()).json()) as any;
    assert.ok(conf(body, SANTA_ANA.id) > conf(body, SANTA_ROSA.id));
  });

  it("a FAILED outcome read ranks EXACTLY as acceptance-only — not the outcome formula with empty counts", async () => {
    // The two differ: the outcome formula halves every bare acceptance. So the
    // failed serve's confidences must equal a no-hint serve's, value for value.
    setup({ ...base(), feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)], __fail: { "rpc:input_outcome_memory": true } });
    const r = await suggest();
    assert.equal(r.status, 200);
    const failed = (await r.json()) as any;
    setup({ ...base(), feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] });
    _resetRateLimit();
    const plain = (await (await suggest(A_TOK, false)).json()) as any;
    assert.equal(conf(failed, SANTA_ANA.id), conf(plain, SANTA_ANA.id));
    assert.equal(conf(failed, SANTA_ROSA.id), conf(plain, SANTA_ROSA.id));
  });

  it("an active answer with no counts DOES use the outcome formula (the failure case above is not the same thing)", async () => {
    const st = { ...base(), feature_flags: [flag(true)], input_outcome_consent: [consentRow(USER_A)] };
    st.input_outcome_counters = [];
    setup(st);
    const active = (await (await suggest()).json()) as any;
    setup({ ...base(), feature_flags: [flag(true)] });
    _resetRateLimit();
    const plain = (await (await suggest(A_TOK, false)).json()) as any;
    assert.ok(conf(active, SANTA_ANA.id) < conf(plain, SANTA_ANA.id), "a consenting user's bare acceptances are halved");
  });
});

// ── 5. 30 days, then delete (OD-INPUT-2) ──────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const dayAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString().slice(0, 10);

describe("OD-INPUT-2 — a completion counts for 30 UTC days, then it is deleted", () => {
  it("the window is today and the 29 days before it", () => {
    assert.equal(INPUT_OUTCOME_RETENTION_DAYS, 30);
    assert.equal(outcomeWindowStartDay(NOW), dayAgo(29));
  });

  it("the reader ignores a bucket that is 30 days old even if the sweep has not run", async () => {
    const s: FakeState = {
      input_outcome_counters: [
        { user_id: USER_A, context: "city_picker", entity_type: "city", entity_id: "in", bucket_day: dayAgo(29), completed_count: 1 },
        { user_id: USER_A, context: "city_picker", entity_type: "city", entity_id: "out", bucket_day: dayAgo(30), completed_count: 9 },
      ],
    };
    s.feature_flags = [flag(true)];
    s.input_outcome_consent = [consentRow(USER_A)];
    const read = await readOutcomeMemory(makeFakeClient(s) as any, { userId: USER_A, context: "city_picker", now: NOW });
    assert.ok(read.ok && read.active);
    assert.deepEqual([...(read as any).counts.entries()], [["city:in", 1]]);
    assert.equal(s.__rpc![0]!.args.p_since, dayAgo(29), "the window travels to the database");
  });

  it("the sweep deletes every bucket outside the window, for every user, and keeps the rest", async () => {
    const s: FakeState = {
      input_outcome_counters: [
        { user_id: USER_A, context: "c", entity_type: "city", entity_id: "keep", bucket_day: dayAgo(29), completed_count: 1 },
        { user_id: USER_A, context: "c", entity_type: "city", entity_id: "drop", bucket_day: dayAgo(30), completed_count: 1 },
        { user_id: USER_B, context: "c", entity_type: "city", entity_id: "drop", bucket_day: dayAgo(400), completed_count: 1 },
      ],
    };
    const r = await runInputOutcomeRetentionSweep({ client: makeFakeClient(s), now: NOW });
    assert.deepEqual(r, { purged: 2, skipped: false, reason: null });
    assert.deepEqual(s.input_outcome_counters.map((x: any) => x.entity_id), ["keep"]);
  });

  it("a failed sweep says 'error' — it is not indistinguishable from a sweep that found nothing", async () => {
    const s: FakeState = { input_outcome_counters: [], __fail: { "delete:input_outcome_counters": true } };
    const r = await runInputOutcomeRetentionSweep({ client: makeFakeClient(s), now: NOW });
    assert.deepEqual(r, { purged: 0, skipped: true, reason: "error" });
  });

  it("a failed read is a failed read, not an empty one; a malformed answer is also a failure", async () => {
    const s: FakeState = { __fail: { "rpc:input_outcome_memory": true } };
    assert.equal((await readOutcomeMemory(makeFakeClient(s) as any, { userId: USER_A, context: "c", now: NOW })).ok, false);
    const odd = { rpc: async () => ({ data: { active: true }, error: null }) };
    assert.equal((await readOutcomeMemory(odd as any, { userId: USER_A, context: "c", now: NOW })).ok, false, "active without counts is not an answer");
  });
});

// ── 6. Client and server agree on the words' version and the task vocabulary ──

describe("the client's disclosure version and task list are the server's (a grant the server refuses is a dead switch)", () => {
  const CLIENT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "..", "..",
    "travel-buddy-standalone/src/platform/input-assistance/services/outcomeLearning.ts",
  );
  const src = fs.readFileSync(CLIENT, "utf8");

  it("OUTCOME_DISCLOSURE_VERSION === INPUT_OUTCOME_DISCLOSURE_VERSION", () => {
    const m = src.match(/export const OUTCOME_DISCLOSURE_VERSION = '([^']+)';/);
    assert.ok(m, "client disclosure version not found");
    assert.equal(m![1], INPUT_OUTCOME_DISCLOSURE_VERSION);
  });

  it("INPUT_OUTCOME_TASKS is the same closed list on both sides", () => {
    const m = src.match(/export const INPUT_OUTCOME_TASKS = \[([\s\S]*?)\] as const;/);
    assert.ok(m, "client task list not found");
    const client = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    assert.deepEqual(client, [...INPUT_OUTCOME_TASKS]);
  });
});
