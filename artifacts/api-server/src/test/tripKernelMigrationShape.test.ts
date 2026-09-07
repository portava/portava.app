/**
 * Migration 2316 — the kernel spine, asserted against the SQL itself.
 *
 * WHY A TEXT TEST. The properties that matter here are properties of the SQL —
 * that the log has both uniqueness constraints, that the append-only guard is
 * ROW level and not statement level, that the erasure paths still work, that
 * the table is deny-default. This repo cannot reach a database from a unit test
 * (the live-DB tier is a separate CI lane), and every one of these has a history
 * of being got wrong in a way no green unit suite noticed:
 *
 *   * a statement-level append-only trigger broke account deletion twice
 *     (2130 → 2137, 2276/2277/2279 → 2292);
 *   * a blanket `GRANT ALL … TO anon` is how every client-write defect in this
 *     codebase started;
 *   * a fifth trip status vocabulary is the specific thing the owner's ruling
 *     forbids, and it would arrive as a `text` column with a new CHECK.
 *
 * Run: node --import tsx/esm --test src/test/tripKernelMigrationShape.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");
const FILE = "2316_trip_kernel_foundation.sql";
const SQL = readFileSync(join(MIGRATIONS, FILE), "utf8");

/**
 * The same file with `--` comments removed. Absence assertions MUST run against
 * this, not against SQL: this migration's header discusses `lifecycle_state`
 * and `FOR EACH STATEMENT` precisely in order to explain why it has neither, and
 * a naive "the string does not appear" check would fail on the explanation.
 * A `--` is treated as a comment only when an even number of single quotes
 * precedes it on the line, so a `--` inside a string literal survives.
 */
const CODE = SQL.split("\n")
  .map((line) => {
    let quotes = 0;
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] === "'") quotes++;
      if (line[i] === "-" && line[i + 1] === "-" && quotes % 2 === 0) return line.slice(0, i);
    }
    return line;
  })
  .join("\n");

/** public.trip_status, from the baseline. No label outside this set may appear. */
const TRIP_STATUS_LABELS = [
  "draft", "planning", "upcoming", "active", "completed", "cancelled", "archived",
];

describe("2316 — the spine exists", () => {
  it("is the only file on its prefix", () => {
    const collisions = readdirSync(MIGRATIONS).filter((f) => f.startsWith("2316"));
    assert.deepEqual(collisions, [FILE]);
  });

  it("creates public.trip_events", () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS public\.trip_events/);
  });

  it("adds trips.version additively, defaulted, and NOT NULL", () => {
    assert.match(
      SQL,
      /ALTER TABLE public\.trips\s+ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1/,
    );
    // Additive means existing rows are not rewritten by hand.
    assert.equal(/UPDATE public\.trips\s+SET/i.test(CODE), false, "2316 must not rewrite trip rows");
  });

  it("carries the aggregate_version and idempotency_key columns the kernel needs", () => {
    assert.match(SQL, /aggregate_version integer NOT NULL/);
    assert.match(SQL, /idempotency_key\s+text NOT NULL/);
    assert.match(SQL, /actor_id\s+uuid REFERENCES public\.profiles\(id\) ON DELETE SET NULL/);
    assert.match(SQL, /trip_id\s+uuid NOT NULL REFERENCES public\.trips\(id\) ON DELETE CASCADE/);
  });
});

describe("2316 — the two constraints the kernel's correctness rests on", () => {
  it("UNIQUE (trip_id, aggregate_version) — the concurrency serialization point", () => {
    assert.match(SQL, /ADD CONSTRAINT trip_events_trip_version_uniq UNIQUE \(trip_id, aggregate_version\)/);
  });

  it("UNIQUE (trip_id, idempotency_key) — command de-duplication at the database", () => {
    assert.match(SQL, /ADD CONSTRAINT trip_events_trip_idempotency_uniq UNIQUE \(trip_id, idempotency_key\)/);
  });

  it("asserts both in postconditions rather than assuming them", () => {
    assert.match(SQL, /POSTCONDITION FAILED: the \(trip_id, aggregate_version\) uniqueness is missing/);
    assert.match(SQL, /POSTCONDITION FAILED: the \(trip_id, idempotency_key\) uniqueness is missing/);
  });
});

