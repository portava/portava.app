/**
 * NL trip draft tests — POST /trips/draft-from-text
 *
 * Covers:
 *  - Extraction round-trip with a fake OpenAI (fenced JSON is stripped)
 *  - NO DB WRITE EVER: zero insert calls on the fake client
 *  - Input reaches the model UGC-wrapped
 *  - Flag gate (nl_trip_creation_enabled)
 *  - 2000-char length cap (model is never called on oversized input)
 *  - Parse failure → 400 invalid_payload 'could_not_extract'
 *
 * Runtime: node:test + node:assert/strict. No network / no real DB.
 * Run: node --import tsx/esm --test src/test/tripDraft.test.ts
 */
import { describe, it, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

// ── Fake supabase client (records every insert call) ──────────────────────────
type Row = Record<string, any>;
interface FakeTable { rows: Row[]; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    feature_flags: tables.feature_flags ?? { rows: [] },
    profiles:      tables.profiles      ?? { rows: [] },
    trips:         tables.trips         ?? { rows: [] },
    ...tables,
  };

  const insertCalls: Array<{ table: string; payload: any }> = [];

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _single = false;
    let _maybeSingle = false;

    const obj: any = {
      select: () => obj,
      insert(data: Row | Row[]) {
        _insert = data;
        insertCalls.push({ table: tableName, payload: data });
        return obj;
      },
      update: () => obj,
      delete: () => obj,
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return obj; },
      order: () => obj,
      limit: () => obj,
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single = true;      return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function resolve(): Promise<{ data: any; error: any }> {
      return Promise.resolve().then(() => {
        if (!db[tableName]) db[tableName] = { rows: [] };
        const table = db[tableName];
        if (_insert !== null) {
          const rows = Array.isArray(_insert) ? _insert : [_insert];
          const inserted = rows.map((r) => ({ id: "inserted-id", ...r }));
          table.rows.push(...inserted);
          return { data: _single || _maybeSingle ? inserted[0] ?? null : inserted, error: null };
        }
        const rows = table.rows.filter((r) => filters.every((f) => f(r)));
        if (_single || _maybeSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      });
    }

    return obj;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) =>
        token === "user-token"
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
    from: (tableName: string) => chain(tableName),
    _insertCalls: insertCalls,
  };

  return { client, insertCalls };
}

function flagOn(enabled: boolean): Record<string, FakeTable> {
  return { feature_flags: { rows: [{ flag: "nl_trip_creation_enabled", enabled }] } };
}

// ── Fake OpenAI ───────────────────────────────────────────────────────────────

function makeOpenAIMock(content: string, capture?: { opts: any[]; calls: number }) {
  return {
    chat: {
      completions: {
        create: async (opts: any) => {
          if (capture) { capture.opts.push(opts); capture.calls++; }
          return { choices: [{ message: { role: "assistant", content } }] };
        },
      },
    },
  } as any;
}

const FENCED_DRAFT =
  "```json\n" +
  JSON.stringify({
    draft: {
      title: "Tokyo food trip",
      destinationCity: "Tokyo",
      destinationCountry: "Japan",
      startDate: "2026-11-03",
      endDate: "2026-11-08",
      vibe: "chill food trip",
    },
  }) +
  "\n```";

const MULTI_CITY_DRAFT =
  "```json\n" +
  JSON.stringify({
    draft: {
      title: "Japan trip",
      destinationCity: "Tokyo",
      destinationCountry: "Japan",
      destinations: [
        { city: "Tokyo", country: "Japan" },
        { city: "Kyoto", country: "Japan" },
        { city: "Osaka", country: "Japan" },
      ],
      startDate: "2026-10-01",
      endDate: "2026-10-21",
      vibe: "culture and food",
    },
  }) +
  "\n```";

const MULTI_CITY_WITH_DATES_DRAFT =
  "```json\n" +
  JSON.stringify({
    draft: {
      title: "Japan multi-stop",
      destinationCity: "Tokyo",
      destinationCountry: "Japan",
      destinations: [
        { city: "Tokyo", country: "Japan", arrivalDate: "2026-10-01", departureDate: "2026-10-08" },
        { city: "Kyoto", country: "Japan", arrivalDate: "2026-10-08", departureDate: "2026-10-11" },
      ],
      startDate: "2026-10-01",
      endDate: "2026-10-11",
      vibe: "culture",
    },
  }) +
  "\n```";

// ── Server setup (router mounted directly; index.ts is not edited) ────────────

let app: Express;
let server: Server;
let port: number;

