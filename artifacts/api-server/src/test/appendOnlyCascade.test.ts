/**
 * Append-only guards must not block an erasure cascade.
 *
 * THE BUG THIS EXISTS TO STOP HAPPENING A THIRD TIME
 * ==================================================
 * A `BEFORE ... FOR EACH STATEMENT` trigger fires when the statement STARTS,
 * before any row is examined. It cannot tell "there is nothing here to protect"
 * from "someone is rewriting history", so on a table that CASCADES from
 * profiles or places it refuses every parent delete — including one that would
 * touch zero rows.
 *
 *   Round 1 (2130 → 2137): intel_observations / intel_evidence /
 *     intel_confirmations. It broke the live-DB RLS suite's fixture teardown:
 *     "purgeFixtures: delete profiles: intel_observations is append-only:
 *      DELETE is not permitted at statement level". 2137 dropped the triggers
 *      and dropped public.intel_append_only_stmt() so no caller could return.
 *
 *   Round 2 (2276 / 2277 / 2279 → 2292): intel_presence_verifications /
 *     intel_attributions / intel_historical_patterns. Same trigger, same
 *     function, same error, same suite — this time naming
 *     intel_presence_verifications, on PR #402. 2292 removes them again.
 *
 * The cost is not a red test. The identical cascade runs in real account
 * deletion and right-to-erasure, so a user could not be deleted at all.
 *
 * WHAT THIS FILE ASSERTS
 * ======================
 * It reads the migration corpus as text — the property being protected IS a
 * property of the SQL, and this repo cannot reach a database from a unit test.
 * Two claims:
 *
 *   1. No migration leaves a statement-level UPDATE/DELETE trigger attached to
 *      an append-only table that a profiles / places / intel_observations
 *      cascade can reach. This is computed from the files, not from a list, so
 *      a NEW migration that re-attaches one fails here rather than in CI's
 *      live-DB tier three subsystems away.
 *
 *   2. 2292 itself does what it claims: drops the three triggers, keeps the
 *      row-level and TRUNCATE guards, and asserts both in postconditions.
 *
 * The row-level guard is deliberately NOT flagged: it fires once per real row,
 * which is exactly when there is something to protect, and it is what actually
 * enforces append-only.
 *
 * Run: node --import tsx/esm --test src/test/appendOnlyCascade.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "../migrations");

const FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const SQL = new Map<string, string>(
  FILES.map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")]),
);

const CORRECTIVE = "2292_intel_stmt_trigger_removal_ig_campaign.sql";

/**
 * The three tables 2292 corrects, with the cascade that reaches each. Named
 * here so the reasoning is reviewable, not so the scan depends on it — the scan
 * below derives its own set from the files.
 */
const CORRECTED: ReadonlyArray<{ table: string; createdBy: string; cascade: string }> = [
  {
    table: "intel_presence_verifications",
    createdBy: "2276_intel_presence_verification.sql",
    cascade: "actor_id -> profiles ON DELETE CASCADE, observation_id -> intel_observations ON DELETE CASCADE",
  },
  {
    table: "intel_attributions",
    createdBy: "2277_intel_outcomes_attribution.sql",
    cascade: "actor_id -> profiles ON DELETE CASCADE, observation_id -> intel_observations ON DELETE CASCADE",
  },
  {
    table: "intel_historical_patterns",
    createdBy: "2279_intel_historical_patterns.sql",
    cascade: "subject_id -> places ON DELETE CASCADE",
  },
];

/**
 * Statement-level triggers that are CORRECT and must not be swept up.
 *
 *   discovery_shadow_serves_no_update_stmt (2092) — BEFORE UPDATE only. It never
 *     sees a DELETE, so no cascade can trip it. This table has coexisted with
 *     account deletion since 2092.
 *   canonical_events_no_mutate_stmt (2120) — BEFORE UPDATE OR DELETE, but
 *     canonical_events deliberately takes NO foreign key at all (2120's header
 *     says so in as many words), so nothing cascades into it.
 *   *_no_truncate / *_truncate — TRUNCATE guards. TRUNCATE fires no row-level
 *     trigger, so a statement-level trigger is the ONLY way to block it, and
 *     TRUNCATE is never issued by a cascade. These must survive.
 */
