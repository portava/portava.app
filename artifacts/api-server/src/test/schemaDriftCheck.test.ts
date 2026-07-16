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
});
