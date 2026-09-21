/**
 * supabaseConformance — a CONTRACT harness that runs one scenario against two
 * subjects and requires them to agree: the real installed supabase-js client
 * (`postgrestOracle.ts`) and an in-memory double from this directory.
 *
 * ── THE FAILURE THIS EXISTS TO STOP ─────────────────────────────────────────
 * `src/test/rentABuddy.test.ts` captured inserted rows EAGERLY, inside
 * `.insert()`, carrying a comment that recorded `_resolve()` is never reached.
 * The double had been written AROUND the defect. Twenty `void …insert(…)` sites
 * therefore proved that a row was CONSTRUCTED and never that it was SENT, and
 * they stayed green for months. Every other suite in this repository inherits
 * assumptions from doubles written the same way — by reading the production code
 * they had to satisfy, never by reading the client they replace.
 *
 * A double is only as trustworthy as the last time something checked it. This is
 * that check, and it is mechanical: add a fake, register it as a `Subject`, and
 * it is measured rather than believed.
 *
 * ── THE THREE HONEST OUTCOMES ───────────────────────────────────────────────
 * For each (scenario, fake) pair exactly one of these must hold, and
 * `supabaseContract.test.ts` fails the build if none does:
 *
 *   1. AGREE      — the fake's observation deep-equals the real client's.
 *   2. REFUSED    — the fake THROWS a message saying it does not model this.
 *                   A test cannot then quietly claim the property: the call
 *                   blows up. This is the honest form of a gap.
 *   3. DIVERGENT  — the fake answers differently, the difference is declared in
 *                   `Subject.gaps`, AND the scenario id appears verbatim in the
 *                   fake's own file header. An undeclared divergence is a
 *                   failure; so is a DECLARED divergence that has quietly
 *                   started agreeing (a stale alibi is as misleading as a
 *                   missing one).
 *
 * A fake that quietly answers a question it cannot answer is what caused the
 * original defect, so option 3 is deliberately expensive: it costs a permanent
 * comment in the fake that every future reader of that fake sees.
 *
 * ── ONE TRANSLATION, STATED OUT LOUD ────────────────────────────────────────
 * No in-memory double makes a request, so `transport: "abort"` cannot be handed
 * to one literally. `forFake()` translates it into the shape the real client was
 * MEASURED to produce for a dead transport — every read and write resolving
 * `{ data: null, error }` with NO PostgREST code — and the fake is judged on
 * that. The contract being pinned is the caller-visible shape, which is the
 * shape production code branches on; the socket is not the fake's business.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeOracle, type OracleWorld, type Row } from "./postgrestOracle.js";
import { makeLayoverDb } from "./fakeLayoverDb.js";
import { makePassportDb } from "./fakePassportDb.js";
import { makeFailClosedClient } from "./failClosedSupabase.js";
import { makeFakeMapDb } from "./fakeMapDb.js";
import { makeSchemaStrictClient } from "./schemaStrictSupabase.js";
import { makeEnumAwareClient } from "./enumAwareSupabase.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export type { OracleWorld, Row };

/** A normalized, comparable summary of what a caller actually observed. */
export type Obs = Record<string, string | number | boolean | null>;

export interface SubjectOps {
  client: any;
  /** Rows the subject believes were WRITTEN to `table` since it was built. */
  writes(table: string): number;
}

export type GapMode = "refused" | "divergent";

export interface Gap {
  mode: GapMode;
  /** Why the fake cannot model this. Goes in the report and in the fake's header. */
  why: string;
}

export interface Subject {
  name: string;
  /** Absolute path of the file whose header must document every declared gap. */
  sourceFile: string;
  build(world: OracleWorld): SubjectOps;
  gaps: Record<string, Gap>;
}

export interface Scenario {
  id: string;
  group: string;
  title: string;
  /** A fresh world per subject — the fakes mutate their seed in place. */
  world(): OracleWorld;
  run(s: SubjectOps): Promise<Obs>;
}

// ── observation ─────────────────────────────────────────────────────────────

const tick = () => new Promise((r) => setTimeout(r, 25));

