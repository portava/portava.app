/**
 * rent_buddy_launch_controls — NULL-safe identity: write, then read back.
 *
 * ── WHAT THIS PROTECTS ──────────────────────────────────────────────────────
 * The table's identity is `UNIQUE (country_code, city, category)`, all three
 * NULLABLE, and a plain PostgreSQL UNIQUE constraint is NULLS DISTINCT. The
 * global launch control -- what the kill switch writes and what
 * enforceBookingCreationGates falls back to -- has the key (NULL, NULL, NULL);
 * every category control has (NULL, NULL, '<category>'). Neither can ever
 * conflict with itself, so `ON CONFLICT (country_code, city, category)` never
 * fires for them and each admin press INSERTs a duplicate. Once duplicated, a
 * `.maybeSingle()` read of that key errors and hands the caller `data: null` --
 * a duplicated control read as a missing one.
 *
 * ── THE FAKE MODELS THE DATABASE, NOT THE CODE ──────────────────────────────
 * `applyUpsert` below reproduces NULLS DISTINCT exactly: an `onConflict`
 * arbiter whose key contains a NULL matches nothing and falls through to an
 * INSERT, precisely as Postgres does. That is what makes these tests
 * load-bearing rather than decorative -- restore the old
 * `.upsert(..., { onConflict: "country_code,city,category" })` at any of the
 * five admin writers and the duplicate assertions go red, because the fake
 * duplicates for the same reason the database did.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddyLaunchControlIdentity.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddySpecRouter from "../routes/rentABuddySpec.js";
import {
  applyLaunchControlKey,
  findLaunchControlRow,
  normalizeLaunchControlKey,
  upsertLaunchControlRow,
} from "../lib/rentBuddyLaunchControls.js";

// ── Fake launch-control table ────────────────────────────────────────────────

interface LCState {
  controls: any[];
  /** Every write the fake performed, in order, so a test can prove which ran. */
  ops: Array<{ op: "insert" | "update" | "upsert-insert" | "upsert-update"; row: any }>;
  adminActions: any[];
  profiles: Record<string, any>;
  seq: number;
}

let state: LCState;

function resetState(controls: any[] = []) {
  state = {
    controls: controls.map((c) => ({ ...c })),
    ops: [],
    adminActions: [],
    profiles: { [ADMIN_ID]: { id: ADMIN_ID, role: "admin" } },
    seq: 0,
  };
}

/** SQL `IS NOT DISTINCT FROM` over the three key columns. */
function sameKey(a: any, b: any): boolean {
  return ["country_code", "city", "category"].every(
    (c) => (a[c] ?? null) === (b[c] ?? null),
  );
}

/**
 * NULLS DISTINCT `ON CONFLICT`: the arbiter index cannot match a row whose key
 * contains a NULL, so such a write always INSERTs. This is the database's real
 * behaviour and the whole reason the fix exists.
 */
