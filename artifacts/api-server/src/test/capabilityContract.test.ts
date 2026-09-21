/**
 * The capability contract — `capability = FLAG_ENABLED && SCHEMA_READY`.
 *
 * WHAT IS PROVEN HERE, AND WHY EACH PROOF IS A PROOF
 * ==================================================
 * The defect this contract closes is a flag that is ON over a database that
 * cannot take the payload, with the driver's rejection swallowed. So every
 * test below is one of:
 *
 *   • FAIL-CLOSED: a path on which the old code would have proceeded now
 *     REFUSES — flag unreadable, flag absent, probe rejected, probe thrown,
 *     probe resolved with no error field, one of two tables missing.
 *     Each asserts `enabled === false` AND that the guarded path made no
 *     write, which is the only observable that matters.
 *   • LOUD: the refusal reaches a caller as a 503 that cannot be dropped by
 *     `void f()`. `requireCapability` THROWS with `status`/`code` the global
 *     error handler reads.
 *   • THE PRODUCTION STATE, REPRODUCED: `media_canonical_enabled` TRUE over a
 *     `media_assets` that answers PGRST204 for `captured_at` resolves to
 *     `enabled: false, reason: schema_missing`. If this test goes green
 *     while that verdict is `enabled: true`, the contract is a comment.
 *   • MEMO: a `ready` verdict is served for its TTL and re-probed after; an
 *     absent verdict expires much sooner, so an applied migration is picked
 *     up without a restart.
 *
 * Run: node --import tsx/esm --test src/test/capabilityContract.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ABSENT_TTL_MS,
  CapabilityUnavailableError,
  READY_TTL_MS,
  isMissingColumnError,
  isMissingTableError,
  markSchemaMissing,
  missingObjectsNamedBy,
  peekSchemaReadiness,
  probeSchemaReadiness,
  readFlagState,
  requireCapability,
  resetSchemaCapabilityMemo,
  resolveCapability,
} from "../lib/capability/schemaCapability.js";
import { SCHEMA_PROBE_SENTINEL_ID, requiredObjects, type CapabilityDefinition } from "../lib/capability/schemaRequirement.js";
import { MEDIA_CANONICAL } from "../lib/capability/registry.js";

// ── A two-table capability, so multi-table probing is exercised ──────────────

const TWO_TABLES: CapabilityDefinition = {
  flag: "fx_enabled",
  providedBy: ["9999_fx.sql"],
  requires: {
    tables: {
      fx_primary: { columns: ["alpha", "beta"] },
      fx_secondary: { columns: ["gamma"], probe: { column: "slug", value: "__none__" } },
    },
    functions: ["fx_fn"],
  },
  consumers: ["lib/fx.ts"],
  note: "test capability",
};

function pgrst204(table: string, column: string) {
  return { code: "PGRST204", message: `Could not find the '${column}' column of '${table}' in the schema cache` };
}
function pgrst205(table: string) {
  return { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` };
}

/**
 * A fake client whose per-table probe answer is scripted. Every probe is
 * recorded — (table, select list, filter) — so a test can assert exactly
 * what was asked of the database and that nothing else was.
 */
