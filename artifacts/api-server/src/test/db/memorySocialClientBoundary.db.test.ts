/**
 * memorySocialClientBoundary — lane MEM-ACL-2 (follow-up to 3813 / PR #726,
 * census-highlights-memories §BL): migration 3814 and its rollback, executed
 * against real PostgreSQL on the chain CI's local-db job replays.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/memorySocialClientBoundary.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every
 *      src/test/db suite; scripts/local-db/run-tests.sh refuses a skipped run.
 *      NOT RUN ON A POSTGRESQL SERVER ON THE AUTHORING MACHINE, which has none:
 *      the same properties were executed there through a psql stand-in over
 *      PGlite (PostgreSQL 16.4) on a fixture of the touched objects, red without
 *      3814 and green with it (lane report).
 *
 * THE DEFECT: the baseline's GRANT ALL on memory_saves, memory_likes,
 * memory_tags and memory_items to anon and authenticated, under policies that
 * decide rows only. Through PostgREST — `SET LOCAL ROLE` plus the JWT GUCs
 * auth.uid() reads, as in memoriesClientBoundary / postsReleaseTimingColumns — a
 * signed-in user saved and liked any Memory id (a private or removed one
 * included), learned from the foreign key whether an id exists, re-pointed their
 * own tag row at another Memory, read who liked a public Memory, and an owner
 * wrote tags and photos past the API's checks.
 *
 * PROPERTIES
 *   S0  3814 is in force on all four: no client or PUBLIC ACL entry, table or
 *       column; no effective privilege; service_role keeps its four DML verbs;
 *       RLS and every policy unchanged.
 *   S1  saves: a stranger cannot save a private, a removed or a public Memory,
 *       or a missing id — and an existing-private id and a missing one get the
 *       SAME refusal (no existence oracle). anon likewise. Nothing was written.
 *   S2  likes: the same, plus the likers read of a public Memory is refused.
 *   S3  tags: the tagged person cannot re-point their row (with or without a
 *       WHERE), cannot probe an id through it, cannot self-approve; an owner
 *       cannot tag directly. The row is unchanged.
 *   S4  photos: an owner cannot insert another user's storage object, rewrite
 *       or delete a photo; a stranger and anon cannot read one.
 *   S5  the API's path: service_role does every read and write the routes do
 *       (like/save upsert, counts, lists, deletes; tag insert, status update,
 *       delete — 3674's trigger firing; photo insert … RETURNING, delete).
 *   S6  the postcondition passes alone on the committed database (certify stage
 *       4), and the precondition accepts this chain as it is (its function,
 *       trigger, view and policy checks find nothing real to refuse).
 *   S7  the rollback restores exactly SELECT, INSERT, UPDATE, DELETE for both
 *       client roles on the four and nothing more, clears the ledger row and
 *       re-opens a door; 3814 re-applied reproduces today's catalog; the
 *       database is left as found.
 *   S8  the precondition refuses what it says it refuses and accepts a definer
 *       function and the rollback's state.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.js";
import { isAssertionOnlyDoBlock, isPreconditionDoBlock, topLevelStatements } from "../../scripts/lib/migrationSqlBlocks.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3814_memory_social_client_privileges_revoked.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-14-3814-memory-social-client-privileges-revoked-rollback.sql");
const TABLES = ["memory_saves", "memory_likes", "memory_tags", "memory_items"] as const;

type Who = { role: "anon" } | { role: "authenticated"; uid: string };

let A = ""; // an owner
let S = ""; // a signed-in stranger, tagged on X's Memory
let X = ""; // a friend who owns FR and liked PUB
let PUB = ""; // A's published, public Memory
let PRIV = ""; // A's published only_me Memory
let RMV = ""; // A's Memory a moderator removed
let FR = ""; // X's friends_only Memory S is tagged on (pending)
let SOWN = ""; // S's own public Memory
let ITEM = ""; // a photo on PUB

function prelude(who: Who): string {
  if (who.role === "anon") {
    return `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`;
  }
  return (
    `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${who.uid}', true);` +
    ` PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\n` +
    `SET LOCAL ROLE authenticated;\n`
  );
}
/** The refusal, verbatim: one line of stderr naming the table, so two refusals can be compared. */
function refusal(who: Who, sql: string): string {
  const r = psql(prelude(who) + sql, { single: true });
  assert.notEqual(r.status, 0, `expected a refusal as ${who.role}, got success:\n${sql}\n${r.stdout}`);
  const line = r.stderr.split("\n").find((l) => /ERROR:/.test(l)) ?? r.stderr;
  return line.replace(/^psql:[^:]*:\d+:\s*/, "").trim();
}
function assertDenied(who: Who, sql: string, table: string): void {
  const line = refusal(who, sql);
  assert.match(line, new RegExp(`permission denied for table ${table}\\b`), `expected a privilege refusal on ${table} as ${who.role}:\n${sql}\n${line}`);
}
const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });

