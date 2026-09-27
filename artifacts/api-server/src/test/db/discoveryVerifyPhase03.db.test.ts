/**
 * discoveryVerifyPhase03.db.test.ts — census-discovery §59 (P12) and §62 (P15),
 * DV-76: `12` Phase 0.3 "Complete privacy/tagging Phase 0 … other catalogued
 * Phase 0 findings" (docs/specs/discovery-v1/12_Claude_Code_Implementation.md:20).
 * The named items were fixed at the ROUTE and SERVICE (tagging.test.ts). This
 * suite asks what the DATABASE holds for a client that never calls the route.
 *
 *   P1  FLIPPED at §62 (migration 3422). §59 pinned: a signed-in client INSERTed
 *       a tag naming a 'nobody' user on a post it does not own, landing
 *       'approved'. Now a client INSERT, UPDATE and DELETE of `tags` are each
 *       refused 42501 and nothing lands; the tagger still READS its own tag, and
 *       the service role (the API's only writer) still inserts.
 *   P2  what holds: a third party cannot read a pending tag; the tagger cannot
 *       promote it; anon cannot insert. Since 3422 the last two are refused by
 *       PRIVILEGE (42501) where RLS refused them before; the reads are unchanged.
 *   P3  (§62) the REAL routes/tags.ts over discoveryVerifyBridge (service_role):
 *       the author tags a user who allows it on the author's own post (201,
 *       approved; a retry is alreadyTagged, no second row); a stranger's post
 *       is refused (403) and writes nothing.
 *   P4  DEFECT, pinned (§62): the ROUTE tags a user whose tag_permission is
 *       'nobody' (201, approved) — the permission engine does not know profiles'
 *       enum values. Routed as a hunk (§62.7); flip it when that lands.
 *
 * P1/P2 run in a transaction that is ROLLED BACK; P3/P4's rows are committed by
 * the bridge (one statement per request) and deleted in after().
 */
import { describe, test, before, after } from "node:test"; import assert from "node:assert/strict"; import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto"; import express from "express"; import pino from "pino";
import { HAVE_DB, psql, exec, scalar, seedUser } from "./localDb.js"; import { bridge, lit, type Bridge } from "./discoveryVerifyBridge.js";
import { _setTestClient } from "../../lib/http.js"; import { _setTestServiceClient } from "../../lib/supabase.js"; import tagsRouter from "../../routes/tags.js";

/** One rolled-back script: three users, then `body` (which may SET LOCAL ROLE). */
function inRolledBackTx(ids: { x: string; y: string; z: string }, body: string): { status: number; stdout: string; stderr: string } {
  const seed = [
    `INSERT INTO auth.users (id, email) VALUES ('${ids.x}', 'p12x-${ids.x.slice(0, 8)}@local.test'), ('${ids.y}', 'p12y-${ids.y.slice(0, 8)}@local.test'), ('${ids.z}', 'p12z-${ids.z.slice(0, 8)}@local.test');`,
    `INSERT INTO public.profiles (id, handle, name) VALUES ('${ids.x}', 'p12x_${ids.x.slice(0, 8)}', 'x'), ('${ids.y}', 'p12y_${ids.y.slice(0, 8)}', 'y'), ('${ids.z}', 'p12z_${ids.z.slice(0, 8)}', 'z');`,
    `UPDATE public.profiles SET tag_permission = 'nobody' WHERE id = '${ids.z}';`,
  ].join("\n");
  return psql(`\\set VERBOSITY verbose\nBEGIN;\n${seed}\n${body}\nROLLBACK;\n`);
}
const asRole = (role: "authenticated" | "anon", sub: string | null) =>
  `SELECT set_config('request.jwt.claim.sub', '${sub ?? ""}', true);\nSELECT set_config('request.jwt.claim.role', '${role}', true);\nSET LOCAL ROLE ${role};`;
const fresh = () => ({ x: randomUUID(), y: randomUUID(), z: randomUUID() });

