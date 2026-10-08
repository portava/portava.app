/**
 * moderationReportCapture — migration 3705 and its rollback, executed against
 * real PostgreSQL (lead rulings Q-L23 / D-38a and D-MODACTION-SHAPE, lane L,
 * 2026-10-08).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/moderationReportCapture.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * PROPERTIES
 *   MC-0  3705 is in force on the replayed chain: moderation_report_captures
 *         exists with RLS on and no policy; PUBLIC, anon and authenticated hold
 *         NO privilege on it; service_role reads and writes it; the flag is
 *         seeded FALSE; moderation_actions has report_id and no expires_at.
 *   MC-1  THE REPORTER cannot read the capture of their own report — selected
 *         or counted — while the same reporter still reads their report's
 *         status (3700's grant is untouched: the column set of
 *         moderation_reports is unchanged).
 *   MC-2  DELETED WITH THE REPORT: deleting the report deletes its capture, and
 *         the moderation action that named it keeps its row with report_id NULL.
 *   MC-3  the link is a real foreign key (an id naming no report is refused);
 *         capture_state and the snapshot's shape are constrained.
 *   MC-4  the rollback refuses while the flag is TRUE; off, it removes the table
 *         and the column, and 3705 re-applies with its postcondition passing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3705_moderation_report_capture_and_action_link.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-08-3705-moderation-report-capture-and-action-link-rollback.sql");

let REPORTER = "";
let AUTHOR = "";
let REPORT = "";
let ACTION = "";

function asReporter(uid: string, sql: string) {
  return psql(
    `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${uid}', true);` +
      ` PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\n` +
      `SET LOCAL ROLE authenticated;\n${sql}`,
    { single: true },
  );
}

describe("3705: the reported content is captured for moderators only, and goes with its report", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  before(() => {
    REPORTER = seedUser("mc3705reporter");
    AUTHOR = seedUser("mc3705author");
    REPORT = randomUUID();
    ACTION = randomUUID();
    exec(`INSERT INTO public.moderation_reports (id, reporter_id, subject_type, subject_id, subject_user_id, category, details, status)
            VALUES ('${REPORT}', '${REPORTER}', 'user', '${AUTHOR}', '${AUTHOR}', 'harassment', 'reported words', 'open');
          INSERT INTO public.moderation_report_captures (report_id, capture_state, snapshot)
            VALUES ('${REPORT}', 'ok', '{"name":"Author","handle":"author"}'::jsonb);
          INSERT INTO public.moderation_actions (id, target_user_id, action_type, reason, report_id, metadata)
            VALUES ('${ACTION}', '${AUTHOR}', 'report_actioned', 'confirmed', '${REPORT}', jsonb_build_object('report_id', '${REPORT}'));`);
  });

  after(() => {
    if (!REPORTER) return;
    exec(`DELETE FROM public.moderation_actions WHERE id = '${ACTION}';
          DELETE FROM public.moderation_reports WHERE id = '${REPORT}';`);
    for (const u of [REPORTER, AUTHOR]) if (u) deleteUser(u);
  });

  it("MC-0 — in force: RLS on, no policy, no client privilege, service_role reads and writes, flag FALSE, report_id and no expires_at", () => {
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.moderation_report_captures'::regclass`), "t");
    assert.equal(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.moderation_report_captures'::regclass`), "0");
    assert.deepEqual(
      rows(`SELECT a.privilege_type FROM pg_class c, LATERAL aclexplode(c.relacl) a
             WHERE c.oid = 'public.moderation_report_captures'::regclass
               AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole))`),
      [],
    );
    assert.equal(scalar(`SELECT has_table_privilege('service_role', 'public.moderation_report_captures', 'SELECT')
                            AND has_table_privilege('service_role', 'public.moderation_report_captures', 'INSERT')`), "t");
    assert.equal(scalar(`SELECT enabled FROM public.feature_flags WHERE flag = 'moderation_report_capture_enabled'`), "f");
    assert.equal(scalar(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.moderation_actions'::regclass AND attname = 'report_id' AND NOT attisdropped`), "1");
    assert.equal(scalar(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.moderation_actions'::regclass AND attname = 'expires_at' AND NOT attisdropped`), "0");
  });

  it("MC-1 — the reporter cannot read their own report's capture; they still read their report's status", () => {
    // CONTROL from outside the role under test: the capture is there.
    assert.equal(scalar(`SELECT capture_state FROM public.moderation_report_captures WHERE report_id = '${REPORT}'`), "ok");
    for (const sql of [
      `SELECT snapshot FROM public.moderation_report_captures WHERE report_id = '${REPORT}';`,
      `SELECT count(*) FROM public.moderation_report_captures;`,
    ]) {
      const r = asReporter(REPORTER, sql);
      assert.notEqual(r.status, 0, `${sql} was answered to the reporter`);
      assert.match(r.stderr, /permission denied/);
    }
    const own = asReporter(REPORTER, `SELECT status FROM public.moderation_reports WHERE id = '${REPORT}';`);
    assert.equal(own.status, 0, own.stderr);
    assert.match(own.stdout, /open/);
  });

  it("MC-2 — deleting the report deletes its capture; the action keeps its row with report_id NULL", () => {
    const tmpReport = randomUUID();
    const tmpAction = randomUUID();
    exec(`INSERT INTO public.moderation_reports (id, reporter_id, subject_type, subject_id, category, status)
            VALUES ('${tmpReport}', '${REPORTER}', 'user', '${AUTHOR}', 'spam', 'open');
          INSERT INTO public.moderation_report_captures (report_id, capture_state, snapshot) VALUES ('${tmpReport}', 'ok', '{}'::jsonb);
          INSERT INTO public.moderation_actions (id, target_user_id, action_type, report_id) VALUES ('${tmpAction}', '${AUTHOR}', 'report_dismissed', '${tmpReport}');`);
    try {
      exec(`DELETE FROM public.moderation_reports WHERE id = '${tmpReport}';`);
      assert.equal(scalar(`SELECT count(*) FROM public.moderation_report_captures WHERE report_id = '${tmpReport}'`), "0", "the capture outlived its report");
      assert.equal(scalar(`SELECT count(*) FROM public.moderation_actions WHERE id = '${tmpAction}'`), "1", "the audit row went with the report");
      assert.equal(scalar(`SELECT coalesce(report_id::text, 'null') FROM public.moderation_actions WHERE id = '${tmpAction}'`), "null");
    } finally {
      exec(`DELETE FROM public.moderation_actions WHERE id = '${tmpAction}';`);
    }
  });

  it("MC-3 — a real foreign key, a closed state vocabulary, an object snapshot", () => {
    const ghost = randomUUID();
    const fk = psql(`INSERT INTO public.moderation_actions (target_user_id, action_type, report_id) VALUES ('${AUTHOR}', 'warn', '${ghost}');`);
    assert.notEqual(fk.status, 0);
    assert.match(fk.stderr, /foreign key/);
    const state = psql(`UPDATE public.moderation_report_captures SET capture_state = 'maybe' WHERE report_id = '${REPORT}';`);
    assert.notEqual(state.status, 0);
    assert.match(state.stderr, /state_check/);
    const shape = psql(`UPDATE public.moderation_report_captures SET snapshot = '[1,2]'::jsonb WHERE report_id = '${REPORT}';`);
    assert.notEqual(shape.status, 0);
    assert.match(shape.stderr, /snapshot_object_check/);
  });

  it("MC-4 — the rollback refuses while the flag is TRUE; off, it removes both; 3705 re-applies and its postcondition passes", () => {
    exec(`UPDATE public.feature_flags SET enabled = TRUE WHERE flag = 'moderation_report_capture_enabled';`);
    try {
      const refused = psql(readFileSync(ROLLBACK, "utf8"));
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /ROLLBACK REFUSED \(3705\)/);
      assert.equal(scalar(`SELECT count(*) FROM pg_class WHERE oid = to_regclass('public.moderation_report_captures')`), "1");
    } finally {
      exec(`UPDATE public.feature_flags SET enabled = FALSE WHERE flag = 'moderation_report_capture_enabled';`);
    }
    // Clear this suite's rows that name the table/column, then roll back and re-apply.
    exec(`DELETE FROM public.moderation_actions WHERE id = '${ACTION}';`);
    const rb = psql(readFileSync(ROLLBACK, "utf8"));
    assert.equal(rb.status, 0, rb.stderr);
    try {
      assert.equal(scalar(`SELECT to_regclass('public.moderation_report_captures') IS NULL`), "t");
      assert.equal(scalar(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.moderation_actions'::regclass AND attname = 'report_id' AND NOT attisdropped`), "0");
    } finally {
      const re = psql(readFileSync(MIGRATION, "utf8"));
      assert.equal(re.status, 0, re.stderr); // its $post$ block raises on any failed postcondition
    }
  });
});