function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}
const postconditions = (path: string) =>
  topLevelStatements(readFileSync(path, "utf8")).filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
function precondition(path: string): string {
  const pre = topLevelStatements(readFileSync(path, "utf8")).filter((s) => isPreconditionDoBlock(s));
  assert.equal(pre.length, 1);
  return pre[0]!;
}

const LIST = TABLES.map((t) => `'${t}'`).join(", ");
/** The four tables' ACLs (sorted aclexplode tuples), column ACLs, policies and RLS. */
const SNAPSHOT = `SELECT json_build_object(
  'relacl', (SELECT json_agg(e ORDER BY e) FROM (
               SELECT c.relname || ' ' || format('%s=%s/%s%s', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END,
                             x.privilege_type, x.grantor::regrole::text, CASE WHEN x.is_grantable THEN '*' ELSE '' END) AS e
                 FROM pg_class c, LATERAL aclexplode(c.relacl) x
                WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${LIST})) q),
  'attacl', (SELECT json_agg(c.relname || '.' || a.attname || '=' || a.attacl::text ORDER BY c.relname, a.attnum)
               FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
              WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${LIST}) AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL),
  'policies', (SELECT json_agg(json_build_array(c.relname, p.polname, p.polcmd::text, pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) ORDER BY c.relname, p.polname)
                 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${LIST})),
  'rls', (SELECT json_agg(c.relname || '=' || c.relrowsecurity::text ORDER BY c.relname) FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${LIST}))
)::text;`;
type Snap = { relacl: string[] | null; attacl: string[] | null; policies: unknown; rls: string[] };
const snaps = (out: string[]) => out.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Snap);
const clientEntries = (snap: Snap) => (snap.relacl ?? []).filter((e) => / (anon|authenticated|PUBLIC)=/.test(e)).sort();

