/**
 * check-flag-polarity.mjs — the seed scanner sees every seeding statement.
 *
 * RED-PROOF for the `public.` prefix fix.
 *
 * The script's seeded-flag population is built by matching `INSERT INTO
 * feature_flags` across src/migrations. Until 2026-08-12 that matcher required
 * the table name to be unqualified, so it silently skipped both migrations that
 * write `INSERT INTO public.feature_flags` — 0051_compass_foundation.sql and
 * 0062_notifications_schema.sql, 14 seeded flags, 10 of them read by nothing.
 *
 * The damage from that class of bug is not a wrong answer, it is a confident
 * right-looking one: rule R6 ("every seeded flag is either read or declared
 * inert") cannot fail on a flag it never saw, so the check reported a clean
 * population precisely because it was blind. The script's own preamble names
 * this — "a broken scan here reports 'every seeded flag has a reader', which is
 * the most comfortable possible lie".
 *
 * A test that hard-codes "the scanner must find 49 statements" would rot on the
 * next migration. So this test re-derives the answer instead: it scans the same
 * directory with a DELIBERATELY BROADER matcher — any schema qualifier, quoted
 * or not, plus optional whitespace around the dot — and asserts the script's own
 * reported totals match. It stays true as migrations are added, and goes red for
 * any seeding form the narrower matcher misses, not just the `public.` one that
 * prompted it.
 *
 * Run: node --import tsx/esm --test src/test/flagPolaritySeedScan.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = join(PKG_ROOT, "src", "migrations");
const SCRIPT = join(PKG_ROOT, "scripts", "check-flag-polarity.mjs");

/**
 * Broader than the script's matcher on purpose. If the script ever needs to be
 * narrower than this for a good reason, this test should fail and the reason
 * should be written down here — that argument is the point of the test.
 */
const BROAD_INSERT = /INSERT\s+INTO\s+(?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)?"?feature_flags"?\b/gi;
const ROW_LITERAL = /\(\s*'([A-Za-z0-9_]+)'\s*,/g;

/** Quote-aware comment strip, written independently of the script's own. */
function stripComments(sql: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], d = sql[i + 1];
    if (inStr) {
      out += c;
      if (c === "'" && d === "'") { out += sql[++i]; } else if (c === "'") { inStr = false; }
      continue;
    }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === "-" && d === "-") { while (i < sql.length && sql[i] !== "\n") { out += " "; i++; } out += "\n"; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) { out += sql[i] === "\n" ? "\n" : " "; i++; }
      i++; out += "  ";
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Index of the statement-terminating semicolon — the first one that is NOT
 * inside a quoted string.
 *
 * This was `rest.indexOf(";")` in both the script and this test until
 * 2026-08-12, and the duplication is the lesson: this file exists to check the
 * script with an independent implementation, but it had independently
 * reproduced the same bug, so the two agreed and the agreement proved nothing.
 * A description containing a semicolon — 0090:201 and 2068:5 both have one —
 * truncated the statement mid-VALUES, and 23 seeded flags, 8 of them read by
 * nothing, were invisible to rule R6 on both sides of the comparison.
 *
 * "Independent" has to mean independent of the FAILURE MODE, not just of the
 * source text.
 */
function statementEnd(sql: string): number {
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") inStr = !inStr;       // a doubled '' toggles off then on: still inside
    else if (c === ";" && !inStr) return i;
  }
  return sql.length;
}

/** Independently scan the migrations, mirroring the script's dedupe rule
 *  (first seeding of a name wins, files visited in sorted order). */
function independentScan(): { statements: number; flags: Set<string> } {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const flags = new Set<string>();
  let statements = 0;

  for (const f of files) {
    // Strip comments for the same reason the script does: a migration that
    // explains a seeding statement in its header would otherwise have its prose
    // counted as SQL. Written independently of the script's helper so the two
    // can disagree — an agreement produced by sharing one implementation would
    // prove nothing.
    const text = stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    for (const m of text.matchAll(BROAD_INSERT)) {
      statements++;
      const rest = text.slice(m.index);
      const stmt = rest.slice(0, statementEnd(rest));
      for (const row of stmt.matchAll(ROW_LITERAL)) flags.add(row[1]);
    }
  }
  return { statements, flags };
}

