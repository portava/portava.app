/**
 * Trust engine — the attendance vocabulary contract, and the check-in-cluster
 * gaming scan that reads it.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
 *
 * `TrustGamingDetectionService.detectCheckinClusters` filtered
 * `plan_attendance_events.event_type = 'checked_in'`. No writer has ever
 * produced that string and the table's CHECK constraint has never admitted it,
 * so the scan matched zero rows in every environment — the check-in-cluster
 * detector had never flagged anyone and could not.
 *
 * It survived because `trust.test.ts` seeded six fixture rows carrying the
 * impossible value through a fake client with no constraint model. The fixture
 * encoded the bug, so the test defended it. That is the trap this file is built
 * not to repeat: the fake client below REJECTS an insert whose `event_type` is
 * outside the CHECK set, and the CHECK set is PARSED FROM THE SQL rather than
 * retyped here — so a fixture can never assert a value the database would
 * refuse, and the admitted set can never silently drift away from the code.
 *
 * There was a second, larger half to the same defect: every string the
 * application actually wrote was ALSO outside the constraint, so the table was
 * unwritable and permanently empty in production (verified: 0 rows). Migration
 * 2302 admits the real vocabulary. The static suite below is what keeps writer,
 * reader and constraint pinned to each other.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runGamingDetectionScan,
  CHECKIN_CLUSTER_EVENT_TYPES,
  CHECKIN_CLUSTER_WATERMARK_JOB,
  RAPID_JUMP_WATERMARK_JOB,
  DEFAULT_LOOKBACK_MS,
  MAX_CATCHUP_MS,
} from "../services/trust/TrustGamingDetectionService.js";
import { COUNTERPARTY_METADATA_KEY } from "../services/trust/TrustEventService.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const BASELINE = resolve(API_ROOT, "baseline/20260819_baseline_structure.sql");
const MIGRATIONS_DIR = resolve(API_ROOT, "src/migrations");
const GEOFENCE_ROUTE = resolve(API_ROOT, "src/routes/geofence.ts");
const ADMIN_ROUTE = resolve(API_ROOT, "src/routes/admin.ts");

// ── Deriving the CHECK sets from SQL, never from database.types.ts ───────────

/**
 * Every source of truth for a constraint, oldest first: the committed baseline
 * dump, then the migrations in lane order. The LAST definition wins, exactly as
 * it does when the files are applied in sequence.
 */
function sqlSourcesInApplyOrder(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return [readFileSync(BASELINE, "utf8"), ...files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))];
}

/**
 * The labels a named CHECK constraint admits.
 *
 * Handles both spellings the repo uses — the pg_dump form
 * `CHECK ((col = ANY (ARRAY['a'::text, …])))` and the hand-written form
 * `CHECK (col IN ('a', …))` — and returns the labels of the last definition
 * found across the apply order.
 */
function admittedLabels(constraintName: string): string[] {
  let latest: string[] | null = null;
  for (const sql of sqlSourcesInApplyOrder()) {
    // Find each occurrence of the constraint name followed by its CHECK body.
    const re = new RegExp(`${constraintName}\\s+CHECK\\s*\\(([\\s\\S]{0,2000}?)\\)\\s*[;,)]`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const body = m[1];
      const labels = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
      if (labels.length > 0) latest = labels;
    }
  }
  if (latest === null) {
    throw new Error(`no CHECK definition found for ${constraintName} in the baseline or any migration`);
  }
  return latest;
}

const ATTENDANCE_EVENT_TYPES = admittedLabels("plan_attendance_events_event_type_check");
const CHECKIN_STATUSES = admittedLabels("plan_checkins_status_check");

// ── Literals the application code uses on those two columns ──────────────────

/**
 * Every `event_type` the geofence route can write to plan_attendance_events.
 *
 * Scoped to the two helpers that reach the table — `writeAttendanceEvent` and
 * `upsertCheckin`, which forwards to it — because the file also builds a
 * TRUST event with a field of the same name (`eventType: "plan_attended"`),
 * which is a `trust_events.event_type` and belongs to a different vocabulary
 * entirely. A whole-file scan conflates the two.
 */