const DELIBERATE_STATEMENT_TRIGGERS = new Set([
  "discovery_shadow_serves_no_update_stmt",
  "canonical_events_no_mutate_stmt",
]);

/** Every `CREATE TRIGGER` in the corpus, literal or built inside a DO/format(). */
interface TriggerDecl {
  file: string;
  name: string;
  timing: string;
  events: string;
  level: "row" | "statement";
}

/**
 * The intel family attaches its triggers from inside a DO block, with the table
 * name in a loop variable:
 *
 *   DO $$ DECLARE t text := 'intel_presence_verifications'; BEGIN
 *     EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I
 *                     FOR EACH STATEMENT EXECUTE FUNCTION …', t || '_no_update_delete_stmt', t);
 *
 * so the real trigger name is `<table><suffix>`. Resolving it matters: keying on
 * the suffix alone would let 2292's drop cancel a same-suffix trigger on a table
 * it never touches. Every `t` this file needs comes from either a scalar DECLARE
 * or a FOREACH … ARRAY[…] in the same block.
 */
function blockTables(block: string): string[] {
  const foreach = block.match(/foreach\s+t\s+in\s+array\s+array\s*\[([^\]]*)\]/i);
  if (foreach) return [...foreach[1].matchAll(/'([a-z0-9_]+)'/gi)].map((m) => m[1]);
  const scalar = block.match(/declare\s+t\s+text\s*:=\s*'([a-z0-9_]+)'/i);
  return scalar ? [scalar[1]] : [];
}

/** Split into top-level SQL plus each DO $$ … $$ block, so `t` resolves locally. */
function segments(sql: string): string[] {
  const blocks = [...sql.matchAll(/do\s+\$\$[\s\S]*?\$\$\s*;/gi)].map((m) => m[0]);
  const rest = sql.replace(/do\s+\$\$[\s\S]*?\$\$\s*;/gi, " ");
  return [rest, ...blocks];
}

const LITERAL_CREATE =
  /create\s+trigger\s+([a-z0-9_]+)\s+(before|after|instead\s+of)\s+([a-z\s]+?)\s+on\s+[a-z0-9_."]+\s+for\s+each\s+(row|statement)/gi;
const DYNAMIC_CREATE =
  /create\s+trigger\s+%I\s+(before|after|instead\s+of)\s+([a-z\s]+?)\s+on\s+public\.%I\s+for\s+each\s+(row|statement)[\s\S]*?'\s*,\s*t\s*\|\|\s*'([a-z0-9_]+)'/gi;
const LITERAL_DROP = /drop\s+trigger\s+if\s+exists\s+([a-z0-9_]+)\s+on\b/gi;
const DYNAMIC_DROP =
  /drop\s+trigger\s+if\s+exists\s+%I\s+on\s+public\.%I'\s*,\s*t\s*\|\|\s*'([a-z0-9_]+)'/gi;

function parseTriggers(file: string, sql: string): TriggerDecl[] {
  const out: TriggerDecl[] = [];
  for (const seg of segments(sql)) {
    const tables = blockTables(seg);
    for (const m of seg.matchAll(LITERAL_CREATE)) {
      out.push({ file, name: m[1], timing: m[2].toLowerCase(), events: m[3].toLowerCase(), level: m[4].toLowerCase() as "row" | "statement" });
    }
    for (const m of seg.matchAll(DYNAMIC_CREATE)) {
      for (const t of tables) {
        out.push({ file, name: `${t}${m[4]}`, timing: m[1].toLowerCase(), events: m[2].toLowerCase(), level: m[3].toLowerCase() as "row" | "statement" });
      }
    }
  }
  return out;
}

/** Trigger names a migration drops, so a create-then-drop pair nets to nothing. */
function droppedNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const seg of segments(sql)) {
    const tables = blockTables(seg);
    for (const m of seg.matchAll(LITERAL_DROP)) out.add(m[1]);
    for (const m of seg.matchAll(DYNAMIC_DROP)) for (const t of tables) out.add(`${t}${m[1]}`);
  }
  return out;
}

