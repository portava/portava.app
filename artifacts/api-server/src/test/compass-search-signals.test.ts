/**
 * Compass search-signal pipeline integration tests.
 *
 * Covers POST /api/compass/signals/search:
 *   - authenticated request with a category nudges category_weights +1
 *   - repeated calls clamp at +10 (never exceed ±10 bound)
 *   - unauthenticated request returns 401, no DB write
 *   - category "for_you" does NOT touch the DB
 *   - missing category does NOT touch the DB
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-search-signals.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import compassRouter from "../routes/compass.js";

// ── Fake Supabase client ───────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeClient(store: Record<string, Row[]> = {}) {
  const s = store;
  function tbl(name: string): Row[] {
    if (!s[name]) s[name] = [];
    return s[name]!;
  }

  function builder(tableName: string) {
    let _rows: Row[] = [...tbl(tableName)];
    let _eqFilters: [string, unknown][] = [];

    function applyFilters(rows: Row[]) {
      return rows.filter((r) => _eqFilters.every(([k, v]) => r[k] === v));
    }

    const b: any = {};

    b.select = (_cols?: string) => { _rows = [...tbl(tableName)]; return b; };
    b.eq     = (k: string, v: unknown) => { _eqFilters.push([k, v]); return b; };

    b.maybeSingle = () => ({
      then: (resolve: Function) =>
        resolve({ data: applyFilters(_rows)[0] ?? null, error: null }),
    });

    b.upsert = (row: Row, _opts?: unknown) => {
      const existing = tbl(tableName);
      const idx = existing.findIndex((r) => r["user_id"] === row["user_id"]);
      if (idx >= 0) existing[idx] = { ...existing[idx]!, ...row };
      else existing.push({ ...row });
      return { then: (res: Function) => res({ data: null, error: null }) };
    };

    b.insert = (row: Row | Row[]) => {
      const rows = Array.isArray(row) ? row : [row];
      for (const r of rows) tbl(tableName).push({ ...r });
      return { then: (res: Function) => res({ data: rows, error: null }) };
    };

    b.update = (patch: Row) => {
      for (const r of applyFilters(tbl(tableName))) Object.assign(r, patch);
      return b;
    };

    b.delete = () => {
      s[tableName] = tbl(tableName).filter((r) => !applyFilters([r]).length);
      return { then: (res: Function) => res({ data: null, error: null }) };
    };

    b.then = (resolve: Function) =>
      resolve({ data: applyFilters(_rows), error: null });

    return b;
  }

  return {
    fakeClient: {
      from: (name: string) => builder(name),
      auth: {
        getUser: (token: string) =>
          token === "valid-token"
            ? Promise.resolve({ data: { user: { id: "00000000-0000-0000-0000-000000000001" } }, error: null })
            : Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
      },
    } as any,
    store: s,
  };
}

// ── Mini express app ───────────────────────────────────────────────────────────

const USER_ID = "00000000-0000-0000-0000-000000000001";

const testApp = express();
testApp.use(express.json());
testApp.use((req: any, _res: any, next: any) => {
  req.log = pino({ level: "silent" });
  next();
});
testApp.use("/api", compassRouter);

let server: Server;
let base: string;

before(async () => {
  server = createServer(testApp);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((res, rej) =>
    server.close((e) => (e ? rej(e) : res())),
  );
});

async function post(
  path: string,
  body: unknown,
  token = "valid-token",
) {
  const resp = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}

/** Wait long enough for the detached async IIFE inside the route to flush. */
function flushAsync(): Promise<void> {
  return new Promise((res) => setTimeout(res, 50));
}

// ── POST /api/compass/signals/search ─────────────────────────────────────────

describe("POST /api/compass/signals/search", () => {
  it("nudges category_weights +1 for an authenticated search with a category", async () => {
    const { fakeClient, store } = makeFakeClient({});
    _setTestClient(fakeClient, true);

    const { status, json } = await post(
      "/api/compass/signals/search",
      { query: "tacos", category: "food" },
    );

    assert.equal(status, 202);
    assert.deepEqual(json, { ok: true });

    // Wait for the detached async weight-nudge to complete.
    await flushAsync();

    const prefs = (store["compass_user_preferences"] ?? []).find(
      (r) => r["user_id"] === USER_ID,
    );
    assert.ok(prefs, "a compass_user_preferences row should have been written");
    const weights = prefs!["category_weights"] as Record<string, number>;
    assert.equal(weights["food"], 1, "food weight should be nudged to 1");
  });

  it("increments from an existing weight and clamps at +10", async () => {
    const { fakeClient, store } = makeFakeClient({
      compass_user_preferences: [
        {
          user_id:          USER_ID,
          category_weights: { food: 9 },
          updated_at:       "2026-07-01T00:00:00Z",
        },
      ],
    });
    _setTestClient(fakeClient, true);

    // First call: 9 → 10
    await post("/api/compass/signals/search", { query: "pizza", category: "food" });
    await flushAsync();

    let weights = (store["compass_user_preferences"]!.find(
      (r) => r["user_id"] === USER_ID,
    )!["category_weights"]) as Record<string, number>;
    assert.equal(weights["food"], 10, "weight should reach the +10 ceiling");

    // Second call: already at 10 → must stay at 10
    await post("/api/compass/signals/search", { query: "burger", category: "food" });
    await flushAsync();

    weights = (store["compass_user_preferences"]!.find(
      (r) => r["user_id"] === USER_ID,
    )!["category_weights"]) as Record<string, number>;
    assert.equal(weights["food"], 10, "weight must never exceed +10");
  });

  it("returns 401 and writes nothing when unauthenticated", async () => {
    const { fakeClient, store } = makeFakeClient({});
    _setTestClient(fakeClient, true);

    const { status } = await post(
      "/api/compass/signals/search",
      { query: "nightclub", category: "nightlife" },
      "bad-token",
    );

    assert.equal(status, 401);
    await flushAsync();
    assert.equal(
      (store["compass_user_preferences"] ?? []).length,
      0,
      "no DB write should occur for unauthenticated requests",
    );
  });

  it("does NOT touch the DB when category is 'for_you'", async () => {
    const { fakeClient, store } = makeFakeClient({});
    _setTestClient(fakeClient, true);

    const { status } = await post(
      "/api/compass/signals/search",
      { query: "everything", category: "for_you" },
    );

    assert.equal(status, 202);
    await flushAsync();
    assert.equal(
      (store["compass_user_preferences"] ?? []).length,
      0,
      "for_you category must not write any weight rows",
    );
  });

  it("does NOT touch the DB when category is missing", async () => {
    const { fakeClient, store } = makeFakeClient({});
    _setTestClient(fakeClient, true);

    const { status } = await post(
      "/api/compass/signals/search",
      { query: "nice restaurants" },
    );

    assert.equal(status, 202);
    await flushAsync();
    assert.equal(
      (store["compass_user_preferences"] ?? []).length,
      0,
      "missing category must not write any weight rows",
    );
  });
});
