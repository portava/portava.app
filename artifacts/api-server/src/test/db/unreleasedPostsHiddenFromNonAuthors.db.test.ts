/**
 * unreleasedPostsHiddenFromNonAuthors — migration 3925 (census-media §56.5, lead ruling 2026-10-24), executed
 * against real PostgreSQL (CI's postgis/postgis:16-3.4 service, scripts/local-db/up.sh) through the real policies,
 * column grants and authz helpers the chain installed.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/unreleasedPostsHiddenFromNonAuthors.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database, like every src/test/db suite;
 *      scripts/local-db/run-tests.sh refuses a skipped run.
 *
 * The server's one released predicate is lib/postVisibility.ts isPostPublished
 * (`!post_status || post_status === "published"`). Before 3925 the database API did not apply it: anyone the
 * permissive policies admitted read an unreleased post and its post_media rows through PostgREST.
 *
 * PROPERTIES
 *   C0  the two policies are RESTRICTIVE SELECT TO {anon, authenticated}; the posts one carries the released
 *       predicate, the post_media one defers to it (an EXISTS on posts that names no column a client role lacks).
 *   R0  RED BEFORE: with 3925's two policies dropped inside a rolled-back transaction, anon, a stranger and a friend
 *       read an unreleased post and its media.
 *   P1  posts: anon, a stranger, a friend (follower + accepted trip member) and the author, each against a released
 *       and an unreleased post of every audience — a non-author reads only released posts; the author reads all.
 *   P2  every non-published delayed_post_status label is unreleased; publishing a post makes it readable.
 *   M1  post_media: the same four readers — a non-author reads only a released post's rows; the author reads all,
 *       including a row on their unreleased post that another account uploaded.
 *   M2  the post_media policy bounds every permissive path: under a permissive post_media policy that admits every
 *       row, a non-author still reads no unreleased post's media; without 3925's post_media policy, they do.
 *   M3  the posts policy alone (post_media's dropped) still closes the media read today, through
 *       post_media_public_select's own EXISTS on posts.
 *   G0  every client read of post_media succeeds: no 3925 policy names a posts column anon/authenticated lack
 *       (a draft that named p.post_status failed every such read with "permission denied for table posts").
 *   S1  service_role (BYPASSRLS — every server path) reads every row.
 * Client roles hold no INSERT/UPDATE/DELETE grant on either table (column SELECT only), so no client write path exists
 * for 3925 to change.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, rows, scalar, seedUser, deleteUser } from "./localDb.js";

type Who = "anon" | "stranger" | "friend" | "author" | "uploader";

const U: Record<Exclude<Who, "anon">, string> = { stranger: "", friend: "", author: "", uploader: "" };
let TRIP = "";
/** posts, keyed by audience + released state */
const P = { pubRel: "", pubUnrel: "", folRel: "", folUnrel: "", tripRel: "", tripUnrel: "" };
/** post_media rows owned by the author, one per post (followers_only media is out of scope: no follower arm in
 *  post_media_public_select before or after 3925), plus one row another account uploaded to the author's post */
const M = { pubRel: "", pubUnrel: "", tripRel: "", tripUnrel: "", foreignOnUnrel: "" };

const DROP_POSTS = "DROP POLICY posts_select_released_or_author ON public.posts;";
const DROP_MEDIA = "DROP POLICY post_media_select_post_readable_or_owner ON public.post_media;";
/** a future permissive post_media policy that does not route through posts (e.g. one built on can_see_post) */
const OPEN_MEDIA = "CREATE POLICY t3925_open ON public.post_media FOR SELECT TO anon, authenticated USING (true);";

function as(who: Who): string {
  return who === "anon"
    ? `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.role', 'anon', true); END $p$;\nSET LOCAL ROLE anon;\n`
    : `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${U[who]}', true); PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\nSET LOCAL ROLE authenticated;\n`;
}

/** The ids of `ids` that `who` reads from `table`, as PostgREST's role would; `prelude` runs first, as the harness
 *  superuser, in the same rolled-back transaction. */
function visible(who: Who | "service_role", table: "posts" | "post_media", ids: string[], prelude = ""): Set<string> {
  const role = who === "service_role" ? "SET LOCAL ROLE service_role;\n" : as(who);
  const list = ids.map((i) => `'${i}'`).join(", ");
  const out = exec(`BEGIN;\n${prelude}\n${role}SELECT 'id=' || id FROM public.${table} WHERE id IN (${list});\nSELECT 'end=1';\nROLLBACK;`);
  assert.ok(out.includes("end=1"), out.join("\n"));
  return new Set(out.filter((l) => l.startsWith("id=")).map((l) => l.slice(3)));
}
const sees = (who: Who | "service_role", table: "posts" | "post_media", id: string, prelude = "") =>
  visible(who, table, [id], prelude).has(id);