async function startServer() {
  const { default: tripDraftRouter } = await import("../routes/tripDraft.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", tripDraftRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
}

async function draftFromText(
  body: any,
  token = "user-token",
): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/trips/draft-from-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let out: any = null;
  try { out = await r.json(); } catch { out = null; }
  return { status: r.status, body: out };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /trips/draft-from-text", () => {
  beforeEach(async () => {
    if (server) server.close();
    await startServer();
  });

  afterEach(() => {
    _setTestOpenAI(null);
  });

  after(() => {
    if (server) server.close();
    _setTestClient(null as any, false);
    _setTestOpenAI(null);
  });

  it("round-trips a fenced draft and NEVER writes to the DB", async () => {
    const { client, insertCalls } = makeFakeClient(flagOn(true));
    _setTestClient(client, true);
    const capture = { opts: [] as any[], calls: 0 };
    _setTestOpenAI(makeOpenAIMock(FENCED_DRAFT, capture));

    const text = "Thinking 5 chill days eating our way around Tokyo, Nov 3 to Nov 8 2026";
    const r = await draftFromText({ text });

    assert.equal(r.status, 200);
    assert.equal(r.body.confirmed, false);
    assert.equal(r.body.message, "Review and confirm to create this trip.");
    assert.equal(r.body.draft.destinationCity, "Tokyo");
    assert.equal(r.body.draft.destinationCountry, "Japan");
    assert.equal(r.body.draft.startDate, "2026-11-03");
    assert.equal(r.body.draft.endDate, "2026-11-08");

    assert.equal(insertCalls.length, 0, "draft extraction must NEVER insert anything");

    // Model discipline: UGC-wrapped input, gpt-4o-mini, temperature 0.
    const sent = capture.opts[0];
    const userMsg = sent.messages.find((m: any) => m.role === "user");
    assert.ok(userMsg.content.includes("<portava:ugc>"), "text must be UGC-wrapped");
    assert.ok(userMsg.content.includes(text));
    assert.equal(sent.model, "gpt-4o-mini");
    assert.equal(sent.temperature, 0);
  });

  it("extracts a destinations[] array for multi-city trips", async () => {
    const { client, insertCalls } = makeFakeClient(flagOn(true));
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock(MULTI_CITY_DRAFT));

    const text = "Three weeks in Japan — Tokyo then Kyoto then Osaka, October 1–21 2026";
    const r = await draftFromText({ text });

    assert.equal(r.status, 200);
    assert.equal(r.body.confirmed, false);
    assert.ok(Array.isArray(r.body.draft.destinations), "destinations must be an array");
    assert.equal(r.body.draft.destinations.length, 3);
    assert.equal(r.body.draft.destinations[0].city, "Tokyo");
    assert.equal(r.body.draft.destinations[1].city, "Kyoto");
    assert.equal(r.body.draft.destinations[2].city, "Osaka");
    assert.equal(r.body.draft.destinationCity, "Tokyo");
    assert.equal(r.body.draft.startDate, "2026-10-01");
    assert.equal(r.body.draft.endDate, "2026-10-21");
    assert.equal(insertCalls.length, 0, "draft extraction must NEVER insert anything");
  });

  it("extracts per-stop arrivalDate/departureDate for multi-city trips", async () => {
    const { client, insertCalls } = makeFakeClient(flagOn(true));
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock(MULTI_CITY_WITH_DATES_DRAFT));

    const text = "Tokyo for a week then Kyoto for 3 days, Oct 1–11 2026";
    const r = await draftFromText({ text });

    assert.equal(r.status, 200);
    assert.equal(r.body.confirmed, false);
    assert.ok(Array.isArray(r.body.draft.destinations), "destinations must be an array");
    assert.equal(r.body.draft.destinations.length, 2);

    const tokyo = r.body.draft.destinations[0];
    assert.equal(tokyo.city, "Tokyo");
    assert.equal(tokyo.arrivalDate, "2026-10-01");
    assert.equal(tokyo.departureDate, "2026-10-08");

    const kyoto = r.body.draft.destinations[1];
    assert.equal(kyoto.city, "Kyoto");
    assert.equal(kyoto.arrivalDate, "2026-10-08");
    assert.equal(kyoto.departureDate, "2026-10-11");

    assert.equal(r.body.draft.startDate, "2026-10-01");
    assert.equal(r.body.draft.endDate, "2026-10-11");
    assert.equal(insertCalls.length, 0, "draft extraction must NEVER insert anything");
  });

  it("is gated by the nl_trip_creation_enabled flag", async () => {
    const { client } = makeFakeClient(flagOn(false));
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock(FENCED_DRAFT));

    const r = await draftFromText({ text: "a week in Rome" });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("rejects text over 2000 chars without calling the model", async () => {
    const { client, insertCalls } = makeFakeClient(flagOn(true));
    _setTestClient(client, true);
    const capture = { opts: [] as any[], calls: 0 };
    _setTestOpenAI(makeOpenAIMock(FENCED_DRAFT, capture));

    const r = await draftFromText({ text: "x".repeat(2001) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(capture.calls, 0, "oversized input must not reach the model");
    assert.equal(insertCalls.length, 0);
  });

  it("returns invalid_payload 'could_not_extract' when the model output is unparseable", async () => {
    const { client, insertCalls } = makeFakeClient(flagOn(true));
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock("I had trouble with that, here is prose instead of JSON"));

    const r = await draftFromText({ text: "somewhere sunny in spring" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(r.body.message, "could_not_extract");
    assert.equal(insertCalls.length, 0);
  });

  it("requires auth", async () => {
    const { client } = makeFakeClient(flagOn(true));
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock(FENCED_DRAFT));

    const r = await draftFromText({ text: "a week in Rome" }, "bad-token");
    assert.equal(r.status, 401);
  });
});
