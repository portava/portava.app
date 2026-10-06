/**
 * §6 `allowMemoryContext` (census G25) under OD-INPUT-3 — "Compass memory: Don't
 * use it for input assistance by default. Add it only through a separate, clear
 * opt-in with a way to inspect and revoke it."
 *
 * What is driven: the REAL router (suggest, memory-context inspect, consent PUT)
 * and the REAL memory retrieval service (`searchMemories`), over a fake Supabase
 * client that logs every read by table. The person's CompassMemoryProjection is
 * seeded as a registered derivative in `memory_derivative_registry`, exactly
 * where the retrieval service reads it, so "zero memory reads" is asserted on
 * the table the memory layer would actually touch.
 *
 * NOT exercised: 3782's SQL (no local Postgres) and the projection BUILDER that
 * fills the registry in production (the memory lane's; read-only here).
 *
 * Run: node --import tsx/esm --test src/test/inputMemoryContext.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import inputAssistanceRouter from "../routes/inputAssistance.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import {
  INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION,
  INPUT_MEMORY_CONTEXT_FLAG,
  memoryContextGate,
} from "../lib/inputAssistance/memoryContext.js";

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
      if (name === "input_record_outcome") {
        // Models 3780: re-check consent in the database, then upsert-increment
        // today's bucket.
        const c = (state.input_outcome_consent ?? []).find((r: any) => r.user_id === args.p_user_id);
        if (!c || !c.enabled || c.withdrawn_at) return { data: false, error: null };
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


const flag = (on: boolean) => ({ flag: INPUT_MEMORY_CONTEXT_FLAG, enabled: on });
const consent = (user: string, over: Record<string, unknown> = {}) => ({
  user_id: user, enabled: true, consent_version: INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION,
  consented_at: "2026-10-01T00:00:00.000Z", withdrawn_at: null, ...over,
});
/** The person's registered CompassMemoryProjection, where searchMemories reads it. */
function registry(owner: string, rows: Array<Record<string, unknown>>, state = "ACTIVE") {
  return {
    projection_id: "CompassMemoryProjection",
    scope_key: `CompassMemoryProjection|owner:${owner}|viewer:${owner}`,
    payload_json: rows,
    revocation_state: state,
    row_count: rows.length,
    generated_at: "2026-10-04T00:00:00.000Z",
    revoked_at: null,
    revocation_reason: null,
  };
}
const MEMORIES = [
  { memory_id: "m1", occurred_at: "2026-09-20T00:00:00.000Z", location_city: "Hội An", location_country: "Vietnam", canonical_location_id: "canon-hoi-an", place_id: null, trip_id: "t1", event_id: null, confidence_note: "historical record" },
  { memory_id: "m2", occurred_at: "2026-09-10T00:00:00.000Z", location_city: "Hội An", location_country: "Vietnam", canonical_location_id: "canon-hoi-an", place_id: null, trip_id: "t1", event_id: null, confidence_note: "historical record" },
  { memory_id: "m3", occurred_at: "2026-08-01T00:00:00.000Z", location_city: "Tokyo", location_country: "Japan", canonical_location_id: "canon-tokyo", place_id: null, trip_id: null, event_id: null, confidence_note: "historical record" },
];
const MEMORY_TABLES = ["memory_derivative_registry", "input_memory_context_consent"];
const memoryReads = (s: FakeState) => (s.__reads ?? []).filter((t) => MEMORY_TABLES.includes(t));

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
const compass = (tok = A_TOK) =>
  call("POST", "/input-assistance/suggest", { context: "compass_prompt", text: "", sessionContext: { surface: "compass" } }, tok);
const memoryRows = (body: any) => (body.suggestions ?? []).filter((s: any) => s.source === "memory");

// ── 1. The three gates, in order, each reading nothing past itself ────────────