function kindOf(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "scalar";
}

/**
 * `""` and a missing `code` both mean "this error carries no PostgREST code".
 * The real client produces exactly that for a transport failure (measured), and
 * the fakes produce it for a bare `{ message }`, so they are one bucket.
 */
function errorCode(e: any): string | null {
  if (e === null || e === undefined) return null;
  const c = String(e.code ?? "");
  return c === "" ? "UNCODED" : c;
}

const REFUSAL = /does not model|not modelled|not supported|unsupported/i;

/**
 * Run a terminal call and normalize it. A THROW is an observation too — for a
 * fake it is the honest refusal; for the real client it would be a contract
 * violation, since supabase-js resolves every failure.
 */
export async function settle(fn: () => any, opts: { count?: boolean } = {}): Promise<Obs> {
  try {
    const r: any = await fn();
    const o: Obs = {
      outcome: "resolved",
      dataKind: kindOf(r?.data),
      dataLen: Array.isArray(r?.data) ? r.data.length : null,
      errorCode: errorCode(r?.error),
    };
    if (opts.count) o.count = r?.count ?? null;
    return o;
  } catch (e: any) {
    return {
      outcome: "threw",
      refusal: REFUSAL.test(String(e?.message ?? "")),
      thrown: String(e?.name ?? "Error"),
    };
  }
}

// ── subjects ────────────────────────────────────────────────────────────────

/**
 * Translate a world into terms an in-memory double can express. Only the
 * transport failure needs it — see ONE TRANSLATION in the header.
 */
function forFake(world: OracleWorld): OracleWorld {
  if (world.transport !== "abort" && world.transport !== "network") return world;
  const err = {
    // Uncoded, exactly as the real client reports a dead transport (measured).
    code: "",
    message: world.transport === "abort" ? "AbortError: The operation was aborted" : "TypeError: fetch failed",
  };
  const every = Object.fromEntries(Object.keys(world.tables).map((t) => [t, err]));
  return { ...world, failReads: { ...every, ...world.failReads }, failWrites: { ...every, ...world.failWrites } };
}

function seedSizes(tables: Record<string, Row[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [t, rs] of Object.entries(tables)) out[t] = rs.length;
  return out;
}

export function oracleSubject(): Subject {
  return {
    name: "real @supabase/supabase-js",
    sourceFile: join(HERE, "postgrestOracle.ts"),
    gaps: {},
    build(world) {
      const h = makeOracle(world);
      return { client: h.client, writes: (t) => h.writes(t) };
    },
  };
}

/** `failReads`/`failWrites` in the shape each fake takes. */
function layoverFailures(world: OracleWorld): Record<string, { message: string; code?: string }> {
  const out: Record<string, { message: string; code?: string }> = {};
  for (const [t, e] of Object.entries(world.failReads ?? {})) out[`${t}:select`] = { message: e.message, code: e.code };
  for (const [t, e] of Object.entries(world.failWrites ?? {})) {
    for (const op of ["insert", "upsert", "update", "delete"]) out[`${t}:${op}`] = { message: e.message, code: e.code };
  }
  return out;
}

export function layoverSubject(): Subject {
  return {
    name: "fakeLayoverDb",
    sourceFile: join(HERE, "fakeLayoverDb.ts"),
    gaps: {
      "insert/unique-violation-23505": {
        mode: "divergent",
        why: "no unique index is modelled; a duplicate insert simply appends a second row",
      },
      "rls/denied-read-yields-zero-rows": {
        mode: "refused",
        why: "no service-vs-user distinction; passing `role` throws rather than answering",
      },
      "rls/denied-write-yields-42501": {
        mode: "refused",
        why: "no service-vs-user distinction; passing `role` throws rather than answering",
      },
      "rpc/success": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
      "rpc/error-resolves": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
      "rpc/unknown-function": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
      "error/unknown-column-42703": {
        mode: "divergent",
        why: "no schema knowledge; an unknown column reads as undefined instead of failing the statement (use schemaStrictSupabase for that question)",
      },
    },
    build(w) {
      const world = forFake(w);
      const sizes = seedSizes(world.tables);
      const client = makeLayoverDb(world.tables, {
        failures: layoverFailures(world),
        role: world.denyReads || world.denyWrites ? "user" : undefined,
      } as any);
      return { client, writes: (t) => (world.tables[t]?.length ?? 0) - (sizes[t] ?? 0) };
    },
  };
}

