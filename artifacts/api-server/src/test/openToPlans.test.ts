/**
 * Open-to-Plans / Temporary Intent (Passport §8, AvailabilityWindow) — node:test
 *
 * Covers:
 *   HTTP  GET/POST/PATCH/DELETE /api/me/availability-windows (flag-gated)
 *   Rule  §7  only EXPLICIT answers become public/shared; inferred stays private
 *   Rule  §31 expired windows are never rendered as current / public
 *   CRUD  create → list → update → clear round-trip, intent list round-trip
 *   RLS   owner-scoping — a user cannot read/patch/delete another user's window
 *
 * Runtime: node:test + fetch() on a real Express server at a random port,
 * plus direct service calls against the same in-memory fake Supabase.
 * Fake Supabase injected via _setTestClient.
 *
 * Run: node --import tsx/esm --test src/test/openToPlans.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import availabilityRouter from "../routes/availability.js";
import {
  createWindow,
  listWindows,
  projectPublicWindows,
  recordInferredWindow,
  validateCreate,
  isExpired,
  isActive,
  isVisibleTo,
  effectiveExpiry,
} from "../services/passport/OpenToPlansService.js";

// ── IDs ───────────────────────────────────────────────────────────────────────

const ALICE_ID = "00000000-0000-0000-0000-0000000000a1";
const BOB_ID   = "00000000-0000-0000-0000-0000000000b2";
const FLAG      = "open_to_plans_windows_enabled";

// ── Fake Supabase ───────────────────────────────────────────────────────────────
// Supports insert().select().single(), update().eq().eq().select().maybeSingle(),
// delete().eq().eq().select(), and select().eq()...(list). Unknown tables read
// as empty (requireUser's profiles account_status probe returns null → active).

interface FlagRow { flag: string; enabled: boolean }

interface State {
  users: Record<string, { id: string } | null>;
  feature_flags: FlagRow[];
  availability_windows: any[];
  profiles: any[];
}

function baseState(flagEnabled: boolean): State {
  return {
    users: { "alice-tok": { id: ALICE_ID }, "bob-tok": { id: BOB_ID } },
    feature_flags: [{ flag: FLAG, enabled: flagEnabled }],
    availability_windows: [],
    profiles: [],
  };
}

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "insert" | "update" | "delete" = "select";
    let _payload: any = null;
    let _insertRow: any = null;

    const b: any = {
      select() { return b; },
      insert(row: any) { _op = "insert"; _insertRow = Array.isArray(row) ? row[0] : row; return b; },
      update(p: any) { _op = "update"; _payload = p; return b; },
      delete() { _op = "delete"; return b; },
      eq(c: string, v: any) { filters.push((r: any) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r: any) => r[c] !== v); return b; },
      in(c: string, vals: any[]) { filters.push((r: any) => vals.includes(r[c])); return b; },
      is() { return b; },
      not() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolveSingle(); },
      single() { return resolveSingle(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function src(): any[] { return ((state as any)[table] ??= []); }
    function matched(): any[] { return src().filter((r) => filters.every((f) => f(r))); }
    function insertRow(): any {
      const row = { ..._insertRow };
      if (!row.id) row.id = randomUUID();
      src().push(row);
      return row;
    }

    async function resolveList() {
      if (_op === "insert") return { data: [insertRow()], error: null };
      if (_op === "update") { const rows = matched(); for (const r of rows) Object.assign(r, _payload); return { data: rows, error: null }; }
      if (_op === "delete") { const rows = matched(); (state as any)[table] = src().filter((r) => !filters.every((f) => f(r))); return { data: rows, error: null }; }
      return { data: matched(), error: null };
    }
    async function resolveSingle() {
      if (_op === "insert") return { data: insertRow(), error: null };
      if (_op === "update") { const rows = matched(); for (const r of rows) Object.assign(r, _payload); return { data: rows[0] ?? null, error: null }; }
      return { data: matched()[0] ?? null, error: null };
    }
    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

// ── HTTP test server ────────────────────────────────────────────────────────────

interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", availabilityRouter);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, state, close: () => new Promise<void>((res, rej) => srv.close((e) => (e ? rej(e) : res()))) });
    });
    srv.on("error", reject);
  });
}

after(() => { _clearTestClient(); });

async function req(port: number, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A window that starts now and ends in 4h (active), TTL in 5h.
function tonightBody(extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    type: "one_time",
    startAt: new Date(now - 60_000).toISOString(),
    endAt: new Date(now + 4 * 3_600_000).toISOString(),
    openToPlans: true,
    intents: ["Food", "Nightlife"],
    visibility: "public",
    ...extra,
  };
}

// ── HTTP: auth + flag gate ──────────────────────────────────────────────────────

describe("§8 availability-windows — auth & flag gate", () => {
  it("GET returns 401 without a token", async () => {
    const s = await startServer(baseState(true));
    try {
      const r = await req(s.port, "GET", "/api/me/availability-windows");
      assert.equal(r.status, 401);
    } finally { await s.close(); }
  });

  it("GET returns disabled envelope when the flag is OFF", async () => {
    const s = await startServer(baseState(false));
    try {
      const r = await req(s.port, "GET", "/api/me/availability-windows", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.enabled, false);
      assert.deepEqual(r.body.windows, []);
    } finally { await s.close(); }
  });

  it("POST stores nothing when the flag is OFF", async () => {
    const s = await startServer(baseState(false));
    try {
      const r = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody());
      assert.equal(r.status, 200);
      assert.equal(r.body.enabled, false);
      assert.equal(s.state.availability_windows.length, 0);
    } finally { await s.close(); }
  });
});

// ── HTTP: CRUD + intent round-trip ──────────────────────────────────────────────

describe("§8 availability-windows — CRUD", () => {
  it("POST creates an explicit window and round-trips the intent list", async () => {
    const s = await startServer(baseState(true));
    try {
      const r = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody());
      assert.equal(r.status, 201);
      assert.equal(r.body.enabled, true);
      assert.equal(r.body.window.userId, ALICE_ID);
      assert.equal(r.body.window.source, "explicit"); // §7: API answer is explicit
      assert.deepEqual(r.body.window.intents, ["Food", "Nightlife"]);
      assert.equal(r.body.window.openToPlans, true);
    } finally { await s.close(); }
  });

  it("user_id comes from the JWT, not the body", async () => {
    const s = await startServer(baseState(true));
    try {
      // Attempt to smuggle Bob's id in the body — schema ignores it, owner stays Alice.
      const r = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody({ userId: BOB_ID }));
      assert.equal(r.status, 201);
      assert.equal(r.body.window.userId, ALICE_ID);
    } finally { await s.close(); }
  });

  it("POST rejects endAt <= startAt", async () => {
    const s = await startServer(baseState(true));
    try {
      const now = Date.now();
      const r = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", {
        type: "one_time",
        startAt: new Date(now + 3_600_000).toISOString(),
        endAt: new Date(now).toISOString(),
      });
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("POST rejects an out-of-set intent", async () => {
    const s = await startServer(baseState(true));
    try {
      const r = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody({ intents: ["Karaoke"] }));
      assert.equal(r.status, 400);
    } finally { await s.close(); }
  });

  it("GET lists the owner's non-expired windows", async () => {
    const s = await startServer(baseState(true));
    try {
      await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody());
      const r = await req(s.port, "GET", "/api/me/availability-windows", "alice-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.enabled, true);
      assert.equal(r.body.windows.length, 1);
      assert.deepEqual(r.body.windows[0].intents, ["Food", "Nightlife"]);
    } finally { await s.close(); }
  });

  it("PATCH updates intents and visibility on an owned window", async () => {
    const s = await startServer(baseState(true));
    try {
      const c = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody());
      const id = c.body.window.id;
      const r = await req(s.port, "PATCH", `/api/me/availability-windows/${id}`, "alice-tok", {
        intents: ["Explore"], visibility: "followers", openToPlans: false,
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.window.intents, ["Explore"]);
      assert.equal(r.body.window.visibility, "followers");
      assert.equal(r.body.window.openToPlans, false);
    } finally { await s.close(); }
  });

  it("DELETE clears a window; a second DELETE is not_found", async () => {
    const s = await startServer(baseState(true));
    try {
      const c = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody());
      const id = c.body.window.id;
      const d1 = await req(s.port, "DELETE", `/api/me/availability-windows/${id}`, "alice-tok");
      assert.equal(d1.status, 200);
      assert.equal(d1.body.cleared, true);
      assert.equal(s.state.availability_windows.length, 0);
      const d2 = await req(s.port, "DELETE", `/api/me/availability-windows/${id}`, "alice-tok");
      assert.equal(d2.status, 404);
    } finally { await s.close(); }
  });
});

// ── HTTP: RLS owner-scoping ─────────────────────────────────────────────────────

describe("§8 availability-windows — owner-scoping", () => {
  it("a viewer never sees another user's windows via the owner GET", async () => {
    const s = await startServer(baseState(true));
    try {
      await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody());
      const bob = await req(s.port, "GET", "/api/me/availability-windows", "bob-tok");
      assert.equal(bob.status, 200);
      assert.deepEqual(bob.body.windows, []);
    } finally { await s.close(); }
  });

  it("a user cannot PATCH another user's window", async () => {
    const s = await startServer(baseState(true));
    try {
      const c = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody());
      const id = c.body.window.id;
      const r = await req(s.port, "PATCH", `/api/me/availability-windows/${id}`, "bob-tok", { openToPlans: false });
      assert.equal(r.status, 404);
      // Alice's window is untouched.
      assert.equal(s.state.availability_windows[0].open_to_plans, true);
    } finally { await s.close(); }
  });

  it("a user cannot DELETE another user's window", async () => {
    const s = await startServer(baseState(true));
    try {
      const c = await req(s.port, "POST", "/api/me/availability-windows", "alice-tok", tonightBody());
      const id = c.body.window.id;
      const r = await req(s.port, "DELETE", `/api/me/availability-windows/${id}`, "bob-tok");
      assert.equal(r.status, 404);
      assert.equal(s.state.availability_windows.length, 1); // still there
    } finally { await s.close(); }
  });
});

// ── Pure helpers: TTL / expiry (§31) ────────────────────────────────────────────

describe("§31 expiry helpers", () => {
  const base = { startAt: new Date(0).toISOString(), endAt: new Date(10_000).toISOString(), expiresAt: null as string | null };

  it("effectiveExpiry uses the earlier of endAt and expiresAt", () => {
    assert.equal(effectiveExpiry({ endAt: new Date(10_000).toISOString(), expiresAt: new Date(5_000).toISOString() }), 5_000);
    assert.equal(effectiveExpiry({ endAt: new Date(10_000).toISOString(), expiresAt: null }), 10_000);
  });

  it("isExpired flips at COALESCE(expiresAt, endAt)", () => {
    assert.equal(isExpired(base, 9_999), false);
    assert.equal(isExpired(base, 10_000), true);
    assert.equal(isExpired({ ...base, expiresAt: new Date(3_000).toISOString() }, 3_000), true);
  });

  it("isActive requires started and not expired", () => {
    const w = { startAt: new Date(5_000).toISOString(), endAt: new Date(10_000).toISOString(), expiresAt: null };
    assert.equal(isActive(w, 4_000), false); // not started
    assert.equal(isActive(w, 6_000), true);
    assert.equal(isActive(w, 10_000), false); // expired
  });
});

// ── §7 explicit-vs-inferred visibility ──────────────────────────────────────────

describe("§7 explicit vs inferred visibility", () => {
  it("validateCreate rejects an inferred window that is not private", () => {
    const now = Date.now();
    const v = validateCreate({
      userId: ALICE_ID, type: "derived",
      startAt: new Date(now).toISOString(), endAt: new Date(now + 3_600_000).toISOString(),
      source: "plan_derived", visibility: "public",
    });
    assert.equal(v.ok, false);
  });

  it("isVisibleTo hides an inferred window from every non-self viewer", () => {
    const w = {
      startAt: new Date(0).toISOString(), endAt: new Date(1e13).toISOString(), expiresAt: null,
      source: "plan_derived" as const, visibility: "private" as const,
    };
    assert.equal(isVisibleTo(w, "self", 1_000), true);
    assert.equal(isVisibleTo(w, "public", 1_000), false);
    assert.equal(isVisibleTo(w, "follower", 1_000), false);
  });

  it("isVisibleTo respects visibility policy for explicit windows", () => {
    const explicit = (visibility: any) => ({
      startAt: new Date(0).toISOString(), endAt: new Date(1e13).toISOString(), expiresAt: null,
      source: "explicit" as const, visibility,
    });
    assert.equal(isVisibleTo(explicit("public"), "public", 1_000), true);
    assert.equal(isVisibleTo(explicit("followers"), "public", 1_000), false);
    assert.equal(isVisibleTo(explicit("followers"), "follower", 1_000), true);
    assert.equal(isVisibleTo(explicit("private"), "public", 1_000), false);
    assert.equal(isVisibleTo(explicit("private"), "self", 1_000), true);
  });

  it("an expired explicit public window is never visible to others (§31)", () => {
    const w = {
      startAt: new Date(0).toISOString(), endAt: new Date(5_000).toISOString(), expiresAt: null,
      source: "explicit" as const, visibility: "public" as const,
    };
    assert.equal(isVisibleTo(w, "public", 6_000), false);
    assert.equal(isVisibleTo(w, "public", 4_000), true);
  });
});

// ── Service: recordInferredWindow + projection ──────────────────────────────────

describe("§7 inference path via the service", () => {
  it("recordInferredWindow stores a private plan_derived window and returns a prompt", async () => {
    const state = baseState(true);
    const db = makeFakeClient(state) as any;
    const now = Date.now();
    const { window, prompt } = await recordInferredWindow(db, {
      userId: ALICE_ID, type: "derived",
      startAt: new Date(now).toISOString(), endAt: new Date(now + 4 * 3_600_000).toISOString(),
      intents: ["Nightlife"],
    });
    assert.ok(window);
    assert.equal(window!.source, "plan_derived");
    assert.equal(window!.visibility, "private");
    assert.deepEqual(prompt, { kind: "free_tonight", label: "Free tonight?" });

    // Inferred window is invisible to a follower, visible to self.
    const forFollower = await projectPublicWindows(db, ALICE_ID, "follower", now + 1000);
    assert.equal(forFollower.length, 0);
    const forSelf = await projectPublicWindows(db, ALICE_ID, "self", now + 1000);
    assert.equal(forSelf.length, 1);
  });

  it("an explicit public window IS projected to a public viewer; expired is not", async () => {
    const state = baseState(true);
    const db = makeFakeClient(state) as any;
    const now = Date.now();

    // Active explicit public window.
    await createWindow(db, {
      userId: ALICE_ID, type: "one_time",
      startAt: new Date(now - 1000).toISOString(), endAt: new Date(now + 3_600_000).toISOString(),
      source: "explicit", visibility: "public", intents: ["Food"], openToPlans: true,
    });
    // Expired explicit public window.
    await createWindow(db, {
      userId: ALICE_ID, type: "one_time",
      startAt: new Date(now - 7_200_000).toISOString(), endAt: new Date(now - 3_600_000).toISOString(),
      source: "explicit", visibility: "public",
    });

    const projected = await projectPublicWindows(db, ALICE_ID, "public", now);
    assert.equal(projected.length, 1, "only the active window is projected");
    assert.equal(projected[0].intents[0], "Food");

    // Owner's own non-expired list excludes the expired one by default (§31).
    const own = await listWindows(db, ALICE_ID, { nowMs: now });
    assert.equal(own.length, 1);
    const withHistory = await listWindows(db, ALICE_ID, { includeExpired: true, nowMs: now });
    assert.equal(withHistory.length, 2);
  });
});