function geofenceAttendanceEventLiterals(): string[] {
  const src = readFileSync(GEOFENCE_ROUTE, "utf8");
  const out = new Set<string>();
  const callSites = [...src.matchAll(/\b(?:writeAttendanceEvent|upsertCheckin)\(/g)].map((m) => m.index ?? 0);
  assert.ok(callSites.length >= 3, `expected >= 3 attendance write call sites, found ${callSites.length}`);
  for (const at of callSites) {
    const window = src.slice(at, at + 500);
    for (const m of window.matchAll(/eventType:\s*"([^"]+)"/g)) out.add(m[1]);
  }
  // The successful-check-in path picks its label in a ternary just above the
  // upsertCheckin call, then passes the variable in.
  for (const m of src.matchAll(/const\s+eventType\s*=\s*[^;]*?"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    out.add(m[1]); out.add(m[2]);
  }
  return [...out];
}

/** The `ATTENDANCE_STATUSES` tuple the route's zod enum and upsert are built from. */
function geofenceAttendanceStatuses(): string[] {
  const src = readFileSync(GEOFENCE_ROUTE, "utf8");
  const m = /ATTENDANCE_STATUSES\s*=\s*\[([^\]]+)\]/.exec(src);
  assert.ok(m, "ATTENDANCE_STATUSES literal not found in routes/geofence.ts — update this extractor");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** `.eq("event_type", "x")` inside the admin suspicious-check-in query. */
function adminAttendanceEventLiterals(): string[] {
  const src = readFileSync(ADMIN_ROUTE, "utf8");
  const idx = src.indexOf('from("plan_attendance_events")');
  assert.ok(idx > 0, 'routes/admin.ts no longer reads plan_attendance_events — update this extractor');
  const window = src.slice(idx, idx + 600);
  return [...window.matchAll(/\.eq\("event_type",\s*"([^"]+)"\)/g)].map((x) => x[1]);
}

describe("attendance vocabulary — the parsed CHECK sets are real", () => {
  it("parses a plausible set for both constraints", () => {
    // A parser that silently collapsed would make every subset assertion below
    // vacuous, so pin that it found something and that it found the labels the
    // constraint has always carried.
    assert.ok(
      ATTENDANCE_EVENT_TYPES.length >= 4,
      `expected >= 4 admitted event_type labels, parsed ${JSON.stringify(ATTENDANCE_EVENT_TYPES)}`,
    );
    assert.ok(
      CHECKIN_STATUSES.length >= 4,
      `expected >= 4 admitted plan_checkins.status labels, parsed ${JSON.stringify(CHECKIN_STATUSES)}`,
    );
    for (const legacy of ["suspicious", "late", "override", "excused"]) {
      assert.ok(ATTENDANCE_EVENT_TYPES.includes(legacy), `legacy event_type '${legacy}' must stay admitted`);
    }
    for (const legacy of ["pending", "arrived", "no_show", "excused"]) {
      assert.ok(CHECKIN_STATUSES.includes(legacy), `legacy status '${legacy}' must stay admitted`);
    }
  });
});

describe("attendance vocabulary — every writer and reader is admitted", () => {
  it("the geofence route only ever writes an admitted event_type", () => {
    const written = geofenceAttendanceEventLiterals();
    assert.ok(written.length >= 3, `expected >= 3 attendance event literals, found ${JSON.stringify(written)}`);
    for (const label of written) {
      assert.ok(
        ATTENDANCE_EVENT_TYPES.includes(label),
        `routes/geofence.ts writes plan_attendance_events.event_type='${label}', which the CHECK ` +
        `constraint does not admit (${JSON.stringify(ATTENDANCE_EVENT_TYPES)}). Every such INSERT is ` +
        `rejected with 23514 and swallowed by writeAttendanceEvent's catch.`,
      );
    }
  });

  it("the geofence route only ever writes an admitted plan_checkins.status", () => {
    const statuses = geofenceAttendanceStatuses();
    for (const label of statuses) {
      assert.ok(
        CHECKIN_STATUSES.includes(label),
        `ATTENDANCE_STATUSES contains '${label}', which plan_checkins_status_check does not admit ` +
        `(${JSON.stringify(CHECKIN_STATUSES)}). upsertCheckin returns false for it, so the check-in ` +
        `fails and no plan_attended trust event is recorded.`,
      );
    }
  });

  it("the admin suspicious-check-in dashboard reads an admitted event_type", () => {
    const read = adminAttendanceEventLiterals();
    assert.ok(read.length >= 1, "expected the admin route to filter event_type");
    for (const label of read) {
      assert.ok(
        ATTENDANCE_EVENT_TYPES.includes(label),
        `routes/admin.ts filters event_type='${label}', outside the CHECK set ` +
        `${JSON.stringify(ATTENDANCE_EVENT_TYPES)} — the dashboard can only ever be empty.`,
      );
    }
  });

  it("the gaming detector reads admitted event_types, and only real arrivals", () => {
    for (const label of CHECKIN_CLUSTER_EVENT_TYPES) {
      assert.ok(
        ATTENDANCE_EVENT_TYPES.includes(label),
        `CHECKIN_CLUSTER_EVENT_TYPES contains '${label}', outside the CHECK set ` +
        `${JSON.stringify(ATTENDANCE_EVENT_TYPES)} — the cluster scan would match zero rows.`,
      );
    }
    // Every value the detector looks for must also be something the geofence
    // route actually writes; otherwise the scan is admitted-but-still-empty.
    const written = new Set(geofenceAttendanceEventLiterals());
    for (const label of CHECKIN_CLUSTER_EVENT_TYPES) {
      assert.ok(written.has(label), `no writer emits event_type='${label}'`);
    }
    // A rejected check-in and a host override are not arrivals and must not
    // count toward a farming cluster.
    for (const notAnArrival of ["suspicious_check_in", "host_manual_override"]) {
      assert.ok(
        !(CHECKIN_CLUSTER_EVENT_TYPES as readonly string[]).includes(notAnArrival),
        `'${notAnArrival}' is not an arrival and must not be counted as a check-in`,
      );
    }
  });
});

// ── Behaviour: the cluster scan actually fires on rows the writers produce ───

interface FakeTables {
  feature_flags: any[];
  trust_settings: any[];
  trust_events: any[];
  trust_reviews: any[];
  plan_attendance_events: any[];
}

const CLUSTER_LIMIT = 5;
const USER_A = "user-cluster-a";

function makeTables(): FakeTables {
  return {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: true },
    ],
    trust_settings: [{
      id: 1,
      gaming_checkin_cluster_limit: CLUSTER_LIMIT,
      gaming_mutual_rate_threshold: 0.8,
      gaming_rapid_jump_points: 20,
    }],
    trust_events: [],
    trust_reviews: [],
    plan_attendance_events: [],
  };
}

/**
 * A fake client that models the ONE database rule this defect turned on: the
 * CHECK constraint on `plan_attendance_events.event_type`, parsed from the SQL.
 * An insert outside the admitted set resolves with a 23514 error tuple, exactly
 * as postgrest-js does — it does not throw.
 */
function makeClient(tables: FakeTables) {
  let seq = 1;
  function from(table: keyof FakeTables) {
    const store = tables[table] as any[];
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let insertError: any = null;

    const builder: any = {
      select() { return builder; },
      insert(row: any) {
        if (table === "plan_attendance_events" && !ATTENDANCE_EVENT_TYPES.includes(row.event_type)) {
          insertError = {
            code: "23514",
            message: `new row for relation "plan_attendance_events" violates check constraint ` +
                     `"plan_attendance_events_event_type_check" (event_type='${row.event_type}')`,
          };
          return builder;
        }
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r);
        pendingInsert = r;
        return builder;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return resolve_(true); },
      single() { return resolve_(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    async function resolve_(_maybe: boolean) {
      if (insertError) return { data: null, error: insertError };
      if (pendingInsert) return { data: pendingInsert, error: null };
      const rows = store.filter((r) => filters.every((f) => f(r)));
      return { data: rows[0] ?? null, error: null };
    }
    async function resolveList() {
      if (insertError) return { data: null, error: insertError };
      if (pendingInsert) return { data: [pendingInsert], error: null };
      const rows = store.filter((r) => filters.every((f) => f(r)));
      return { data: rows, error: null, count: rows.length };
    }
    return builder;
  }
  return { from } as any;
}

/** Seed one arrival row through the constraint-enforcing insert path. */
async function seedArrival(client: any, userId: string, geofenceId: string, eventType: string) {
  const { error } = await client.from("plan_attendance_events").insert({
    user_id: userId, geofence_id: geofenceId, event_type: eventType,
    created_at: new Date().toISOString(),
  });
  return error;
}

describe("TrustGamingDetectionService — check-in cluster scan", () => {
  it("the fake client refuses a value the real CHECK constraint refuses", async () => {
    // Guards the guard: if this insert quietly succeeded, every fixture below
    // would prove nothing about the database. 'checked_in' is the exact string
    // the production filter used to carry.
    const tables = makeTables();
    const client = makeClient(tables);
    const error = await seedArrival(client, USER_A, "gf-1", "checked_in");
    assert.ok(error, "'checked_in' must be rejected — it is not an admitted event_type");
    assert.equal((error as any).code, "23514");
    assert.equal(tables.plan_attendance_events.length, 0);
  });

  it("flags a user who exceeds the cluster limit at one geofence", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    // Derived from the configured limit, not hard-coded: the scan flags on
    // strictly MORE than the limit, so one over is the smallest failing case.
    const overLimit = CLUSTER_LIMIT + 1;
    for (let i = 0; i < overLimit; i++) {
      const err = await seedArrival(client, USER_A, "gf-1", CHECKIN_CLUSTER_EVENT_TYPES[0]);
      assert.equal(err, null, "seeding a real arrival must be accepted by the constraint");
    }
    assert.equal(tables.plan_attendance_events.length, overLimit);

    const result = await runGamingDetectionScan(client);
    assert.equal(result.ok, true);
    const review = tables.trust_reviews.find((r) => r.metadata?.pattern === "checkin_cluster");
    assert.ok(review, "a checkin_cluster gaming review must be created");
    assert.equal(review.user_id, USER_A);
    assert.equal(review.metadata.checkinCount, overLimit);
    assert.equal(review.metadata.limit, CLUSTER_LIMIT);
  });

  it("does NOT flag at exactly the limit", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    for (let i = 0; i < CLUSTER_LIMIT; i++) {
      await seedArrival(client, USER_A, "gf-1", CHECKIN_CLUSTER_EVENT_TYPES[0]);
    }
    await runGamingDetectionScan(client);
    assert.equal(
      tables.trust_reviews.filter((r) => r.metadata?.pattern === "checkin_cluster").length,
      0,
      "the limit is a ceiling the scan tolerates, not one it flags",
    );
  });

  it("counts late arrivals but not rejected check-ins or host overrides", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    // Fill the cluster entirely with the OTHER admitted arrival label, so this
    // test fails if the detector narrows back to a single value.
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) {
      await seedArrival(client, USER_A, "gf-2", CHECKIN_CLUSTER_EVENT_TYPES[1]);
    }
    // Noise that must not be counted, on a different geofence and user.
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) {
      await seedArrival(client, "user-noise", "gf-3", "suspicious_check_in");
      await seedArrival(client, "user-noise", "gf-3", "host_manual_override");
    }
    await runGamingDetectionScan(client);
    const flagged = tables.trust_reviews.filter((r) => r.metadata?.pattern === "checkin_cluster");
    assert.equal(flagged.length, 1, "exactly the arriving user is flagged");
    assert.equal(flagged[0].user_id, USER_A);
  });

  it("separates clusters by geofence — spread-out check-ins are not farming", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) {
      await seedArrival(client, USER_A, `gf-${i}`, CHECKIN_CLUSTER_EVENT_TYPES[0]);
    }
    await runGamingDetectionScan(client);
    assert.equal(
      tables.trust_reviews.filter((r) => r.metadata?.pattern === "checkin_cluster").length,
      0,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The scan watermark: the gap these detectors used to forget
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY HERE. This file is the registered suite that exercises
// TrustGamingDetectionService's behaviour (see `pnpm test` / `test:trust-lane`
// in package.json), and the check-in-cluster detector it already drives is one
// of the two the watermark applies to. The fixtures below use their own fake
// client rather than extending the constraint-enforcing one above, so nothing
// here can relax the CHECK-constraint modelling those tests depend on.
//
// ── THE DEFECT THESE EXIST FOR ──────────────────────────────────────────────
//
// The maintenance pass runs every six hours and two of the three detectors
// selected evidence with a bare `created_at > now - 24h`. A window forgets: as
// soon as the gap between passes exceeds the window, every row inside the gap
// is older than the next pass's `since` and is examined by NO later pass. After
// a 54-hour outage roughly 30 hours of check-in clusters and rapid score jumps
// were skipped permanently and a score gamed inside the gap simply stood.
//
// Each test below therefore asserts the RESULTING STATE — the review rows, and
// the watermark row afterwards — never that a call returned ok
// (CONTRIBUTING.md: "assert the resulting state"). Three of them carry an
// explicit CONTROL arm proving the fixture is genuinely outside the old 24h
// window, so a regression that silently restored the window cannot pass by
// flagging evidence that was in range all along.

const WM_TABLE = "scheduler_watermarks";
const HOUR = 60 * 60 * 1_000;

/** The outage in the production report: 54 hours, against a 24h window. */
const GAP_MS = 54 * HOUR;
/** Inside that gap and comfortably outside the old window. */
const INSIDE_GAP_MS = 40 * HOUR;

const JUMP_THRESHOLD = 20;
/** Above anything any fixture here accumulates, to park a detector that must stay quiet. */
const UNREACHABLE = 1_000_000;

interface WmTables {
  feature_flags: any[];
  trust_settings: any[];
  trust_events: any[];
  trust_reviews: any[];
  plan_attendance_events: any[];
  scheduler_watermarks: any[];
}

function makeWmTables(opts?: { clusterLimit?: number; jumpPoints?: number; mutualRate?: number }): WmTables {
  return {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: true },
    ],
    trust_settings: [{
      id: 1,
      gaming_checkin_cluster_limit: opts?.clusterLimit ?? CLUSTER_LIMIT,
      gaming_mutual_rate_threshold: opts?.mutualRate ?? 0.8,
      gaming_rapid_jump_points: opts?.jumpPoints ?? JUMP_THRESHOLD,
    }],
    trust_events: [],
    trust_reviews: [],
    plan_attendance_events: [],
    scheduler_watermarks: [],
  };
}