export function passportSubject(): Subject {
  return {
    name: "fakePassportDb",
    sourceFile: join(HERE, "fakePassportDb.ts"),
    gaps: {
      "insert/unique-violation-23505": {
        mode: "divergent",
        why: "no unique index is modelled; a duplicate insert simply appends a second row",
      },
      "rls/denied-read-yields-zero-rows": {
        mode: "refused",
        why: "no service-vs-user distinction; passing `role` throws rather than answering",
      },
      "rls/denied-write-yields-42501": {
        mode: "refused",
        why: "no service-vs-user distinction; passing `role` throws rather than answering",
      },
      "rpc/success": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
      "rpc/error-resolves": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
      "rpc/unknown-function": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
      "error/unknown-column-42703": {
        mode: "divergent",
        why: "no schema knowledge; an unknown column reads as undefined instead of failing the statement (use schemaStrictSupabase for that question)",
      },
    },
    build(w) {
      const world = forFake(w);
      const sizes = seedSizes(world.tables);
      const client = makePassportDb(world.tables, {
        failReads: world.failReads,
        failWrites: world.failWrites,
        role: world.denyReads || world.denyWrites ? "user" : undefined,
      } as any);
      return { client, writes: (t) => (world.tables[t]?.length ?? 0) - (sizes[t] ?? 0) };
    },
  };
}

export function failClosedSubject(): Subject {
  return {
    name: "failClosedSupabase",
    sourceFile: join(HERE, "failClosedSupabase.ts"),
    gaps: {
      "insert/unique-violation-23505": {
        mode: "divergent",
        why: "no unique index is modelled; use `failWritesOn` to stage the 23505 shape instead",
      },
      "write/read-after-write-visible": {
        mode: "divergent",
        why: "writes are recorded in spec.inserted/spec.updated rather than applied to spec.rows, so a read after a write still sees the seed",
      },
      "error/unknown-column-42703": {
        mode: "divergent",
        why: "no schema knowledge; an unknown column reads as undefined instead of failing the statement (use schemaStrictSupabase for that question)",
      },
    },
    build(w) {
      const world = forFake(w);
      const spec: any = {
        rows: world.tables,
        inserted: {},
        updated: {},
        role: world.denyReads || world.denyWrites ? "user" : undefined,
        rlsHiddenTables: world.denyReads,
        rlsProtectedTables: world.denyWrites,
        rpc: world.rpc
          ? Object.fromEntries(Object.entries(world.rpc).map(([k, h]) => [k, (a: any) => h(a) as any]))
          : undefined,
        failOn: (ctx: any) => world.failReads?.[ctx.table] ?? null,
        failWritesOn: (t: string) => world.failWrites?.[t] ?? null,
      };
      const client = makeFailClosedClient(spec);
      return {
        client,
        writes: (t) => (spec.inserted[t]?.length ?? 0),
      };
    },
  };
}

