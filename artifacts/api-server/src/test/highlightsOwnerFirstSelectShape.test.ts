/**
 * highlightsOwnerFirstSelectShape.test.ts — the DB-FREE witness for
 * 3502_highlights_permanent_visibility_owner_first.sql.
 *
 * ── WHAT THIS PROVES THAT THE DATABASE TEST CANNOT ──────────────────────────
 * `src/test/db/highlightsPermanentOwnerFirst.db.test.ts` runs the real policies
 * against real rows, and it is the stronger evidence — but it needs a harness,
 * and it can only observe the database in front of it. This suite is the half
 * that can be checked on every `pnpm test` run with no credentials and no
 * server, and it asks two questions the database test cannot:
 *
 *   1. Does the migration's own transformation turn PRODUCTION's measured qual
 *      into PORTAVA-CI's measured qual, CHARACTER FOR CHARACTER? The constants
 *      are read out of the migration file itself, so this is a test of the
 *      committed SQL rather than of a transcription of it.
 *   2. Is the DEFECT real, and does the fix actually fix it — evaluated, not
 *      asserted? S5 below evaluates both quals under Kleene three-valued logic
 *      over the six-case truth table, and requires production's qual to FAIL
 *      three of the six while the rewritten qual passes all six.
 *
 * ── THE MEASUREMENTS THESE FIXTURES ARE ────────────────────────────────────
 * All four quals below were read with `SELECT qual FROM pg_policies` on
 * 2026-10-02, read-only:
 *
 *   PROD_*  ajrurzioarfkagpuxfnb (production) — `expires_at` is NOT NULL there,
 *           2975 is absent from `public.schema_migration_ledger` (0 of 469
 *           rows), and both SELECT policies are PERMISSIVE with 0 RESTRICTIVE
 *           policies on the table.
 *   CI_*    hwokxgbmezheskbzskfr (portava-ci) — `expires_at` is nullable, 2975
 *           is in the ledger, and `20260907024317` (PR #461's 2313, unmerged)
 *           is in `supabase_migrations.schema_migrations`.
 *
 * The same two production quals were reproduced CHARACTER FOR CHANGE-FREE by
 * `scripts/local-db/up.sh`'s baseline + chain replay, which is why a result on
 * that harness is evidence about production.
 *
 * ── RED BEFORE GREEN ───────────────────────────────────────────────────────
 * Measured 2026-10-02, 11 tests in this file:
 *
 *   the migration file absent                        1 pass, 10 FAIL
 *   the migration file as committed                 11 pass,  0 fail
 *   one character (a trailing space) deleted from
 *   highlights_select's `new_head` in the migration   9 pass,  2 FAIL (S3, S5)
 *
 * The first row is the honest red: every test but S6 reads the migration, and
 * `readFileSync` on a file that is not there throws. S6 passes there because it
 * tests the evaluator against itself and reads nothing. The third row is the
 * negative case that makes the second worth reporting — the suite is sensitive
 * to one character of the constant it is checking.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(
  __dir,
  "../migrations/3502_highlights_permanent_visibility_owner_first.sql",
);

// ── the four measured quals ──────────────────────────────────────────────────
const PROD_SELECT =
  "((deleted_at IS NULL) AND (expires_at > now()) AND ((owner_id = auth.uid()) OR ((NOT viewer_is_blocked(owner_id)) AND ((visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text])) OR ((visibility = 'circle_only'::text) AND (authz.in_accepted_circle(auth.uid(), owner_id) OR (EXISTS ( SELECT 1\n   FROM user_friendships\n  WHERE (((user_friendships.user_a = auth.uid()) AND (user_friendships.user_b = highlights.owner_id)) OR ((user_friendships.user_b = auth.uid()) AND (user_friendships.user_a = highlights.owner_id)))))))))))";

const CI_SELECT =
  "((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR (((expires_at IS NULL) OR (expires_at > now())) AND (NOT viewer_is_blocked(owner_id)) AND ((visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text])) OR ((visibility = 'circle_only'::text) AND (authz.in_accepted_circle(auth.uid(), owner_id) OR (EXISTS ( SELECT 1\n   FROM user_friendships\n  WHERE (((user_friendships.user_a = auth.uid()) AND (user_friendships.user_b = highlights.owner_id)) OR ((user_friendships.user_b = auth.uid()) AND (user_friendships.user_a = highlights.owner_id)))))))))))";

const PROD_ACTIVE =
  "((deleted_at IS NULL) AND (expires_at > now()) AND (NOT authz.is_blocked(auth.uid(), owner_id)) AND ((owner_id = auth.uid()) OR (visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text])) OR ((visibility = 'circle_only'::text) AND (EXISTS ( SELECT 1\n   FROM circle_memberships cm\n  WHERE ((cm.user_id = highlights.owner_id) AND (cm.other_id = auth.uid()))))) OR ((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))))";

const CI_ACTIVE =
  "((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR (((expires_at IS NULL) OR (expires_at > now())) AND (NOT authz.is_blocked(auth.uid(), owner_id)) AND ((visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text])) OR ((visibility = 'circle_only'::text) AND (EXISTS ( SELECT 1\n   FROM circle_memberships cm\n  WHERE ((cm.user_id = highlights.owner_id) AND (cm.other_id = auth.uid()))))) OR ((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))))))";

const TRIP_BRANCH =
  "((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))";
const TOP_EXPIRY = ") AND (expires_at > now()) AND ";
const NULL_ARM = "((expires_at IS NULL) OR (expires_at > now()))";
const OWNER_FIRST = "((deleted_at IS NULL) AND ((owner_id = auth.uid()) OR ";

interface PolicySpec {
  readonly name: string;
  readonly prod: string;
  readonly ci: string;
  readonly oldHead: string;
  readonly newHead: string;
  readonly tail: string;
  readonly wantTrip: boolean;
}

/**
 * Read the two VALUES rows of the migration's own rewrite loop. The heads are
 * dollar-quoted with the `$oh$` / `$nh$` tags and the tail is an ordinary
 * literal, in a fixed order per row; parsing them (rather than restating them)
 * is what makes this a test OF the migration.
 */
