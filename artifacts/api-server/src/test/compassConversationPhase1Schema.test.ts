/**
 * census-compass C1-01 — the phase-1 conversation schema, AS STATED.
 *
 * docs/specs/compass-phase1-spec.md §1: `compass_conversations (…, trip_id
 * nullable, …, status)` and messages with `role user|assistant|system-event`.
 * Migration 20260723 shipped none of the three, and C1-01 has read "the
 * stated schema ✗" since §13.3 while its other five criteria pass.
 *
 * This suite pins:
 *   A. migration 2996 declares the three, in the 2100-2999 band, idempotently;
 *   B. the service names the new columns ONLY where a probe finds them — so
 *      a build carrying 2996 runs unchanged against a database without it —
 *      and, where it finds them, writes `trip_id` and `status`, reuses only
 *      active conversations, and can append a `system-event`;
 *   C. `/compass/ask` accepts `tripId`, and a `system-event` row is never
 *      handed to the model as a turn.
 *
 * Mutation log (2026-09-20; each applied alone, suite run, source restored):
 *   M1 the INSERT names status/trip_id on a database without 2996 → 1 red
 *   M2 an archived conversation is reused                          → 1 red
 *   M3 a system-event is written when the schema is not ready     → 1 red
 *   M4 modelTurns hands system-event rows to the model            → 1 red
 *   M5 an unreadable probe is treated as "absent"                 → 1 red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassConversationPhase1Schema.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendSystemEvent,
  archiveConversation,
  conversationSchemaReady,
  getOrCreateConversation,
  loadHistory,
  modelTurns,
} from "../services/compass/CompassConversationService.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const USER = "11111111-0000-4000-8000-000000000001";
const TRIP = "22222222-0000-4000-8000-000000000002";
const CONV = "33333333-0000-4000-8000-000000000003";
const nowIso = () => new Date().toISOString();

type Schema = "ready" | "absent" | "unreadable" | "probe_outage";

/**
 * A fake whose `compass_conversations` table either HAS the 2996 columns
 * (`ready`), answers a select naming them with Postgres's 42703 (`absent`), or
 * fails every read (`unreadable`), or fails ONLY the select that names the new
 * columns with a non-42703 error while everything else works (`probe_outage`
 * — the case that tells "unreadable" from "absent"). Every attempted write is
 * counted, succeeded or not, so a refusal that happened at the database can
 * be told from one that happened in the service.
 */
function makeClient(schema: Schema, seed: Record<string, any[]> = {}) {
  const store: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) store[k] = v.map((r) => ({ ...r }));
  const inserted: Record<string, any[]> = {};
  const attempted: Record<string, number> = {};
  let gen = 0;
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let cols = "";
    let mode: "select" | "insert" | "update" = "select";
    let payload: any = null;
    let patch: any = null;
    let lim: number | null = null;
    const namesNew = () => /\b(trip_id|status)\b/.test(cols) || (payload && ("trip_id" in payload || "status" in payload)) || (patch && "status" in patch);
    const settle = () => {
      if (mode !== "select") attempted[table] = (attempted[table] ?? 0) + 1;
      if (table === "compass_conversations") {
        if (schema === "unreadable") return { data: null, error: { message: "injected outage", code: "XX000" } };
        if (schema === "probe_outage" && mode === "select" && /\btrip_id\b/.test(cols)) return { data: null, error: { message: "injected outage on the probe", code: "XX000" } };
        if (schema === "absent" && namesNew()) return { data: null, error: { message: 'column compass_conversations.status does not exist', code: "42703" } };
      }
      if (table === "compass_conversation_messages" && schema === "absent" && payload?.role === "system-event") {
        return { data: null, error: { message: 'new row violates check constraint "compass_conversation_messages_role_check"', code: "23514" } };
      }
      store[table] = store[table] ?? [];
      if (mode === "insert") {
        const row = { id: `gen-${table}-${gen++}`, created_at: nowIso(), last_active_at: nowIso(), ...payload };
        store[table].push(row); (inserted[table] ??= []).push(row);
        return { data: [row], error: null };
      }
      if (mode === "update") {
        const t = store[table].filter((r) => preds.every((p) => p(r)));
        for (const r of t) Object.assign(r, patch);
        return { data: t, error: null };
      }
      let out = store[table].filter((r) => preds.every((p) => p(r)));
      if (lim !== null) out = out.slice(0, lim);
      return { data: out, error: null };
    };
    const b: any = {
      select(c?: string) { cols = c ?? ""; return b; },
      insert(p: any) { mode = "insert"; payload = Array.isArray(p) ? p[0] : p; return b; },
      update(p: any) { mode = "update"; patch = p; return b; },
      eq(col: string, v: any) { preds.push((r) => r?.[col] === v); return b; },
      in(col: string, vs: any[]) { preds.push((r) => vs.includes(r?.[col])); return b; },
      order() { return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { const s = settle(); return Promise.resolve({ data: s.error ? null : (s.data as any[])[0] ?? null, error: s.error }); },
      single() { const s = settle(); return Promise.resolve({ data: s.error ? null : (s.data as any[])[0] ?? null, error: s.error }); },
      then(res: any, rej?: any) { return Promise.resolve(settle()).then(res, rej); },
    };
    return b;
  }
  return { from, _store: store, _inserted: inserted, _attempted: attempted };
}

