/**
 * LAY-01 on a REAL database — `LayoverConstraintStore` against the table that
 * migration 2992 actually creates, and the two flags 3640 actually seeds.
 *
 * WHY THIS FILE EXISTS (census L295 / App C3: "live-schema/literal checks must
 * cover safety-critical query paths"). The unit suites drive the store through
 * `fakeLayoverDb`, whose own header says what it cannot do: it has no schema
 * (an unknown column is `undefined`, not an error), no CHECK constraints, no
 * unique index (a duplicate insert appends a second row) and no triggers. Every
 * one of those is something this store RELIES on:
 *
 *   - the payload's column names must exist on `layover_constraints`;
 *   - `BAGGAGE_MODES` and `ENTRY_PERMISSION_STATES` must be exactly the CHECKs;
 *   - a second writer of the same version must get 23505, which the store
 *     reports as `version_conflict`;
 *   - an UPDATE must raise, so "an edit is a new version" is the only path.
 *
 * ── THE STORE'S OWN STATEMENTS ARE WHAT RUN ─────────────────────────────────
 * `psqlClient` below is not a second implementation of the store. It turns the
 * calls the store makes — `.insert(payload).select(cols).maybeSingle()` and the
 * `.select().eq()/.in().order().limit()` reads — into SQL, with the INSERT's
 * column list taken from the PAYLOAD'S KEYS. A column the store names that the
 * table does not have is therefore a database error here, not a silent pass.
 *
 * Skips when LOCAL_DB_URL is unset; `scripts/local-db/run-tests.sh` is the run
 * that refuses skipped > 0.
 *
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, asUser, deleteUser, exec, jsonLiteral, psql, rows, scalar, seedUser } from "./localDb.js";
import {
  BAGGAGE_MODES,
  ENTRY_PERMISSION_STATES,
  type LayoverConstraintSet,
} from "../../services/airport/LayoverConstraints.js";
import {
  LAYOVER_CONSTRAINT_FLAGS,
  insertConstraintVersion,
  readLatestConstraints,
  readLatestConstraintsFor,
} from "../../services/layover/LayoverConstraintStore.js";

const TABLE = "layover_constraints";
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`refusing to interpolate identifier ${JSON.stringify(s)}`);
  return `"${s}"`;
};
const lit = (v: unknown) => `'${String(v).replace(/'/g, "''")}'`;

/** Run one statement as the service role and report it the way supabase-js would. */
function run(sql: string): { data: any; error: { message: string; code?: string } | null } {
  const r = psql(`\\set VERBOSITY verbose\nSET ROLE service_role;\n${sql}`);
  if (r.status !== 0) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(r.stderr);
    return { data: null, error: { message: m?.[2] ?? r.stderr.trim(), code: m?.[1] } };
  }
  const text = r.stdout.trim();
  return { data: text ? JSON.parse(text) : null, error: null };
}

/** The slice of the supabase-js surface `LayoverConstraintStore` uses, over psql. */
function psqlClient(): any {
  return {
    from(table: string) {
      const where: string[] = [];
      let cols = "*";
      let order = "";
      let limit = "";
      let insert: Record<string, unknown> | null = null;
      const select = () =>
        `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (SELECT ${cols} FROM public.${ident(table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${order}${limit}) t;`;
      const list = () => {
        if (insert) {
          const keys = Object.keys(insert).map(ident).join(", ");
          return run(
            `WITH ins AS (INSERT INTO public.${ident(table)} (${keys}) SELECT ${keys} FROM jsonb_populate_record(NULL::public.${ident(table)}, ${jsonLiteral(insert)}) RETURNING ${cols}) SELECT COALESCE(json_agg(ins), '[]'::json)::text FROM ins;`,
          );
        }
        return run(select());
      };
      const b: any = {
        select(c?: string) { cols = c && c !== "*" ? c.split(",").map((x) => ident(x.trim())).join(", ") : "*"; return b; },
        insert(payload: Record<string, unknown>) { insert = payload; return b; },
        eq(col: string, v: unknown) { where.push(`${ident(col)} = ${lit(v)}`); return b; },
        in(col: string, vs: unknown[]) { where.push(`${ident(col)} IN (${vs.map(lit).join(", ")})`); return b; },
        order(col: string, o: { ascending?: boolean } = {}) { order = ` ORDER BY ${ident(col)} ${o.ascending === false ? "DESC" : "ASC"}`; return b; },
        limit(n: number) { limit = ` LIMIT ${Number(n)}`; return b; },
        maybeSingle() {
          const r = list();
          if (r.error) return Promise.resolve(r);
          const arr = r.data as unknown[];
          return Promise.resolve({ data: arr[0] ?? null, error: null });
        },
        then(onF: any, onR: any) { return Promise.resolve(list()).then(onF, onR); },
      };
      return b;
    },
  };
}