export function mapSubject(): Subject {
  const readOnly = (why: string): Gap => ({ mode: "refused", why });
  return {
    name: "fakeMapDb",
    sourceFile: join(HERE, "fakeMapDb.ts"),
    gaps: {
      "thenable/no-continuation": readOnly("read-only double; every write verb throws"),
      "thenable/then-continuation": readOnly("read-only double; every write verb throws"),
      "thenable/awaited": readOnly("read-only double; every write verb throws"),
      "insert/no-select-returns-null": readOnly("read-only double; every write verb throws"),
      "insert/with-select-returns-rows": readOnly("read-only double; every write verb throws"),
      "insert/with-select-single": readOnly("read-only double; every write verb throws"),
      "insert/unique-violation-23505": readOnly("read-only double; every write verb throws"),
      "update/zero-rows-no-select": readOnly("read-only double; every write verb throws"),
      "update/many-rows-no-select": readOnly("read-only double; every write verb throws"),
      "update/zero-rows-with-select": readOnly("read-only double; every write verb throws"),
      "update/many-rows-with-select": readOnly("read-only double; every write verb throws"),
      "delete/many-rows-no-select": readOnly("read-only double; every write verb throws"),
      "delete/many-rows-with-select": readOnly("read-only double; every write verb throws"),
      "failure/write-error-resolves": readOnly("read-only double; every write verb throws"),
      "rls/denied-read-yields-zero-rows": {
        mode: "refused",
        why: "auth.getUser distinguishes tokens, but `from()` has no role; passing `role` throws",
      },
      "rls/denied-write-yields-42501": readOnly("read-only double; every write verb throws"),
      "write/read-after-write-visible": readOnly("read-only double; every write verb throws"),
      "error/unknown-column-42703": {
        mode: "divergent",
        why: "no schema knowledge; an unknown column reads as undefined instead of failing the statement (use schemaStrictSupabase for that question)",
      },
    },
    build(w) {
      const world = forFake(w);
      const client = makeFakeMapDb(
        Object.fromEntries(
          Object.entries(world.tables).map(([t, rows]) => [
            t,
            world.failReads?.[t] ? { rows, error: world.failReads[t] } : { rows },
          ]),
        ),
        {
          token: "tok",
          userId: "u1",
          role: world.denyReads || world.denyWrites ? "user" : undefined,
          rpc: world.rpc
            ? Object.fromEntries(Object.entries(world.rpc).map(([k, h]) => [k, (a: any) => h(a) as any]))
            : undefined,
        } as any,
      );
      return { client, writes: () => 0 };
    },
  };
}

export function schemaStrictSubject(): Subject {
  const noFailureKnob = (why: string): Gap => ({ mode: "divergent", why });
  return {
    name: "schemaStrictSupabase",
    sourceFile: join(HERE, "schemaStrictSupabase.ts"),
    gaps: {
      "insert/unique-violation-23505": noFailureKnob(
        "no unique index is modelled; a duplicate insert appends a second row (stage it with opts.writeError)",
      ),
      "failure/read-error-resolves": noFailureKnob("only a WRITE error can be injected (opts.writeError); reads cannot be made to fail"),
      "failure/read-error-under-maybeSingle": noFailureKnob("only a WRITE error can be injected (opts.writeError); reads cannot be made to fail"),
      "transport/aborted-request": noFailureKnob("only a WRITE error can be injected (opts.writeError); reads cannot be made to fail"),
      "rls/denied-read-yields-zero-rows": { mode: "divergent", why: "no service-vs-user distinction; there is one seed and no policies" },
      "rls/denied-write-yields-42501": { mode: "divergent", why: "no service-vs-user distinction; there is one seed and no policies" },
      "rpc/success": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
      "rpc/error-resolves": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
      "rpc/unknown-function": { mode: "refused", why: "no rpc surface; `.rpc()` throws" },
    },
    build(w) {
      const world = forFake(w);
      const sizes = seedSizes(world.tables);
      // The contract's tables are synthetic, so the live snapshot cannot judge
      // them; `syntheticColumns` stands in and is refused outside this harness.
      const declared = world.columns ?? {};
      const client = makeSchemaStrictClient(world.tables, {
        syntheticColumns: Object.fromEntries(
          Object.keys(world.tables).map((t) => [t, declared[t] ?? ["id", "owner", "name", "n", "kind", "created_at"]]),
        ),
        writeError: world.failWrites
          ? { table: Object.keys(world.failWrites)[0], error: Object.values(world.failWrites)[0] }
          : undefined,
      } as any) as any;
      return { client, writes: (t) => (world.tables[t]?.length ?? 0) - (sizes[t] ?? 0) };
    },
  };
}

