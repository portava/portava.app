/**
 * postMediaModerationDesign3909 — migration 3909 (production's 2098 / D3 post_media moderation design, codified),
 * executed against real PostgreSQL (CI's postgis/postgis:16-3.4 service, scripts/local-db/up.sh).
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/postMediaModerationDesign3909.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every src/test/db suite;
 *      scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * THE STARTING SHAPES
 *   production / this harness   the baseline already carries every 2098 object, so 3909 must change nothing
 *                               but the harness's over-granted privileges (the dump's GRANTs are relative to
 *                               PostgreSQL's defaults, not Supabase's).
 *   portava-ci                  the chain from 0001: 0103's FOR ALL post_media_owner_write and none of 2098.
 *                               Rebuilt here inside a rolled-back transaction.
 *
 * PROPERTIES
 *   M0  on the replayed chain, 3909's own postconditions hold: every object's fingerprint equals production's.
 *   M1  re-running 3909's body on that shape is a strict no-op: no catalog row it could touch is rewritten.
 *   M2  on portava-ci's shape the body creates the ledger, the three functions, the trigger and the four
 *       policies, drops post_media_owner_write, and the same postconditions then hold.
 *   M3  the design works: a rejected verdict lands in the ledger and outlives the row's moderation_status; the
 *       owner can no longer attach that storage key, while a fresh key of theirs is admitted as pending.
 *   M4  post_media_path_is_moderated answers only about the caller's own keys, and anon cannot call it;
 *       no client role reads the ledger.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dir, "../../migrations");
const FILE = readFileSync(resolve(MIGRATIONS, "3909_post_media_moderation_design_codified.sql"), "utf8");
/** The applier's split: the body runs between the wrapper's BEGIN and COMMIT, the postconditions after it. */
const BODY = (() => {
  const b = FILE.indexOf("\nBEGIN;\n");
  const c = FILE.indexOf("\nCOMMIT;\n");
  assert.ok(b >= 0 && c > b, "3909 is BEGIN … COMMIT with a postcondition tail");
  return FILE.slice(b + "\nBEGIN;\n".length, c);
})();
const POSTCONDITIONS = FILE.slice(FILE.indexOf("\nCOMMIT;\n") + "\nCOMMIT;\n".length);
/** 0103's post_media_owner_write, verbatim, schema-qualified the way portava-ci resolved it. */
const OWNER_WRITE_0103 = (() => {
  const s = readFileSync(resolve(MIGRATIONS, "0103_post_media.sql"), "utf8");
  const start = s.indexOf('CREATE POLICY "post_media_owner_write"');
  const end = s.indexOf(");\n", s.indexOf("WITH CHECK", start));
  assert.ok(start >= 0 && end > start, "0103 still creates post_media_owner_write");
  return s.slice(start, end + 3).replace("ON post_media FOR ALL", "ON public.post_media FOR ALL").replace("FROM posts", "FROM public.posts");
})();

/** Every catalog row 3909 could create or rewrite, with its xmin: a rewrite changes xmin, a re-creation the oid. */
const CATALOG = `
  SELECT 'proc:' || proname || '@' || oid || '/' || xmin FROM pg_proc WHERE proname LIKE 'post\\_media\\_%'
  UNION ALL SELECT 'policy:' || polname || '@' || oid || '/' || xmin FROM pg_policy WHERE polrelid = 'public.post_media'::regclass
  UNION ALL SELECT 'trigger:' || tgname || '@' || oid || '/' || xmin FROM pg_trigger WHERE tgrelid = 'public.post_media'::regclass AND NOT tgisinternal
  UNION ALL SELECT 'class:' || relname || '@' || oid || '/' || xmin FROM pg_class WHERE relname IN ('post_media', 'post_media_moderation_ledger')
  UNION ALL SELECT 'comment:' || objoid || '/' || objsubid || '/' || xmin FROM pg_description
   WHERE objoid IN (SELECT oid FROM pg_proc WHERE proname LIKE 'post\\_media\\_%'
                    UNION ALL SELECT oid FROM pg_policy WHERE polrelid = 'public.post_media'::regclass
                    UNION ALL SELECT 'public.post_media_moderation_ledger'::regclass::oid)
  ORDER BY 1`;

const as = (uid: string | null) =>
  uid === null
    ? `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`
    : `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${uid}', true); PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\nSET LOCAL ROLE authenticated;\n`;

let OWNER = "";
let OTHER = "";
let POST = "";
let REJECTED_KEY = "";

