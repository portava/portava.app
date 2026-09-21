/**
 * The NL trip draft must not report an OUTAGE as a fact about the user's text.
 *
 * THE DEFECT
 * ==========
 * `routes/tripDraft.ts` wrapped the whole extraction — the provider call AND
 * the parsing of what it returned — in one `try`/`catch` whose only exit was:
 *
 *     sendError(res, "invalid_payload", "could_not_extract");   // HTTP 400
 *
 * `invalid_payload` is 400: a statement that the REQUEST was bad. So a missing
 * API key, a 429, a provider 500, a DNS failure or a timeout — none of which
 * the caller caused and none of which the caller can fix — answered with the
 * same code and the same string as a model that genuinely found no trip in the
 * text. The two are indistinguishable on the wire, and `app/trip/new.tsx`
 * renders either one as *"Could not generate a draft. Fill the form manually."*
 * — telling a user their words were unusable when the extractor never ran.
 *
 * That is the failure this repository has fixed repeatedly elsewhere:
 * `lib/http.ts`'s ban gate refuses to make a claim it cannot support and sends
 * `degraded_unavailable` — "the check was NOT PERFORMED" — which is the only
 * retryable code in the envelope. The draft route now does the same.
 *
 * THE LINE THIS DRAWS
 * ===================
 *   provider never answered        → 503 degraded_unavailable, retryable
 *   provider answered, output junk → 400 invalid_payload 'could_not_extract'
 *
 * The second half is deliberately re-asserted here. The fix splits one
 * `try`/`catch` into two, and a split that quietly swept the model-output case
 * into 503 would be just as wrong in the other direction: it would tell the
 * user to retry a request that will fail identically every time.
 *
 * VACUITY TRAPS AVOIDED (the two `failOpenRouteReads.test.ts` names, plus one)
 * ===========================================================================
 *  1. No `assert.notEqual(status, 400)`. A request rejected at auth, at the
 *     flag gate or at body validation never reaches the provider call and
 *     would satisfy that. Every assertion below names the exact `error` code.
 *  2. The `req.log` shim the real server installs is present, so a route that
 *     crashed would 500 rather than pass as fail-closed.
 *  3. Each outage case asserts the model was actually REACHED (`calls === 1`),
 *     so a future change that short-circuits before the provider cannot make
 *     these pass without meaning it.
 *
 * Runtime: node:test + node:assert/strict. No network, no real DB, no real
 * OpenAI — the provider is injected through `_setTestOpenAI`.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/tripDraftExtractorOutage.test.ts
 */
import { describe, it, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";

// ── Fake supabase client ─────────────────────────────────────────────────────
// Only two tables matter here: `feature_flags` (the route's gate) and whatever
// an insert would land in — recorded so every case can prove NOTHING was
// written on a refusal.
type Row = Record<string, any>;

function makeFakeClient(flagEnabled: boolean) {
  const db: Record<string, { rows: Row[] }> = {
    feature_flags: { rows: [{ flag: "nl_trip_creation_enabled", enabled: flagEnabled }] },
  };
  const insertCalls: Array<{ table: string; payload: any }> = [];

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _one = false;

    const obj: any = {
      select: () => obj,
      insert(data: Row | Row[]) { _insert = data; insertCalls.push({ table: tableName, payload: data }); return obj; },
      update: () => obj,
      delete: () => obj,
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return obj; },
      order: () => obj,
      limit: () => obj,
      maybeSingle() { _one = true; return resolve(); },
      single()      { _one = true; return resolve(); },
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
          return { data: _one ? inserted[0] ?? null : inserted, error: null };
        }
        const rows = table.rows.filter((r) => filters.every((f) => f(r)));
        if (_one) return { data: rows[0] ?? null, error: null };
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
    from: (t: string) => chain(t),
  };
  return { client, insertCalls };
}

// ── Injected providers ───────────────────────────────────────────────────────

/** A provider whose call REJECTS — the shape a 429, a 500 or a socket error takes. */
function providerThatRejects(err: Error, capture: { calls: number }) {
  return {
    chat: { completions: { create: async () => { capture.calls++; throw err; } } },
  } as any;
}