describe("append-only guards vs the erasure cascade — the corpus", () => {
  it("reads a non-empty migration corpus (a vacuous scan is a failure, not a pass)", () => {
    assert.ok(FILES.length > 300, `expected the full migration corpus, found ${FILES.length} file(s)`);
    assert.ok(SQL.has(CORRECTIVE), `${CORRECTIVE} is missing`);
  });

  it("finds the round-1 and round-2 statement-level triggers, so the scan is known to bite", () => {
    // If this ever finds nothing, the parser has drifted and every other
    // assertion in this file has quietly become vacuous.
    const all = FILES.flatMap((f) => parseTriggers(f, SQL.get(f)!));
    const stmtDeleteGuards = all.filter(
      (t) => t.level === "statement" && t.timing === "before" && t.events.includes("delete"),
    );
    assert.ok(
      stmtDeleteGuards.length >= 4,
      `parser found only ${stmtDeleteGuards.length} statement-level DELETE trigger declaration(s); it should still see 2130's, 2276's, 2277's, 2279's and 2120's`,
    );
    for (const name of ["intel_presence_verifications_no_update_delete_stmt", "intel_attributions_no_update_delete_stmt", "intel_historical_patterns_no_update_delete_stmt"]) {
      assert.ok(
        stmtDeleteGuards.some((t) => t.name === name),
        `${name} not seen by the parser — the scan below cannot be trusted`,
      );
    }
  });

  it("no statement-level DELETE guard survives the corpus except the deliberate ones", () => {
    const created = new Map<string, TriggerDecl>();

    // Apply order is filename order, the same order the ledger applies them in.
    // Within one file a DROP … then CREATE of the same name nets to created;
    // a file that only DROPs removes what an earlier file created.
    for (const f of FILES) {
      const sql = SQL.get(f)!;
      const makes = parseTriggers(f, sql);
      const madeHere = new Set(makes.map((t) => t.name));
      for (const n of droppedNames(sql)) if (!madeHere.has(n)) created.delete(n);
      for (const t of makes) created.set(t.name, t);
    }

    const survivors = [...created.values()].filter(
      (t) =>
        t.level === "statement" &&
        t.timing === "before" &&
        t.events.includes("delete") &&
        !t.events.includes("truncate") &&
        !DELIBERATE_STATEMENT_TRIGGERS.has(t.name),
    );

    assert.deepEqual(
      survivors.map((t) => `${t.name} (${t.file})`),
      [],
      "A statement-level BEFORE DELETE trigger fires even when the statement deletes zero rows, so it refuses any " +
        "profiles/places cascade that merely TOUCHES the table — breaking account deletion and right-to-erasure. " +
        "Read 2137_intel_stmt_trigger_removal.sql before adding one back. The row-level *_no_update_delete guard " +
        "is what enforces append-only; the statement-level one adds no case it misses.",
    );
  });

  it("keeps every TRUNCATE guard — those can only be statement-level", () => {
    const truncateGuards = FILES.flatMap((f) => parseTriggers(f, SQL.get(f)!)).filter((t) =>
      t.events.includes("truncate"),
    );
    assert.ok(truncateGuards.length >= 6, `expected the TRUNCATE guards to survive, found ${truncateGuards.length}`);
    for (const t of truncateGuards) {
      assert.equal(t.level, "statement", `${t.name}: a TRUNCATE trigger cannot be FOR EACH ROW`);
    }
  });
});

