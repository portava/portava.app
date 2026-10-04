/**
 * 3521 — the `standard` commission seed, executed against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/rentBuddyStandardSeed.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT SUITE ─────────────────────
 * `src/test/rentBuddyStandardSeedAndFeeRuleV2.test.ts` proves what the seeded
 * VALUES make the real resolver and the real ledger writer do. It cannot prove
 * the two properties the owner's constraint actually turns on — that a re-run
 * neither duplicates the row nor overwrites an operator's later edit — because
 * those are `ON CONFLICT DO NOTHING` semantics and only PostgreSQL has them.
 * Asserting them by reading the SQL would be asserting that the statement is
 * SPELLED correctly, which is not the same claim.
 *
 * Every property below runs inside a transaction that always ROLLS BACK, so no
 * database is left modified by this suite.
 *
 * PROPERTIES
 *   S0  3520 then 3521 on the replayed chain: 'standard' exists, at 1000 basis
 *       points, no approval, mirror 10, traveller fee 0.
 *   S1  IDEMPOTENT: the body runs three times in one transaction and there is
 *       still exactly one 'standard' row.
 *   S2  AN OPERATOR'S EDIT SURVIVES A RE-RUN: an approved override written after
 *       the seed is still there, unchanged, after the body runs again.
 *   S3  the seed disturbs no other level, and deletes none.
 *   S4  the seed does not write commission_override_approval.
 *   S5  the flat-rate CHECK is intact and still bites: an unapproved off-flat
 *       rate is still unwritable after the seed.
 *   S6  the postconditions are not decorative: a body whose seeded rate is
 *       mutated to 1500 RAISES instead of storing a price nobody approved.
 *   S7  the precondition refuses on a database that has not run 3520, rather
 *       than silently seeding nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, psql, rows, scalar } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const M3520 = resolve(__dir, "../../migrations/3520_rent_buddy_commission_basis_points.sql");
const M3521 = resolve(__dir, "../../migrations/3521_rent_buddy_standard_level_commission_seed.sql");

/** A migration's statements without its own BEGIN … COMMIT, so a test can run them in its transaction. */
function body(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n";
}

const B3520 = body(M3520);
const B3521 = body(M3521);

/** Run a script in one transaction that always rolls back. */
function inRolledBackTx(script: string) {
  return psql(`\\set VERBOSITY verbose\nBEGIN;\n${script}\nROLLBACK;\n`);
}

/** The chain this suite needs: the storage change, then the seed. */
const CHAIN = `${B3520}\n${B3521}\n`;

function ok(r: { status: number; stderr: string }, what: string) {
  assert.equal(r.status, 0, `${what} failed:\n${r.stderr}`);
}