describe("MEM-ACL-2 — 3814: memory_saves, memory_likes, memory_tags and memory_items refuse every client role", { skip: !HAVE_DB }, () => {
  before(() => {
    A = seedUser("memacl2_owner");
    S = seedUser("memacl2_stranger");
    X = seedUser("memacl2_friend");
    [PUB, PRIV, RMV, FR, SOWN, ITEM] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    exec(`INSERT INTO public.memories (id, owner_id, title, visibility, state) VALUES
            ('${PUB}', '${A}', 'memacl2 public', 'public', 'published'),
            ('${PRIV}', '${A}', 'memacl2 private', 'only_me', 'published'),
            ('${RMV}', '${A}', 'memacl2 removed', 'public', 'removed'),
            ('${FR}', '${X}', 'memacl2 friends', 'friends_only', 'published'),
            ('${SOWN}', '${S}', 'memacl2 own', 'public', 'published');
          INSERT INTO public.memory_items (id, memory_id, media_url) VALUES ('${ITEM}', '${PUB}', 'https://example.test/memacl2.jpg');
          INSERT INTO public.memory_likes (memory_id, user_id) VALUES ('${PUB}', '${X}');
          INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES ('${FR}', '${S}', 'pending');`);
  });

  after(() => {
    if (!A) return;
    exec(`DELETE FROM public.memories WHERE owner_id IN ('${A}', '${S}', '${X}');`);
    for (const u of [A, S, X]) if (u) deleteUser(u);
  });

  const stranger = (): Who => ({ role: "authenticated", uid: S });
  const owner = (): Who => ({ role: "authenticated", uid: A });
  const anon: Who = { role: "anon" };

  it("S0 — 3814 is in force on all four: no client or PUBLIC privilege, table or column, effective or written; service_role keeps its DML; RLS and policies unchanged", () => {
    const snap = JSON.parse(exec(SNAPSHOT)[0]!) as Snap;
    assert.deepEqual(clientEntries(snap), []);
    assert.equal(
      scalar(`SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, LATERAL aclexplode(a.attacl) x
               WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${LIST}) AND a.attnum > 0 AND NOT a.attisdropped
                 AND a.attacl IS NOT NULL AND (x.grantee = 0 OR x.grantee IN ('anon'::regrole, 'authenticated'::regrole))`),
      "0",
    );
    for (const t of TABLES) {
      for (const r of ["anon", "authenticated"]) {
        for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          assert.equal(scalar(`SELECT has_table_privilege('${r}', 'public.${t}', '${p}')::text`), "false", `${t} ${r} ${p}`);
        }
        for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
          assert.equal(scalar(`SELECT has_any_column_privilege('${r}', 'public.${t}', '${p}')::text`), "false", `${t} ${r} column ${p}`);
        }
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(scalar(`SELECT has_table_privilege('service_role', 'public.${t}', '${p}')::text`), "true", `${t} service_role ${p}`);
      }
    }
    assert.deepEqual(snap.rls, TABLES.slice().sort().map((t) => `${t}=true`));
    assert.deepEqual(
      rows<{ n: string }>(`SELECT c.relname || '.' || p.polname AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                            WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${LIST}) ORDER BY 1`).map((r) => r.n),
      [
        "memory_items.memory_items_public_read", "memory_items.memory_items_via_memory",
        "memory_likes.memory_likes_own", "memory_likes.memory_likes_read",
        "memory_saves.memory_saves_own",
        "memory_tags.memory_tags_owner_delete", "memory_tags.memory_tags_owner_insert", "memory_tags.memory_tags_owner_read", "memory_tags.memory_tags_tagged_update",
      ],
    );
  });

  it("S1 — saves: no client saves any Memory id, and an existing private id answers exactly like a missing one", () => {
    for (const id of [PRIV, RMV, PUB, randomUUID()]) assertDenied(stranger(), `INSERT INTO public.memory_saves (memory_id, user_id) VALUES ('${id}', '${S}');`, "memory_saves");
    assert.equal(
      refusal(stranger(), `INSERT INTO public.memory_saves (memory_id, user_id) VALUES ('${PRIV}', '${S}');`),
      refusal(stranger(), `INSERT INTO public.memory_saves (memory_id, user_id) VALUES ('${randomUUID()}', '${S}');`),
      "an existing private Memory and a missing id must get the same answer",
    );
    assertDenied(stranger(), `SELECT memory_id FROM public.memory_saves WHERE user_id = '${S}';`, "memory_saves");
    assertDenied(stranger(), `DELETE FROM public.memory_saves;`, "memory_saves");
    assertDenied(anon, `SELECT count(*) FROM public.memory_saves;`, "memory_saves");
    assertDenied(anon, `INSERT INTO public.memory_saves (memory_id, user_id) VALUES ('${PUB}', '${S}');`, "memory_saves");
    assert.equal(scalar(`SELECT count(*) FROM public.memory_saves WHERE user_id = '${S}'`), "0", "nothing was written");
  });

  it("S2 — likes: no client likes any Memory id or reads the likers, and an existing removed id answers exactly like a missing one", () => {
    for (const id of [RMV, PRIV, PUB, randomUUID()]) assertDenied(stranger(), `INSERT INTO public.memory_likes (memory_id, user_id) VALUES ('${id}', '${S}');`, "memory_likes");
    assert.equal(
      refusal(stranger(), `INSERT INTO public.memory_likes (memory_id, user_id) VALUES ('${RMV}', '${S}');`),
      refusal(stranger(), `INSERT INTO public.memory_likes (memory_id, user_id) VALUES ('${randomUUID()}', '${S}');`),
    );
    assertDenied(stranger(), `INSERT INTO public.memory_likes (memory_id, user_id) VALUES ('${PUB}', '${S}') RETURNING memory_id;`, "memory_likes");
    assertDenied(stranger(), `SELECT user_id FROM public.memory_likes WHERE memory_id = '${PUB}';`, "memory_likes");
    assertDenied(stranger(), `DELETE FROM public.memory_likes;`, "memory_likes");
    assertDenied(anon, `SELECT count(*) FROM public.memory_likes;`, "memory_likes");
    assert.deepEqual(rows(`SELECT user_id::text AS u FROM public.memory_likes WHERE memory_id IN ('${PUB}', '${RMV}', '${PRIV}')`), [{ u: X }], "nothing was written");
  });

  it("S3 — tags: the tagged person cannot re-point, probe or self-approve their row; an owner cannot tag directly; the row is unchanged", () => {
    assertDenied(stranger(), `UPDATE public.memory_tags SET memory_id = '${PRIV}', status = 'approved';`, "memory_tags");
    assertDenied(stranger(), `UPDATE public.memory_tags SET memory_id = '${PRIV}' WHERE memory_id = '${FR}' AND tagged_user_id = '${S}';`, "memory_tags");
    assert.equal(
      refusal(stranger(), `UPDATE public.memory_tags SET memory_id = '${PRIV}';`),
      refusal(stranger(), `UPDATE public.memory_tags SET memory_id = '${randomUUID()}';`),
      "re-pointing at an existing private Memory and at a missing id must get the same answer",
    );
    assertDenied(stranger(), `UPDATE public.memory_tags SET status = 'approved' WHERE memory_id = '${FR}' AND tagged_user_id = '${S}';`, "memory_tags");
    assertDenied(stranger(), `INSERT INTO public.memory_tags (memory_id, tagged_user_id) VALUES ('${SOWN}', '${X}');`, "memory_tags");
    assertDenied(stranger(), `DELETE FROM public.memory_tags WHERE memory_id = '${FR}';`, "memory_tags");
    assertDenied(stranger(), `SELECT * FROM public.memory_tags;`, "memory_tags");
    assertDenied(anon, `SELECT count(*) FROM public.memory_tags;`, "memory_tags");
    assert.deepEqual(rows(`SELECT memory_id::text AS m, status FROM public.memory_tags WHERE tagged_user_id = '${S}'`), [{ m: FR, status: "pending" }]);
  });

  it("S4 — photos: an owner cannot attach another user's object, rewrite or delete a photo; a stranger and anon cannot read one", () => {
    assertDenied(owner(), `INSERT INTO public.memory_items (memory_id, media_url) VALUES ('${PUB}', 'https://x.supabase.co/storage/v1/object/public/post-media/${S}/p.jpg');`, "memory_items");
    assertDenied(owner(), `UPDATE public.memory_items SET media_url = 'https://evil.test/x.jpg';`, "memory_items");
    assertDenied(owner(), `DELETE FROM public.memory_items WHERE id = '${ITEM}';`, "memory_items");
    assertDenied(stranger(), `SELECT media_url FROM public.memory_items WHERE memory_id = '${PUB}';`, "memory_items");
    assertDenied(anon, `SELECT media_url FROM public.memory_items;`, "memory_items");
    assert.deepEqual(rows(`SELECT media_url FROM public.memory_items WHERE memory_id = '${PUB}'`), [{ media_url: "https://example.test/memacl2.jpg" }]);
  });

  it("S5 — the API's path is untouched: service_role does every read and write the routes do", () => {
    const out = asService(`
      INSERT INTO public.memory_likes (memory_id, user_id) VALUES ('${PUB}', '${S}') ON CONFLICT (memory_id, user_id) DO NOTHING;
      SELECT 'likes=' || count(*) FROM public.memory_likes WHERE memory_id = '${PUB}' AND user_id IN ('${S}', '${X}');
      DELETE FROM public.memory_likes WHERE memory_id = '${PUB}' AND user_id = '${S}';
      INSERT INTO public.memory_saves (memory_id, user_id) VALUES ('${PUB}', '${S}') ON CONFLICT (memory_id, user_id) DO NOTHING;
      SELECT 'saved=' || count(*) FROM public.memory_saves WHERE user_id = '${S}' AND memory_id = '${PUB}';
      DELETE FROM public.memory_saves WHERE memory_id = '${PUB}' AND user_id = '${S}';
      INSERT INTO public.memory_tags (memory_id, tagged_user_id, status) VALUES ('${PUB}', '${X}', 'pending');
      UPDATE public.memory_tags SET status = 'approved' WHERE memory_id = '${PUB}' AND tagged_user_id = '${X}' RETURNING 'tag=' || status;
      DELETE FROM public.memory_tags WHERE memory_id = '${PUB}' AND tagged_user_id = '${X}';
      INSERT INTO public.memory_items (memory_id, media_url, position) VALUES ('${PUB}', 'https://example.test/memacl2-b.jpg', 1) RETURNING 'item=' || media_url;
      SELECT 'items=' || count(*) FROM public.memory_items WHERE memory_id = '${PUB}' AND media_url = 'https://example.test/memacl2-b.jpg';
      DELETE FROM public.memory_items WHERE memory_id = '${PUB}' AND media_url = 'https://example.test/memacl2-b.jpg';
      SELECT 'items-after=' || count(*) FROM public.memory_items WHERE memory_id = '${PUB}' AND media_url = 'https://example.test/memacl2-b.jpg';`);
    assert.deepEqual(out, [`likes=2`, `saved=1`, `tag=approved`, `item=https://example.test/memacl2-b.jpg`, `items=1`, `items-after=0`]);
  });

  it("S6 — the postcondition passes alone; the precondition accepts this chain as it is", () => {
    const post = postconditions(MIGRATION);
    assert.equal(post.length, 1);
    exec(post[0]!);
    const r = psql(`BEGIN;\n${precondition(MIGRATION)}\nROLLBACK;`);
    assert.equal(r.status, 0, `the precondition refuses the chain as it is:\n${r.stderr}`);
  });

  it("S7 — the rollback restores exactly SELECT/INSERT/UPDATE/DELETE for both client roles and re-opens a door; 3814 re-applied is today's catalog", () => {
    const reopen = `SELECT set_config('request.jwt.claim.sub', '${S}', true);\nSET LOCAL ROLE authenticated;\n` +
      `INSERT INTO public.memory_saves (memory_id, user_id) VALUES ('${PRIV}', '${S}');\nSELECT 'reopened=' || count(*) FROM public.memory_saves WHERE user_id = '${S}';\nRESET ROLE;\n`;
    const out = exec(`BEGIN;\n${SNAPSHOT}\n${unwrapped(ROLLBACK)}\n${SNAPSHOT}\n${reopen}${unwrapped(MIGRATION)}\n${SNAPSHOT}\nROLLBACK;`);
    const [now, rolled, reapplied] = snaps(out);
    assert.ok(now && rolled && reapplied, "three snapshots");
    assert.ok(out.includes("reopened=1"), "anti-vacuity: under the rollback a stranger saves a private Memory again");
    const ownerOf = scalar(`SELECT relowner::regrole::text FROM pg_class WHERE oid = 'public.memory_saves'::regclass`);
    assert.deepEqual(
      clientEntries(rolled),
      TABLES.flatMap((t) => ["anon", "authenticated"].flatMap((r) => ["DELETE", "INSERT", "SELECT", "UPDATE"].map((p) => `${t} ${r}=${p}/${ownerOf}`))).sort(),
      "exactly SELECT, INSERT, UPDATE, DELETE for both client roles on the four — never TRUNCATE/REFERENCES/TRIGGER, never PUBLIC",
    );
    assert.deepEqual(rolled.policies, now.policies, "no policy changes");
    assert.deepEqual(rolled.rls, now.rls);
    assert.deepEqual(reapplied, now, "3814 after its rollback is the state 3814 left");
    assert.deepEqual(JSON.parse(exec(SNAPSHOT)[0]!), now, "the test left the database as it found it");
    const led = exec(`BEGIN;
      INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
        VALUES ('3814_memory_social_client_privileges_revoked.sql', 'test', 'manual', 'memorySocialClientBoundary.db.test.ts')
        ON CONFLICT (filename) DO NOTHING;
      SELECT 'ledger-before=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3814_memory_social_client_privileges_revoked.sql';
      ${unwrapped(ROLLBACK)}
      SELECT 'ledger-after=' || count(*) FROM public.schema_migration_ledger WHERE filename = '3814_memory_social_client_privileges_revoked.sql';
      ROLLBACK;`);
    assert.ok(led.includes("ledger-before=1"), "anti-vacuity: the ledger row is there before the rollback");
    assert.ok(led.includes("ledger-after=0"), "the rollback deletes 3814's ledger row");
  });

  it("S8 — the precondition refuses what it says it refuses, and accepts a definer function and the rollback's state", () => {
    const pre = precondition(MIGRATION);
    const tag = randomUUID().replace(/-/g, "").slice(0, 8);
    const refuse = (setup: string, why: RegExp) => {
      const r = psql(`BEGIN;\n${setup}\n${pre}\nROLLBACK;`);
      assert.notEqual(r.status, 0, `the precondition must refuse after: ${setup}`);
      assert.match(r.stderr, why);
    };
    const accept = (setup: string) => {
      const r = psql(`BEGIN;\n${setup}\n${pre}\nROLLBACK;`);
      assert.equal(r.status, 0, `the precondition must accept after: ${setup}\n${r.stderr}`);
    };
    refuse(`GRANT SELECT ON public.memory_likes TO authenticated WITH GRANT OPTION;`, /public\.memory_likes was granted by a role other than its owner, or with a grant option: authenticated:SELECT\+grant option/);
    refuse(
      `CREATE ROLE memacl2_g_${tag};\nGRANT SELECT ON public.memory_saves TO memacl2_g_${tag} WITH GRANT OPTION;\nSET LOCAL ROLE memacl2_g_${tag};\nGRANT SELECT (memory_id) ON public.memory_saves TO authenticated;\nRESET ROLE;`,
      new RegExp(`authenticated:SELECT by memacl2_g_${tag}`),
    );
    refuse(
      `CREATE VIEW public.memacl2_v_${tag} AS SELECT memory_id, user_id FROM public.memory_saves;\nGRANT SELECT ON public.memacl2_v_${tag} TO authenticated;`,
      // The local-db replica's default ACL hands anon the new view too, so the list may name both roles.
      new RegExp(`a view over public\\.memory_saves is readable by a client role: .*memacl2_v_${tag} \\((anon|authenticated)\\)`),
    );
    refuse(
      `CREATE FUNCTION public.memacl2_f_${tag}() RETURNS bigint LANGUAGE sql SECURITY INVOKER AS $f$ SELECT count(*) FROM public.memory_tags $f$;\nGRANT EXECUTE ON FUNCTION public.memacl2_f_${tag}() TO authenticated;`,
      new RegExp(`SECURITY INVOKER function a client role may call reads or writes public\\.memory_tags: .*memacl2_f_${tag}\\(\\)`),
    );
    refuse(
      `CREATE TABLE public.memacl2_t_${tag} (id int);\nGRANT INSERT ON public.memacl2_t_${tag} TO authenticated;\n` +
        `CREATE FUNCTION public.memacl2_tf_${tag}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM public.memory_likes WHERE user_id = auth.uid(); RETURN NEW; END $f$;\n` +
        `CREATE TRIGGER memacl2_tr_${tag} AFTER INSERT ON public.memacl2_t_${tag} FOR EACH ROW EXECUTE FUNCTION public.memacl2_tf_${tag}();`,
      new RegExp(`SECURITY INVOKER trigger reads or writes public\\.memory_likes and fires on a table a client role can write: memacl2_tr_${tag} ON .*memacl2_t_${tag}`),
    );
    refuse(
      `CREATE TABLE public.memacl2_p_${tag} (id uuid);\nALTER TABLE public.memacl2_p_${tag} ENABLE ROW LEVEL SECURITY;\nGRANT SELECT ON public.memacl2_p_${tag} TO authenticated;\n` +
        `CREATE POLICY memacl2_pp_${tag} ON public.memacl2_p_${tag} FOR SELECT USING (EXISTS (SELECT 1 FROM public.memory_items i WHERE i.memory_id = memacl2_p_${tag}.id));`,
      new RegExp(`a policy on a table a client role can use reads public\\.memory_items: .*memacl2_p_${tag}\\.memacl2_pp_${tag}`),
    );
    accept(`CREATE FUNCTION public.memacl2_d_${tag}() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $f$ SELECT count(*) FROM public.memory_likes $f$;\nGRANT EXECUTE ON FUNCTION public.memacl2_d_${tag}() TO authenticated;`);
    accept(unwrapped(ROLLBACK).replace(/DO \$post\$[\s\S]*END \$post\$;/, ""));
  });
});
