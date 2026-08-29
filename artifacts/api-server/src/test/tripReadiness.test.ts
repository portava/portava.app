/**
 * Trip Readiness + Next Best Action + Arrival Board tests
 *
 * Covers:
 * - plan: dates-missing item; single aggregated gap item
 * - stay: critical inside 14 days of start vs normal outside
 * - budget: over-budget → critical
 * - entry: per-member passport prompt; corridor visa_required → critical with
 *   official source url in actionRef
 * - stale-row cleanup on recompute
 * - critical-visibility rule: criticalItems present even when score is high
 * - NBA ranking order (critical → autopilot proposal → action_needed →
 *   incomplete) and the honest fallback
 * - membership gate (non-member → not_member) and flag off → feature_disabled
 * - defensive absence of trip_reservations (fake throws → compute still works)
 * - arrival board: per-member flight arrivals + honest sparse note, no flag
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------
const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RES_ID    = "44444444-4444-4444-4444-444444444444";
const PROP_ID   = "55555555-5555-5555-5555-555555555555";
const DOC_ID    = "66666666-6666-6666-6666-666666666666";
const PASS_ID   = "77777777-7777-7777-7777-777777777777";

// ---------------------------------------------------------------------------
// Fake client builder (imitates src/test/tripsExpansion.test.ts)
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
interface FakeTable { rows: Row[]; nextInsertError?: string; }
interface FakeOpts { throwOnTables?: string[]; }

function makeFakeClient(tables: Record<string, FakeTable> = {}, opts: FakeOpts = {}) {
  const db: Record<string, FakeTable> = {
    trips:                    tables.trips                    ?? { rows: [] },
    trip_members:             tables.trip_members             ?? { rows: [] },
    trip_plan_items:          tables.trip_plan_items          ?? { rows: [] },
    trip_budget:              tables.trip_budget              ?? { rows: [] },
    trip_documents:           tables.trip_documents           ?? { rows: [] },
    trip_readiness_items:     tables.trip_readiness_items     ?? { rows: [] },
    trip_reservations:        tables.trip_reservations        ?? { rows: [] },
    trip_traveler_passports:  tables.trip_traveler_passports  ?? { rows: [] },
    entry_requirements:       tables.entry_requirements       ?? { rows: [] },
    trip_autopilot_proposals:  tables.trip_autopilot_proposals  ?? { rows: [] },
    trip_destinations:         tables.trip_destinations         ?? { rows: [] },
    trip_readiness_snapshots:  tables.trip_readiness_snapshots  ?? { rows: [] },
    feature_flags:             tables.feature_flags             ?? { rows: [] },
    profiles:                  tables.profiles                  ?? { rows: [] },
    blocks:                    tables.blocks                    ?? { rows: [] },
    ...tables,
  };
  const throwOn = opts.throwOnTables ?? [];

  let idCtr = 0;
  function newId() {
    const n = String(++idCtr).padStart(8, "0");
    return `${n}-0000-0000-0000-000000000000`;
  }

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _upsert: { data: Row | Row[]; opts?: any } | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _limitN: number | null = null;
    let _orderCol: string | null = null;
    let _orderAsc = true;
    let _single = false;
    let _maybeSingle = false;
    let _selectCols: string | null = null;

    const obj: any = {
      select(cols?: string) { _selectCols = cols ?? null; return obj; },
      insert(data: Row | Row[]) { _insert = data; return obj; },
      upsert(data: Row | Row[], o?: any) { _upsert = { data, opts: o }; return obj; },
      update(patch: Row) { _update = patch; return obj; },
      delete() { _delete = true; return obj; },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => r[col] !== val);
        return obj;
      },
      or(_expr: string) { return obj; },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return obj; },
      lte(col: string, val: any) { filters.push((r) => r[col] <= val); return obj; },
      gt(col: string, val: any)  { filters.push((r) => r[col] >  val); return obj; },
      lt(col: string, val: any)  { filters.push((r) => r[col] <  val); return obj; },
      is(col: string, val: any)  { filters.push((r) => r[col] == val); return obj; },
      limit(n: number) { _limitN = n; return obj; },
      order(col: string, o?: any) { _orderCol = col; _orderAsc = o?.ascending !== false; return obj; },
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single      = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function getTable(): FakeTable {
      if (!db[tableName]) db[tableName] = { rows: [] };
      return db[tableName];
    }

    function resolve(): Promise<{ data: any; error: any }> {
      return Promise.resolve().then(() => {
        const table = getTable();

        if (_insert !== null && !_upsert) {
          if (table.nextInsertError) {
            const err = table.nextInsertError;
            table.nextInsertError = undefined;
            return { data: null, error: { message: err } };
          }
          const rows = Array.isArray(_insert) ? _insert : [_insert];
          const inserted = rows.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
          table.rows.push(...inserted);
          const result = _single || _maybeSingle ? inserted[0] ?? null : inserted;
          return { data: result, error: null };
        }

        if (_upsert !== null) {
          const rows = Array.isArray(_upsert.data) ? _upsert.data : [_upsert.data];
          const onConflict = _upsert.opts?.onConflict as string | undefined;
          const upserted = rows.map((newRow) => {
            if (onConflict) {
              const keys = onConflict.split(",").map((k) => k.trim());
              const idx = table.rows.findIndex((r) =>
                keys.every((k) => r[k] === (newRow as any)[k])
              );
              if (idx >= 0) {
                table.rows[idx] = { ...table.rows[idx], ...newRow };
                return table.rows[idx];
              }
            }
            const ins = { id: newId(), created_at: new Date().toISOString(), ...newRow };
            table.rows.push(ins);
            return ins;
          });
          const result = _single || _maybeSingle ? upserted[0] ?? null : upserted;
          return { data: result, error: null };
        }

        if (_delete) {
          table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }

        if (_update !== null) {
          const matched: Row[] = [];
          table.rows = table.rows.map((r) => {
            if (filters.every((f) => f(r))) {
              const updated = { ...r, ..._update };
              matched.push({ ...updated });
              return updated;
            }
            return r;
          });
          if (_single || _maybeSingle) return { data: matched[0] ?? null, error: null };
          if (_selectCols !== null)    return { data: matched, error: null };
          return { data: null, error: null };
        }

        // SELECT
        let rows = table.rows.filter((r) => filters.every((f) => f(r)));
        if (_orderCol) {
          const col = _orderCol;
          rows = [...rows].sort((a, b) =>
            _orderAsc
              ? String(a[col] ?? "").localeCompare(String(b[col] ?? ""))
              : String(b[col] ?? "").localeCompare(String(a[col] ?? ""))
          );
        }
        if (_limitN !== null) rows = rows.slice(0, _limitN);

        if (_single)      return { data: rows[0] ?? null, error: null };
        if (_maybeSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      });
    }

    return obj;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token")  return { data: { user: { id: OWNER_ID }  }, error: null };
        if (token === "member-token") return { data: { user: { id: MEMBER_ID } }, error: null };
        if (token === "other-token")  return { data: { user: { id: OTHER_ID }  }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from: (tableName: string) => {
      if (throwOn.includes(tableName)) {
        // Simulates an environment where the table's schema doesn't exist yet.
        throw new Error(`relation "${tableName}" does not exist`);
      }
      return chain(tableName);
    },
  };

  return { client, db };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any;
  const ct = res.headers.get("content-type") ?? "";
  try { body = ct.includes("application/json") ? await res.json() : await res.text(); }
  catch { body = null; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
}
function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600e3).toISOString();
}
function flagOn()  { return { rows: [{ flag: "trip_readiness_enabled", enabled: true  }, { flag: "stamp_system_v2_enabled", enabled: true }] }; }
function flagOff() { return { rows: [{ flag: "trip_readiness_enabled", enabled: false }, { flag: "stamp_system_v2_enabled", enabled: true }] }; }
function baseTrip(overrides: Row = {}): Row {
  return {
    id: TRIP_ID, owner_id: OWNER_ID, title: "Tokyo Trip", destination_city: "Tokyo",
    destination_country: "JP", status: "upcoming", visibility: "private",
    created_at: "2026-01-01T00:00:00Z", ...overrides,
  };
}
function ownerMemberRow(): Row {
  return { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" };
}
function findItem(items: any[], dedupeKey: string): any | undefined {
  return items.find((i) => i.dedupeKey === dedupeKey);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("trip readiness routes", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(async () => {
    if (server) server.close();
  });

  // ── Readiness derivation ───────────────────────────────────────────────────

  it("emits the dates-missing item and mechanical summary when the trip has no dates", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip({ start_date: null, end_date: null })] },
      trip_members: { rows: [ownerMemberRow()] },
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);

    const dates = findItem(r.body.items, "plan:dates");
    assert.ok(dates, "plan:dates item should be present");
    assert.equal(dates.status, "incomplete");
    assert.equal(dates.severity, "normal");
    assert.equal(dates.title, "Trip dates not set");
    assert.equal(r.body.categories.plan, "incomplete");
    // stay/transport/entry action_needed; plan/budget/documents incomplete;
    // reservations ready → score = round(100 * 1/7)
    assert.deepEqual(r.body.counts, { ready: 1, actionNeeded: 3, incomplete: 3, unknown: 0 });
    assert.equal(r.body.score, 14);
  });

  it("aggregates open days into ONE plan gap item listing the gap dates", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip({ start_date: "2026-08-01", end_date: "2026-08-04" })] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_plan_items: { rows: [
        { id: "p1", trip_id: TRIP_ID, category: "activity", status: "confirmed", day_date: "2026-08-01" },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);

    const gaps = findItem(r.body.items, "plan:gaps");
    assert.ok(gaps, "aggregated plan:gaps item should be present");
    assert.equal(gaps.status, "action_needed");
    assert.equal(gaps.title, "3 open days: Aug 2, Aug 3, Aug 4");
    // ONE aggregated item — no per-day gap items
    const planItems = r.body.items.filter((i: any) => i.category === "plan");
    assert.equal(planItems.length, 1);
    assert.ok(!findItem(r.body.items, "plan:dates"), "dates item must not appear when dates are set");
  });

  it("marks missing accommodation CRITICAL when the trip starts within 14 days", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip({ start_date: daysFromNow(7), end_date: daysFromNow(8) })] },
      trip_members: { rows: [ownerMemberRow()] },
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);
    const stay = findItem(r.body.items, "stay:none");
    assert.ok(stay, "stay:none item should be present");
    assert.equal(stay.severity, "critical");
    assert.ok(
      r.body.criticalItems.some((i: any) => i.dedupeKey === "stay:none"),
      "stay item must appear in criticalItems",
    );
  });

  it("marks missing accommodation normal when the trip starts far in the future", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip({ start_date: daysFromNow(60), end_date: daysFromNow(61) })] },
      trip_members: { rows: [ownerMemberRow()] },
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);
    const stay = findItem(r.body.items, "stay:none");
    assert.ok(stay);
    assert.equal(stay.severity, "normal");
  });

  it("flags over-budget as action_needed/critical", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_budget: { rows: [{ trip_id: TRIP_ID, currency: "USD", total_budget: 100, spent: 150 }] },
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);
    const over = findItem(r.body.items, "budget:over");
    assert.ok(over, "budget:over item should be present");
    assert.equal(over.status, "action_needed");
    assert.equal(over.severity, "critical");
    assert.equal(over.title, "Over budget");
    assert.ok(r.body.criticalItems.some((i: any) => i.dedupeKey === "budget:over"));
  });

  it("prompts each accepted member (user-scoped) to select a travel passport", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [
        ownerMemberRow(),
        { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "member-token" });
    assert.equal(r.status, 200);

    const ownerPrompt = findItem(r.body.items, `entry:${OWNER_ID}:passport`);
    const memberPrompt = findItem(r.body.items, `entry:${MEMBER_ID}:passport`);
    assert.ok(ownerPrompt, "owner passport prompt should exist");
    assert.ok(memberPrompt, "member passport prompt should exist");
    assert.equal(memberPrompt.status, "action_needed");
    assert.equal(memberPrompt.severity, "normal");
    assert.equal(memberPrompt.title, "Select your travel passport");
    assert.equal(memberPrompt.userId, MEMBER_ID);
  });

  it("raises a CRITICAL visa item with the official source url for a visa_required corridor", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      // Canonical 0169 shape: selection row carries passport_id; the issuing
      // country lives on traveler_passports.
      trip_traveler_passports: { rows: [
        { trip_id: TRIP_ID, user_id: OWNER_ID, passport_id: PASS_ID },
      ]},
      traveler_passports: { rows: [
        { id: PASS_ID, user_id: OWNER_ID, issuing_country: "US" },
      ]},
      entry_requirements: { rows: [
        { passport_country: "US", destination_country: "JP", status: "visa_required",
          official_source_url: "https://example.gov/visa" },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);

    const visa = findItem(r.body.items, `entry:${OWNER_ID}`);
    assert.ok(visa, "corridor entry item should be present");
    assert.equal(visa.status, "action_needed");
    assert.equal(visa.severity, "critical");
    assert.ok(visa.title.includes("official source"));
    assert.equal(visa.actionRef?.officialSourceUrl, "https://example.gov/visa");
    assert.ok(r.body.criticalItems.some((i: any) => i.dedupeKey === `entry:${OWNER_ID}`));
  });

  it("emits an honest unknown item when the corridor has no verified entry data", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_traveler_passports: { rows: [
        { trip_id: TRIP_ID, user_id: OWNER_ID, passport_country: "BR" },
      ]},
      entry_requirements: { rows: [
        { passport_country: "US", destination_country: "JP", status: "visa_free" },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);
    const unknown = findItem(r.body.items, `entry:${OWNER_ID}`);
    assert.ok(unknown);
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.title, "No verified entry data yet");
  });

  // ── previousScore population ───────────────────────────────────────────────

  it("sets previousScore to null when no prior items exist", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      feature_flags: flagOn(),
      // trip_readiness_items starts empty — first-time computation
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.strictEqual(r.body.previousScore, null, "no prior snapshot → previousScore must be null");
  });

  it("sets previousScore to null when stored items are from today (same-day recompute)", async () => {
    // Items computed less than a minute ago — same UTC day, so no prior-day delta.
    const todayIso = new Date().toISOString();
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_readiness_items: { rows: [
        { id: "r1", trip_id: TRIP_ID, user_id: null, category: "stay",
          status: "action_needed", severity: "normal",
          title: "No accommodation", detail: null, due_at: null,
          action_ref: null, dedupe_key: "stay:none", computed_at: todayIso },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    // Force refresh to trigger recompute even though items are fresh
    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness?refresh=1`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.strictEqual(r.body.previousScore, null,
      "same-day cached items → previousScore must be null even on forced recompute");
  });

  it("sets previousScore to the old score when stored items are from a prior day", async () => {
    // Items from yesterday — all action_needed → old score = 0.
    const yesterdayIso = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const makeOldRow = (category: string, key: string) => ({
      id: `old-${key}`, trip_id: TRIP_ID, user_id: null, category,
      status: "action_needed", severity: "normal",
      title: `Old ${category}`, detail: null, due_at: null,
      action_ref: null, dedupe_key: key, computed_at: yesterdayIso,
    });
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_readiness_items: { rows: [
        makeOldRow("plan",         "plan:dates"),
        makeOldRow("stay",         "stay:none"),
        makeOldRow("transport",    "transport:none"),
        makeOldRow("budget",       "budget:none"),
        makeOldRow("entry",        "entry:old"),
        makeOldRow("documents",    "documents:none"),
        makeOldRow("reservations", "reservations:old"),
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    // Stale (yesterday) → triggers recompute; previousScore = 0 (all action_needed = 0 ready-ish)
    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.strictEqual(r.body.previousScore, 0,
      "all-action_needed prior rows → previousScore must be 0");
    // Fresh score must differ (base trip has some ready categories)
    assert.ok(r.body.score !== null, "fresh score must be present");
    assert.ok(r.body.previousScore !== r.body.score,
      "fresh score must differ from prior-day score when trip state changed");
  });

  it("persists today's score to trip_readiness_snapshots on recompute", async () => {
    const { client, db } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);

    const snapshots = db.trip_readiness_snapshots.rows;
    assert.equal(snapshots.length, 1, "exactly one snapshot row should be written");
    const snap = snapshots[0];
    const todayStr = new Date().toISOString().slice(0, 10);
    assert.equal(snap.trip_id, TRIP_ID);
    assert.equal(snap.snapshot_date, todayStr, "snapshot_date must be today (UTC)");
    assert.equal(snap.score, r.body.score, "snapshot score must match the returned score");
  });

  it("prunes snapshot rows older than 30 days on recompute, keeping recent ones", async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    // 31 days ago — must be deleted
    const oldDate = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10);
    // 29 days ago — must be kept (within the 30-day window)
    const recentDate = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);

    const { client, db } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_readiness_snapshots: { rows: [
        { id: "s-old",    trip_id: TRIP_ID, snapshot_date: oldDate,    score: 10,
          computed_at: new Date(Date.now() - 31 * 864e5).toISOString() },
        { id: "s-recent", trip_id: TRIP_ID, snapshot_date: recentDate, score: 40,
          computed_at: new Date(Date.now() - 29 * 864e5).toISOString() },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);

    const snapRows = db.trip_readiness_snapshots.rows;
    assert.ok(
      !snapRows.some((s) => s.snapshot_date === oldDate),
      "snapshot older than 30 days must be pruned",
    );
    assert.ok(
      snapRows.some((s) => s.snapshot_date === recentDate),
      "snapshot within 30 days must be kept",
    );
    assert.ok(
      snapRows.some((s) => s.snapshot_date === todayStr),
      "today's snapshot must still be written",
    );
  });

  it("reads previousScore from trip_readiness_snapshots on a same-day second recompute", async () => {
    // Simulate: yesterday's snapshot exists; items are fresh from today (same-day).
    // The first recompute already ran today and stored a snapshot. A second
    // forced refresh must read yesterday's snapshot — not derive from today's items.
    const yesterdayStr = new Date(Date.now() - 25 * 3600 * 1000).toISOString().slice(0, 10);
    const todayIso = new Date().toISOString();

    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      // Today's items are fresh — same-day, would normally suppress previousScore
      trip_readiness_items: { rows: [
        { id: "r1", trip_id: TRIP_ID, user_id: null, category: "stay",
          status: "action_needed", severity: "normal",
          title: "No accommodation", detail: null, due_at: null,
          action_ref: null, dedupe_key: "stay:none", computed_at: todayIso },
      ]},
      // Yesterday's snapshot carries a known prior score
      trip_readiness_snapshots: { rows: [
        { id: "s1", trip_id: TRIP_ID, snapshot_date: yesterdayStr, score: 57,
          computed_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness?refresh=1`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.strictEqual(r.body.previousScore, 57,
      "previousScore must come from yesterday's snapshot even on a same-day forced recompute");
  });

  it("sweeps stale rows on recompute (resolved items disappear from storage)", async () => {
    const { client, db } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      // Accommodation now exists → the stored stay:none row is stale.
      trip_plan_items: { rows: [
        { id: "p1", trip_id: TRIP_ID, category: "accommodation", status: "confirmed" },
      ]},
      trip_readiness_items: { rows: [
        { id: RES_ID, trip_id: TRIP_ID, user_id: null, category: "stay",
          status: "action_needed", severity: "normal", title: "No accommodation planned",
          detail: null, due_at: null, action_ref: null, dedupe_key: "stay:none",
          computed_at: "2026-01-01T00:00:00Z" },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness?refresh=1`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.ok(!findItem(r.body.items, "stay:none"), "resolved stay item must not be served");
    assert.ok(
      !db.trip_readiness_items.rows.some((row) => row.dedupe_key === "stay:none"),
      "stale stay:none row must be deleted from storage",
    );
    // Fresh items were persisted with new computed_at
    assert.ok(db.trip_readiness_items.rows.length > 0, "recompute should persist fresh items");
  });

  it("never hides critical items behind a high score (critical-visibility rule)", async () => {
    const day1 = daysFromNow(5);
    const day2 = daysFromNow(6);
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip({ start_date: day1, end_date: day2 })] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_plan_items: { rows: [
        { id: "p1", trip_id: TRIP_ID, category: "accommodation", status: "confirmed", day_date: day1 },
        { id: "p2", trip_id: TRIP_ID, category: "transport", status: "confirmed", day_date: day2 },
      ]},
      trip_budget: { rows: [{ trip_id: TRIP_ID, currency: "USD", total_budget: 1000, spent: 100 }] },
      trip_documents: { rows: [{ id: DOC_ID, trip_id: TRIP_ID, title: "Passport scan" }] },
      trip_traveler_passports: { rows: [
        { trip_id: TRIP_ID, user_id: OWNER_ID, passport_country: "US" },
      ]},
      entry_requirements: { rows: [
        { passport_country: "US", destination_country: "JP", status: "visa_free" },
      ]},
      trip_reservations: { rows: [
        { id: RES_ID, trip_id: TRIP_ID, type: "tour", title: "Sunset tour", status: "confirmed",
          cancellation_deadline_at: hoursFromNow(24) },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);

    // Six of seven categories ready → high score…
    assert.equal(r.body.score, 86);
    // …and the critical cancellation deadline is STILL fully visible.
    assert.equal(r.body.criticalItems.length, 1);
    const critical = r.body.criticalItems[0];
    assert.ok(critical.dedupeKey.startsWith("reservations:deadline:"));
    assert.equal(critical.severity, "critical");
    assert.ok(critical.dueAt, "critical deadline item must carry due_at");
    assert.equal(r.body.categories.reservations, "action_needed");
  });

  // ── Next best action ───────────────────────────────────────────────────────

  it("ranks NBA: critical → autopilot proposal → action_needed → incomplete", async () => {
    const day1 = daysFromNow(60);
    const day2 = daysFromNow(61);
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip({ start_date: day1, end_date: day2 })] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_plan_items: { rows: [
        { id: "p1", trip_id: TRIP_ID, category: "accommodation", status: "confirmed", day_date: day1 },
        { id: "p2", trip_id: TRIP_ID, category: "activity", status: "confirmed", day_date: day2 },
      ]},
      trip_budget: { rows: [{ trip_id: TRIP_ID, currency: "USD", total_budget: 100, spent: 150 }] },
      trip_traveler_passports: { rows: [
        { trip_id: TRIP_ID, user_id: OWNER_ID, passport_country: "US" },
      ]},
      entry_requirements: { rows: [
        { passport_country: "US", destination_country: "JP", status: "visa_free" },
      ]},
      trip_autopilot_proposals: { rows: [
        { id: PROP_ID, trip_id: TRIP_ID, user_id: OWNER_ID, issue_type: "closure",
          severity: "attention", reason: "Museum closed on Tuesday", status: "pending",
          created_at: "2026-07-01T00:00:00Z" },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/next-best-action`, { token: "owner-token" });
    assert.equal(r.status, 200);

    // (1) critical: over budget
    assert.equal(r.body.primary.title, "Over budget");
    assert.equal(r.body.primary.severity, "critical");
    // (2) autopilot proposal, (3) action_needed, (4) incomplete — capped at 3
    assert.equal(r.body.alternatives.length, 3);
    assert.equal(r.body.alternatives[0].title, "Review proposed fix: Museum closed on Tuesday");
    assert.equal(r.body.alternatives[0].actionRef?.proposalId, PROP_ID);
    assert.equal(r.body.alternatives[1].title, "No transport planned");
    assert.equal(r.body.alternatives[2].title, "No documents saved");
    assert.ok(r.body.computedAt);
  });

  it("returns the honest fallback when nothing is urgent", async () => {
    const day1 = daysFromNow(5);
    const day2 = daysFromNow(6);
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip({ start_date: day1, end_date: day2 })] },
      trip_members: { rows: [ownerMemberRow()] },
      trip_plan_items: { rows: [
        { id: "p1", trip_id: TRIP_ID, category: "accommodation", status: "confirmed", day_date: day1 },
        { id: "p2", trip_id: TRIP_ID, category: "transport", status: "confirmed", day_date: day2 },
      ]},
      trip_budget: { rows: [{ trip_id: TRIP_ID, currency: "USD", total_budget: 1000, spent: 100 }] },
      trip_documents: { rows: [{ id: DOC_ID, trip_id: TRIP_ID, title: "Passport scan" }] },
      trip_traveler_passports: { rows: [
        { trip_id: TRIP_ID, user_id: OWNER_ID, passport_country: "US" },
      ]},
      entry_requirements: { rows: [
        { passport_country: "US", destination_country: "JP", status: "visa_free" },
      ]},
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/next-best-action`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.equal(r.body.primary, null);
    assert.deepEqual(r.body.alternatives, []);
    assert.equal(r.body.message, "You're on track — nothing urgent.");
  });

  // ── Gates ──────────────────────────────────────────────────────────────────

  it("rejects non-members with not_member on readiness and NBA", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      feature_flags: flagOn(),
    });
    _setTestClient(client, true);

    const r1 = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "other-token" });
    assert.equal(r1.status, 403);
    assert.equal(r1.body.error, "not_member");

    const r2 = await req(port, "GET", `/trips/${TRIP_ID}/next-best-action`, { token: "other-token" });
    assert.equal(r2.status, 403);
    assert.equal(r2.body.error, "not_member");
  });

  it("returns feature_disabled when the flag is off", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      feature_flags: flagOff(),
    });
    _setTestClient(client, true);

    const r1 = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r1.status, 404);
    assert.equal(r1.body.error, "feature_disabled");

    const r2 = await req(port, "GET", `/trips/${TRIP_ID}/next-best-action`, { token: "owner-token" });
    assert.equal(r2.status, 404);
    assert.equal(r2.body.error, "feature_disabled");
  });

  it("still computes readiness when trip_reservations does not exist (defensive)", async () => {
    const { client } = makeFakeClient(
      {
        trips: { rows: [baseTrip()] },
        trip_members: { rows: [ownerMemberRow()] },
        feature_flags: flagOn(),
      },
      { throwOnTables: ["trip_reservations"] },
    );
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/readiness`, { token: "owner-token" });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items), "compute must succeed without the table");
    // Reservations treated as absent → transport gap still derived from plan items
    assert.ok(findItem(r.body.items, "transport:none"));
    assert.equal(r.body.categories.reservations, "ready");
  });

  // ── Arrival board ──────────────────────────────────────────────────────────

  it("builds the arrival board from flight reservations with an honest sparse note (no flag required)", async () => {
    const arrivalIso = "2026-08-01T22:15:00Z";
    const { client } = makeFakeClient({
      // NOTE: trip_readiness_enabled deliberately NOT seeded — the board must
      // not be flag-gated. stamp_system_v2_enabled is required by the pathless
      // stamps-router gate that all late-registered routers pass through.
      feature_flags: { rows: [{ flag: "stamp_system_v2_enabled", enabled: true }] },
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [
        ownerMemberRow(),
        { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
      ]},
      trip_destinations: { rows: [
        { id: "d2", trip_id: TRIP_ID, city: "Kyoto", country: "JP", position: 2 },
        { id: "d1", trip_id: TRIP_ID, city: "Tokyo", country: "JP", position: 1 },
      ]},
      trip_reservations: { rows: [
        { id: RES_ID, trip_id: TRIP_ID, user_id: OWNER_ID, type: "flight",
          title: "UA 79 to Tokyo", status: "confirmed",
          starts_at: "2026-08-01T10:00:00Z", ends_at: arrivalIso },
        { id: "r2", trip_id: TRIP_ID, user_id: OWNER_ID, type: "stay",
          title: "Hotel", starts_at: "2026-08-01T00:00:00Z" },
      ]},
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/arrival-board`, { token: "member-token" });
    assert.equal(r.status, 200);
    assert.equal(r.body.destination.city, "Tokyo");
    assert.equal(r.body.board.length, 2);

    const ownerEntry = r.body.board.find((b: any) => b.userId === OWNER_ID);
    const memberEntry = r.body.board.find((b: any) => b.userId === MEMBER_ID);
    assert.ok(ownerEntry.arrival, "owner should have arrival info");
    assert.equal(ownerEntry.arrival.time, new Date(arrivalIso).toISOString());
    assert.equal(ownerEntry.arrival.label, "UA 79 to Tokyo");
    assert.equal(memberEntry.arrival, null);
    // Honest note when the board is sparse
    assert.equal(r.body.note, "Add flight reservations to populate the arrival board.");
  });

  it("rejects non-members on the arrival board", async () => {
    const { client } = makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [ownerMemberRow()] },
      feature_flags: { rows: [{ flag: "stamp_system_v2_enabled", enabled: true }] },
    });
    _setTestClient(client, true);

    const r = await req(port, "GET", `/trips/${TRIP_ID}/arrival-board`, { token: "other-token" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });
});