describe("2316 — no fifth status vocabulary", () => {
  it("types the transition columns as the EXISTING public.trip_status enum, not text", () => {
    assert.match(SQL, /from_status\s+public\.trip_status/);
    assert.match(SQL, /to_status\s+public\.trip_status/);
  });

  it("creates no new type and no lifecycle_state column", () => {
    assert.equal(/CREATE TYPE/i.test(CODE), false, "2316 must not add an enum");
    assert.equal(/ALTER TYPE/i.test(CODE), false, "2316 must not extend an enum");
    assert.equal(/lifecycle_state/i.test(CODE), false, "lifecycle_state is explicitly out of scope");
  });

  it("invents no status literal — every quoted status word is a real trip_status label", () => {
    // Any single-quoted lowercase word that looks like a status must be known.
    const suspicious = [...CODE.matchAll(/'([a-z_]{3,20})'::public\.trip_status/g)].map((m) => m[1]);
    for (const s of suspicious) {
      assert.ok(TRIP_STATUS_LABELS.includes(s), `${s} is not a public.trip_status label`);
    }
  });

  it("constrains event_type to a closed set containing only what the kernel emits", () => {
    const m = /CHECK \(event_type IN \(([^)]*)\)\)/.exec(CODE);
    assert.ok(m, "event_type must carry a closed CHECK");
    const labels = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(labels, ["trip.completed"], "one command is routed, so one event type is legal");
  });
});