/** A provider that ANSWERS, with the given assistant content. */
function providerThatAnswers(content: string, capture: { calls: number }) {
  return {
    chat: {
      completions: {
        create: async () => { capture.calls++; return { choices: [{ message: { role: "assistant", content } }] }; },
      },
    },
  } as any;
}

// ── Server (the REAL router, mounted; routes/index.ts is not touched) ─────────

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

async function draftFromText(body: any, token = "user-token"): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/trips/draft-from-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let out: any = null;
  try { out = await r.json(); } catch { out = null; }
  return { status: r.status, body: out };
}

const TEXT = "Five chill days eating our way around Tokyo, Nov 3 to Nov 8 2026";

describe("POST /trips/draft-from-text — an extractor outage is not a verdict on the user's text", () => {
  beforeEach(async () => {
    if (server) server.close();
    await startServer();
  });
  afterEach(() => { _setTestOpenAI(null); });
  after(() => {
    if (server) server.close();
    _setTestClient(null as any, false);
    _setTestOpenAI(null);
  });

  it("a provider REJECTION is 503 degraded_unavailable and retryable — never 400 'could_not_extract'", async () => {
    const { client, insertCalls } = makeFakeClient(true);
    _setTestClient(client, true);
    const capture = { calls: 0 };
    _setTestOpenAI(providerThatRejects(new Error("429 Too Many Requests"), capture));

    const r = await draftFromText({ text: TEXT });

    assert.equal(capture.calls, 1, "the provider must actually have been reached");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true, "an outage the caller can retry must say so");
    assert.notEqual(
      r.body.message, "could_not_extract",
      "an outage must not be phrased as a finding about the user's text",
    );
    assert.equal(insertCalls.length, 0, "a refusal must write nothing");
  });

  it("a provider that throws the missing-key error is the same 503, not a 400", async () => {
    const { client } = makeFakeClient(true);
    _setTestClient(client, true);
    const capture = { calls: 0 };
    _setTestOpenAI(providerThatRejects(new Error("401 Incorrect API key provided: not-configured"), capture));

    const r = await draftFromText({ text: TEXT });

    assert.equal(capture.calls, 1);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("the provider's error text NEVER reaches the caller", async () => {
    const { client } = makeFakeClient(true);
    _setTestClient(client, true);
    const capture = { calls: 0 };
    _setTestOpenAI(providerThatRejects(new Error("sk-live-SECRET-KEY rejected by upstream host 10.0.0.4"), capture));

    const r = await draftFromText({ text: TEXT });

    assert.equal(r.status, 503);
    const wire = JSON.stringify(r.body);
    assert.ok(!wire.includes("sk-live-SECRET-KEY"), "provider error text leaked to the caller");
    assert.ok(!wire.includes("10.0.0.4"), "provider error text leaked to the caller");
  });

  it("REGRESSION GUARD: a provider that ANSWERS with junk is still 400 invalid_payload 'could_not_extract'", async () => {
    const { client, insertCalls } = makeFakeClient(true);
    _setTestClient(client, true);
    const capture = { calls: 0 };
    _setTestOpenAI(providerThatAnswers("I had trouble with that, here is prose instead of JSON", capture));

    const r = await draftFromText({ text: TEXT });

    assert.equal(capture.calls, 1);
    assert.equal(r.status, 400, "the model ran and produced nothing usable — that is not an outage");
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(r.body.message, "could_not_extract");
    assert.equal(insertCalls.length, 0);
  });

  it("REGRESSION GUARD: a provider that answers a well-formed EMPTY draft is a 200, not either error", async () => {
    const { client } = makeFakeClient(true);
    _setTestClient(client, true);
    const capture = { calls: 0 };
    _setTestOpenAI(providerThatAnswers(JSON.stringify({ draft: {} }), capture));

    const r = await draftFromText({ text: "somewhere nice" });

    assert.equal(capture.calls, 1);
    assert.equal(r.status, 200);
    assert.equal(r.body.confirmed, false);
    assert.deepEqual(r.body.draft, {});
  });
});
