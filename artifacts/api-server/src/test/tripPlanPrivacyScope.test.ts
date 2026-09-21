/**
 * Trips spec §6.3 — the six privacy scopes, end to end (census-trips TR116).
 *
 * WHAT THIS PINS, AND WHY EACH CASE EXISTS
 * ========================================
 *  1. The vocabulary is 2770's, lowercase, in the migration's order — an
 *     uppercase spelling would be refused by `trip_plan_items_privacy_scope_known`
 *     rather than quietly stored, so the constant IS the contract.
 *  2. `visibility` is DERIVED and never asked for: exactly `public` maps to
 *     `public`, and all five narrower scopes map to `members`. 2770 ties the
 *     two by CHECK, so a writer that let them disagree could only be refused
 *     by the database.
 *  3. A create that names NO scope writes no `privacy_scope` key at all. This
 *     is the compatibility case and it is the one most easily broken by a
 *     "harmless" default: naming the column on every create would make an
 *     optional field a hard dependency on an unapplied migration.
 *  4. A create or patch that DOES name one on a database without 2770 is a
 *     retryable 503 naming the migration, not a `db_error`. The request is
 *     well-formed; only the deployment is behind.
 *  5. The plan list asks for the scope and, on a database without it, retries
 *     once without it and serves the itinerary with `privacyScope: null` —
 *     NOT READ, never a scope invented from `visibility`.
 *
 * Runtime: node:test + node:assert/strict. No network / no real DB.
 * Run: node --import tsx/esm --test src/test/tripPlanPrivacyScope.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import tripsRouter from "../routes/trips.js";
import {
  TRIP_PLAN_PRIVACY_SCOPES,
  DEFAULT_TRIP_PLAN_PRIVACY_SCOPE,
  isTripPlanPrivacyScope,
  visibilityForPrivacyScope,
  privacyScopeFromVisibility,
} from "../domain/trips/policies/tripPlanPrivacy.js";

const ALICE = "aaaaaaaa-0000-0000-0000-0000000000a1";
const TRIP  = "33333333-0000-0000-0000-000000000031";
const ITEM  = "66666666-0000-0000-0000-000000000064";

// ── The pure half ────────────────────────────────────────────────────────────

describe("§6.3 privacy scopes — the vocabulary and the derivation", () => {
  it("is 2770's six values, lowercase, in the migration's order", () => {
    assert.deepEqual([...TRIP_PLAN_PRIVACY_SCOPES], [
      "private", "selected_participants", "crew", "friends_nearby", "trip", "public",
    ]);
    assert.equal(DEFAULT_TRIP_PLAN_PRIVACY_SCOPE, "crew");
  });

  it("recognises exactly those six and nothing else, without throwing on a non-string", () => {
    for (const s of TRIP_PLAN_PRIVACY_SCOPES) assert.equal(isTripPlanPrivacyScope(s), true);
    assert.equal(isTripPlanPrivacyScope("CREW"), false, "the CHECK is case-sensitive; so is this");
    assert.equal(isTripPlanPrivacyScope("members"), false, "`members` is a visibility, not a scope");
    assert.equal(isTripPlanPrivacyScope(undefined), false);
    assert.equal(isTripPlanPrivacyScope(7), false);
  });

  it("derives visibility exactly as 2772's kernel CASE does: only `public` is public", () => {
    assert.equal(visibilityForPrivacyScope("public"), "public");
    for (const s of TRIP_PLAN_PRIVACY_SCOPES.filter((x) => x !== "public")) {
      assert.equal(visibilityForPrivacyScope(s), "members", `${s} must not widen to public`);
    }
  });

  it("maps a pre-2770 row back, and refuses to invent a scope from an unread visibility", () => {
    assert.equal(privacyScopeFromVisibility("public"), "public");
    assert.equal(privacyScopeFromVisibility("members"), "crew");
    assert.equal(privacyScopeFromVisibility(null), null, "not read is not `crew`");
    assert.equal(privacyScopeFromVisibility(undefined), null);
  });
});

// ── The route half ───────────────────────────────────────────────────────────

interface State {
  trips: any[];
  trip_members: any[];
  trip_plan_items: any[];
  trip_activity_log: any[];
  feature_flags: any[];
  /** Columns this fake database does NOT have, by table — the pre-2770 case. */
  missing: Record<string, string[]>;
}