describe("2316 — append-only without breaking erasure", () => {
  it("attaches a ROW-level append-only trigger", () => {
    assert.match(
      SQL,
      /CREATE TRIGGER trip_events_append_only_row\s+BEFORE UPDATE OR DELETE ON public\.trip_events\s+FOR EACH ROW/,
    );
  });

  it("attaches NO statement-level trigger — the defect that broke deletion twice", () => {
    // Checked on the TRIGGER DECLARATIONS, not on the whole file: the table's
    // COMMENT ON FUNCTION names the phrase in order to explain why it is absent,
    // and that comment is executable SQL, so it survives comment-stripping.
    const declarations = [...CODE.matchAll(/CREATE TRIGGER[\s\S]*?;/gi)].map((m) => m[0]);
    assert.ok(declarations.length >= 1, "expected at least one trigger declaration to check");
    for (const d of declarations) {
      assert.equal(
        /FOR EACH STATEMENT/i.test(d),
        false,
        "a BEFORE ... FOR EACH STATEMENT guard refuses every parent DELETE, including one touching zero rows",
      );
    }
    // …and says so in a postcondition, so a future edit cannot reintroduce one
    // silently on an applied database.
    assert.match(SQL, /statement-level trigger\(s\) on trip_events/);
  });

  it("permits the trips CASCADE — DELETE is refused only while the parent trip exists", () => {
    assert.match(SQL, /IF EXISTS \(SELECT 1 FROM public\.trips t WHERE t\.id = OLD\.trip_id\) THEN/);
    assert.match(SQL, /DELETE is not permitted while the trip exists/);
  });

  it("permits exactly one UPDATE shape: the actor_id erasure null-out", () => {
    assert.match(SQL, /IF OLD\.actor_id IS NOT NULL\s+AND NEW\.actor_id IS NULL/);
    // Every other column must be compared, or the carve-out is a hole.
    for (const col of [
      "id", "trip_id", "aggregate_version", "event_type",
      "from_status", "to_status", "payload", "idempotency_key", "occurred_at",
    ]) {
      assert.ok(
        new RegExp(`NEW\\.${col}\\s+IS NOT DISTINCT FROM OLD\\.${col}`).test(SQL),
        `the erasure carve-out does not pin ${col}; it would let a rewrite through`,
      );
    }
    assert.match(SQL, /RAISE EXCEPTION 'trip_events is append-only: UPDATE is not permitted/);
  });

  it("grants the UPDATE the erasure null-out needs, and asserts it", () => {
    assert.match(SQL, /GRANT INSERT, SELECT, UPDATE, DELETE ON public\.trip_events TO service_role/);
    assert.match(SQL, /service_role lacks UPDATE on trip_events/);
  });
});

describe("2316 — RLS posture", () => {
  it("enables RLS and revokes before it grants", () => {
    assert.match(SQL, /ALTER TABLE public\.trip_events ENABLE ROW LEVEL SECURITY/);
    const revoke = SQL.indexOf("REVOKE ALL ON public.trip_events FROM PUBLIC");
    const grant = SQL.indexOf("GRANT INSERT, SELECT, UPDATE, DELETE ON public.trip_events");
    assert.ok(revoke > -1 && grant > revoke, "REVOKE must precede GRANT");
  });

  it("grants nothing to anon or authenticated", () => {
    assert.equal(
      /GRANT[^;]*\bON public\.trip_events\b[^;]*\bTO\b[^;]*\b(anon|authenticated)\b/i.test(CODE),
      false,
      "the kernel log is server-only; a client grant is how every write-boundary defect here started",
    );
    assert.match(SQL, /REVOKE ALL ON public\.trip_events FROM anon/);
    assert.match(SQL, /REVOKE ALL ON public\.trip_events FROM authenticated/);
    assert.match(SQL, /trip_events carries % client grant\(s\)/);
  });

  it("has exactly one policy, scoped to service_role", () => {
    const policies = [...CODE.matchAll(/CREATE POLICY (\w+) ON public\.trip_events/g)].map((m) => m[1]);
    assert.deepEqual(policies, ["trip_events_service_all"]);
    assert.match(SQL, /CREATE POLICY trip_events_service_all ON public\.trip_events\s+FOR ALL\s+TO service_role/);
  });
});

describe("2316 — migration hygiene", () => {
  it("is transactional", () => {
    assert.match(SQL, /^BEGIN;/m);
    assert.match(SQL, /^COMMIT;/m);
  });

  it("is idempotent: every create is guarded", () => {
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS/);
    assert.match(SQL, /ADD COLUMN IF NOT EXISTS/);
    assert.match(SQL, /CREATE INDEX IF NOT EXISTS/);
    assert.match(SQL, /DROP POLICY IF EXISTS/);
    assert.match(SQL, /DROP TRIGGER IF EXISTS/);
    const adds = [...CODE.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]);
    for (const c of adds) {
      assert.ok(
        SQL.includes(`DROP CONSTRAINT IF EXISTS ${c}`),
        `${c} is added without a preceding DROP … IF EXISTS, so a re-run fails`,
      );
    }
  });

  it("states preconditions and postconditions", () => {
    assert.match(SQL, /PRECONDITION FAILED: public\.trips must exist/);
    assert.match(SQL, /POSTCONDITION FAILED: trip_events was not created/);
    assert.match(SQL, /POSTCONDITION FAILED: trips\.version was not added/);
  });

  it("does NOT self-register in schema_migration_ledger", () => {
    assert.equal(/schema_migration_ledger/i.test(CODE), false);
  });

  it("touches no existing row and drops nothing that serves data", () => {
    assert.equal(/DROP TABLE/i.test(CODE), false);
    assert.equal(/^\s*(INSERT INTO|DELETE FROM)\s/im.test(CODE), false);
  });

  it("documents a reversal", () => {
    assert.match(SQL, /-- REVERSAL \(manual\):/);
  });

  it("flips no feature flag", () => {
    assert.equal(/feature_flags/i.test(CODE), false, "the kernel is not flag-gated; it is additive");
  });
});
