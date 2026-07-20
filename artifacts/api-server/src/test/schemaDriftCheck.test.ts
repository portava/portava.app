/**
 * Unit tests for the generic startup schema-drift check.
 *
 * Uses a fake Supabase client whose from()/rpc() responses are controlled
 * per-test, and a fake logger that records calls.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runSchemaDriftCheck,
  CRITICAL_COLUMNS,
  type ColumnProbe,
  type FunctionProbe,
} from "../lib/schemaDriftCheck.js";

type FakeError = { code: string; message?: string } | null;

function makeFakeClient(opts: {
  columnErrors?: Record<string, FakeError>; // key "table.column"
  rpcErrors?: Record<string, FakeError>;
}) {
  return {
    from(table: string) {
      return {
        select(column: string) {
          return {
            limit(_n: number) {
              const error = opts.columnErrors?.[`${table}.${column}`] ?? null;
              return Promise.resolve({ data: error ? null : [], error });
            },
          };
        },
      };
    },
    rpc(fn: string, _args?: Record<string, unknown>) {
      const error = opts.rpcErrors?.[fn] ?? null;
      return Promise.resolve({ data: null, error });
    },
  } as any;
}

function makeFakeLogger() {
  const warns: Array<{ obj: unknown; msg: string | undefined }> = [];
  const infos: string[] = [];
  return {
    logger: {
      warn: (obj: unknown, msg?: string) => {
        if (typeof obj === "string") warns.push({ obj: undefined, msg: obj });
        else warns.push({ obj, msg });
      },
      info: (msg: string) => infos.push(msg),
      error: () => {},
    } as any,
    warns,
    infos,
  };
}

const COLUMNS: ColumnProbe[] = [
  { table: "profiles", column: "passport_section_order", migration: "0120.sql", impact: "layout saves fail" },
  { table: "trip_crew_location_sessions", column: "status", migration: "n/a", impact: "cleanup fails" },
];

const FUNCTIONS: FunctionProbe[] = [
  { fn: "toggle_feature_flag_with_audit", args: {}, migration: "0119.sql", impact: "flags 503" },
];

describe("runSchemaDriftCheck", () => {
  it("reports nothing missing and logs info when all columns/functions exist", async () => {
    const client = makeFakeClient({});
    const { logger, warns, infos } = makeFakeLogger();
    const result = await runSchemaDriftCheck(client, logger, COLUMNS, FUNCTIONS);
    assert.deepEqual(result.missingColumns, []);
    assert.deepEqual(result.missingFunctions, []);
    assert.equal(warns.length, 0);
    assert.equal(infos.length, 1);
    assert.match(infos[0]!, /schema drift check passed/);
  });

  it("collects every missing column into one consolidated warning", async () => {
    const client = makeFakeClient({
      columnErrors: {
        "profiles.passport_section_order": { code: "42703" },
        "trip_crew_location_sessions.status": { code: "PGRST204" },
      },
      rpcErrors: { toggle_feature_flag_with_audit: { code: "42883" } },
    });
    const { logger, warns } = makeFakeLogger();
    const result = await runSchemaDriftCheck(client, logger, COLUMNS, FUNCTIONS);

    assert.equal(result.missingColumns.length, 2);
    assert.equal(result.missingFunctions.length, 1);
    // exactly ONE consolidated warning
    assert.equal(warns.length, 1);
    const warn = warns[0]!;
    assert.match(warn.msg!, /schema drift detected — 3 missing/);
    const missing = (warn.obj as { missing: string[] }).missing;
    assert.equal(missing.length, 3);
    assert.ok(missing.some((m) => m.includes("profiles.passport_section_order") && m.includes("0120.sql")));
    assert.ok(missing.some((m) => m.includes("trip_crew_location_sessions.status")));
    assert.ok(missing.some((m) => m.includes("toggle_feature_flag_with_audit()")));
  });

  it("only flags a single missing column when the rest are present", async () => {
    const client = makeFakeClient({
      columnErrors: { "trip_crew_location_sessions.status": { code: "42703" } },
    });
    const { logger, warns } = makeFakeLogger();
    const result = await runSchemaDriftCheck(client, logger, COLUMNS, FUNCTIONS);
    assert.equal(result.missingColumns.length, 1);
    assert.equal(result.missingColumns[0]!.column, "status");
    assert.equal(result.missingFunctions.length, 0);
    assert.equal(warns.length, 1);
  });

  it("treats a missing table (42P01/PGRST205) as drift", async () => {
    const client = makeFakeClient({
      columnErrors: { "profiles.passport_section_order": { code: "PGRST205" } },
    });
    const { logger } = makeFakeLogger();
    const result = await runSchemaDriftCheck(client, logger, COLUMNS, FUNCTIONS);
    assert.equal(result.missingColumns.length, 1);
  });

  it("ignores unrelated errors (e.g. permission denied) and P0002 from the function probe", async () => {
    const client = makeFakeClient({
      columnErrors: { "profiles.passport_section_order": { code: "42501" } },
      rpcErrors: { toggle_feature_flag_with_audit: { code: "P0002" } },
    });
    const { logger, warns } = makeFakeLogger();
    const result = await runSchemaDriftCheck(client, logger, COLUMNS, FUNCTIONS);
    assert.deepEqual(result.missingColumns, []);
    assert.deepEqual(result.missingFunctions, []);
    assert.equal(warns.length, 0);
  });

  it("logs a per-probe warning but does not throw when a probe rejects", async () => {
    const client = {
      from() {
        return { select() { return { limit() { return Promise.reject(new Error("network down")); } }; } };
      },
      rpc() {
        return Promise.resolve({ data: null, error: null });
      },
    } as any;
    const { logger, warns } = makeFakeLogger();
    const result = await runSchemaDriftCheck(client, logger, COLUMNS, FUNCTIONS);
    assert.deepEqual(result.missingColumns, []);
    // one transport-failure warning per column probe, no consolidated drift warning
    assert.equal(warns.length, 2);
    assert.ok(warns.every((w) => w.msg === "schema drift check: probe failed"));
  });

  it("default critical probe list targets real live column names", () => {
    // Regression guard: a probe naming a column that doesn't exist in the live
    // schema produces permanent false-positive drift warnings on healthy DBs.
    // buddy_availability_exceptions uses `exception_date`, not `date`
    // (0133/0134 rebuild shape).
    const bae = CRITICAL_COLUMNS.filter((p) => p.table === "buddy_availability_exceptions");
    assert.ok(bae.length >= 1);
    for (const p of bae) assert.equal(p.column, "exception_date");
    // No probe may use an empty or wildcard column, and (table, column) pairs
    // must be unique so consolidated warnings stay readable.
    const keys = CRITICAL_COLUMNS.map((p) => `${p.table}.${p.column}`);
    assert.equal(new Set(keys).size, keys.length);
    for (const p of CRITICAL_COLUMNS) {
      assert.match(p.column, /^[a-z_]+$/);
      assert.match(p.table, /^[a-z_]+$/);
    }
  });

  it("covers all five buddy-wizard columns on rent_buddy_profiles", () => {
    // Regression guard for the availability_blocks incident: the wizard writes
    // these five columns via one upsert and BUDDY_PUBLIC_COLUMNS selects them,
    // so a single missing live column fails every wizard submit AND all buddy
    // browse/search/profile reads. The startup drift check must keep probing
    // every one of them.
    const probed = new Set(
      CRITICAL_COLUMNS.filter((p) => p.table === "rent_buddy_profiles").map((p) => p.column),
    );
    for (const col of [
      "display_name",
      "bio",
      "hourly_rate_usd",
      "availability_blocks",
      "preferred_meetup_zones",
    ]) {
      assert.ok(probed.has(col), `rent_buddy_profiles.${col} must be in CRITICAL_COLUMNS`);
    }
  });

  it("covers every audited wizard-style write path (task-1925 audit)", () => {
    // Regression guard: the 2026-07-20 audit diffed all multi-column
    // insert/upsert/update payloads against the live information_schema and
    // found three drifted paths (fixed by 0163). Each audited high-traffic
    // write path must keep at least the probes below so a re-drift is caught
    // at startup rather than as a hard write failure in production.
    const probed = new Set(CRITICAL_COLUMNS.map((p) => `${p.table}.${p.column}`));
    for (const key of [
      // found missing live by the audit; added by 0163
      "posts.filter_id",
      "posts.filter_intensity",
      "posts.media_duration_seconds",
      "rent_buddy_bookings.country_code",
      "rent_buddy_policy_flags.updated_at",
      // one sentinel column per remaining audited path
      "profiles.public_social_links",
      "trips.cover_media_type",
      "events.cover_media_type",
      "profile_privacy_settings.delayed_posting_default",
      "passport_postcards.note",
      "compass_user_preferences.rent_buddy_discoverable",
    ]) {
      assert.ok(probed.has(key), `${key} must be in CRITICAL_COLUMNS`);
    }
  });
});
