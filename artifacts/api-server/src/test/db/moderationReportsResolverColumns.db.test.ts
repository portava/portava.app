/**
 * moderationReportsResolverColumns — migration 3700 and its rollback, executed
 * against real PostgreSQL (verifier finding 6, lane L, 2026-10-06).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/moderationReportsResolverColumns.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE DEFECT: the baseline grants ALL on moderation_reports to anon and
 * authenticated, and two policies let a reporter SELECT their own report. RLS
 * picks rows, not columns, so the reporter's own client key could read
 * resolver_id (who reviewed it) and resolver_note (what the moderator wrote).
 * 3700 replaces the table-level SELECT with SELECT on the twelve other columns.
 *
 * PROPERTIES
 *   MR-0  3700 is in force on the replayed chain: no client role holds a
 *         table-level SELECT, every column is classified once, RLS is on.
 *   MR-1  the REPORTER, through RLS, reads their own report's twelve columns
 *         and is refused resolver_id and resolver_note — selected, filtered
 *         on, and through `*`. Non-vacuous: the same probe reads the granted
 *         columns, and the row really carries a resolver id and note.
 *   MR-2  the MODERATOR's path (service_role, as the admin API reads) reads
 *         both columns.
 *   MR-3  rows are unchanged: the reporter sees their own report and not a
 *         stranger's; a stranger sees neither.
 *   MR-4  THE DEFECT, reproduced under the rollback: with the table-level
 *         grant back, the reporter reads resolver_note. Then 3700 re-applies
 *         and its postcondition passes.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3700_moderation_reports_resolver_columns_withheld.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-06-3700-moderation-reports-resolver-columns-withheld-rollback.sql");

const GRANTED = [
  "id", "reporter_id", "subject_type", "subject_id", "subject_user_id", "category",
  "details", "status", "created_at", "resolved_at", "thread_id", "image_url",
].sort();
const WITHHELD = ["resolver_id", "resolver_note"].sort();
const NOTE = "internal: repeat reporter, see thread";

let REPORTER = "";
let MODERATOR = "";
let STRANGER = "";
let REPORT = "";
let OTHER_REPORT = "";

function asReporter(uid: string, sql: string) {
  return psql(
    `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${uid}', true);` +
      ` PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\n` +
      `SET LOCAL ROLE authenticated;\n${sql}`,
    { single: true },
  );
}

/** Per column, as the reporter: which are readable and which refused (one statement each). */
function probe(uid: string, filter = false): { readable: string[]; denied: string[] } {
  const stmt = filter
    ? `format('SELECT id FROM public.moderation_reports WHERE %I IS NOT NULL AND id = %L', c, '${REPORT}')`
    : `format('SELECT %I FROM public.moderation_reports WHERE id = %L', c, '${REPORT}')`;
  const r = asReporter(uid, `DO $probe$
     DECLARE c text; readable text[] := '{}'; denied text[] := '{}';
     BEGIN
       FOR c IN SELECT attname::text FROM pg_attribute
                 WHERE attrelid = 'public.moderation_reports'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum LOOP
         BEGIN
           EXECUTE ${stmt};
           readable := readable || c;
         EXCEPTION WHEN insufficient_privilege THEN
           denied := denied || c;
         END;
       END LOOP;
       PERFORM set_config('mr.readable', array_to_string(readable, ','), true);
       PERFORM set_config('mr.denied', array_to_string(denied, ','), true);
     END $probe$;
     SELECT 'R|' || current_setting('mr.readable');
     SELECT 'D|' || current_setting('mr.denied');`);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.split("\n");
  const pick = (tag: string) =>
    (out.find((l) => l.startsWith(tag)) ?? tag).slice(tag.length).split(",").filter((s) => s.length > 0).sort();
  return { readable: pick("R|"), denied: pick("D|") };
}