describe("migration 2292 — what it does to each affected table", () => {
  const sql = () => SQL.get(CORRECTIVE)!;

  it("drops the statement-level guard on all three cascade-reachable tables", () => {
    for (const { table } of CORRECTED) {
      assert.ok(sql().includes(`'${table}'`), `${table} not named in 2292`);
    }
    assert.match(
      sql(),
      /DROP TRIGGER IF EXISTS %I ON public\.%I', t \|\| '_no_update_delete_stmt', t/,
      "2292 must drop the statement-level trigger",
    );
  });

  it("never drops the row-level guard or the TRUNCATE guard", () => {
    // The whole point: the protection stays, only the zero-row refusal goes.
    assert.equal(
      /drop\s+trigger[^\n]*_no_update_delete'/i.test(sql()),
      false,
      "2292 must not drop the row-level append-only trigger",
    );
    assert.equal(
      /drop\s+trigger[^\n]*_no_truncate/i.test(sql()),
      false,
      "2292 must not drop the TRUNCATE guard",
    );
  });

  it("refuses to run if a table it is about to unguard has no row-level trigger", () => {
    assert.ok(
      sql().includes("carries no row-level append-only trigger"),
      "2292 must precondition on the row-level guard being present",
    );
  });

  it("postconditions RAISE on every claim it makes", () => {
    for (const needle of [
      "statement-level append-only trigger still on public.%",
      "expected 1 row-level append-only trigger on public.%",
      "expected 1 TRUNCATE guard on public.%",
      "append-only weakened",
      "statement-level trigger(s) back on the 2130 intel family",
      "still execute intel_append_only_stmt()",
    ]) {
      assert.ok(sql().includes(needle), `missing postcondition: ${needle}`);
    }
    assert.match(sql(), /^BEGIN;/m);
    assert.match(sql(), /^COMMIT;/m);
  });

  it("does not weaken the client append-only guarantee", () => {
    // No grant, no policy, no RLS change anywhere in the file.
    assert.equal(/^\s*GRANT\s/im.test(sql()), false, "2292 must grant nothing");
    assert.equal(/CREATE\s+POLICY/i.test(sql()), false, "2292 must create no policy");
    assert.equal(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql()), false, "2292 must not disable RLS");
    // And it proves the absence of client write privileges rather than assuming it.
    assert.match(sql(), /has_table_privilege\(r\.role, 'public\.' \|\| t, p\.priv\)/);
  });

  it("is idempotent and additive — safe to re-run, changes no data", () => {
    assert.match(sql(), /DROP TRIGGER IF EXISTS/);
    assert.equal(/^\s*(INSERT|UPDATE|DELETE)\s/im.test(sql()), false, "2292 must not touch data");
    assert.equal(/DROP\s+TABLE/i.test(sql()), false);
  });

  it("tolerates a table that has not been created yet in some environment", () => {
    assert.match(sql(), /IF to_regclass\('public\.' \|\| t\) IS NULL THEN\s+CONTINUE;/);
    // …but refuses a fully vacuous run, which would otherwise pass silently.
    assert.ok(sql().includes("this file has nothing to correct and a vacuous pass would hide that"));
  });
});

describe("the three corrected tables, and why each needed it", () => {
  for (const { table, createdBy, cascade } of CORRECTED) {
    it(`${table}: created append-only by ${createdBy}, reachable by cascade (${cascade})`, () => {
      const src = SQL.get(createdBy);
      assert.ok(src, `${createdBy} missing`);
      // The cascade that made the statement trigger fatal is still declared —
      // if it is ever removed, this test should be revisited, not silently pass.
      assert.match(src!, /ON DELETE CASCADE/, `${createdBy} no longer declares a cascade`);
      // The row-level guard, which is the real protection, is still there.
      assert.ok(
        src!.includes(`${table}_no_update_delete`) ||
          src!.includes("_no_update_delete', t"),
        `${createdBy} no longer attaches the row-level append-only guard`,
      );
    });
  }

  it("intel_state_snapshot_versions (2273) needed no correction — it takes no cascade", () => {
    const src = SQL.get("2273_intel_replayable_projection.sql")!;
    assert.ok(
      src.includes("carries no FK"),
      "2273 documented that it deliberately takes no FK from places; if that changed, it needs 2292's treatment too",
    );
    const stmt = parseTriggers("2273", src).filter(
      (t) => t.level === "statement" && t.events.includes("delete") && !t.events.includes("truncate"),
    );
    assert.deepEqual(stmt.map((t) => t.name), [], "2273 must not carry a statement-level DELETE guard");
  });
});