type Op = "select" | "insert" | "upsert";

/**
 * A fake client that models the watermark row and the ONE postgrest behaviour
 * every assertion here turns on: a database error RESOLVES with `{ error }`, it
 * does not throw. `fail(table, op)` injects that tuple for every matching call,
 * which is how "the read failed" is distinguished from "there is no row" — the
 * two are identical in the data and mean opposite things.
 */
function makeWmClient(tables: WmTables) {
  let seq = 1;
  interface Rule { table: string; op: Op; job?: string; times?: number }
  const failures: Rule[] = [];

  function from(table: string) {
    const store = ((tables as any)[table] ??= []) as any[];
    const filters: Array<(r: any) => boolean> = [];
    const eqs: Record<string, any> = {};
    let op: Op = "select";
    let pending: any = null;

    /**
     * A rule may be scoped to one `job` and limited to a number of calls, so a
     * TRANSIENT failure can be modelled. That matters: a permanent failure of
     * the watermark table makes `commitWatermark` refuse on its own internal
     * re-read, which masks whether the CALLER withheld the commit. A failure
     * that clears between the two reads isolates the caller's own decision.
     */
    const failing = () => {
      const r = failures.find((f) =>
        f.table === table && f.op === op &&
        (f.job === undefined || f.job === eqs["job"]) &&
        (f.times === undefined || f.times > 0));
      if (!r) return false;
      if (r.times !== undefined) r.times -= 1;
      return true;
    };
    const errTuple = () => ({
      data: null,
      error: { code: "57014", message: `injected ${op} failure on ${table}` },
    });

    const builder: any = {
      select() { return builder; },
      insert(row: any) {
        op = "insert";
        if (failing()) return builder;
        const r = { id: `wm-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r);
        pending = r;
        return builder;
      },
      upsert(row: any, _opts?: any) {
        op = "upsert";
        if (failing()) return builder;
        const i = store.findIndex((r) => r.job === row.job);
        if (i >= 0) store[i] = { ...store[i], ...row };
        else store.push({ ...row });
        pending = row;
        return builder;
      },
      eq(col: string, val: any) { eqs[col] = val; filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return single(); },
      single() { return single(); },
      then(onF: any, onR: any) { return list().then(onF, onR); },
    };

    async function single() {
      if (failing()) return errTuple();
      if (pending) return { data: pending, error: null };
      const rows = store.filter((r) => filters.every((f) => f(r)));
      return { data: rows[0] ?? null, error: null };
    }
    async function list() {
      if (failing()) return errTuple();
      if (pending) return { data: [pending], error: null };
      const rows = store.filter((r) => filters.every((f) => f(r)));
      return { data: rows, error: null, count: rows.length };
    }
    return builder;
  }

  return {
    client: { from } as any,
    fail(table: string, op: Op) { failures.push({ table, op }); },
    /** Fail the next `times` matching calls for one job, then recover. */
    failTransiently(table: string, op: Op, job: string, times: number) {
      failures.push({ table, op, job, times });
    },
  };
}

/** Put a mark for `job` at `agoMs` before now. */
function setMark(tables: WmTables, job: string, agoMs: number) {
  tables.scheduler_watermarks.push({
    job,
    processed_through: new Date(Date.now() - agoMs).toISOString(),
    updated_at: new Date(Date.now() - agoMs).toISOString(),
  });
}

function markAt(tables: WmTables, job: string): string | undefined {
  return tables.scheduler_watermarks.find((r) => r.job === job)?.processed_through;
}

function seedArrivalAt(tables: WmTables, userId: string, geofenceId: string, agoMs: number) {
  tables.plan_attendance_events.push({
    id: `pae-${tables.plan_attendance_events.length + 1}`,
    user_id: userId,
    geofence_id: geofenceId,
    event_type: CHECKIN_CLUSTER_EVENT_TYPES[0],
    created_at: new Date(Date.now() - agoMs).toISOString(),
  });
}

function seedScoredEventAt(tables: WmTables, userId: string, delta: number, agoMs: number) {
  tables.trust_events.push({
    id: `te-${tables.trust_events.length + 1}`,
    user_id: userId,
    delta,
    status: "applied",
    source_type: "review",
    source_id: `src-${tables.trust_events.length + 1}`,
    metadata: {},
    created_at: new Date(Date.now() - agoMs).toISOString(),
  });
}

const clusterReviews = (t: WmTables) => t.trust_reviews.filter((r) => r.metadata?.pattern === "checkin_cluster");
const jumpReviews = (t: WmTables) => t.trust_reviews.filter((r) => r.metadata?.pattern === "rapid_jump");
const ringReviews = (t: WmTables) => t.trust_reviews.filter((r) => r.metadata?.pattern === "mutual_ring");

// (a) Evidence inside a 54-hour gap is examined.

describe("gaming scan watermark — evidence inside an outage gap is examined", () => {
  it("CONTROL: with no mark, 40-hour-old check-ins are invisible — the defect, reproduced", async () => {
    // This is the arm that gives the next test its meaning. If a future change
    // restored the bare 24h window, the next test would still pass unless this
    // one proves the fixture sits OUTSIDE that window.
    const tables = makeWmTables({ jumpPoints: UNREACHABLE });
    const { client } = makeWmClient(tables);
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) seedArrivalAt(tables, USER_A, "gf-gap", INSIDE_GAP_MS);

    const r = await runGamingDetectionScan(client);
    assert.equal(r.inputs!.checkins, 0, "a 24h lookback cannot see 40-hour-old rows");
    assert.equal(clusterReviews(tables).length, 0);
  });

  it("a mark from before a 54-hour gap makes the check-in cluster inside it visible", async () => {
    const tables = makeWmTables({ jumpPoints: UNREACHABLE });
    const { client } = makeWmClient(tables);
    setMark(tables, CHECKIN_CLUSTER_WATERMARK_JOB, GAP_MS);
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) seedArrivalAt(tables, USER_A, "gf-gap", INSIDE_GAP_MS);

    const r = await runGamingDetectionScan(client);
    assert.equal(r.inputs!.checkins, CLUSTER_LIMIT + 1, "the whole cluster must be inside the scanned span");
    const review = clusterReviews(tables)[0];
    assert.ok(review, "the cluster farmed during the outage must raise a review");
    assert.equal(review.user_id, USER_A);
    assert.equal(review.metadata.checkinCount, CLUSTER_LIMIT + 1);
    // And the span is now covered, so the next pass starts from here.
    const after = markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB);
    assert.ok(after, "a successful scan must leave a mark");
    assert.ok(
      Date.now() - new Date(after!).getTime() < HOUR,
      `mark should have advanced to ~now, got ${after}`,
    );
  });

  it("CONTROL: with no mark, a 40-hour-old score jump is invisible", async () => {
    const tables = makeWmTables({ clusterLimit: UNREACHABLE });
    const { client } = makeWmClient(tables);
    seedScoredEventAt(tables, "user-jump", JUMP_THRESHOLD + 5, INSIDE_GAP_MS);

    const r = await runGamingDetectionScan(client);
    assert.equal(r.inputs!.scoredEvents, 0);
    assert.equal(jumpReviews(tables).length, 0);
  });

  it("a mark from before a 54-hour gap makes the rapid jump inside it visible", async () => {
    const tables = makeWmTables({ clusterLimit: UNREACHABLE });
    const { client } = makeWmClient(tables);
    setMark(tables, RAPID_JUMP_WATERMARK_JOB, GAP_MS);
    seedScoredEventAt(tables, "user-jump", JUMP_THRESHOLD + 5, INSIDE_GAP_MS);

    const r = await runGamingDetectionScan(client);
    assert.equal(r.inputs!.scoredEvents, 1);
    const review = jumpReviews(tables)[0];
    assert.ok(review, "the score jump farmed during the outage must raise a review");
    assert.equal(review.user_id, "user-jump");
    assert.equal(review.metadata.deltaIn24h, JUMP_THRESHOLD + 5);
  });

  it("each detector carries its OWN mark — one failing cannot advance the other's coverage", async () => {
    // A single shared key would let the detector that succeeded certify the span
    // the detector that FAILED never examined, manufacturing the same permanent
    // skip out of a transient error. Both marks start before the gap; only the
    // check-in table is broken.
    const tables = makeWmTables();
    const h = makeWmClient(tables);
    h.fail("plan_attendance_events", "select");
    setMark(tables, CHECKIN_CLUSTER_WATERMARK_JOB, GAP_MS);
    setMark(tables, RAPID_JUMP_WATERMARK_JOB, GAP_MS);
    const clusterBefore = markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB);
    seedScoredEventAt(tables, "user-jump", JUMP_THRESHOLD + 5, INSIDE_GAP_MS);

    const r = await runGamingDetectionScan(h.client);
    assert.equal(r.inputs!.checkins, null, "the cluster query failed — 'could not look', not 'saw nothing'");
    assert.equal(
      markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB),
      clusterBefore,
      "the failed detector's mark must not move",
    );
    assert.ok(
      Date.now() - new Date(markAt(tables, RAPID_JUMP_WATERMARK_JOB)!).getTime() < HOUR,
      "the detector that DID succeed advances its own mark",
    );
  });
});

// (b) An unreadable mark is a refusal, not an absence.

describe("gaming scan watermark — an unreadable mark neither widens nor commits", () => {
  it("a failed mark read keeps the 24h lookback and leaves the stored mark alone", async () => {
    const tables = makeWmTables({ jumpPoints: UNREACHABLE });
    const h = makeWmClient(tables);
    // The mark exists and WOULD have widened the scan — but it cannot be read,
    // and a read this process cannot establish must not be acted on in either
    // direction (CONTRIBUTING.md:33-66).
    setMark(tables, CHECKIN_CLUSTER_WATERMARK_JOB, GAP_MS);
    const before = markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB);
    h.fail(WM_TABLE, "select");
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) seedArrivalAt(tables, USER_A, "gf-gap", INSIDE_GAP_MS);

    const r = await runGamingDetectionScan(h.client);

    // NOT widened: the scan fell back to exactly the 24h window it used before
    // the watermark existed, so the gap evidence is out of range.
    assert.equal(r.inputs!.checkins, 0, "an unreadable mark must not widen the scan");
    assert.equal(clusterReviews(tables).length, 0);
    // NOT committed: a blip cannot move coverage it could not account for.
    assert.equal(markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB), before, "the mark must not move");
    assert.equal(tables.scheduler_watermarks.length, 1, "and no second row may appear");
  });

  it("a TRANSIENT mark-read failure still withholds the commit — isolating the caller's own refusal", async () => {
    // Why this exists as well as the test above. When the watermark table is
    // permanently unreadable, `commitWatermark` refuses on its own internal
    // re-read, so "the mark did not move" proves nothing about the caller. Here
    // only the FIRST read for this job fails; a commit, had the caller made
    // one, would have read successfully and landed. The mark staying put is
    // therefore evidence that THIS detector declined to certify a span whose
    // starting point it could not establish — and not a side effect of the
    // shared module's clamp.
    const tables = makeWmTables({ jumpPoints: UNREACHABLE });
    const h = makeWmClient(tables);
    setMark(tables, CHECKIN_CLUSTER_WATERMARK_JOB, GAP_MS);
    const before = markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB);
    h.failTransiently(WM_TABLE, "select", CHECKIN_CLUSTER_WATERMARK_JOB, 1);
    // Evidence well inside the fallback 24h, so the scan itself succeeds and
    // the commit is the ONLY thing being withheld.
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) seedArrivalAt(tables, USER_A, "gf-now", 2 * HOUR);

    const r = await runGamingDetectionScan(h.client);
    assert.equal(r.inputs!.checkins, CLUSTER_LIMIT + 1, "the scan ran and succeeded");
    assert.equal(clusterReviews(tables).length, 1, "and raised its flag");
    assert.equal(
      markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB),
      before,
      "but the span is unaccounted for, so the mark must not move — an unreadable mark is a " +
      "REFUSAL, not an absence (CONTRIBUTING.md:33-66)",
    );
  });

  it("a missing mark is NOT a refusal — it scans the default 24h and commits", async () => {
    // The other half of the same distinction: `{at: null, ok: true}` means
    // "fresh install", and collapsing the two is what would make a blip look
    // like one. Evidence inside 24h, so the default lookback is enough.
    const tables = makeWmTables({ jumpPoints: UNREACHABLE });
    const { client } = makeWmClient(tables);
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) seedArrivalAt(tables, USER_A, "gf-now", 2 * HOUR);

    await runGamingDetectionScan(client);
    assert.equal(clusterReviews(tables).length, 1, "first-run behaviour is the unchanged 24h lookback");
    assert.ok(markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB), "a first successful scan establishes the mark");
  });

  it("the fallback span is the 24h the detectors have always used, not a new number", () => {
    assert.equal(DEFAULT_LOOKBACK_MS, 24 * HOUR, "changing this changes first-run behaviour");
  });
});

// (c) The catch-up cap bounds how far one pass reaches back.

describe("gaming scan watermark — the catch-up cap bounds the span", () => {
  it("a mark older than the cap scans back exactly to the cap, and no further", async () => {
    const tables = makeWmTables({ jumpPoints: UNREACHABLE });
    const { client } = makeWmClient(tables);
    // A mark from well before the cap: an uncapped catch-up would reach it.
    setMark(tables, CHECKIN_CLUSTER_WATERMARK_JOB, MAX_CATCHUP_MS + 72 * HOUR);
    // Two clusters, sized off the cap rather than hardcoded so this keeps
    // testing the cap if the constant moves: one just inside, one just outside.
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) {
      seedArrivalAt(tables, "user-inside-cap", "gf-in", MAX_CATCHUP_MS - 24 * HOUR);
      seedArrivalAt(tables, "user-beyond-cap", "gf-out", MAX_CATCHUP_MS + 24 * HOUR);
    }

    const r = await runGamingDetectionScan(client);
    assert.equal(r.inputs!.checkins, CLUSTER_LIMIT + 1, "only the rows inside the cap may be examined");
    const flagged = clusterReviews(tables).map((x) => x.user_id);
    assert.deepEqual(flagged, ["user-inside-cap"]);
    assert.ok(
      !flagged.includes("user-beyond-cap"),
      "the cap is a real bound: evidence older than it is NOT covered by this pass",
    );
  });

  it("the cap is at least wide enough for the 54-hour outage that exposed this", () => {
    // The whole point of the change. A cap below the observed gap would leave
    // the original defect in place for exactly the case it was reported for.
    assert.ok(
      MAX_CATCHUP_MS > GAP_MS,
      `maxCatchupMs (${MAX_CATCHUP_MS / HOUR}h) must exceed the 54h production gap`,
    );
    // And never narrower than the window it replaces — this path may only ever
    // see MORE than it did before.
    assert.ok(MAX_CATCHUP_MS >= DEFAULT_LOOKBACK_MS, "the cap must not narrow the existing lookback");
  });
});

// (d) A failed or unaccounted-for pass does not advance the mark.

describe("gaming scan watermark — a pass that did not cover the span does not advance", () => {
  it("a failed detector query leaves the mark where it was", async () => {
    const tables = makeWmTables();
    const h = makeWmClient(tables);
    setMark(tables, RAPID_JUMP_WATERMARK_JOB, GAP_MS);
    const before = markAt(tables, RAPID_JUMP_WATERMARK_JOB);
    h.fail("trust_events", "select");

    const r = await runGamingDetectionScan(h.client);
    assert.equal(r.inputs!.scoredEvents, null);
    assert.equal(
      markAt(tables, RAPID_JUMP_WATERMARK_JOB),
      before,
      "advancing here would skip the span forever — the exact defect",
    );
  });

  it("a flag that never reached trust_reviews withholds the commit, so the next pass re-raises it", async () => {
    // The same defect from the other end: the evidence WAS examined, but the
    // review insert was rejected. Advancing over that span would lose the flag
    // permanently, and `createGamingReview` swallows its own insert errors.
    const tables = makeWmTables({ jumpPoints: UNREACHABLE });
    const h = makeWmClient(tables);
    setMark(tables, CHECKIN_CLUSTER_WATERMARK_JOB, GAP_MS);
    const before = markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB);
    h.fail("trust_reviews", "insert");
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) seedArrivalAt(tables, USER_A, "gf-gap", INSIDE_GAP_MS);

    const r = await runGamingDetectionScan(h.client);
    assert.equal(r.inputs!.checkins, CLUSTER_LIMIT + 1, "the evidence was examined");
    assert.equal(tables.trust_reviews.length, 0, "but no review row exists");
    assert.equal(
      markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB),
      before,
      "so the span still owes a review and the mark must not move",
    );
  });

  it("a commit that cannot land is not reported as coverage — the mark simply stays put", async () => {
    const tables = makeWmTables({ jumpPoints: UNREACHABLE });
    const h = makeWmClient(tables);
    setMark(tables, CHECKIN_CLUSTER_WATERMARK_JOB, GAP_MS);
    const before = markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB);
    h.fail(WM_TABLE, "upsert");
    for (let i = 0; i < CLUSTER_LIMIT + 1; i++) seedArrivalAt(tables, USER_A, "gf-gap", INSIDE_GAP_MS);

    await runGamingDetectionScan(h.client);
    assert.equal(clusterReviews(tables).length, 1, "the flag is still raised");
    assert.equal(markAt(tables, CHECKIN_CLUSTER_WATERMARK_JOB), before, "re-scanning is the safe direction");
  });
});

// (e) detectMutualRings is untouched.

describe("detectMutualRings is deliberately NOT watermarked", () => {
  it("still spans 7 days, with no watermark job of its own", () => {
    const src = readFileSync(resolve(API_ROOT, "src/services/trust/TrustGamingDetectionService.ts"), "utf8");
    const start = src.indexOf("async function detectMutualRings(");
    assert.ok(start > 0, "detectMutualRings not found — update this extractor");
    const end = src.indexOf("async function detectRapidJumps(", start);
    assert.ok(end > start, "detectRapidJumps not found after detectMutualRings");
    const body = src.slice(start, end);

    assert.match(
      body,
      /const since = new Date\(Date\.now\(\) - 7 \* 24 \* 60 \* 60 \* 1000\)/,
      "the ring scan's 7-day window must stay exactly as it was",
    );
    assert.ok(
      !body.includes("detectorWindow("),
      "detectMutualRings must not take a watermark: 7 days already exceeds any gap this scheduler " +
      "produces, and a ring is a RATIO over a population — moving its span moves what the ratio means",
    );
    assert.ok(
      !body.includes("advanceDetectorWatermark("),
      "detectMutualRings must not commit a watermark",
    );
    // And the other two must, or this suite is asserting against nothing.
    for (const fn of ["detectCheckinClusters", "detectRapidJumps"]) {
      const s2 = src.indexOf(`async function ${fn}(`);
      assert.ok(s2 > 0, `${fn} not found`);
      const b2 = src.slice(s2, s2 + 3_000);
      assert.ok(b2.includes("detectorWindow("), `${fn} must resolve a watermarked span`);
      assert.ok(b2.includes("advanceDetectorWatermark("), `${fn} must commit its span on success`);
    }
  });

  it("flags a 3-day-old ring even while the watermark table is unreadable", async () => {
    // Behavioural proof that the ring scan's reach does not depend on the
    // watermark at all: with every mark read failing, the two watermarked
    // detectors fall back to 24h, and the ring scan still sees 3 days back.
    const tables = makeWmTables({ clusterLimit: UNREACHABLE, jumpPoints: UNREACHABLE });
    const h = makeWmClient(tables);
    h.fail(WM_TABLE, "select");
    const A = "ring-a";
    const B = "ring-b";
    const pushRing = (userId: string, other: string, i: number) => {
      tables.trust_events.push({
        id: `ring-${userId}-${i}`,
        user_id: userId,
        delta: 4,
        status: "applied",
        source_type: "review",
        source_id: `obj-${userId}-${i}`,
        metadata: { [COUNTERPARTY_METADATA_KEY]: other },
        created_at: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
      });
    };
    for (let i = 0; i < 9; i++) { pushRing(A, B, i); pushRing(B, A, i); }

    await runGamingDetectionScan(h.client);
    assert.ok(ringReviews(tables).length > 0, "the 7-day ring window is unchanged by the watermark work");
  });
});