describe("3700: a reporter never reads who reviewed their report or the moderator's note", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  before(() => {
    REPORTER = seedUser("mr3700reporter");
    MODERATOR = seedUser("mr3700moderator");
    STRANGER = seedUser("mr3700stranger");
    REPORT = randomUUID();
    OTHER_REPORT = randomUUID();
    exec(`INSERT INTO public.moderation_reports (id, reporter_id, subject_type, subject_id, category, details, status, resolved_at, resolver_id, resolver_note)
            VALUES ('${REPORT}', '${REPORTER}', 'user', '${STRANGER}', 'harassment', 'reported words', 'actioned', now(), '${MODERATOR}', '${NOTE}'),
                   ('${OTHER_REPORT}', '${STRANGER}', 'user', '${REPORTER}', 'spam', 'other words', 'open', NULL, NULL, NULL);`);
  });

  after(() => {
    if (!REPORTER) return;
    exec(`DELETE FROM public.moderation_reports WHERE id IN ('${REPORT}', '${OTHER_REPORT}');`);
    for (const u of [REPORTER, MODERATOR, STRANGER]) if (u) deleteUser(u);
  });

  it("MR-0 — 3700 is in force: no table-level SELECT for a client role, every column classified, RLS on", () => {
    assert.deepEqual(
      rows(`SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
             WHERE c.oid = 'public.moderation_reports'::regclass
               AND ((a.grantee = 0) OR (a.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND a.privilege_type = 'SELECT'))`),
      [],
      "a table-level SELECT on moderation_reports makes every column readable again",
    );
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.moderation_reports'::regclass`), "t");
    const cols = rows<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'public.moderation_reports'::regclass AND attnum > 0 AND NOT attisdropped`,
    ).map((r) => r.attname).sort();
    assert.deepEqual(cols, [...GRANTED, ...WITHHELD].sort(), "every column of moderation_reports is classified, once");
  });

  it("MR-1 — the reporter reads their report's twelve columns and is refused resolver_id and resolver_note (selected, filtered, and through *)", () => {
    // CONTROL from outside the role under test: the row really carries both.
    assert.equal(scalar(`SELECT resolver_note FROM public.moderation_reports WHERE id = '${REPORT}'`), NOTE);
    assert.equal(scalar(`SELECT resolver_id::text FROM public.moderation_reports WHERE id = '${REPORT}'`), MODERATOR);

    const sel = probe(REPORTER);
    assert.deepEqual(sel.denied, WITHHELD);
    assert.deepEqual(sel.readable, GRANTED);
    const filt = probe(REPORTER, true);
    assert.deepEqual(filt.denied, WITHHELD, "a filter on a withheld column is an oracle and must be refused too");

    const star = asReporter(REPORTER, `SELECT * FROM public.moderation_reports WHERE id = '${REPORT}';`);
    assert.notEqual(star.status, 0, "select * must not hand the reporter the withheld columns");
    assert.match(star.stderr, /permission denied/);
    const named = asReporter(REPORTER, `SELECT status FROM public.moderation_reports WHERE id = '${REPORT}';`);
    assert.equal(named.status, 0, named.stderr);
    assert.match(named.stdout, /actioned/, "the reporter still learns their report's outcome");
  });

  it("MR-2 — the moderator's path (service_role, as the admin API reads) reads both columns", () => {
    const r = psql(`SET LOCAL ROLE service_role;\nSELECT resolver_id::text || '|' || resolver_note FROM public.moderation_reports WHERE id = '${REPORT}';`, { single: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`${MODERATOR}\\|${NOTE}`));
  });

  it("MR-3 — rows are unchanged: the reporter sees their own report and not another's; a stranger sees only theirs", () => {
    const mine = asReporter(REPORTER, `SELECT id FROM public.moderation_reports WHERE id IN ('${REPORT}', '${OTHER_REPORT}') ORDER BY id;`);
    assert.equal(mine.status, 0, mine.stderr);
    assert.match(mine.stdout, new RegExp(REPORT));
    assert.doesNotMatch(mine.stdout, new RegExp(OTHER_REPORT));
    const theirs = asReporter(STRANGER, `SELECT id FROM public.moderation_reports WHERE id IN ('${REPORT}', '${OTHER_REPORT}') ORDER BY id;`);
    assert.equal(theirs.status, 0, theirs.stderr);
    assert.doesNotMatch(theirs.stdout, new RegExp(REPORT));
  });

  it("MR-4 — under the rollback the reporter reads the moderator's note (the defect); 3700 re-applied closes it and its postcondition passes", () => {
    const rb = psql(readFileSync(ROLLBACK, "utf8"));
    assert.equal(rb.status, 0, rb.stderr);
    try {
      const leak = asReporter(REPORTER, `SELECT resolver_note FROM public.moderation_reports WHERE id = '${REPORT}';`);
      assert.equal(leak.status, 0, leak.stderr);
      assert.match(leak.stdout, new RegExp(NOTE), "the rollback should restore the reporter's read — the defect 3700 closes");
    } finally {
      const re = psql(readFileSync(MIGRATION, "utf8"));
      assert.equal(re.status, 0, re.stderr);
    }
    const closed = asReporter(REPORTER, `SELECT resolver_note FROM public.moderation_reports WHERE id = '${REPORT}';`);
    assert.notEqual(closed.status, 0);
    assert.match(closed.stderr, /permission denied/);
  });
});