export function enumAwareSubject(): Subject {
  const readOnly = (why: string): Gap => ({ mode: "refused", why });
  const W = "read-only double for predicate vocabulary; every write verb throws";
  return {
    name: "enumAwareSupabase",
    sourceFile: join(HERE, "enumAwareSupabase.ts"),
    gaps: {
      "thenable/no-continuation": readOnly(W),
      "thenable/then-continuation": readOnly(W),
      "thenable/awaited": readOnly(W),
      "insert/no-select-returns-null": readOnly(W),
      "insert/with-select-returns-rows": readOnly(W),
      "insert/with-select-single": readOnly(W),
      "insert/unique-violation-23505": readOnly(W),
      "update/zero-rows-no-select": readOnly(W),
      "update/many-rows-no-select": readOnly(W),
      "update/zero-rows-with-select": readOnly(W),
      "update/many-rows-with-select": readOnly(W),
      "delete/many-rows-no-select": readOnly(W),
      "delete/many-rows-with-select": readOnly(W),
      "failure/write-error-resolves": readOnly(W),
      "write/read-after-write-visible": readOnly(W),
      "rls/denied-write-yields-42501": readOnly(W),
      "rpc/success": readOnly("no rpc surface; `.rpc()` throws"),
      "rpc/error-resolves": readOnly("no rpc surface; `.rpc()` throws"),
      "rpc/unknown-function": readOnly("no rpc surface; `.rpc()` throws"),
      "failure/read-error-resolves": { mode: "divergent", why: "the only error it can raise is 22P02 from a dead enum literal; a read cannot be made to fail" },
      "failure/read-error-under-maybeSingle": { mode: "divergent", why: "the only error it can raise is 22P02 from a dead enum literal; a read cannot be made to fail" },
      "transport/aborted-request": { mode: "divergent", why: "the only error it can raise is 22P02 from a dead enum literal; a read cannot be made to fail" },
      "error/unknown-column-42703": { mode: "divergent", why: "no schema knowledge; it validates VALUES, not column names (use schemaStrictSupabase)" },
      "rls/denied-read-yields-zero-rows": { mode: "divergent", why: "no service-vs-user distinction; there is one seed and no policies" },
      "select/count-exact": { mode: "divergent", why: "no count surface; `count` is always absent" },
    },
    build(w) {
      const world = forFake(w);
      return { client: makeEnumAwareClient(world.tables) as any, writes: () => 0 };
    },
  };
}

export function allFakeSubjects(): Subject[] {
  return [
    layoverSubject(),
    passportSubject(),
    failClosedSubject(),
    mapSubject(),
    schemaStrictSubject(),
    enumAwareSubject(),
  ];
}

// ── scenarios ───────────────────────────────────────────────────────────────

const AUDIT = "audit_events";
const T = "t";

const rows2 = (): Row[] => [
  { id: "r1", owner: "u1", name: "one", n: 1 },
  { id: "r2", owner: "u1", name: "two", n: 2 },
];
const rows1 = (): Row[] => [{ id: "r1", owner: "u1", name: "one", n: 1 }];

const DBERR = { code: "57P01", message: "connection terminated unexpectedly" };

