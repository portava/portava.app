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
} from "../services/trust/TrustGamingDetectionService.js";

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