function seedSession(userId: string): string {
  const id = randomUUID();
  exec(
    `INSERT INTO public.layover_sessions (id, user_id, arrival_time, departure_time, flight_type) ` +
    `VALUES ('${id}', '${userId}', now(), now() + interval '8 hours', 'international');`,
  );
  return id;
}

const set = (version: number, over: Partial<LayoverConstraintSet> = {}): LayoverConstraintSet => ({
  version, baggageMode: "UNKNOWN", recheckRequired: null, airportChangeRequired: null, ...over,
});

describe("layover_constraints — the store against migration 2992's table", { skip: !HAVE_DB }, () => {
  let user = "";
  let session = "";
  const db = psqlClient();

  before(() => { user = seedUser("constraints"); session = seedSession(user); });
  after(() => {
    if (!HAVE_DB) return;
    exec(`DELETE FROM public.layover_sessions WHERE user_id = '${user}';`);
    deleteUser(user);
  });

  it("the store's INSERT names only columns the table has, and reads back what it wrote", async () => {
    const out = await insertConstraintVersion(db, {
      sessionId: session,
      set: set(1, { baggageMode: "COLLECT_RECHECK", recheckRequired: true, airportChangeRequired: false }),
      snapshotId: "snap:0123456789abcdef0123456789abcdef",
      entryPermissionState: "CONFIRMED_ALLOWED",
      criticalUnknowns: ["baggage_mode"],
    });
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.set.version, 1);
    assert.equal(out.set.baggageMode, "COLLECT_RECHECK");
    assert.equal(out.set.recheckRequired, true);
    assert.equal(out.set.airportChangeRequired, false);
    assert.ok(out.set.declaredAt, "created_at did not come back");

    // The STATE, read from a separate statement rather than from RETURNING.
    const stored = rows<Record<string, unknown>>(`SELECT * FROM public.${TABLE} WHERE session_id = '${session}'`);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.snapshot_id, "snap:0123456789abcdef0123456789abcdef");
    assert.equal(stored[0]!.entry_permission_state, "CONFIRMED_ALLOWED");
    assert.deepEqual(stored[0]!.critical_unknowns, ["baggage_mode"]);
    // Columns this store does not declare keep 2992's defaults.
    assert.equal(stored[0]!.mobility_profile, "STANDARD");
    assert.equal(stored[0]!.buffer_profile, "STANDARD");
  });

  it("a second writer of the SAME version gets 23505, which the store reports as a version conflict", async () => {
    const again = await insertConstraintVersion(db, {
      sessionId: session, set: set(1), snapshotId: null, entryPermissionState: "UNKNOWN", criticalUnknowns: [],
    });
    assert.equal(again.ok, false);
    assert.ok(!again.ok && again.reason === "version_conflict", JSON.stringify(again));
    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE session_id = '${session}'`), "1");
  });

  it("the latest version is the declared set, for one session and in the batch read", async () => {
    const v2 = await insertConstraintVersion(db, {
      sessionId: session, set: set(2, { baggageMode: "CHECKED_THROUGH" }), snapshotId: null,
      entryPermissionState: "UNKNOWN", criticalUnknowns: [],
    });
    assert.ok(v2.ok, JSON.stringify(v2));
    const one = await readLatestConstraints(db, session);
    assert.ok(one.state === "declared" && one.set.version === 2 && one.set.baggageMode === "CHECKED_THROUGH", JSON.stringify(one));

    const other = seedSession(user);
    const many = await readLatestConstraintsFor(db, [session, other]);
    assert.equal(many.get(session)?.state, "declared");
    assert.equal(many.get(other)?.state, "undeclared");
  });

  it("the TypeScript vocabularies ARE the CHECK constraints — every member accepted, and nothing else", async () => {
    const s = seedSession(user);
    let version = 0;
    for (const baggageMode of BAGGAGE_MODES) {
      for (const entryPermissionState of ENTRY_PERMISSION_STATES) {
        version += 1;
        const r = await insertConstraintVersion(db, {
          sessionId: s, set: set(version, { baggageMode }), snapshotId: null, entryPermissionState, criticalUnknowns: [],
        });
        assert.ok(r.ok, `${baggageMode} / ${entryPermissionState}: ${JSON.stringify(r)}`);
      }
    }
    const bad = await insertConstraintVersion(db, {
      sessionId: s, set: set(version + 1, { baggageMode: "TELEPORTED" as never }), snapshotId: null,
      entryPermissionState: "UNKNOWN", criticalUnknowns: [],
    });
    assert.ok(!bad.ok && bad.reason === "write_failed", "a baggage mode outside the CHECK was stored");
    const badEntry = await insertConstraintVersion(db, {
      sessionId: s, set: set(version + 1), snapshotId: null, entryPermissionState: "MAYBE" as never, criticalUnknowns: [],
    });
    assert.ok(!badEntry.ok && badEntry.reason === "write_failed", "an entry state outside the CHECK was stored");
  });

  it("a version is IMMUTABLE: an UPDATE raises even as the service role, so an edit can only be a new version", () => {
    const r = psql(`SET ROLE service_role;\nUPDATE public.${TABLE} SET baggage_mode = 'CARRY_ON_ONLY' WHERE session_id = '${session}' AND version = 1;`);
    assert.notEqual(r.status, 0, "an UPDATE of a declared version succeeded");
    assert.match(r.stderr, /IMMUTABLE \(2992\)/);
    assert.equal(scalar(`SELECT baggage_mode FROM public.${TABLE} WHERE session_id = '${session}' AND version = 1`), "COLLECT_RECHECK");
  });

  it("the table is server-mediated: a signed-in traveller can neither read nor write their own rows directly", () => {
    assert.equal(scalar(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = '${TABLE}'`), "0");
    assert.equal(scalar(`SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.${TABLE}'::regclass`), "true");
    assert.throws(() => asUser(user, `SELECT count(*) FROM public.${TABLE};`), /permission denied/);
    assert.throws(
      () => asUser(user, `INSERT INTO public.${TABLE} (session_id, version) VALUES ('${session}', 99);`),
      /permission denied/,
    );
  });

  it("closing the layover's row takes its declared versions with it (ON DELETE CASCADE)", () => {
    const s = seedSession(user);
    exec(`SET ROLE service_role; INSERT INTO public.${TABLE} (session_id, version) VALUES ('${s}', 1);`);
    exec(`DELETE FROM public.layover_sessions WHERE id = '${s}';`);
    assert.equal(scalar(`SELECT count(*) FROM public.${TABLE} WHERE session_id = '${s}'`), "0");
  });

  it("3640 seeded both flags, and seeded them OFF", () => {
    const flags = rows<{ flag: string; enabled: boolean }>(
      `SELECT flag, enabled FROM public.feature_flags WHERE flag IN (${Object.values(LAYOVER_CONSTRAINT_FLAGS).map(lit).join(", ")}) ORDER BY flag`,
    );
    assert.deepEqual(flags, [
      { flag: "layover_constraints_enabled", enabled: false },
      { flag: "layover_entry_forbid_landside_enabled", enabled: false },
    ]);
  });
});