export function contractScenarios(): Scenario[] {
  return [
    // ── thenable execution: the defect itself ───────────────────────────────
    {
      id: "thenable/no-continuation",
      group: "thenable",
      title: "a builder with no .then/.await issues nothing and writes nothing",
      world: () => ({ tables: { [AUDIT]: [] } }),
      async run(s) {
        // Deliberately NOT awaited and NOT continued — the production idiom that
        // lost twenty rows. `void` so no linter rewrites it into a continuation.
        void s.client.from(AUDIT).insert({ id: "a1", kind: "x" });
        await tick();
        return { writes: s.writes(AUDIT) };
      },
    },
    {
      id: "thenable/then-continuation",
      group: "thenable",
      title: "a builder given .then(…) issues exactly one request and writes once",
      world: () => ({ tables: { [AUDIT]: [] } }),
      async run(s) {
        void s.client.from(AUDIT).insert({ id: "a1", kind: "x" }).then(undefined, () => {});
        await tick();
        return { writes: s.writes(AUDIT) };
      },
    },
    {
      id: "thenable/awaited",
      group: "thenable",
      title: "an awaited builder writes exactly once",
      world: () => ({ tables: { [AUDIT]: [] } }),
      async run(s) {
        await s.client.from(AUDIT).insert({ id: "a1", kind: "x" });
        return { writes: s.writes(AUDIT) };
      },
    },
    {
      id: "thenable/is-not-a-promise",
      group: "thenable",
      title: "the builder is thenable but not a promise: no .catch, no .finally",
      world: () => ({ tables: { [T]: rows1() } }),
      async run(s) {
        const b: any = s.client.from(T).select("*");
        const o: Obs = { hasCatch: typeof b.catch, hasFinally: typeof b.finally, hasThen: typeof b.then };
        // Settle it so no subject is left holding an unissued builder.
        await b;
        return o;
      },
    },

    // ── cardinality ─────────────────────────────────────────────────────────
    {
      id: "maybeSingle/zero-rows",
      group: "cardinality",
      title: "maybeSingle over zero rows resolves data null, error null",
      world: () => ({ tables: { [T]: [] } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1").maybeSingle()),
    },
    {
      id: "maybeSingle/one-row",
      group: "cardinality",
      title: "maybeSingle over one row resolves the object",
      world: () => ({ tables: { [T]: rows1() } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1").maybeSingle()),
    },
    {
      id: "maybeSingle/many-rows",
      group: "cardinality",
      title: "maybeSingle over MORE than one row resolves a PGRST116 error, data null",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1").maybeSingle()),
    },
    {
      id: "single/zero-rows",
      group: "cardinality",
      title: "single over zero rows resolves a PGRST116 error, data null",
      world: () => ({ tables: { [T]: [] } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1").single()),
    },
    {
      id: "single/one-row",
      group: "cardinality",
      title: "single over one row resolves the object",
      world: () => ({ tables: { [T]: rows1() } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1").single()),
    },
    {
      id: "single/many-rows",
      group: "cardinality",
      title: "single over MORE than one row resolves a PGRST116 error, data null",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1").single()),
    },

    // ── failure is resolved, never thrown ───────────────────────────────────
    {
      id: "failure/read-error-resolves",
      group: "failure",
      title: "a failed read RESOLVES { data: null, error } — it does not throw or reject",
      world: () => ({ tables: { [T]: rows2() }, failReads: { [T]: DBERR } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1")),
    },
    {
      id: "failure/read-error-under-maybeSingle",
      group: "failure",
      title: "a failed read under maybeSingle is the error, not an empty row",
      world: () => ({ tables: { [T]: rows2() }, failReads: { [T]: DBERR } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1").maybeSingle()),
    },
    {
      id: "failure/write-error-resolves",
      group: "failure",
      title: "a failed write RESOLVES { data: null, error } and leaves nothing behind",
      world: () => ({ tables: { [AUDIT]: [] }, failWrites: { [AUDIT]: DBERR } }),
      async run(s) {
        const o = await settle(() => s.client.from(AUDIT).insert({ id: "a1", kind: "x" }));
        return { ...o, writes: s.writes(AUDIT) };
      },
    },
    {
      id: "insert/unique-violation-23505",
      group: "failure",
      title: "inserting a duplicate key resolves 23505 and stores nothing",
      world: () => ({ tables: { [AUDIT]: [{ id: "a1", kind: "x" }] }, unique: { [AUDIT]: ["id"] } }),
      async run(s) {
        const o = await settle(() => s.client.from(AUDIT).insert({ id: "a1", kind: "y" }));
        return { ...o, writes: s.writes(AUDIT) };
      },
    },
    {
      id: "error/unknown-column-42703",
      group: "failure",
      title: "selecting a column that does not exist fails the WHOLE statement with 42703",
      world: () => ({ tables: { [T]: rows2() }, columns: { [T]: ["id", "owner", "name", "n"] } }),
      run: (s) => settle(() => s.client.from(T).select("id,nope").eq("owner", "u1")),
    },
    {
      id: "transport/aborted-request",
      group: "failure",
      title: "an aborted or failed transport still RESOLVES an error, data null",
      world: () => ({ tables: { [T]: rows2() }, transport: "abort" }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1")),
    },

    // ── affected rows ───────────────────────────────────────────────────────
    {
      id: "update/zero-rows-no-select",
      group: "affected",
      title: "an UPDATE matching zero rows, no .select(): data null, count null",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).update({ name: "z" }).eq("id", "nope"), { count: true }),
    },
    {
      id: "update/many-rows-no-select",
      group: "affected",
      title: "an UPDATE matching TWO rows, no .select(): still data null, count null — indistinguishable from zero",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).update({ name: "z" }).eq("owner", "u1"), { count: true }),
    },
    {
      id: "update/zero-rows-with-select",
      group: "affected",
      title: "an UPDATE matching zero rows WITH .select(): an empty array",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).update({ name: "z" }).eq("id", "nope").select()),
    },
    {
      id: "update/many-rows-with-select",
      group: "affected",
      title: "an UPDATE matching TWO rows WITH .select(): both rows come back",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).update({ name: "z" }).eq("owner", "u1").select()),
    },
    {
      id: "delete/many-rows-no-select",
      group: "affected",
      title: "a DELETE removing TWO rows, no .select(): data null",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).delete().eq("owner", "u1"), { count: true }),
    },
    {
      id: "delete/many-rows-with-select",
      group: "affected",
      title: "a DELETE removing TWO rows WITH .select(): both removed rows come back",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).delete().eq("owner", "u1").select()),
    },

    // ── RETURNING ───────────────────────────────────────────────────────────
    {
      id: "insert/no-select-returns-null",
      group: "returning",
      title: "an INSERT with no chained .select() returns data null",
      world: () => ({ tables: { [AUDIT]: [] } }),
      run: (s) => settle(() => s.client.from(AUDIT).insert({ id: "a1", kind: "x" })),
    },
    {
      id: "insert/with-select-returns-rows",
      group: "returning",
      title: "an INSERT with a chained .select() returns the inserted rows",
      world: () => ({ tables: { [AUDIT]: [] } }),
      run: (s) => settle(() => s.client.from(AUDIT).insert({ id: "a1", kind: "x" }).select()),
    },
    {
      id: "insert/with-select-single",
      group: "returning",
      title: "an INSERT with .select().single() returns the object, not an array",
      world: () => ({ tables: { [AUDIT]: [] } }),
      run: (s) => settle(() => s.client.from(AUDIT).insert({ id: "a1", kind: "x" }).select().single()),
    },

    {
      id: "write/read-after-write-visible",
      group: "returning",
      title: "a row written through the client is visible to the next read",
      world: () => ({ tables: { [AUDIT]: [] } }),
      async run(s) {
        await s.client.from(AUDIT).insert({ id: "a1", kind: "x" });
        return settle(() => s.client.from(AUDIT).select("*").eq("id", "a1"));
      },
    },

    // ── count ───────────────────────────────────────────────────────────────
    {
      id: "select/count-null-unless-requested",
      group: "count",
      title: "count is null when the caller did not ask for it",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1"), { count: true }),
    },
    {
      id: "select/count-exact",
      group: "count",
      title: "count: 'exact' returns the matched row count alongside the rows",
      world: () => ({ tables: { [T]: rows2() } }),
      run: (s) => settle(() => s.client.from(T).select("*", { count: "exact" }).eq("owner", "u1"), { count: true }),
    },

    // ── rpc ─────────────────────────────────────────────────────────────────
    {
      id: "rpc/success",
      group: "rpc",
      title: "rpc resolves the function's payload",
      world: () => ({ tables: {}, rpc: { fn_ok: () => ({ data: { ok: true }, error: null }) } }),
      run: (s) => settle(() => s.client.rpc("fn_ok", { x: 1 })),
    },
    {
      id: "rpc/error-resolves",
      group: "rpc",
      title: "a raising rpc RESOLVES { data: null, error } — it does not throw",
      world: () => ({
        tables: {},
        rpc: { fn_bad: () => ({ data: null, error: { code: "P0001", message: "boom" } }) },
      }),
      run: (s) => settle(() => s.client.rpc("fn_bad", {})),
    },
    {
      id: "rpc/unknown-function",
      group: "rpc",
      title: "calling an rpc that does not exist resolves PGRST202, never silence",
      world: () => ({ tables: {}, rpc: {} }),
      run: (s) => settle(() => s.client.rpc("fn_missing", {})),
    },

    // ── RLS ─────────────────────────────────────────────────────────────────
    {
      id: "rls/denied-read-yields-zero-rows",
      group: "rls",
      title: "a read denied by RLS returns ZERO ROWS and NO error — the fail-open shape",
      world: () => ({ tables: { [T]: rows2() }, denyReads: [T] }),
      run: (s) => settle(() => s.client.from(T).select("*").eq("owner", "u1")),
    },
    {
      id: "rls/denied-write-yields-42501",
      group: "rls",
      title: "a write denied by RLS resolves 42501 and stores nothing",
      world: () => ({ tables: { [AUDIT]: [] }, denyWrites: [AUDIT] }),
      async run(s) {
        const o = await settle(() => s.client.from(AUDIT).insert({ id: "a1", kind: "x" }));
        return { ...o, writes: s.writes(AUDIT) };
      },
    },
  ];
}

// ── runner ──────────────────────────────────────────────────────────────────

export type Verdict = "agree" | "refused" | "divergent-declared" | "divergent-UNDECLARED" | "stale-gap" | "refusal-not-honest";

export interface Cell {
  scenario: string;
  group: string;
  subject: string;
  oracle: Obs;
  fake: Obs;
  verdict: Verdict;
  gap: Gap | null;
}

function eq(a: Obs, b: Obs): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a[k] === b[k]);
}