describe("3909 — production's 2098 post_media moderation design, codified", { skip: !HAVE_DB }, () => {
  before(() => {
    OWNER = seedUser("m3909owner");
    OTHER = seedUser("m3909other");
    POST = randomUUID();
    REJECTED_KEY = `${OWNER}/m3909-rejected.jpg`;
    exec(`INSERT INTO public.posts (id, author_id, content, visibility, status) VALUES ('${POST}', '${OWNER}', 'm3909 post', 'public', 'active');`);
    // The server path: the service role inserts the row, then moderation rejects it.
    exec(`SET LOCAL ROLE service_role;
      INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path)
      VALUES ('${POST}', '${OWNER}', 'image', 'image/jpeg', '${REJECTED_KEY}');
      UPDATE public.post_media SET moderation_status = 'rejected' WHERE storage_path = '${REJECTED_KEY}';`, { single: true });
  });

  after(() => {
    if (!OWNER) return;
    exec(`DELETE FROM public.post_media WHERE user_id IN ('${OWNER}', '${OTHER}');
          DELETE FROM public.post_media_moderation_ledger WHERE subject_user_id IN ('${OWNER}', '${OTHER}');
          DELETE FROM public.posts WHERE author_id IN ('${OWNER}', '${OTHER}');`);
    for (const u of [OWNER, OTHER]) if (u) deleteUser(u);
  });

  it("M0 — on the replayed chain every 2098 object matches production's fingerprint", () => {
    exec(POSTCONDITIONS);
    assert.equal(scalar(`SELECT count(*) FROM pg_policy WHERE polrelid = 'public.post_media'::regclass AND polname = 'post_media_owner_write'`), "0");
  });

  it("M1 — on that shape, 3909's body rewrites no catalog row (a strict no-op, as on production)", () => {
    const out = exec(`BEGIN;\n${CATALOG};\nSELECT '---';\n${BODY}\n${CATALOG};\nROLLBACK;`);
    const sep = out.indexOf("---");
    assert.ok(sep > 0, out.join("\n"));
    const beforeRows = out.slice(0, sep);
    const afterRows = out.slice(sep + 1);
    assert.ok(beforeRows.length >= 12, `anti-vacuity: the snapshot read the objects (${beforeRows.length} rows)`);
    assert.deepEqual(afterRows, beforeRows, "no oid or xmin changed");
  });

  it("M2 — on portava-ci's shape the body creates 2098 and drops 0103's policy; the postconditions then hold", () => {
    const setup = `
      DROP POLICY post_media_owner_insert ON public.post_media;
      DROP POLICY post_media_owner_update ON public.post_media;
      DROP POLICY post_media_owner_delete ON public.post_media;
      DROP POLICY post_media_service_role_all ON public.post_media;
      DROP TRIGGER trg_post_media_record_moderation_verdict ON public.post_media;
      DROP FUNCTION public.post_media_record_moderation_verdict();
      DROP FUNCTION public.post_media_path_is_moderated(text, uuid);
      DROP FUNCTION public.post_media_path_is_owned(text, uuid);
      DROP TABLE public.post_media_moderation_ledger;
      ${OWNER_WRITE_0103}`;
    const policies = `SELECT 'policies=' || string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'public.post_media'::regclass;`;
    const out = exec(`BEGIN;\n${setup}\n${policies}\nSELECT 'ledger=' || coalesce(to_regclass('public.post_media_moderation_ledger')::text, 'absent');\n${BODY}\n${POSTCONDITIONS}\n${policies}\nROLLBACK;`);
    assert.deepEqual(out.filter((l) => l.startsWith("policies=") || l.startsWith("ledger=")), [
      "policies=post_media_owner_write,post_media_public_select",
      "ledger=absent",
      "policies=post_media_owner_delete,post_media_owner_insert,post_media_owner_update,post_media_public_select,post_media_service_role_all",
    ]);
  });

  it("M3 — a rejected key is in the ledger and cannot be re-attached; a fresh key is admitted as pending", () => {
    const ledger = rows<{ verdict: string; key_role: string; subject_user_id: string }>(
      `SELECT verdict, key_role, subject_user_id FROM public.post_media_moderation_ledger WHERE storage_path = '${REJECTED_KEY}'`);
    assert.deepEqual(ledger, [{ verdict: "rejected", key_role: "original", subject_user_id: OWNER }]);

    const insert = (key: string) =>
      psql(`BEGIN;\n${as(OWNER)}INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path)
            VALUES ('${POST}', '${OWNER}', 'image', 'image/jpeg', '${key}');\nROLLBACK;`);
    const again = insert(REJECTED_KEY);
    assert.notEqual(again.status, 0, "re-attaching a moderated key is refused");
    assert.match(again.stderr, /row-level security/);
    const fresh = insert(`${OWNER}/m3909-fresh.jpg`);
    assert.equal(fresh.status, 0, `a fresh key of the owner's own is admitted: ${fresh.stderr}`);
    const foreign = insert(`${OTHER}/m3909-not-mine.jpg`);
    assert.notEqual(foreign.status, 0, "a key under another user's prefix is refused");
    assert.match(foreign.stderr, /row-level security/);
  });

  it("M4 — post_media_path_is_moderated answers only about the caller's own keys; anon cannot call it; no client reads the ledger", () => {
    const ask = (who: string | null, owner: string) =>
      psql(`BEGIN;\n${as(who)}SELECT 'answer=' || public.post_media_path_is_moderated('${REJECTED_KEY}', '${owner}');\nROLLBACK;`);
    assert.match(ask(OWNER, OWNER).stdout, /answer=true/, "the owner learns their own key is moderated");
    assert.match(ask(OTHER, OWNER).stdout, /answer=false/, "another user asking about the owner's key learns nothing");
    const anon = ask(null, OWNER);
    assert.notEqual(anon.status, 0);
    assert.match(anon.stderr, /permission denied for function post_media_path_is_moderated/);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.post_media_moderation_ledger', 'SELECT')`), "f", `${role} reads no ledger`);
    }
  });
});