function fakeClient(opts: {
  flag?: { data: { enabled: boolean } | null; error?: unknown } | "throw";
  probes?: Record<string, { error: unknown } | "throw" | "no-error-field">;
}) {
  const log: Array<{ table: string; select: string; filter: [string, string] }> = [];
  const writes: string[] = [];
  const client = {
    from(table: string) {
      return {
        select(cols: string) {
          if (table !== "feature_flags" && opts.probes?.[table] === "throw") throw new TypeError("select(...).eq is not a function");
          return {
            eq(col: string, val: string) {
              return {
                maybeSingle() {
                  if (table === "feature_flags") {
                    if (opts.flag === "throw") throw new Error("boom");
                    return Promise.resolve({ data: opts.flag?.data ?? null, error: opts.flag?.error ?? null });
                  }
                  log.push({ table, select: cols, filter: [col, val] });
                  const p = opts.probes?.[table];
                  if (p === "no-error-field") return Promise.resolve({ data: null } as any);
                  if (p && p !== "throw") return Promise.resolve({ data: null, error: p.error });
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        insert(_row: unknown) {
          writes.push(table);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client: client as any, log, writes };
}

const ON = { data: { enabled: true } };

beforeEach(() => resetSchemaCapabilityMemo());

describe("error classification (pure)", () => {
  it("tells a missing column from a missing table from everything else", () => {
    assert.equal(isMissingColumnError(pgrst204("t", "c")), true);
    assert.equal(isMissingColumnError({ code: "42703", message: 'column "c" of relation "t" does not exist' }), true);
    assert.equal(isMissingTableError(pgrst205("t")), true);
    assert.equal(isMissingTableError({ code: "42P01", message: 'relation "t" does not exist' }), true);
    assert.equal(isMissingColumnError(pgrst205("t")), false, "a missing table is not a missing column");
    assert.equal(isMissingTableError(pgrst204("t", "c")), false, "a missing column is not a missing table");
    assert.equal(isMissingColumnError({ code: "23505", message: "duplicate key" }), false);
    assert.equal(isMissingColumnError(null), false);
    assert.equal(isMissingTableError("PGRST205"), false);
  });

  it("names the required objects an error mentions, as table.column / table", () => {
    assert.deepEqual(missingObjectsNamedBy(TWO_TABLES, pgrst204("fx_primary", "beta")), ["fx_primary.beta"]);
    assert.deepEqual(missingObjectsNamedBy(TWO_TABLES, pgrst205("fx_secondary")), ["fx_secondary"]);
    assert.deepEqual(missingObjectsNamedBy(TWO_TABLES, { code: "PGRST301", message: "JWT expired" }), []);
  });

  it("requiredObjects lists every column, table-only requirement and function", () => {
    assert.deepEqual(requiredObjects(TWO_TABLES.requires), ["fx_primary.alpha", "fx_primary.beta", "fx_secondary.gamma", "fx_fn()"]);
    assert.deepEqual(requiredObjects({ tables: { t: { columns: [] } } }), ["t"]);
  });
});

describe("probeSchemaReadiness — one round trip per table, pinned to a sentinel", () => {
  it("ready: asks each table for exactly its columns, at the declared or default sentinel", async () => {
    const { client, log } = fakeClient({});
    const v = await probeSchemaReadiness(client, TWO_TABLES);
    assert.equal(v.state, "ready");
    assert.deepEqual(v.missing, []);
    assert.deepEqual(log, [
      { table: "fx_primary", select: "alpha, beta", filter: ["id", SCHEMA_PROBE_SENTINEL_ID] },
      { table: "fx_secondary", select: "gamma", filter: ["slug", "__none__"] },
    ]);
  });

  it("missing: names every absent object across BOTH tables, not just the first", async () => {
    const { client } = fakeClient({ probes: { fx_primary: { error: pgrst204("fx_primary", "beta") }, fx_secondary: { error: pgrst205("fx_secondary") } } });
    const v = await probeSchemaReadiness(client, TWO_TABLES);
    assert.equal(v.state, "missing");
    assert.deepEqual(v.missing, ["fx_primary.beta", "fx_secondary"]);
    assert.equal(v.errorCode, "PGRST204");
  });

  it("a missing-schema error that names no recognised object still counts the table as missing", async () => {
    const { client } = fakeClient({ probes: { fx_primary: { error: { code: "42703", message: "column mystery does not exist" } } } });
    const v = await probeSchemaReadiness(client, TWO_TABLES);
    assert.equal(v.state, "missing");
    assert.deepEqual(v.missing, ["fx_primary"], "the floor is the table, never an empty list that reads as ready");
  });

  it("unknown (fail-closed): any other rejection", async () => {
    const { client } = fakeClient({ probes: { fx_primary: { error: { code: "PGRST301", message: "JWT expired" } } } });
    const v = await probeSchemaReadiness(client, TWO_TABLES);
    assert.equal(v.state, "unknown");
    assert.equal(v.errorCode, "PGRST301");
  });

  it("unknown (fail-closed): a client that throws on the probe — never a throw out of the probe", async () => {
    const { client } = fakeClient({ probes: { fx_secondary: "throw" } });
    const v = await probeSchemaReadiness(client, TWO_TABLES);
    assert.equal(v.state, "unknown");
  });

  it("unknown (fail-closed): a probe that resolves WITHOUT an error field is not evidence of anything", async () => {
    const { client } = fakeClient({ probes: { fx_primary: "no-error-field" } });
    const v = await probeSchemaReadiness(client, TWO_TABLES);
    assert.equal(v.state, "unknown", "a fake or transport that answers `{ data: null }` must not read as `error: null`");
  });

  it("unknown (fail-closed): no `from` at all", async () => {
    const v = await probeSchemaReadiness({}, TWO_TABLES);
    assert.equal(v.state, "unknown");
  });

  it("memo: ready lives READY_TTL_MS; missing/unknown live ABSENT_TTL_MS, which is much shorter", async () => {
    const t0 = 5_000_000;
    const ok = fakeClient({});
    assert.equal((await probeSchemaReadiness(ok.client, TWO_TABLES, { now: t0 })).cached, false);
    assert.equal((await probeSchemaReadiness(ok.client, TWO_TABLES, { now: t0 + READY_TTL_MS - 1 })).cached, true);
    assert.equal((await probeSchemaReadiness(ok.client, TWO_TABLES, { now: t0 + READY_TTL_MS + 1 })).cached, false);
    assert.equal(ok.log.length, 4, "two probes (two tables each): the memo served the middle call");

    const bad = fakeClient({ probes: { fx_primary: { error: pgrst204("fx_primary", "alpha") } } });
    await probeSchemaReadiness(bad.client, TWO_TABLES, { now: t0 });
    assert.equal((await probeSchemaReadiness(bad.client, TWO_TABLES, { now: t0 + ABSENT_TTL_MS - 1 })).cached, true);
    assert.equal((await probeSchemaReadiness(bad.client, TWO_TABLES, { now: t0 + ABSENT_TTL_MS + 1 })).cached, false, "an applied migration is picked up without a restart");
    assert.ok(ABSENT_TTL_MS * 5 <= READY_TTL_MS);

    assert.equal((await probeSchemaReadiness(ok.client, TWO_TABLES, { now: t0 + 1, force: true })).cached, false, "force bypasses the memo");
    assert.equal(peekSchemaReadiness({}, TWO_TABLES), null, "peek never probes an unseen client");
  });

  it("memo is per (client, capability): two capabilities on one client do not share a verdict", async () => {
    const other: CapabilityDefinition = { ...TWO_TABLES, flag: "other_enabled", requires: { tables: { fx_primary: { columns: ["alpha"] } } } };
    const { client } = fakeClient({ probes: { fx_secondary: { error: pgrst205("fx_secondary") } } });
    assert.equal((await probeSchemaReadiness(client, TWO_TABLES)).state, "missing");
    assert.equal((await probeSchemaReadiness(client, other)).state, "ready");
    assert.equal(peekSchemaReadiness(client, TWO_TABLES)?.state, "missing");
    assert.equal(peekSchemaReadiness(client, other)?.state, "ready");
  });

  it("markSchemaMissing: a rejected write flips the memo so the next probe refuses without a round trip", async () => {
    const { client, log } = fakeClient({});
    assert.equal((await probeSchemaReadiness(client, TWO_TABLES)).state, "ready");
    const probesBefore = log.length;
    markSchemaMissing(client, TWO_TABLES, pgrst204("fx_primary", "alpha"));
    const v = await probeSchemaReadiness(client, TWO_TABLES);
    assert.equal(v.state, "missing");
    assert.deepEqual(v.missing, ["fx_primary.alpha"]);
    assert.equal(v.cached, true);
    assert.equal(log.length, probesBefore, "no re-probe: the rejection is the evidence");
  });
});

describe("readFlagState — four states, never `on` on a failure path", () => {
  it("on / off / absent / unreadable", async () => {
    assert.equal(await readFlagState(fakeClient({ flag: ON }).client, "f"), "on");
    assert.equal(await readFlagState(fakeClient({ flag: { data: { enabled: false } } }).client, "f"), "off");
    assert.equal(await readFlagState(fakeClient({ flag: { data: null } }).client, "f"), "absent");
    assert.equal(await readFlagState(fakeClient({ flag: { data: ON.data, error: { code: "PGRST301" } } }).client, "f"), "unreadable",
      "an error with data alongside it is still unreadable — supabase-js resolves on a database error");
    assert.equal(await readFlagState(fakeClient({ flag: "throw" }).client, "f"), "unreadable");
    assert.equal(await readFlagState({}, "f"), "unreadable");
  });
});

describe("resolveCapability — enabled iff flag on AND schema ready", () => {
  it("flag on, schema ready → enabled", async () => {
    const v = await resolveCapability(fakeClient({ flag: ON }).client, TWO_TABLES);
    assert.equal(v.enabled, true);
    assert.equal(v.flag, "on");
    assert.equal(v.schema?.state, "ready");
    assert.equal(v.reason, null);
  });

  for (const [label, flag, reason] of [
    ["off", { data: { enabled: false } }, "flag_off"],
    ["absent", { data: null }, "flag_absent"],
    ["unreadable", { data: ON.data, error: { code: "PGRST301" } }, "flag_unreadable"],
    ["throwing", "throw", "flag_unreadable"],
  ] as const) {
    it(`flag ${label} → NOT enabled, and the schema is not even probed`, async () => {
      const { client, log } = fakeClient({ flag, probes: { fx_primary: { error: pgrst204("fx_primary", "alpha") } } });
      const v = await resolveCapability(client, TWO_TABLES);
      assert.equal(v.enabled, false);
      assert.equal(v.reason, reason);
      assert.equal(v.schema, null);
      assert.equal(log.length, 0, "a dark flag makes no database contact beyond the flag read");
    });
  }

  it("flag on, schema missing → NOT enabled, reason schema_missing (the three-week state)", async () => {
    const v = await resolveCapability(fakeClient({ flag: ON, probes: { fx_primary: { error: pgrst204("fx_primary", "beta") } } }).client, TWO_TABLES);
    assert.equal(v.enabled, false);
    assert.equal(v.reason, "schema_missing");
    assert.deepEqual(v.schema?.missing, ["fx_primary.beta"]);
  });

  it("flag on, schema unknown → NOT enabled, reason schema_unknown (fail-closed, not fail-open)", async () => {
    const v = await resolveCapability(fakeClient({ flag: ON, probes: { fx_primary: "throw" } }).client, TWO_TABLES);
    assert.equal(v.enabled, false);
    assert.equal(v.reason, "schema_unknown");
  });

  it("THE PRODUCTION STATE: media_canonical_enabled TRUE over a media_assets without 2250 → refused", async () => {
    const { client, writes } = fakeClient({ flag: ON, probes: { media_assets: { error: pgrst204("media_assets", "captured_at") } } });
    const v = await resolveCapability(client, MEDIA_CANONICAL);
    assert.equal(v.enabled, false);
    assert.equal(v.reason, "schema_missing");
    assert.deepEqual(v.schema?.missing, ["media_assets.captured_at"]);
    assert.equal(writes.length, 0);
    // And the same client with the columns present is enabled — the refusal is
    // about the schema, not a constant `false`.
    resetSchemaCapabilityMemo();
    const ok = await resolveCapability(fakeClient({ flag: ON }).client, MEDIA_CANONICAL);
    assert.equal(ok.enabled, true);
  });
});

describe("requireCapability — the refusal cannot be dropped", () => {
  it("throws a 503 degraded_unavailable when the flag is on and the schema is not ready", async () => {
    const { client } = fakeClient({ flag: ON, probes: { fx_secondary: { error: pgrst205("fx_secondary") } } });
    await assert.rejects(
      () => requireCapability(client, TWO_TABLES),
      (err: unknown) => {
        assert.ok(err instanceof CapabilityUnavailableError);
        assert.equal(err.status, 503);
        assert.equal(err.code, "degraded_unavailable");
        assert.match(err.message, /fx_enabled/);
        assert.match(err.message, /fx_secondary/);
        assert.equal(err.verdict.reason, "schema_missing");
        return true;
      },
    );
  });

  it("does NOT throw for a flag that is off — the caller answers feature_disabled as before", async () => {
    const v = await requireCapability(fakeClient({ flag: { data: { enabled: false } }, probes: { fx_primary: "throw" } }).client, TWO_TABLES);
    assert.equal(v.enabled, false);
    assert.equal(v.reason, "flag_off");
  });

  it("returns the verdict when everything is ready", async () => {
    const v = await requireCapability(fakeClient({ flag: ON }).client, TWO_TABLES);
    assert.equal(v.enabled, true);
  });

  it("a guarded writer pattern: refuse BEFORE any write, on the verdict alone", async () => {
    const { client, writes } = fakeClient({ flag: ON, probes: { fx_primary: { error: pgrst204("fx_primary", "alpha") } } });
    async function guardedWrite(sc: any): Promise<"written" | "refused"> {
      const v = await resolveCapability(sc, TWO_TABLES);
      if (!v.enabled) return "refused";
      await sc.from("fx_primary").insert({ alpha: 1 });
      return "written";
    }
    assert.equal(await guardedWrite(client), "refused");
    assert.equal(writes.length, 0, "the dead-writer path was never entered");
  });
});