export async function runConformance(scenarios: Scenario[], fakes: Subject[]): Promise<Cell[]> {
  const oracle = oracleSubject();
  const cells: Cell[] = [];
  for (const sc of scenarios) {
    const oracleObs = await sc.run(oracle.build(sc.world()));
    if (oracleObs.outcome === "threw") {
      throw new Error(
        `postgrestOracle: the REAL client threw on "${sc.id}". supabase-js resolves every failure, so this is a bug in the scenario or the emulator, not a contract result.`,
      );
    }
    for (const f of fakes) {
      let fakeObs: Obs;
      try {
        fakeObs = await sc.run(f.build(sc.world()));
      } catch (e: any) {
        fakeObs = { outcome: "threw", refusal: REFUSAL.test(String(e?.message ?? "")), thrown: String(e?.name ?? "Error") };
      }
      const gap = f.gaps[sc.id] ?? null;
      const agrees = eq(oracleObs, fakeObs);
      let verdict: Verdict;
      if (agrees) verdict = gap ? "stale-gap" : "agree";
      else if (gap?.mode === "refused") {
        verdict = fakeObs.outcome === "threw" && fakeObs.refusal === true ? "refused" : "refusal-not-honest";
      } else if (gap?.mode === "divergent") verdict = "divergent-declared";
      else verdict = "divergent-UNDECLARED";
      cells.push({ scenario: sc.id, group: sc.group, subject: f.name, oracle: oracleObs, fake: fakeObs, verdict, gap });
    }
  }
  return cells;
}

/** Every declared gap's scenario id must appear verbatim in the fake's header. */
export function undocumentedGaps(subject: Subject): string[] {
  const src = readFileSync(subject.sourceFile, "utf8");
  const header = src.slice(0, src.indexOf("\n */") + 4 || 8000);
  return Object.keys(subject.gaps).filter((id) => !header.includes(id));
}

export function renderMatrix(cells: Cell[]): string {
  const lines = ["scenario | subject | oracle | fake | verdict"];
  for (const c of cells) {
    lines.push(
      `${c.scenario} | ${c.subject} | ${JSON.stringify(c.oracle)} | ${JSON.stringify(c.fake)} | ${c.verdict}`,
    );
  }
  return lines.join("\n");
}