describe("3925 — an unreleased post and its post_media are the author's alone on the database API", { skip: !HAVE_DB }, () => {
  before(() => {
    U.author = seedUser("u3925author");
    U.stranger = seedUser("u3925stranger");
    U.friend = seedUser("u3925friend");
    U.uploader = seedUser("u3925uploader");
    TRIP = randomUUID();
    for (const k of Object.keys(P) as (keyof typeof P)[]) P[k] = randomUUID();
    for (const k of Object.keys(M) as (keyof typeof M)[]) M[k] = randomUUID();
    const post = (id: string, visibility: string, status: string, trip = "NULL") =>
      `('${id}', '${U.author}', '3925 ${visibility} ${status}', '${visibility}', 'active', '${status}', ${trip})`;
    const media = (id: string, postId: string, owner: string) =>
      `('${id}', '${postId}', '${owner}', 'image', 'image/jpeg', '${owner}/3925-${id.slice(0, 8)}.jpg', 'ready', 'approved')`;
    exec([
      `INSERT INTO public.trips (id, owner_id, title, destination_city) VALUES ('${TRIP}', '${U.author}', '3925 trip', 'Da Nang');`,
      `INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${TRIP}', '${U.friend}', 'member', 'accepted') ON CONFLICT DO NOTHING;`,
      `INSERT INTO public.user_follows (follower_id, following_id) VALUES ('${U.friend}', '${U.author}') ON CONFLICT DO NOTHING;`,
      `INSERT INTO public.posts (id, author_id, content, visibility, status, post_status, trip_id) VALUES`,
      `  ${post(P.pubRel, "public", "published")},`,
      `  ${post(P.pubUnrel, "public", "pending_location_exit")},`,
      `  ${post(P.folRel, "followers_only", "published")},`,
      `  ${post(P.folUnrel, "followers_only", "pending_delay")},`,
      `  ${post(P.tripRel, "trip_only", "published", `'${TRIP}'`)},`,
      `  ${post(P.tripUnrel, "trip_only", "pending_safety_review", `'${TRIP}'`)};`,
    ].join("\n"));
    exec(`SET LOCAL ROLE service_role;
      INSERT INTO public.post_media (id, post_id, user_id, media_type, mime_type, storage_path, processing_status, moderation_status) VALUES
        ${media(M.pubRel, P.pubRel, U.author)},
        ${media(M.pubUnrel, P.pubUnrel, U.author)},
        ${media(M.tripRel, P.tripRel, U.author)},
        ${media(M.tripUnrel, P.tripUnrel, U.author)},
        ${media(M.foreignOnUnrel, P.pubUnrel, U.uploader)};`, { single: true });
  });

  after(() => {
    if (!U.author) return;
    const ids = Object.values(U).filter(Boolean).map((u) => `'${u}'`).join(", ");
    exec(`SET LOCAL ROLE service_role;
          DELETE FROM public.post_media WHERE post_id IN (SELECT id FROM public.posts WHERE author_id IN (${ids})) OR user_id IN (${ids});
          DELETE FROM public.posts WHERE author_id IN (${ids});
          DELETE FROM public.user_follows WHERE follower_id IN (${ids}) OR following_id IN (${ids});
          DELETE FROM public.trip_members WHERE trip_id = '${TRIP}';`, { single: true });
    for (const u of Object.values(U)) if (u) deleteUser(u);
  });

  it("C0 — both policies are RESTRICTIVE SELECT TO {anon, authenticated}; posts carries the released predicate, post_media defers to it", () => {
    const pol = rows<{ tablename: string; permissive: string; cmd: string; roles: string; qual: string }>(
      `SELECT tablename, permissive, cmd, array_to_string(roles, ',') AS roles, qual FROM pg_policies
        WHERE schemaname = 'public' AND policyname IN ('posts_select_released_or_author', 'post_media_select_post_readable_or_owner')
        ORDER BY tablename`);
    assert.deepEqual(pol.map((p) => p.tablename), ["post_media", "posts"]);
    for (const p of pol) {
      assert.equal(p.permissive, "RESTRICTIVE", p.tablename);
      assert.equal(p.cmd, "SELECT", p.tablename);
      assert.deepEqual(p.roles.split(",").sort(), ["anon", "authenticated"], p.tablename);
    }
    const [media, posts] = pol;
    assert.match(posts!.qual, /author_id = \( SELECT auth\.uid\(\)/);
    assert.match(posts!.qual, /post_status IS NULL/);
    assert.match(posts!.qual, /post_status = 'published'::delayed_post_status/);
    assert.match(media!.qual, /user_id = \( SELECT auth\.uid\(\)/);
    assert.match(media!.qual, /EXISTS \( SELECT 1\s+FROM posts p\s+WHERE \(p\.id = post_media\.post_id\)\)/);
  });

  it("G0 — every client read of post_media plans and runs (no 3925 policy names an ungranted posts column)", () => {
    const granted = new Set((scalar(`SELECT string_agg(column_name, ',') FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND table_name = 'posts' AND grantee = 'anon' AND privilege_type = 'SELECT'`) ?? "").split(","));
    assert.ok(granted.has("id") && !granted.has("post_status"), "the grant shape this suite guards: id granted, post_status not");
    for (const who of ["anon", "stranger", "author"] as const) {
      assert.ok(visible(who, "post_media", Object.values(M)).size >= 1, `${who}'s read of post_media ran`);
    }
  });

  it("R0 — RED BEFORE: without 3925's policies anon, a stranger and a friend read the unreleased post and its media", () => {
    const before = `${DROP_POSTS}\n${DROP_MEDIA}`;
    for (const who of ["anon", "stranger", "friend"] as const) {
      assert.equal(sees(who, "posts", P.pubUnrel, before), true, `${who} read the unreleased public post before 3925`);
      assert.equal(sees(who, "post_media", M.pubUnrel, before), true, `${who} read its media before 3925`);
    }
    assert.equal(sees("friend", "posts", P.folUnrel, before), true, "the follower read the unreleased followers-only post");
    assert.equal(sees("friend", "posts", P.tripUnrel, before), true, "the crew member read the unreleased trip post");
    assert.equal(sees("friend", "post_media", M.tripUnrel, before), true, "and its media");
  });

  it("P1 — posts: a non-author reads only released posts; the author reads every one", () => {
    const all = Object.values(P);
    const expect: Record<Who, string[]> = {
      anon: [P.pubRel],
      stranger: [P.pubRel],
      friend: [P.pubRel, P.folRel, P.tripRel],
      author: all,
      uploader: [P.pubRel],
    };
    for (const who of Object.keys(expect) as Who[]) {
      assert.deepEqual([...visible(who, "posts", all)].sort(), [...expect[who]].sort(), who);
    }
  });

  it("P2 — every non-published label is unreleased, and publishing releases the post", () => {
    const labels = (scalar(`SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'public.delayed_post_status'::regtype`) ?? "").split(",");
    assert.ok(labels.includes("published") && labels.length >= 3, `anti-vacuity: ${labels.join(",")}`);
    for (const label of labels) {
      const set = `UPDATE public.posts SET post_status = '${label}' WHERE id = '${P.pubRel}';`;
      const released = label === "published";
      for (const who of ["anon", "stranger", "friend"] as const) {
        assert.equal(sees(who, "posts", P.pubRel, set), released, `${who} on a '${label}' post`);
        assert.equal(sees(who, "post_media", M.pubRel, set), released, `${who} on a '${label}' post's media`);
      }
      assert.equal(sees("author", "posts", P.pubRel, set), true, `the author on their '${label}' post`);
      assert.equal(sees("author", "post_media", M.pubRel, set), true, `the author on their '${label}' post's media`);
    }
  });

  it("M1 — post_media: a non-author reads only a released post's rows; the author reads all of theirs", () => {
    const all = Object.values(M);
    const expect: Record<Who, string[]> = {
      anon: [M.pubRel],
      stranger: [M.pubRel],
      friend: [M.pubRel, M.tripRel],
      author: all,
      // the uploader owns the row they uploaded (owner arm); they read no other unreleased row
      uploader: [M.pubRel, M.foreignOnUnrel],
    };
    for (const who of Object.keys(expect) as Who[]) {
      assert.deepEqual([...visible(who, "post_media", all)].sort(), [...expect[who]].sort(), who);
    }
  });

  it("M2 — the post_media policy bounds a permissive policy that does not route through posts", () => {
    for (const who of ["anon", "stranger", "friend"] as const) {
      for (const id of [M.pubUnrel, M.tripUnrel, M.foreignOnUnrel]) {
        assert.equal(sees(who, "post_media", id, OPEN_MEDIA), false, `${who}, ${id === M.pubUnrel ? "public" : id === M.tripUnrel ? "trip" : "foreign row"}`);
        assert.equal(sees(who, "post_media", id, `${OPEN_MEDIA}\n${DROP_MEDIA}`), true, `anti-vacuity: without 3925's post_media policy ${who} reads it`);
      }
      assert.equal(sees(who, "post_media", M.pubRel, OPEN_MEDIA), true, `${who} reads released media`);
    }
    assert.equal(sees("author", "post_media", M.foreignOnUnrel, OPEN_MEDIA), true, "the author reads a row another account uploaded to their unreleased post");
    assert.equal(sees("uploader", "post_media", M.foreignOnUnrel, OPEN_MEDIA), true, "the uploader reads the row they own");
    assert.equal(sees("uploader", "post_media", M.pubUnrel, OPEN_MEDIA), false, "and no other row of that unreleased post");
  });

  it("M3 — today the posts policy alone also closes the media read (post_media_public_select's EXISTS)", () => {
    for (const who of ["anon", "stranger", "friend"] as const) {
      assert.equal(sees(who, "post_media", M.pubUnrel, DROP_MEDIA), false, who);
      assert.equal(sees(who, "post_media", M.tripUnrel, DROP_MEDIA), false, `${who}, trip`);
    }
    assert.equal(sees("friend", "post_media", M.tripRel, DROP_MEDIA), true, "anti-vacuity: the crew member reads released trip media");
  });

  it("S1 — service_role reads every row (BYPASSRLS: every server path is unaffected)", () => {
    assert.equal(visible("service_role", "posts", Object.values(P)).size, Object.values(P).length);
    assert.equal(visible("service_role", "post_media", Object.values(M)).size, Object.values(M).length);
  });
});