/** Run the check once, keeping stdout and exit status. */
let _run: { ok: boolean; out: string } | null = null;
function runCheck(): { ok: boolean; out: string } {
  if (_run) return _run;
  try {
    _run = { ok: true, out: execFileSync("node", [SCRIPT], { cwd: PKG_ROOT, encoding: "utf8" }) };
  } catch (e: any) {
    _run = { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
  return _run;
}

/** Pull the script's self-reported totals out of its summary line:
 *  "Seeded population: 139 flags seeded across 265 migrations (49 INSERT statements)"
 *  The summary is printed only on a clean run, which is why the exit-status test
 *  below runs first and explains the likely cause. */
function reportedTotals(): { statements: number; flags: number } {
  const { out } = runCheck();
  const m = out.match(/Seeded population:\s*(\d+)\s+flags seeded across\s+\d+\s+migrations\s*\((\d+)\s+INSERT statements\)/);
  assert.ok(
    m,
    "no seeded-population summary in check-flag-polarity's output — it is printed only when the check " +
      "passes, so the check is failing. Full output:\n" + out,
  );
  return { flags: Number(m![1]), statements: Number(m![2]) };
}

// Lazily memoized so a broken scan surfaces as a failing assertion inside an
// it() rather than as an exception at suite-construction time, which node:test
// reports as zero tests run — indistinguishable at a glance from a suite that
// was never wired up.
let _independent: ReturnType<typeof independentScan> | null = null;
const scan = () => (_independent ??= independentScan());

describe("check-flag-polarity seed scanner", () => {
  // Vacuity: a scan of nothing agrees with a scan of nothing.
  it("the independent scan has a subject", () => {
    const independent = scan();
    assert.ok(independent.statements > 0, "no INSERT INTO feature_flags found at all — the test's own matcher broke");
    assert.ok(independent.flags.size > 0, "no seeded flag names extracted — the row matcher broke");
  });

  it("check-flag-polarity itself passes", () => {
    const { ok, out } = runCheck();
    assert.ok(
      ok,
      "check-flag-polarity exited non-zero. If the failures are STALE INERT ENTRY lines naming the ten " +
        "flags below, the cause is the seed matcher having been re-narrowed: the entries describe flags " +
        "the scanner can no longer see, so the script correctly reports its own declarations as orphaned. " +
        "That is the fix from 2026-08-12 being undone.\n" + out,
    );
  });

  it("the two schema-qualified migrations are in scope", () => {
    // Named explicitly so that deleting or rewriting them is a visible event
    // rather than a silent shrink of what this test covers.
    for (const f of ["0051_compass_foundation.sql", "0062_notifications_schema.sql"]) {
      const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      assert.match(
        text,
        /INSERT\s+INTO\s+public\.feature_flags/i,
        `${f} no longer seeds via INSERT INTO public.feature_flags — if that is intended, this test's ` +
          "premise changed and the reasoning above needs revisiting",
      );
    }
  });

  it("the script counts every seeding statement the broad matcher finds", () => {
    assert.equal(
      reportedTotals().statements,
      scan().statements,
      "check-flag-polarity's seed scanner missed a seeding statement. The most likely cause is its " +
        "INSERT matcher being narrower than the SQL actually in the tree (this is exactly how " +
        "`INSERT INTO public.feature_flags` went unseen until 2026-08-12). A missed statement does not " +
        "make R6 fail — it makes R6 pass on a population it cannot see.",
    );
  });

  it("the script sees every seeded flag name the broad matcher finds", () => {
    assert.equal(
      reportedTotals().flags,
      scan().flags.size,
      "check-flag-polarity's seeded-flag population is smaller than an independent scan of the same " +
        "directory. Every name it cannot see is a flag R6 can never report as unread.",
    );
  });

  // The counts above are the general guard. This is the named one: the flags
  // that only a schema-qualified matcher can see. It caught a re-narrowing that
  // happens to be compensated elsewhere in the totals.
  //
  // These four are what REMAINS of the two `public.`-qualified seeding
  // statements after the 2026-08-12 wire-or-drop retirement removed the other
  // ten. All four have live readers, which is why they were kept — so this list
  // is also the assertion that the retirement did not take a wired flag with it.
  // RED-PROOF for the 2026-08-12 statement-terminator fix. The counts above are
  // a general guard and would go red for this too, but only while the tree
  // happens to contain a semicolon-bearing description. This test carries its
  // own fixture, so it keeps failing against the old `indexOf(";")` even if
  // every such description is later reworded away.
  it("a semicolon inside a description does not truncate the statement", () => {
    const fixture = `
      INSERT INTO feature_flags (flag, enabled, description) VALUES
        ('flag_before_the_semicolon', false, 'plain description'),
        ('flag_with_semicolon',       false, 'requires an invite; checked at signup'),
        ('flag_after_the_semicolon',  true,  'would be invisible to a naive scan')
      ON CONFLICT (flag) DO NOTHING;
    `;
    const stmt = fixture.slice(0, statementEnd(fixture));
    const found = [...stmt.matchAll(ROW_LITERAL)].map((m) => m[1]);

    assert.deepEqual(
      found,
      ["flag_before_the_semicolon", "flag_with_semicolon", "flag_after_the_semicolon"],
      "the statement was cut at the semicolon inside a description, so every row after it vanished. " +
        "That is the bug fixed on 2026-08-12: R6 cannot report a seeded flag it never saw, so the " +
        "check reports a clean population precisely because it is blind.",
    );

    // And the naive version must actually be wrong, or this test proves nothing.
    const naive = fixture.slice(0, fixture.indexOf(";"));
    assert.ok(
      [...naive.matchAll(ROW_LITERAL)].length < found.length,
      "the naive indexOf(';') scan found just as much, so this fixture no longer reproduces the bug " +
        "and the assertion above is vacuous",
    );
  });

  it("the schema-qualified seeds are in the population", () => {
    const qualifiedSeeds = [
      "COMPASS_ENABLED",
      "COMPASS_V1_RULE_BASED_ENABLED",
      "COMPASS_FALLBACK_MODE_ENABLED",
      "push_notifications_enabled",
    ];
    for (const flag of qualifiedSeeds) {
      assert.ok(
        scan().flags.has(flag),
        `${flag} is seeded by a \`public.\`-qualified INSERT and the scan cannot see it. Either the ` +
          "matcher was re-narrowed, or this flag was retired — and if it was retired, check that was " +
          "intended: all four of these have live readers.",
      );
    }
  });

  // The ten that were retired must stay gone from the seed. A migration that
  // re-adds one would restore an operator-visible toggle over nothing, which is
  // the exact defect 2080 removed.
  it("the retired flags are not seeded by anything", () => {
    const retired = [
      "COMPASS_FRONTLOAD_ENABLED",
      "COMPASS_ACTIVE_REWARD_ENABLED",
      "COMPASS_EXPLAIN_WHY_ENABLED",
      "COMPASS_ADMIN_CONTROLS_ENABLED",
      "COMPASS_ABUSE_DEFENSE_ENABLED",
      "COMPASS_NOTIFICATION_INTELLIGENCE_ENABLED",
      "notifications_enabled",
      "notification_digests_enabled",
      "realtime_activity_enabled",
      "safety_notifications_enabled",
    ];
    for (const flag of retired) {
      assert.ok(
        !scan().flags.has(flag),
        `${flag} was retired on 2026-08-12 by 2080_retire_inert_seeded_flags.sql and is seeded again. ` +
          "A fresh database would re-create a toggle that gates nothing. If it has since been WIRED, " +
          "that is fine — remove it from this list and say where the reader is.",
      );
    }
  });

  // Comment stripping is load-bearing: the retirement migrations explain
  // themselves at length and quote the statement shape they removed. Without
  // stripping, that prose is counted as SQL.
  it("prose in a migration header is not counted as a seeding statement", () => {
    const raw = readFileSync(join(MIGRATIONS_DIR, "2080_retire_inert_seeded_flags.sql"), "utf8");
    assert.match(
      raw,
      /--[^\n]*INSERT INTO public\.feature_flags/,
      "2080's header no longer mentions the statement shape in a comment — this test's subject is gone",
    );
    const stripped = stripComments(raw);
    assert.equal(
      (stripped.match(BROAD_INSERT) ?? []).length,
      0,
      "2080 seeds nothing; every match in it is prose. If this counts above zero, comment stripping broke " +
        "and the reported seeded-statement total is inflated.",
    );
  });
});