describe("3521: the 'standard' level is priced at the approved flat rate", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  it("S0: after 3520 + 3521, 'standard' carries 1000 basis points and no approval", () => {
    const r = psql(
      `BEGIN;\n${CHAIN}\n` +
      `SELECT platform_fee_basis_points, platform_fee_percent, ` +
      `coalesce(commission_override_approval, '<null>') AS approval, ` +
      `traveler_service_fee_usd, traveler_service_fee_pct, ` +
      `(SELECT count(*) FROM public.rent_buddy_fee_rules WHERE buddy_level='standard') AS n ` +
      `FROM public.rent_buddy_fee_rules WHERE buddy_level='standard';\n` +
      `ROLLBACK;\n`,
    );
    ok(r, "3520 + 3521");
    const line = r.stdout.split("\n").map((s) => s.trim()).find((s) => /\|/.test(s) && /^\s*1000\s*\|/.test(s));
    assert.ok(line, `no 'standard' row in output:\n${r.stdout}`);
    const f = line.split("|").map((s) => s.trim());
    assert.equal(f[0], "1000", "the approved flat rate");
    assert.equal(f[1], "10", "the legacy percent mirror agrees");
    assert.equal(f[2], "<null>", "a seed approves no override");
    assert.equal(Number(f[3]), 0, "traveller flat fee 0 — ruling R1 is unmade");
    assert.equal(Number(f[4]), 0, "traveller pct fee 0 — ruling R1 is unmade");
    assert.equal(f[5], "1", "exactly one row for the level");
  });

  it("S1: IDEMPOTENT — three runs in one transaction leave exactly one row", () => {
    const r = psql(
      `BEGIN;\n${B3520}\n${B3521}\n${B3521}\n${B3521}\n` +
      `SELECT count(*) AS n FROM public.rent_buddy_fee_rules WHERE buddy_level='standard';\n` +
      `ROLLBACK;\n`,
    );
    ok(r, "3521 x3");
    assert.match(
      r.stdout, /\n\s*1\s*\n/,
      `three applies must leave one row, not three:\n${r.stdout}`,
    );
    // And the second and third runs must say so rather than pretending to seed.
    const noops = (r.stdout.match(/3521 OK \(no-op\)/g) ?? []).length;
    assert.equal(noops, 2, `expected 2 no-op notices, got ${noops}:\n${r.stdout}`);
  });

  it("S2: AN OPERATOR'S LATER EDIT IS NOT OVERWRITTEN BY A RE-RUN", () => {
    // The operator deliberately moves 'standard' off the flat rate, WITH the
    // separate approval the CHECK requires. A re-run of the seed must leave it
    // exactly as they set it — a migration that reverts live pricing on re-run
    // is a money defect.
    const r = psql(
      `BEGIN;\n${B3520}\n${B3521}\n` +
      `UPDATE public.rent_buddy_fee_rules ` +
      `   SET platform_fee_basis_points = 1500, platform_fee_percent = 15, ` +
      `       commission_override_approval = 'owner ruling 2026-11-01 (fixture)' ` +
      ` WHERE buddy_level = 'standard';\n` +
      `${B3521}\n` +
      `SELECT platform_fee_basis_points, platform_fee_percent, commission_override_approval ` +
      `  FROM public.rent_buddy_fee_rules WHERE buddy_level='standard';\n` +
      `ROLLBACK;\n`,
    );
    ok(r, "seed over an operator edit");
    assert.match(r.stdout, /1500/, `the operator's rate was reverted:\n${r.stdout}`);
    assert.match(r.stdout, /owner ruling 2026-11-01 \(fixture\)/, "the approval was discarded");
    assert.ok(!/\b1000\s*\|\s*10\s*\|/.test(r.stdout), "the seed reset the operator's rate to the flat rate");
    assert.match(r.stdout, /3521 OK \(no-op\)/, "the re-run must report itself as a no-op");
  });

  it("S3: no other level is re-rated, and none is deleted", () => {
    // Seed a second level before the file runs, with an approved override so it
    // is distinguishable and the CHECK permits it.
    const r = psql(
      `BEGIN;\n${B3520}\n` +
      `INSERT INTO public.rent_buddy_fee_rules ` +
      `  (buddy_level, platform_fee_basis_points, platform_fee_percent, commission_override_approval, traveler_service_fee_pct) ` +
      `VALUES ('fixture_level', 2200, 22, 'fixture approval', 5) ` +
      `ON CONFLICT ON CONSTRAINT rent_buddy_fee_rules_buddy_level_key DO NOTHING;\n` +
      `${B3521}\n` +
      `SELECT platform_fee_basis_points, platform_fee_percent, commission_override_approval, traveler_service_fee_pct ` +
      `  FROM public.rent_buddy_fee_rules WHERE buddy_level='fixture_level';\n` +
      `ROLLBACK;\n`,
    );
    ok(r, "seed beside another level");
    assert.match(r.stdout, /2200/, `the other level's rate moved:\n${r.stdout}`);
    assert.match(r.stdout, /fixture approval/, "the other level's approval was touched");
    assert.ok(
      /\|\s*5\.00\s*$|\|\s*5\.00\s*\n|\|\s*5\.00\s*\|/m.test(r.stdout) || /5\.00/.test(r.stdout),
      `the other level's traveller fee moved:\n${r.stdout}`,
    );
  });

  it("S4: the seed writes no commission_override_approval", () => {
    const r = psql(
      `BEGIN;\n${CHAIN}\n` +
      `SELECT count(*) AS n FROM public.rent_buddy_fee_rules WHERE commission_override_approval IS NOT NULL;\n` +
      `ROLLBACK;\n`,
    );
    ok(r, "approval check");
    assert.match(r.stdout, /\n\s*0\s*\n/, `an approval was written:\n${r.stdout}`);
  });

  it("S5: the flat-rate CHECK is intact and still refuses an unapproved off-flat rate", () => {
    const r = inRolledBackTx(
      `${CHAIN}\n` +
      `UPDATE public.rent_buddy_fee_rules SET platform_fee_basis_points = 1500 WHERE buddy_level='standard';\n`,
    );
    assert.notEqual(r.status, 0, "an unapproved 1500 was accepted — the CHECK is not in force");
    assert.match(r.stderr, /rbfr_flat_rate_unless_approved/, r.stderr);
    assert.match(r.stderr, /23514/, `expected a check_violation:\n${r.stderr}`);
  });

  it("S6: the postconditions are not decorative — a mutated rate RAISES", () => {
    // Exactly the mutation the owner's decision forbids: seed a price that was
    // not approved. The file must refuse to commit it.
    const mutated = B3521.replace("VALUES ('standard', 1000, 10)", "VALUES ('standard', 1500, 15)");
    assert.notEqual(mutated, B3521, "the mutation did not apply — the VALUES tuple was respelled");
    const r = inRolledBackTx(`${B3520}\n${mutated}\n`);
    assert.notEqual(r.status, 0, "a seed at an unapproved 1500 was committed");
    assert.ok(
      /postcondition FAILED/.test(r.stderr) || /rbfr_flat_rate_unless_approved/.test(r.stderr),
      `expected a refusal naming the postcondition or the CHECK:\n${r.stderr}`,
    );
  });

  it("S7: on a database without 3520, the seed REFUSES rather than skipping", () => {
    // The precondition path. 3520's columns are removed inside the transaction
    // so the file meets a genuinely un-migrated table.
    const r = inRolledBackTx(
      `ALTER TABLE public.rent_buddy_fee_rules
         DROP CONSTRAINT IF EXISTS rbfr_flat_rate_unless_approved,
         DROP CONSTRAINT IF EXISTS rbfr_basis_points_range;
       ALTER TABLE public.rent_buddy_fee_rules
         DROP COLUMN IF EXISTS platform_fee_basis_points,
         DROP COLUMN IF EXISTS commission_override_approval;\n` +
      `${B3521}\n`,
    );
    assert.notEqual(r.status, 0, "the seed ran against a table with no basis-point column");
    assert.match(r.stderr, /3521 PRECONDITION FAILED/, r.stderr);
    assert.match(r.stderr, /3520/, "the refusal must name the file to apply first");
  });

  it("S8: 'standard' resolves where it previously had no row at all", () => {
    // The behaviour the owner asked for, measured on the database rather than
    // on a fake: before the seed the level is absent (so every fee route
    // refuses), after it the level is present and priced.
    const before = scalar(
      `SELECT count(*) FROM public.rent_buddy_fee_rules WHERE buddy_level='standard'`,
    );
    const r = psql(
      `BEGIN;\n${B3520}\n` +
      `DELETE FROM public.rent_buddy_fee_rules WHERE buddy_level='standard';\n` +
      `SELECT 'pre=' || count(*)::text FROM public.rent_buddy_fee_rules WHERE buddy_level='standard';\n` +
      `${B3521}\n` +
      `SELECT 'post=' || count(*)::text FROM public.rent_buddy_fee_rules WHERE buddy_level='standard';\n` +
      `ROLLBACK;\n`,
    );
    ok(r, "delete-then-seed");
    assert.match(r.stdout, /pre=0/, `the fixture did not start from an absent level:\n${r.stdout}`);
    assert.match(r.stdout, /post=1/, `the seed did not create the level:\n${r.stdout}`);
    assert.ok(before !== null, "the harness answered no count at all");
  });

  it("S9: the schedule rows all agree with 3520's mirror rule after the seed", () => {
    // 3520 asserts percent = ROUND(bps/100) for EVERY row. If 3521's seeded
    // mirror disagreed, a later re-run of 3520 would fail — so this is the
    // forward-compatibility property, not a restatement.
    const r = psql(`BEGIN;\n${CHAIN}\n${B3520}\nROLLBACK;\n`);
    ok(r, "3520 re-run after the seed");
    assert.ok(
      !/postcondition FAILED/.test(r.stderr),
      `re-running 3520 after the seed failed:\n${r.stderr}`,
    );
  });

  it("the suite actually touched the schedule table", () => {
    // Guard against a vacuous run: if the replayed chain has no such table,
    // every property above would pass on empty output.
    const r = rows<{ exists: string }>(
      `SELECT (to_regclass('public.rent_buddy_fee_rules') IS NOT NULL)::text AS exists`,
    );
    assert.equal(r[0]?.exists, "true", "public.rent_buddy_fee_rules is absent from the harness chain");
  });
});