function baseState(): State {
  return {
    trips: [{ id: TRIP, owner_id: ALICE, plan_edit_permission: "all_members", start_date: null, end_date: null }],
    trip_members: [{ trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" }],
    trip_plan_items: [],
    trip_activity_log: [],
    feature_flags: [],
    missing: {},
  };
}

/** PostgREST's answer when a select or a write names a column the table does not have. */
const MISSING_COLUMN_ERROR = (col: string, table: string) => ({
  code: "PGRST204",
  message: `Could not find the '${col}' column of '${table}' in the schema cache`,
});

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let cols: string | null = null;

    const missingIn = (names: string[]): string | null => {
      for (const c of state.missing[table] ?? []) if (names.includes(c)) return c;
      return null;
    };
    const rows = (): any[] => (state as any)[table] ?? [];
    const matched = () => rows().filter((r) => filters.every((f) => f(r)));

    async function resolve(one: boolean) {
      // A select naming an absent column fails the whole read, exactly as
      // PostgREST does — that is what the callers' retry is for.
      if (op === "select") {
        const bad = missingIn((cols ?? "").split(",").map((c) => c.trim()));
        if (bad) return { data: null, error: MISSING_COLUMN_ERROR(bad, table) };
        const m = matched();
        return { data: one ? (m[0] ?? null) : m, error: null };
      }
      if (op === "insert") {
        const bad = missingIn(Object.keys(payload ?? {}));
        if (bad) return { data: null, error: MISSING_COLUMN_ERROR(bad, table) };
        const row = { id: `new-${rows().length + 1}`, removed_at: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...payload };
        rows().push(row);
        return { data: one ? row : [row], error: null };
      }
      if (op === "update") {
        const bad = missingIn(Object.keys(payload ?? {}));
        if (bad) return { data: null, error: MISSING_COLUMN_ERROR(bad, table) };
        let last: any = null;
        for (const r of rows()) if (filters.every((f) => f(r))) { Object.assign(r, payload); last = r; }
        return { data: one ? last : null, error: null };
      }
      (state as any)[table] = rows().filter((r) => !filters.every((f) => f(r)));
      return { data: null, error: null };
    }

    const b: any = {
      select(c?: string) { cols = c ?? null; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };
    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) =>
        token === "alice-tok"
          ? { data: { user: { id: ALICE } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

async function startServer(state: State) {
  _setTestClient(makeFakeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", tripsRouter);
  const srv = createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  srv.unref();
  return { port, close: () => new Promise<void>((res) => { srv.closeAllConnections(); srv.close(() => res()); }) };
}

/**
 * The fields of a plan-route response this file reads. Named rather than
 * inferred because `Response.json()` is typed `Promise<unknown>`, and the two
 * ways to silence that — `any`, or a bare cast — both let a fixture describe a
 * response the route never sends.
 */
interface PlanResponseBody {
  privacyScope?: string;
  /** `privacyScope` is nullable on purpose: a database without 2770 costs the
   *  reader the scope and must report it as NOT READ, never as a value derived
   *  from `visibility`. Typing it `string` would make that test uncompilable. */
  items?: Array<{ privacyScope?: string | null }>;
  error?: string;
}

async function call(
  port: number, method: string, path: string, body?: unknown,
): Promise<{ status: number; body: PlanResponseBody }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer alice-tok", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed: unknown = await r.json().catch(() => null);
  // Checked, not asserted-by-cast: a non-object answer fails here, naming the
  // route and status, instead of surfacing as `undefined !== "trip"` later.
  assert.ok(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `${method} ${path} must answer with a JSON object; status ${r.status} gave ${JSON.stringify(parsed)}`,
  );
  return { status: r.status, body: parsed as PlanResponseBody };
}

/**
 * The plan items from a 200, or a failure naming what came back instead. A 200
 * that carries no `items` is a route defect, and it should read as one here
 * rather than as `undefined` reaching an index.
 */
function planItems(r: { status: number; body: PlanResponseBody }): Array<{ privacyScope?: string | null }> {
  assert.ok(
    Array.isArray(r.body.items),
    `a 200 from the plan route must carry an items array; status ${r.status} gave ${JSON.stringify(r.body)}`,
  );
  return r.body.items;
}

const CREATE = { title: "Rooftop dinner", category: "dining" };

describe("§6.3 privacy scopes on the plan write path (TR116)", () => {
  it("a create that names no scope writes NO privacy_scope column, and `members` as before", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await call(port, "POST", `/api/trips/${TRIP}/plan/items`, CREATE);
    await close();
    assert.equal(r.status, 201);
    const row = s.trip_plan_items[0];
    assert.equal("privacy_scope" in row, false, "an unrequested scope must not name the 2770 column at all");
    assert.equal(row.visibility, "members");
    assert.equal(r.body.privacyScope, null, "no scope stored is reported as NOT READ, not as `crew`");
  });

  it("a create naming a narrower scope stores it and keeps visibility at `members`", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await call(port, "POST", `/api/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "private" });
    await close();
    assert.equal(r.status, 201);
    assert.equal(s.trip_plan_items[0].privacy_scope, "private");
    assert.equal(s.trip_plan_items[0].visibility, "members", "narrower than crew must never widen to public");
    assert.equal(r.body.privacyScope, "private");
  });

  it("a create naming `public` derives visibility `public`, so 2770's CHECK holds", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await call(port, "POST", `/api/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "public" });
    await close();
    assert.equal(r.status, 201);
    assert.equal(s.trip_plan_items[0].privacy_scope, "public");
    assert.equal(s.trip_plan_items[0].visibility, "public");
  });

  it("refuses a scope outside §6.3's six", async () => {
    const s = baseState();
    const { port, close } = await startServer(s);
    const r = await call(port, "POST", `/api/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "members" });
    await close();
    assert.equal(r.status, 400);
    assert.equal(s.trip_plan_items.length, 0);
  });

  it("a PATCH moves the scope and the derived visibility in the SAME statement", async () => {
    const s = baseState();
    s.trip_plan_items.push({ id: ITEM, trip_id: TRIP, creator_id: ALICE, title: "Rooftop dinner", status: "tentative", visibility: "members", privacy_scope: "crew", removed_at: null });
    const { port, close } = await startServer(s);
    const r = await call(port, "PATCH", `/api/trips/${TRIP}/plan/items/${ITEM}`, { privacyScope: "public" });
    await close();
    assert.equal(r.status, 200);
    assert.equal(s.trip_plan_items[0].privacy_scope, "public");
    assert.equal(s.trip_plan_items[0].visibility, "public", "the pair may never be written apart");
  });

  it("a named scope on a database without 2770 is a RETRYABLE refusal naming the gap, not a db_error", async () => {
    const s = baseState();
    s.missing = { trip_plan_items: ["privacy_scope"] };
    const { port, close } = await startServer(s);
    const r = await call(port, "POST", `/api/trips/${TRIP}/plan/items`, { ...CREATE, privacyScope: "private" });
    await close();
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(s.trip_plan_items.length, 0, "nothing is written with the scope silently dropped");
  });

  it("an UNnamed scope on a database without 2770 still works — the compatibility case", async () => {
    const s = baseState();
    s.missing = { trip_plan_items: ["privacy_scope"] };
    const { port, close } = await startServer(s);
    const r = await call(port, "POST", `/api/trips/${TRIP}/plan/items`, CREATE);
    await close();
    assert.equal(r.status, 201);
    assert.equal(s.trip_plan_items[0].visibility, "members");
  });
});

describe("§6.3 privacy scopes on the plan read path (TR116)", () => {
  it("GET /plan carries the scope", async () => {
    const s = baseState();
    s.trip_plan_items.push({ id: ITEM, trip_id: TRIP, creator_id: ALICE, title: "Rooftop dinner", visibility: "members", privacy_scope: "selected_participants", removed_at: null, location_is_private: true });
    const { port, close } = await startServer(s);
    const r = await call(port, "GET", `/api/trips/${TRIP}/plan`);
    await close();
    assert.equal(r.status, 200);
    assert.equal(planItems(r)[0].privacyScope, "selected_participants");
  });

  it("a database without 2770 costs the reader the SCOPE, not the itinerary", async () => {
    const s = baseState();
    s.missing = { trip_plan_items: ["privacy_scope"] };
    s.trip_plan_items.push({ id: ITEM, trip_id: TRIP, creator_id: ALICE, title: "Rooftop dinner", visibility: "public", removed_at: null, location_is_private: true });
    const { port, close } = await startServer(s);
    const r = await call(port, "GET", `/api/trips/${TRIP}/plan`);
    await close();
    assert.equal(r.status, 200, "one retry without the column, not a 500 over the whole plan");
    assert.equal(planItems(r).length, 1);
    assert.equal(planItems(r)[0].privacyScope, null, "NOT READ — never derived from `visibility: public`");
  });
});