describe("memoryContextGate — policy, then flag, then the person's opt-in (G25, OD-INPUT-3)", () => {
  it("a field whose policy does not allow memory context reads NOTHING — not even the flag", async () => {
    const s: FakeState = { feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)] };
    const gate = await memoryContextGate(makeFakeClient(s) as any, resolvePolicy("global_search")!, USER_A);
    assert.equal(gate, "policy");
    assert.deepEqual(s.__reads, []);
  });

  it("only compass_prompt declares allowMemoryContext — every other field is closed by policy", () => {
    const declaring = ["compass_prompt", "global_search", "city_picker", "caption", "telegraph_message"]
      .filter((c) => resolvePolicy(c as any)?.allowMemoryContext === true);
    assert.deepEqual(declaring, ["compass_prompt"]);
  });

  it("flag off: closed, and the opt-in is not even read", async () => {
    const s: FakeState = { feature_flags: [flag(false)], input_memory_context_consent: [consent(USER_A)] };
    assert.equal(await memoryContextGate(makeFakeClient(s) as any, resolvePolicy("compass_prompt")!, USER_A), "flag");
    assert.ok(!s.__reads!.includes("input_memory_context_consent"));
  });

  it("no opt-in, or a withdrawn one: closed", async () => {
    const p = resolvePolicy("compass_prompt")!;
    assert.equal(await memoryContextGate(makeFakeClient({ feature_flags: [flag(true)] }) as any, p, USER_A), "consent");
    assert.equal(await memoryContextGate(makeFakeClient({
      feature_flags: [flag(true)],
      input_memory_context_consent: [consent(USER_A, { enabled: false, withdrawn_at: "2026-10-02T00:00:00.000Z" })],
    }) as any, p, USER_A), "consent");
  });

  it("an INCONSISTENT row — enabled but stamped withdrawn — is a withdrawal, not a grant (fail closed)", async () => {
    const s: FakeState = {
      feature_flags: [flag(true)],
      input_memory_context_consent: [consent(USER_A, { withdrawn_at: "2026-10-02T00:00:00.000Z" })],
    };
    assert.equal(await memoryContextGate(makeFakeClient(s) as any, resolvePolicy("compass_prompt")!, USER_A), "consent");
  });

  it("an unreadable opt-in is its own answer — not 'no', and certainly not 'yes'", async () => {
    const s: FakeState = { feature_flags: [flag(true)], __fail: { input_memory_context_consent: true } };
    assert.equal(await memoryContextGate(makeFakeClient(s) as any, resolvePolicy("compass_prompt")!, USER_A), "consent_unreadable");
  });

  it("policy + flag + a valid opt-in: open", async () => {
    const s: FakeState = { feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)] };
    assert.equal(await memoryContextGate(makeFakeClient(s) as any, resolvePolicy("compass_prompt")!, USER_A), "open");
  });
});

// ── 2. Through the gateway: the starters a person sees ────────────────────────