function applyUpsert(row: any) {
  const keyHasNull = ["country_code", "city", "category"].some((c) => (row[c] ?? null) === null);
  if (!keyHasNull) {
    const existing = state.controls.find((c) => sameKey(c, row));
    if (existing) {
      Object.assign(existing, row);
      state.ops.push({ op: "upsert-update", row: existing });
      return existing;
    }
  }
  const inserted = { id: `lc-${++state.seq}`, ...row };
  state.controls.push(inserted);
  state.ops.push({ op: "upsert-insert", row: inserted });
  return inserted;
}

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _insert: null as any,
      _update: null as any,
      _upsert: null as any,
      _single: false,
      _limit: null as number | null,

      select() { return this; },
      insert(d: any) { this._insert = d; return this; },
      update(d: any) { this._update = d; return this; },
      upsert(d: any, _o?: any) { this._upsert = d; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      // Distinct from eq: `.eq(col, null)` emits `col = NULL` and matches nothing.
      is(col: string, val: any) { this._filters.push(["is", col, val]); return this; },
      limit(n: number) { this._limit = n; return this; },
      order() { return this; },
      maybeSingle() { this._single = true; return this; },
      single() { this._single = true; return this; },

      async then(resolve: (v: any) => void) {
        const r = await this._resolve();
        resolve(r);
        return r;
      },

      _match(rows: any[]): any[] {
        let out = rows;
        for (const [op, col, val] of this._filters) {
          if (op === "eq") out = out.filter((r) => r[col] === val);
          if (op === "is") out = out.filter((r) => (r[col] ?? null) === val);
        }
        return out;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (this._upsert !== null) {
          const row = applyUpsert(this._upsert);
          return { data: this._single ? row : [row], error: null };
        }

        if (this._insert !== null) {
          if (t === "rent_buddy_admin_actions" || t === "rent_buddy_admin_access_logs") {
            state.adminActions.push(this._insert);
            return { data: null, error: null };
          }
          const row = { id: `lc-${++state.seq}`, ...this._insert };
          if (t === "rent_buddy_launch_controls") {
            state.controls.push(row);
            state.ops.push({ op: "insert", row });
          }
          return { data: this._single ? row : [row], error: null };
        }

        if (this._update !== null) {
          if (t === "rent_buddy_launch_controls") {
            const hits = this._match(state.controls);
            for (const h of hits) Object.assign(h, this._update);
            if (hits.length) state.ops.push({ op: "update", row: hits[0] });
            return { data: this._single ? (hits[0] ?? null) : hits, error: null };
          }
          return { data: null, error: null };
        }

        if (t === "profiles") {
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          return { data: eqId ? (state.profiles[eqId[2]] ?? null) : null, error: null };
        }

        if (t === "rent_buddy_launch_controls") {
          const hits = this._match(state.controls);
          if (this._single) {
            // Faithful `.maybeSingle()`: more than one row is an ERROR, and the
            // caller is handed data:null. This is the poisoning the fix avoids.
            if (hits.length > 1) {
              return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
            }
            return { data: hits[0] ?? null, error: null };
          }
          return { data: this._limit === null ? hits : hits.slice(0, this._limit), count: hits.length, error: null };
        }

        if (this._single) return { data: null, error: null };
        return { data: [], count: 0, error: null };
      },
    };
  }

  return {
    from: (table: string) => fakeTable(table),
    auth: {
      getUser: async (token: string) =>
        token === ADMIN_TOKEN
          ? { data: { user: { id: ADMIN_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

// ── HTTP harness ─────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "lc-admin-token";
const ADMIN_ID = "lc-admin-user-1";

let server: http.Server;
let base: string;

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", rentABuddySpecRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  resetState([
    // The seeded GLOBAL control, as production carries it.
    { id: "lc-global", country_code: null, city: null, category: null, enabled: true, notes: "seed" },
  ]);
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

const globals = () => state.controls.filter(
  (c) => c.country_code === null && c.city === null && c.category === null,
);

// ── The key predicates ───────────────────────────────────────────────────────

describe("applyLaunchControlKey — NULL axes use IS NULL, not = NULL", () => {
  it("emits `is` for every NULL axis and `eq` for every valued one", () => {
    const calls: Array<[string, string, any]> = [];
    const qb: any = {
      eq(c: string, v: any) { calls.push(["eq", c, v]); return this; },
      is(c: string, v: any) { calls.push(["is", c, v]); return this; },
    };
    applyLaunchControlKey(qb, { country_code: "Thailand", city: null, category: "nightlife" });
    assert.deepEqual(calls, [
      ["eq", "country_code", "Thailand"],
      ["is", "city", null],
      ["eq", "category", "nightlife"],
    ]);
  });

  it("normalises undefined and blank strings to NULL", () => {
    assert.deepEqual(
      normalizeLaunchControlKey({ countryCode: undefined, city: "   ", category: " nightlife " }),
      { country_code: null, city: null, category: "nightlife" },
    );
  });
});

// ── The write side ───────────────────────────────────────────────────────────

describe("upsertLaunchControlRow — a NULL-bearing key updates, never duplicates", () => {
  it("UPDATEs the existing all-NULL global row instead of inserting a second one", async () => {
    const client = makeClient();
    const { error } = await upsertLaunchControlRow(
      client, normalizeLaunchControlKey({}), { enabled: false, notes: "kill" }, ADMIN_ID,
    );
    assert.equal(error, null);
    assert.equal(globals().length, 1, "must not create a second global control");
    assert.equal(globals()[0].enabled, false);
    assert.deepEqual(state.ops.map((o) => o.op), ["update"]);
  });

  it("INSERTs when the key genuinely has no row yet, with the key columns set", async () => {
    const client = makeClient();
    await upsertLaunchControlRow(
      client, normalizeLaunchControlKey({ category: "nightlife" }), { enabled: false }, ADMIN_ID,
    );
    const cat = state.controls.filter((c) => c.category === "nightlife");
    assert.equal(cat.length, 1);
    assert.equal(cat[0].country_code, null);
    assert.equal(cat[0].city, null);
    assert.equal(cat[0].created_by, ADMIN_ID);
    assert.deepEqual(state.ops.map((o) => o.op), ["insert"]);
  });

  it("a second write to the same category key updates rather than duplicating", async () => {
    const client = makeClient();
    const key = normalizeLaunchControlKey({ category: "nightlife" });
    await upsertLaunchControlRow(client, key, { enabled: false }, ADMIN_ID);
    await upsertLaunchControlRow(client, key, { enabled: true }, ADMIN_ID);
    const cat = state.controls.filter((c) => c.category === "nightlife");
    assert.equal(cat.length, 1, "category control duplicated");
    assert.equal(cat[0].enabled, true, "second write must take effect");
    assert.deepEqual(state.ops.map((o) => o.op), ["insert", "update"]);
  });
});

// ── The read side ────────────────────────────────────────────────────────────

describe("findLaunchControlRow — duplicates degrade to the first row, not to null", () => {
  it("still returns the control when the key is duplicated", async () => {
    resetState([
      { id: "lc-a", country_code: null, city: null, category: null, enabled: false },
      { id: "lc-b", country_code: null, city: null, category: null, enabled: false },
    ]);
    const client = makeClient();
    const { row, error } = await findLaunchControlRow(client, normalizeLaunchControlKey({}));
    assert.equal(error, null, "a duplicated key must not surface as an error");
    assert.ok(row, "a duplicated key must not read as a MISSING control");
    assert.equal(row.enabled, false);
  });

  it("a `.maybeSingle()` read of the same duplicated key does report null — the behaviour being replaced", async () => {
    resetState([
      { id: "lc-a", country_code: null, city: null, category: null, enabled: false },
      { id: "lc-b", country_code: null, city: null, category: null, enabled: false },
    ]);
    const client: any = makeClient();
    const res = await client
      .from("rent_buddy_launch_controls").select("*")
      .is("country_code", null).is("city", null).is("category", null)
      .maybeSingle();
    assert.equal(res.data, null);
    assert.equal(res.error.code, "PGRST116");
  });

  it("does not match a NULL axis against a valued row", async () => {
    resetState([
      { id: "lc-cat", country_code: null, city: null, category: "nightlife", enabled: false },
    ]);
    const client = makeClient();
    const { row } = await findLaunchControlRow(client, normalizeLaunchControlKey({}));
    assert.equal(row, null, "the all-NULL key must not resolve to a category-scoped control");
  });
});

// ── End to end: the kill switch is reversible ────────────────────────────────

describe("POST /api/rent-a-buddy/admin/kill-switch — idempotent and reversible", () => {
  it("engaging then lifting leaves exactly one global control, enabled again", async () => {
    const off = await req("POST", "/api/rent-a-buddy/admin/kill-switch", { enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(globals().length, 1, "engaging the kill switch duplicated the global control");
    assert.equal(globals()[0].enabled, false);

    const on = await req("POST", "/api/rent-a-buddy/admin/kill-switch", { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(globals().length, 1, "lifting the kill switch duplicated the global control");
    assert.equal(globals()[0].enabled, true, "the kill switch must be liftable");
  });

  it("pressing it repeatedly never adds a row", async () => {
    for (let i = 0; i < 4; i++) {
      await req("POST", "/api/rent-a-buddy/admin/kill-switch", { enabled: i % 2 === 0 ? false : true });
    }
    assert.equal(globals().length, 1);
    assert.equal(state.ops.filter((o) => o.op.endsWith("insert")).length, 0);
  });
});

// ── The admin gate sits BEFORE the write, not after it ───────────────────────

describe("launch-control writers are admin-gated before they touch the table", () => {
  it("a non-admin gets 403 and leaves the control untouched", async () => {
    // Same authenticated user, no admin role on their profiles row.
    state.profiles[ADMIN_ID] = { id: ADMIN_ID, role: "user" };

    const r = await req("POST", "/api/rent-a-buddy/admin/kill-switch", { enabled: false });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(globals().length, 1);
    assert.equal(globals()[0].enabled, true, "a refused press must not have written");
    assert.equal(state.ops.length, 0, "no write may occur before the role check");
  });

  it("an unauthenticated caller cannot write either", async () => {
    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const url = new URL("/api/rent-a-buddy/admin/kill-switch", base);
      const rq = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0 })); },
      );
      rq.on("error", reject);
      rq.write(JSON.stringify({ enabled: false }));
      rq.end();
    });
    assert.ok(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
    assert.equal(state.ops.length, 0);
  });

  it("a non-admin cannot flip a category either", async () => {
    state.profiles[ADMIN_ID] = { id: ADMIN_ID, role: "user" };
    const r = await req("POST", "/api/rent-a-buddy/admin/category-status", { category: "nightlife", enabled: true });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(state.controls.filter((c) => c.category === "nightlife").length, 0);
    assert.equal(state.ops.length, 0);
  });
});

describe("POST /api/rent-a-buddy/admin/category-status — idempotent", () => {
  it("two presses on the same category leave one row carrying the second value", async () => {
    const a = await req("POST", "/api/rent-a-buddy/admin/category-status", { category: "nightlife", enabled: false });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await req("POST", "/api/rent-a-buddy/admin/category-status", { category: "nightlife", enabled: true });
    assert.equal(b.status, 200, JSON.stringify(b.body));

    const cat = state.controls.filter((c) => c.category === "nightlife");
    assert.equal(cat.length, 1, "category-status duplicated the control");
    assert.equal(cat[0].enabled, true);
  });

  it("PATCH /category-status/:category shares the same NULL-safe write", async () => {
    await req("PATCH", "/api/rent-a-buddy/admin/category-status/arrival", { enabled: false });
    await req("PATCH", "/api/rent-a-buddy/admin/category-status/arrival", { enabled: true });
    const cat = state.controls.filter((c) => c.category === "arrival");
    assert.equal(cat.length, 1, "PATCH category-status duplicated the control");
    assert.equal(cat[0].enabled, true);
  });
});