function readSpecs(): PolicySpec[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const heads = [...sql.matchAll(/\$oh\$([\s\S]*?)\$oh\$,\s*\n\s*\$nh\$([\s\S]*?)\$nh\$,\s*\n\s*('(?:[^']*)'|'')::text,\s*\n\s*(true|false)/g)];
  assert.equal(
    heads.length,
    2,
    `expected exactly 2 (old_head, new_head, tail, want_trip) rows in ${MIGRATION}, found ${heads.length}. The migration owns two SELECT policies and no more.`,
  );
  const order: Array<{ name: string; prod: string; ci: string }> = [
    { name: "highlights_select", prod: PROD_SELECT, ci: CI_SELECT },
    { name: "highlights_select_active", prod: PROD_ACTIVE, ci: CI_ACTIVE },
  ];
  return heads.map((m, i) => ({
    name: order[i]!.name,
    prod: order[i]!.prod,
    ci: order[i]!.ci,
    oldHead: m[1]!,
    newHead: m[2]!,
    tail: m[3]!.slice(1, -1),
    wantTrip: m[4] === "true",
  }));
}

// ── a bounded Kleene three-valued evaluator ─────────────────────────────────
//
// It does NOT parse SQL. It MASKS the atoms this policy family is made of —
// each one declared below as the exact text it has in the measured quals — and
// then refuses to evaluate anything that is left over. A qual carrying a
// predicate this table does not name fails `maskAtoms` rather than being
// silently treated as `true`, which is the one way an evaluator like this could
// report a pass having understood nothing.
type Kleene = true | false | null;

const ATOMS: ReadonlyArray<readonly [string, string]> = [
  ["D", "(deleted_at IS NULL)"],
  ["N", "(expires_at IS NULL)"],
  ["E", "(expires_at > now())"],
  ["O", "(owner_id = auth.uid())"],
  ["B", "(NOT viewer_is_blocked(owner_id))"],
  ["K", "(NOT authz.is_blocked(auth.uid(), owner_id))"],
  ["P", "(visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text]))"],
  // The whole circle branch, both spellings, as ONE atom: this suite is about
  // expiry and owner ordering, and the circle predicate is carried unchanged.
  [
    "C",
    "((visibility = 'circle_only'::text) AND (authz.in_accepted_circle(auth.uid(), owner_id) OR (EXISTS ( SELECT 1\n   FROM user_friendships\n  WHERE (((user_friendships.user_a = auth.uid()) AND (user_friendships.user_b = highlights.owner_id)) OR ((user_friendships.user_b = auth.uid()) AND (user_friendships.user_a = highlights.owner_id)))))))",
  ],
  [
    "C",
    "((visibility = 'circle_only'::text) AND (EXISTS ( SELECT 1\n   FROM circle_memberships cm\n  WHERE ((cm.user_id = highlights.owner_id) AND (cm.other_id = auth.uid())))))",
  ],
  ["T", TRIP_BRANCH],
];

const ATOM_SYMBOLS = [...new Set(ATOMS.map(([sym]) => sym))].join("");

function maskAtoms(qual: string): string {
  let s = qual;
  for (const [sym, text] of ATOMS) s = s.split(text).join(sym);
  // AND / OR first (they contain the letters A, N, D, O, R, three of which are
  // atom symbols), then ONLY the symbols this table declares. Anything else
  // left standing is a predicate the evaluator has not accounted for.
  const leftover = s
    .replace(/\bAND\b|\bOR\b/g, "")
    .replace(new RegExp(`[${ATOM_SYMBOLS}()\\s]`, "g"), "");
  assert.equal(
    leftover,
    "",
    `the evaluator does not account for every predicate in this qual — leftover: ${JSON.stringify(leftover)}. Treating an unknown predicate as true would make every verdict below meaningless, so this fails instead. Masked form: ${s}`,
  );
  return s;
}

/** Kleene AND / OR / recursive-descent over `(`, `)`, AND, OR and atom letters. */
function evaluate(masked: string, env: Readonly<Record<string, Kleene>>): Kleene {
  const toks = masked.match(/\(|\)|AND|OR|[A-Z]/g) ?? [];
  let i = 0;
  const and = (a: Kleene, b: Kleene): Kleene =>
    a === false || b === false ? false : a === null || b === null ? null : true;
  const or = (a: Kleene, b: Kleene): Kleene =>
    a === true || b === true ? true : a === null || b === null ? null : false;

  function expr(): Kleene {
    let acc = term();
    while (i < toks.length && toks[i] === "OR") {
      i++;
      acc = or(acc, term());
    }
    return acc;
  }
  function term(): Kleene {
    let acc = factor();
    while (i < toks.length && toks[i] === "AND") {
      i++;
      acc = and(acc, factor());
    }
    return acc;
  }
  function factor(): Kleene {
    const t = toks[i];
    assert.ok(t !== undefined, `truncated expression in ${masked}`);
    if (t === "(") {
      i++;
      const v = expr();
      assert.equal(toks[i], ")", `unbalanced parentheses in ${masked}`);
      i++;
      return v;
    }
    // `AND` and `OR` are matched as whole tokens ahead of `[A-Z]` by the
    // tokenizer, so a bare letter here is always an atom symbol.
    assert.ok(/^[A-Z]$/.test(t!), `unexpected token ${t} in ${masked}`);
    i++;
    assert.ok(t! in env, `atom ${t} has no binding in the scenario`);
    return env[t!]!;
  }

  const v = expr();
  assert.equal(i, toks.length, `trailing tokens in ${masked}`);
  return v;
}

/** PostgreSQL admits a row only when a PERMISSIVE policy's USING IS TRUE. */
const admits = (v: Kleene): boolean => v === true;

interface Scenario {
  readonly label: string;
  readonly env: Readonly<Record<string, Kleene>>;
  readonly want: boolean;
}

/**
 * The six cases. `E` is NULL exactly when `expires_at` is NULL, which is the
 * whole defect: `NULL > now()` is unknown, and unknown is not TRUE.
 */
const SCENARIOS: readonly Scenario[] = [
  // D=not deleted, N=expiry is null, E=unexpired, O=is owner,
  // B/K=not blocked, P=public, C=circle, T=trip crew
  { label: "owner + NULL expiry", want: true,
    env: { D: true, N: true, E: null, O: true, B: true, K: true, P: false, C: false, T: false } },
  { label: "owner + past expiry", want: true,
    env: { D: true, N: false, E: false, O: true, B: true, K: true, P: false, C: false, T: false } },
  { label: "non-owner + NULL expiry, public", want: true,
    env: { D: true, N: true, E: null, O: false, B: true, K: true, P: true, C: false, T: false } },
  { label: "non-owner + future expiry, public", want: true,
    env: { D: true, N: false, E: true, O: false, B: true, K: true, P: true, C: false, T: false } },
  { label: "non-owner + past expiry, public", want: false,
    env: { D: true, N: false, E: false, O: false, B: true, K: true, P: true, C: false, T: false } },
  { label: "blocked non-owner + future expiry, public", want: false,
    env: { D: true, N: false, E: true, O: false, B: false, K: false, P: true, C: false, T: false } },
];

describe("3502 — the owner-first / NULL-arm restructure of both highlights SELECT policies", () => {
  test("S1 the migration declares exactly the two SELECT policies it owns, with their role sets", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const specs = readSpecs();
    assert.deepEqual(
      specs.map((s) => s.name),
      ["highlights_select", "highlights_select_active"],
    );
    // Only highlights_select_active has a trip_only arm; 2033's header says why
    // highlights_select never did ("No trip_id in live schema").
    assert.deepEqual(specs.map((s) => s.wantTrip), [false, true]);
    assert.ok(
      sql.includes("'{public}'::name[]") && sql.includes("'{authenticated}'::name[]"),
      "the migration must re-emit each policy's measured role set rather than defaulting one of them",
    );
  });

  for (const [idx, name] of ["highlights_select", "highlights_select_active"].entries()) {
    test(`S2 ${name}: the declared head is an exact, unique prefix of production's measured qual`, () => {
      const spec = readSpecs()[idx]!;
      assert.ok(
        spec.prod.startsWith(spec.oldHead),
        `the declared old head is not a prefix of production's qual.\n  declared: ${JSON.stringify(spec.oldHead)}\n  live    : ${JSON.stringify(spec.prod.slice(0, spec.oldHead.length))}`,
      );
      assert.equal(
        spec.prod.split(spec.oldHead).length - 1,
        1,
        "the head must occur exactly once, or the replacement is ambiguous",
      );
    });

    test(`S3 ${name}: new_head || rest || tail reproduces portava-ci's stored qual CHARACTER FOR CHARACTER`, () => {
      const spec = readSpecs()[idx]!;
      const rest = spec.prod.slice(spec.oldHead.length);
      const out = spec.newHead + rest + spec.tail;
      assert.equal(
        out,
        spec.ci,
        `the rewrite does not reproduce the shape portava-ci already carries.\n  got  (${out.length}): ${JSON.stringify(out)}\n  want (${spec.ci.length}): ${JSON.stringify(spec.ci)}`,
      );
      // Minimality, stated the way the migration states it: masking the carried
      // remainder out of each side must leave exactly the declared scaffold,
      // which also proves `rest` occurs once on each side.
      assert.equal(spec.prod.split(rest).join("<rest>"), spec.oldHead + "<rest>");
      assert.equal(out.split(rest).join("<rest>"), spec.newHead + "<rest>" + spec.tail);
      // A rearrangement cannot change the parenthesis balance.
      const bal = (s: string) => s.split("(").length - s.split(")").length;
      assert.equal(bal(out), 0);
      assert.equal(bal(spec.prod), 0);
    });

    test(`S4 ${name}: the rewritten qual is owner-first, has a NULL arm, no top-level expiry, and no trip_members`, () => {
      const spec = readSpecs()[idx]!;
      const out = spec.newHead + spec.prod.slice(spec.oldHead.length) + spec.tail;
      assert.ok(out.startsWith(OWNER_FIRST), `owner disjunct is not first: ${out}`);
      assert.ok(!out.includes(TOP_EXPIRY), `a top-level expiry conjunct survives: ${out}`);
      assert.ok(out.includes(NULL_ARM), `the expiry test has no NULL arm: ${out}`);
      assert.ok(
        !out.includes("trip_members"),
        "2530 removed the trip_members self-join from this family (blocker-ledger.md:22, CLOSED) and nothing here may put it back",
      );
      assert.equal(
        out.split(TRIP_BRANCH).length - 1,
        spec.wantTrip ? 1 : 0,
        `the trip_only branch must appear exactly ${spec.wantTrip ? "once, as the authz.shares_accepted_trip call" : "never on this policy"}`,
      );
      // The early-return guard is an exact prefix test against this same
      // constant, so portava-ci's qual must satisfy it or the migration would
      // try to rewrite a policy that is already correct.
      assert.ok(
        spec.ci.startsWith(spec.newHead),
        "portava-ci's qual does not begin with the migration's own replacement head, so the per-policy early return would not fire there and the migration would not be a no-op on CI",
      );
    });

    test(`S5 ${name}: the six-case truth table — production FAILS it, the rewrite PASSES it`, () => {
      const spec = readSpecs()[idx]!;
      const out = spec.newHead + spec.prod.slice(spec.oldHead.length) + spec.tail;
      const before = maskAtoms(spec.prod);
      const after = maskAtoms(out);

      const wrongBefore: string[] = [];
      for (const s of SCENARIOS) {
        const got = admits(evaluate(after, s.env));
        assert.equal(
          got,
          s.want,
          `after the rewrite, case "${s.label}" admits=${got} and the contract says ${s.want}. masked=${after}`,
        );
        if (admits(evaluate(before, s.env)) !== s.want) wrongBefore.push(s.label);
      }

      // The negative case. Without this, S5 would pass just as happily against
      // a qual that was already correct, and would therefore be no evidence
      // that the migration fixes anything.
      assert.deepEqual(
        wrongBefore,
        [
          "owner + NULL expiry",
          "owner + past expiry",
          "non-owner + NULL expiry, public",
        ],
        "production's measured qual must get exactly these three cases wrong. If it gets none wrong, the defect this migration exists for is not in the fixture; if it gets more wrong, the fixture is not the qual that was measured.",
      );
    });
  }

  test("S6 the evaluator refuses a qual it does not fully understand", () => {
    // Prove the guard can fail: an unknown predicate must not be read as true.
    assert.throws(
      () => maskAtoms(PROD_ACTIVE.replace("(owner_id = auth.uid())", "(owner_id = some_helper())")),
      /does not account for every predicate/,
    );
  });

  test("S7 the migration carries its own prerequisite ordering and its idempotency guard", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    // The apply order cannot be expressed in the filename — every prefix below
    // 2975 is taken — so it has to be written down, and this is the assertion
    // that it stays written down.
    assert.ok(
      /PREREQUISITE FOR 2975/.test(sql) && /3502 BEFORE 2975/.test(sql),
      "the header must state that this migration is applied to production BEFORE 2975, because lexicographic replay order puts 2975 first and nothing else records the dependency",
    );
    assert.ok(
      /already owner-first with a NULL expiry arm/.test(sql),
      "the per-policy early return must be present: portava-ci already carries the target shape (2313, hand-applied) and this file must be a no-op there without erroring",
    );
    // The real-RLS evidence is NOT in the migration, and must not drift back
    // into it: a probe that undoes itself inside the migration's own
    // transaction can only do so by aborting a subtransaction, which is the
    // self-aborting shape migrationDeployability.test.ts forbids (a RAISE on a
    // path always reached rolls back the DDL batched with it while the
    // migration still reports success — how 2195 silently failed). So this
    // file writes no rows and assumes no role, and the probe lives in a test
    // that observes from a separate transaction.
    assert.ok(
      !/\bINSERT\s+INTO\b/i.test(sql) && !/SET\s+LOCAL\s+ROLE/i.test(sql),
      "3502 must stay policy-only: no row writes and no role switching, or it needs a self-aborting subtransaction to undo itself",
    );
    assert.ok(
      /highlightsPermanentOwnerFirst\.db\.test\.ts/.test(sql),
      "the header must name the DB regression test that carries the real-RLS evidence, so removing the in-migration probe does not quietly remove the evidence",
    );
    assert.ok(
      !/ALTER\s+TABLE/i.test(sql),
      "3502 is policy-only: it must not alter the table, and in particular must not do 2975's DROP NOT NULL",
    );
  });
});