describe("DV-76 — Phase 0.3 at the database, for a client that skips the route (census-discovery §59, §62)", { skip: !HAVE_DB }, () => {
  // §59 pinned DV-76 here as test("P1. DEFECT, pinned: a direct client insert tags a 'nobody' user on a stranger's post, and lands APPROVED"). §62 flipped it:
  test("P1. a direct client insert, update or delete of a tag is REFUSED (3422) — nothing lands; the service role still writes", () => {
    const ids = fresh();
    const own = randomUUID();
    const r = inRolledBackTx(ids, [
      // A tag of x's that already exists (written as the API writes, as service_role).
      `INSERT INTO public.tags (id, source_type, source_id, tagger_id, tagged_user_id, status) VALUES ('${own}', 'post', '${randomUUID()}', '${ids.x}', '${ids.y}', 'pending');`,
      asRole("authenticated", ids.x),
      attempt("p1-insert", `INSERT INTO public.tags (source_type, source_id, tagger_id, tagged_user_id) VALUES ('post', '${randomUUID()}', '${ids.x}', '${ids.z}')`),
      attempt("p1-update", `UPDATE public.tags SET status = 'approved' WHERE id = '${own}'`),
      attempt("p1-delete", `DELETE FROM public.tags WHERE id = '${own}'`),
      `SELECT 'p1-own-visible:' || count(1) FROM public.tags WHERE id = '${own}';`,
      `RESET ROLE;`,
      `SELECT 'p1-count:' || count(1) FROM public.tags WHERE tagger_id = '${ids.x}';`,
      `SELECT 'p1-status:' || status FROM public.tags WHERE id = '${own}';`,
      `SET LOCAL ROLE service_role;`,
      attempt("p1-service-insert", `INSERT INTO public.tags (source_type, source_id, tagger_id, tagged_user_id, status) VALUES ('post', '${randomUUID()}', '${ids.x}', '${ids.y}', 'approved')`),
      `RESET ROLE;`,
    ].join("\n"));
    assert.equal(r.status, 0, r.stderr);
    for (const line of [
      "p1-insert:42501",            // was `p1:approved` — the 'nobody' user on a stranger's post, landed approved
      "p1-update:42501",
      "p1-delete:42501",
      "p1-own-visible:1",           // the tagger still READS its own tag: the parties-only SELECT is untouched
      "p1-count:1",                 // only the service-written tag exists; the direct insert wrote nothing
      "p1-status:pending",          // the refused UPDATE did not promote it
      "p1-service-insert:ok",       // the API's writer keeps its privilege
    ]) {
      assert.ok(r.stdout.includes(line), `${line}\n${r.stdout}`);
    }
  });

  test("P2. what holds: parties-only reads of a pending tag, no client promotion of it, and no anonymous insert", () => {
    const ids = fresh();
    const pendingId = randomUUID();
    const r = inRolledBackTx(ids, [
      `INSERT INTO public.tags (id, source_type, source_id, tagger_id, tagged_user_id, status) VALUES ('${pendingId}', 'post', '${randomUUID()}', '${ids.x}', '${ids.z}', 'pending');`,
      asRole("authenticated", ids.y),
      `SELECT 'p2-third-party-sees:' || count(1) FROM public.tags WHERE id = '${pendingId}';`,
      `RESET ROLE;`,
      asRole("authenticated", ids.z),
      `SELECT 'p2-tagged-sees:' || count(1) FROM public.tags WHERE id = '${pendingId}';`,
      `RESET ROLE;`,
      asRole("authenticated", ids.x),
      // Before 3422 this UPDATE matched 0 rows (no client UPDATE policy); since
      // 3422 it is refused outright. Either way nothing is promoted.
      attempt("p2-tagger-promote", `UPDATE public.tags SET status = 'approved' WHERE id = '${pendingId}'`),
      `SELECT 'p2-tagger-promoted:' || count(1) FROM public.tags WHERE id = '${pendingId}' AND status = 'approved';`,
      `RESET ROLE;`,
      `SELECT 'p2-status:' || status FROM public.tags WHERE id = '${pendingId}';`,
      `SAVEPOINT anon_try;`,
      asRole("anon", null),
      `INSERT INTO public.tags (source_type, source_id, tagger_id, tagged_user_id) VALUES ('post', '${randomUUID()}', '${ids.x}', '${ids.z}');`,
    ].join("\n"));
    // The last statement must be refused, so the script exits non-zero there;
    // everything before it printed.
    assert.notEqual(r.status, 0, "an anonymous insert is refused");
    assert.match(r.stderr, /permission denied for table tags/i, `refused by privilege since 3422 (was: row-level security)\n${r.stderr}`);
    for (const line of ["p2-third-party-sees:0", "p2-tagged-sees:1", "p2-tagger-promote:42501", "p2-tagger-promoted:0", "p2-status:pending"]) {
      assert.ok(r.stdout.includes(line), `${line}\n${r.stdout}`);
    }
  });

  describe("P3. the route still tags through the service role (census-discovery §62)", () => {
    let author = "", allows = "", nobody = "", stranger = "";
    let ownPost = "", strangersPost = "";
    let server: Server | null = null;
    let base = "";
    let b: Bridge;

    before(async () => {
      author = seedUser("p15tagA"); allows = seedUser("p15tagB"); nobody = seedUser("p15tagN"); stranger = seedUser("p15tagS");
      exec(`UPDATE public.profiles SET tag_permission = 'nobody' WHERE id = '${nobody}';\n` +
           `UPDATE public.profiles SET tag_permission = 'anyone' WHERE id = '${allows}';`);
      ownPost = scalar(`INSERT INTO public.posts (author_id) VALUES ('${author}') RETURNING id`)!;
      strangersPost = scalar(`INSERT INTO public.posts (author_id) VALUES ('${stranger}') RETURNING id`)!;
      b = bridge({ flags: { disable_tagging: { enabled: false } }, tokens: { "author-token": author } });
      _setTestClient(b.client, true);
      _setTestServiceClient(b.client);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
      app.use("/api", tagsRouter);
      server = createServer(app);
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
      base = `http://127.0.0.1:${(server!.address() as any).port}`;
    });

    after(async () => {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      _setTestClient(null as any, false);
      _setTestServiceClient(null as any);
      const u = [author, allows, nobody, stranger].map(lit).join(",");
      exec(
        `DELETE FROM public.tags WHERE tagger_id IN (${u}) OR tagged_user_id IN (${u});\n` +
        `DELETE FROM public.posts WHERE author_id IN (${u});\n` +
        `DELETE FROM public.profiles WHERE id IN (${u});\n` +
        `DELETE FROM auth.users WHERE id IN (${u});`,
      );
    });

    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`${base}/api/tags`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer author-token" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) as any };
    };
    const tagRows = (source: string) => Number(scalar(`SELECT count(1) FROM public.tags WHERE source_id = '${source}'`));

    test("P3a. the author tags a user who allows it, on the author's own post: 201 approved, one row", async () => {
      const r = await post({ source_type: "post", source_id: ownPost, tagged_user_id: allows });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body?.status, "approved");
      assert.equal(scalar(`SELECT tagger_id || '|' || tagged_user_id || '|' || status FROM public.tags WHERE id = ${lit(String(r.body?.tagId))}`),
        `${author}|${allows}|approved`);
      const again = await post({ source_type: "post", source_id: ownPost, tagged_user_id: allows });
      assert.equal(again.status, 200, "a retry is answered as the tag that exists");
      assert.equal(again.body?.alreadyTagged, true);
      assert.equal(tagRows(ownPost), 1, "and writes no second row");
    });

    test("P3b. the route refuses what the direct insert used to get through on a stranger's post: 403, no row", async () => {
      const onStrangers = await post({ source_type: "post", source_id: strangersPost, tagged_user_id: allows });
      assert.equal(onStrangers.status, 403, JSON.stringify(onStrangers.body));
      assert.equal(tagRows(strangersPost), 0);
    });

    test("P4. DEFECT, pinned (§62): the ROUTE tags a user whose tag_permission is 'nobody' — the permission engine does not know profiles' vocabulary", async () => {
      // services/interactionPermissions.ts switches on who_can_tag ?? profiles.tag_permission
      // over {everyone, friends, friends_only, followers, no_one, approval_required}
      // with `default: canTag = true`. profiles.tag_permission is the enum
      // {anyone, interacted, friends_only, nobody} (PATCH /me/tag-permission
      // writes it), so 'nobody' and 'interacted' fall to the default and ALLOW.
      // The inline @mention path honours 'nobody' (TaggingService); this route
      // does not. Closing the direct INSERT (P1) leaves this door open. The fix
      // is a hunk routed to the engine's owner (census-discovery §62.7); when it
      // lands this goes red — flip it to expect 403 and no row.
      const toNobody = await post({ source_type: "post", source_id: ownPost, tagged_user_id: nobody });
      assert.equal(toNobody.status, 201, JSON.stringify(toNobody.body));
      assert.equal(toNobody.body?.status, "approved");
      assert.equal(Number(scalar(`SELECT count(1) FROM public.tags WHERE tagged_user_id = '${nobody}'`)), 1,
        "a user who chose 'nobody' is tagged, approved, through the route");
      assert.deepEqual(b.unmodelled, [], `every request the route issued was modelled:\n${b.unmodelled.join("\n")}`);
      assert.deepEqual(b.failed.map((f) => /:: (\S+)/.exec(f)?.[1]), ["23505"], `the only refusal is P3a's provoked duplicate:\n${b.failed.join("\n")}`);
    });
  });
});

// Declared below the suite so the lines §59 cites (P1 at :46) keep their place.
/**
 * Run `stmt` and print `<label>:ok` if it ran, or `<label>:<SQLSTATE>` if it was
 * refused — so one script can observe several refusals under ON_ERROR_STOP.
 */
const attempt = (label: string, stmt: string) => {
  const guc = `p15.${label.replace(/[^a-z0-9]/g, "_")}`;
  return `DO $a$ BEGIN ${stmt}; PERFORM set_config('${guc}', 'ok', true); ` +
    `EXCEPTION WHEN OTHERS THEN PERFORM set_config('${guc}', SQLSTATE, true); END $a$;\n` +
    `SELECT '${label}:' || current_setting('${guc}', true);`;
};