describe("A. migration 2996 states the schema the spec states", () => {
  const sql = readFileSync(join(SRC, "migrations", "2996_compass_conversations_phase1_schema.sql"), "utf8");
  it("adds trip_id (nullable, FK trips, SET NULL) and status (active|archived) to compass_conversations", () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS trip_id UUID NULL REFERENCES public\.trips\(id\) ON DELETE SET NULL/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'/);
    assert.match(sql, /CHECK \(status IN \('active', 'archived'\)\)/);
  });
  it("admits system-event as a message role, replacing 20260723's CHECK by its measured name", () => {
    assert.match(sql, /DROP CONSTRAINT IF EXISTS compass_conversation_messages_role_check/);
    assert.match(sql, /CHECK \(role IN \('user', 'assistant', 'system-event'\)\)/);
  });
  it("verifies its own end state and sits in the 2100-2999 band", () => {
    assert.match(sql, /DO \$post\$/);
    assert.match(sql, /RAISE EXCEPTION '2996: role CHECK does not admit system-event/);
  });
});

describe("B. the service — names the columns only where they exist", () => {
  it("READY: a new conversation carries trip_id and status=active", async () => {
    const sc = makeClient("ready");
    const id = await getOrCreateConversation(sc as any, USER, undefined, { tripId: TRIP });
    assert.ok(id);
    const row = sc._inserted.compass_conversations?.[0];
    assert.equal(row?.trip_id, TRIP);
    assert.equal(row?.status, "active");
    assert.equal(await conversationSchemaReady(sc as any), "ready");
  });

  it("READY: an ARCHIVED conversation is not reused even when fresh; a live one is", async () => {
    const live = makeClient("ready", { compass_conversations: [{ id: CONV, user_id: USER, last_active_at: nowIso(), status: "active" }] });
    assert.equal(await getOrCreateConversation(live as any, USER, CONV), CONV);
    assert.equal((live._inserted.compass_conversations ?? []).length, 0);

    const archived = makeClient("ready", { compass_conversations: [{ id: CONV, user_id: USER, last_active_at: nowIso(), status: "archived" }] });
    const id = await getOrCreateConversation(archived as any, USER, CONV);
    assert.notEqual(id, CONV, "an archived conversation was resumed");
    assert.equal((archived._inserted.compass_conversations ?? []).length, 1);
  });

  it("READY: archiveConversation sets status=archived for the owner only", async () => {
    const sc = makeClient("ready", { compass_conversations: [{ id: CONV, user_id: USER, last_active_at: nowIso(), status: "active" }] });
    assert.equal(await archiveConversation(sc as any, CONV, "someone-else"), false);
    assert.equal(sc._store.compass_conversations[0].status, "active");
    assert.equal(await archiveConversation(sc as any, CONV, USER), true);
    assert.equal(sc._store.compass_conversations[0].status, "archived");
  });

  it("READY: a system-event is appended with its payload and read back by loadHistory", async () => {
    const sc = makeClient("ready", { compass_conversations: [{ id: CONV, user_id: USER, last_active_at: nowIso(), status: "active" }] });
    assert.equal(await appendSystemEvent(sc as any, CONV, "assistant_unavailable", { fallbackReason: "ai_error" }), true);
    const row = sc._inserted.compass_conversation_messages?.[0];
    assert.equal(row?.role, "system-event");
    assert.equal(row?.content, "assistant_unavailable");
    assert.deepEqual(row?.payload, { fallbackReason: "ai_error" });
    const hist = await loadHistory(sc as any, CONV);
    assert.equal(hist.length, 1);
    assert.equal(hist[0]!.role, "system-event");
  });

  it("ABSENT (production before 2996): the columns are never named, the conversation still works, and a system-event is REFUSED", async () => {
    const sc = makeClient("absent");
    const id = await getOrCreateConversation(sc as any, USER, undefined, { tripId: TRIP });
    assert.ok(id);
    const row = sc._inserted.compass_conversations?.[0];
    assert.ok(row, "no conversation was created");
    assert.ok(!("trip_id" in row) && !("status" in row), `a column the database lacks was named: ${JSON.stringify(row)}`);
    assert.equal(await conversationSchemaReady(sc as any), "absent");
    assert.equal(await appendSystemEvent(sc as any, id, "assistant_unavailable", {}), false);
    assert.equal(sc._attempted.compass_conversation_messages ?? 0, 0, "a system-event row was ATTEMPTED against the old CHECK — the refusal must happen in the service, not at the database");
  });

  it("PROBE OUTAGE (a non-42703 failure on the probe alone): an outage, not 'absent' — nothing is inserted on the legacy shape", async () => {
    const sc = makeClient("probe_outage");
    assert.equal(await conversationSchemaReady(sc as any), "unreadable");
    await assert.rejects(() => getOrCreateConversation(sc as any, USER, undefined, { tripId: TRIP }));
    assert.equal(sc._attempted.compass_conversations ?? 0, 0, "a legacy-shaped conversation was created on an outage read as 'no such column'");
  });

  it("UNREADABLE: the probe failing is an outage, not 'no such column' — the caller's fallback answers, nothing is inserted", async () => {
    const sc = makeClient("unreadable");
    await assert.rejects(() => getOrCreateConversation(sc as any, USER, undefined, { tripId: TRIP }));
    assert.equal((sc._inserted.compass_conversations ?? []).length, 0);
  });

  it("a system-event is never a model turn", () => {
    const turns = modelTurns([
      { role: "user", content: "hi", payload: null, promptVersion: null, createdAt: nowIso() },
      { role: "system-event", content: "assistant_unavailable", payload: { fallbackReason: "ai_error" }, promptVersion: null, createdAt: nowIso() },
      { role: "assistant", content: "hello", payload: null, promptVersion: null, createdAt: nowIso() },
    ]);
    assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
  });
});

describe("C. the route", () => {
  const route = strip(readFileSync(join(SRC, "routes", "compass.ts"), "utf8"));
  it("accepts tripId on /compass/ask and hands it to the conversation", () => {
    assert.match(route, /tripId:\s+z\.string\(\)\.uuid\(\)\.optional\(\)/);
    assert.match(route, /getOrCreateConversation\(sc, user\.id, incomingConvId, \{ tripId/);
  });
  it("builds the model's history from modelTurns, never from raw roles", () => {
    assert.match(route, /modelTurns\(history\)/);
    assert.doesNotMatch(route, /history\.map\(\(h\) => \(\{ role: h\.role as "user" \| "assistant"/);
  });
  it("records the ai_error fallback as a system-event in the conversation", () => {
    assert.match(route, /appendSystemEvent\(sc, conversationId, "assistant_unavailable"/);
  });
});