describe("POST /suggest compass_prompt — memory starters only for a person who opted in", () => {
  it("opted in: memory-informed starters LEAD, one per city, labelled as memories, and the curated set still follows", async () => {
    setup({ feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    const r = await compass();
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    const mem = memoryRows(body);
    assert.deepEqual(mem.map((s: any) => s.replacementText), [
      "Plan another trip to Hội An, Vietnam",
      "Plan another trip to Tokyo, Japan",
    ]);
    assert.ok(mem.every((s: any) => s.type === "ai_suggestion" && s.action?.type === "replace_text"));
    assert.ok(mem.every((s: any) => /memories/.test(s.reason) && /not current/.test(s.reason)), "explainable, and history is not current truth");
    assert.equal(body.suggestions[0].source, "memory", "they are not capped out behind the curated set");
    assert.ok(body.suggestions.some((s: any) => s.source === "ai"), "the curated starters are still served");
  });

  it("not opted in: the curated starters exactly, and the person's memories are NEVER READ", async () => {
    setup({ feature_flags: [flag(true)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    const body = (await (await compass()).json()) as any;
    assert.equal(memoryRows(body).length, 0);
    assert.ok(!state.__reads!.includes("memory_derivative_registry"), "no opt-in, no memory read");
  });

  it("flag off: no memory starters, and neither the opt-in nor the memories are read", async () => {
    setup({ feature_flags: [flag(false)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    const body = (await (await compass()).json()) as any;
    assert.equal(memoryRows(body).length, 0);
    assert.deepEqual(memoryReads(state), []);
  });

  it("a field that does not allow memory context never touches memory, opted in or not", async () => {
    setup({ feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    await call("POST", "/input-assistance/suggest", { context: "global_search", text: "" });
    assert.deepEqual(memoryReads(state), []);
  });

  it("reads only the CALLER's own memories — another person's derivative is not in scope", async () => {
    setup({ feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_B, MEMORIES)] });
    const body = (await (await compass()).json()) as any;
    assert.equal(memoryRows(body).length, 0);
  });

  it("a REVOKED derivative yields no memory starters and the serve still succeeds", async () => {
    setup({ feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_A, MEMORIES, "REVOKED")] });
    const r = await compass();
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;
    assert.equal(memoryRows(body).length, 0);
    assert.ok(body.suggestions.length > 0);
  });
});

// ── 3. Inspect and revoke ─────────────────────────────────────────────────────

describe("GET /input-assistance/memory-context — inspect exactly what would be used", () => {
  it("opted in: lists the facts the starters are built from", async () => {
    setup({ feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    const b = (await (await call("GET", "/input-assistance/memory-context")).json()) as any;
    assert.equal(b.enabled, true);
    assert.deepEqual(b.facts.map((f: any) => f.city), ["Hội An", "Tokyo"]);
    assert.ok(!JSON.stringify(b).includes("canon-"), "inspect shows the person their memories, not internal ids");
  });

  it("Inspect and the starters are ONE set: same cities, same order — even when the serve carries a query a re-rank would reorder", async () => {
    // Verifier finding 6: the starters used to read with a semanticQuery and
    // Inspect without, and searchMemories re-ranks before its limit — so a
    // starter could name a city Inspect never listed. "tokyo" would have
    // pulled Tokyo first for the starters only.
    setup({ feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    const inspect = (await (await call("GET", "/input-assistance/memory-context")).json()) as any;
    _resetRateLimit();
    const served = (await (await call("POST", "/input-assistance/suggest", { context: "compass_prompt", text: "tokyo", sessionContext: { surface: "compass" } })).json()) as any;
    const starterCities = memoryRows(served).map((s: any) => s.structuredValue.city);
    assert.deepEqual(starterCities, inspect.facts.map((f: any) => f.city).slice(0, starterCities.length));
    assert.deepEqual(starterCities, ["Hội An", "Tokyo"]);
  });

  it("flag OFF with a consent still on record: Inspect reads NO memory (verifier finding 9)", async () => {
    setup({ feature_flags: [flag(false)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    const b = (await (await call("GET", "/input-assistance/memory-context")).json()) as any;
    assert.equal(b.enabled, true, "the person's choice is still shown, so they can withdraw it");
    assert.equal(b.facts, null);
    assert.ok(!state.__reads!.includes("memory_derivative_registry"), "no memory read while the feature is off");
  });

  it("not opted in: says so, and reads no memory to say it", async () => {
    setup({ feature_flags: [flag(true)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    const b = (await (await call("GET", "/input-assistance/memory-context")).json()) as any;
    assert.equal(b.enabled, false);
    assert.equal(b.facts, null);
    assert.ok(!state.__reads!.includes("memory_derivative_registry"));
  });

  it("a failed memory read while opted in is REPORTED, not shown as 'you have no memories'", async () => {
    setup({ feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)], __fail: { memory_derivative_registry: true } });
    const b = (await (await call("GET", "/input-assistance/memory-context")).json()) as any;
    assert.equal(b.facts, null);
    assert.equal(b.factsUnavailable, true);
  });

  it("an unreadable opt-in is a 503", async () => {
    setup({ feature_flags: [flag(true)], __fail: { input_memory_context_consent: true } });
    assert.equal((await call("GET", "/input-assistance/memory-context")).status, 503);
  });
});

describe("PUT /input-assistance/memory-context-consent — explicit grant, one-step revoke", () => {
  it("a grant is refused while the flag is off, and nothing is written", async () => {
    setup({ feature_flags: [flag(false)] });
    const r = await call("PUT", "/input-assistance/memory-context-consent", { enabled: true, disclosureVersion: INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION });
    assert.equal(r.status, 404);
    assert.equal((state.input_memory_context_consent ?? []).length, 0);
  });

  it("a grant naming another disclosure is refused", async () => {
    setup({ feature_flags: [flag(true)] });
    const r = await call("PUT", "/input-assistance/memory-context-consent", { enabled: true, disclosureVersion: "input_outcome_learning_v1" });
    assert.equal(r.status, 409, "the OUTCOME disclosure is not consent to use memories");
  });

  it("a valid grant is server-stamped against the SESSION's user", async () => {
    setup({ feature_flags: [flag(true)] });
    const r = await call("PUT", "/input-assistance/memory-context-consent", { enabled: true, disclosureVersion: INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION, user_id: USER_B });
    assert.equal(r.status, 200);
    const row = state.input_memory_context_consent[0];
    assert.equal(row.user_id, USER_A);
    assert.equal(row.consent_version, INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION);
  });

  it("revoke works with the flag OFF, and the very next serve reads no memory", async () => {
    setup({ feature_flags: [flag(true)], input_memory_context_consent: [consent(USER_A)], memory_derivative_registry: [registry(USER_A, MEMORIES)] });
    state.feature_flags = [flag(false)];
    const r = await call("PUT", "/input-assistance/memory-context-consent", { enabled: false });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).enabled, false);
    state.feature_flags = [flag(true)];
    state.__reads = [];
    const body = (await (await compass()).json()) as any;
    assert.equal(memoryRows(body).length, 0);
    assert.ok(!state.__reads!.includes("memory_derivative_registry"));
  });

  it("the outcome-learning consent is NOT consent to use memories (one switch per purpose)", async () => {
    setup({
      feature_flags: [flag(true)],
      input_outcome_consent: [{ ...consent(USER_A), consent_version: "input_outcome_learning_v1" }],
      memory_derivative_registry: [registry(USER_A, MEMORIES)],
    });
    const body = (await (await compass()).json()) as any;
    assert.equal(memoryRows(body).length, 0);
  });
});

describe("the client shows the words the server stamps (a grant the server refuses is a dead switch)", () => {
  it("MEMORY_CONTEXT_DISCLOSURE_VERSION === INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION", () => {
    const client = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..",
      "travel-buddy-standalone/src/platform/input-assistance/services/memoryContext.ts"), "utf8");
    const m = client.match(/export const MEMORY_CONTEXT_DISCLOSURE_VERSION = '([^']+)';/);
    assert.ok(m, "client disclosure version not found");
    assert.equal(m![1], INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION);
  });
});

// ── Re-verification of 62f960a7c, finding 4: the fail-open mutant survived ────

describe("an UNREADABLE feature_flags read fails CLOSED — the flag row says ON, only the read failed", () => {
  const opted = (): FakeState => ({
    feature_flags: [flag(true)],
    input_memory_context_consent: [consent(USER_A)],
    memory_derivative_registry: [registry(USER_A, MEMORIES)],
    __fail: { feature_flags: true },
  });

  it("no memory starters, and neither the opt-in nor the memories are read", async () => {
    setup(opted());
    const r = await compass();
    assert.equal(r.status, 200);
    const body: unknown = await r.json();
    assert.equal(memoryRows(body).length, 0);
    assert.deepEqual(memoryReads(state), []);
  });

  it("Inspect reads NO memory and says the feature is not available", async () => {
    setup(opted());
    const b = (await (await call("GET", "/input-assistance/memory-context")).json()) as { available: boolean; facts: unknown };
    assert.equal(b.available, false);
    assert.equal(b.facts, null);
    assert.ok(!state.__reads!.includes("memory_derivative_registry"));
  });

  it("a grant is refused (404) and nothing is written", async () => {
    setup({ feature_flags: [flag(true)], __fail: { feature_flags: true } });
    const r = await call("PUT", "/input-assistance/memory-context-consent", { enabled: true, disclosureVersion: INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION });
    assert.equal(r.status, 404);
    assert.equal((state.input_memory_context_consent ?? []).length, 0);
  });
});
