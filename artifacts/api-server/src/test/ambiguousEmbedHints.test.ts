/**
 * wave 5 (2026-10-17) — five reads that never resolved in production: each
 * embedded across a pair of tables joined by more than one foreign key, with no
 * hint, so PostgREST could not choose a relationship and refused the read
 * (PGRST201).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/ambiguousEmbedHints.test.ts
 *
 * THE DEFECT (production catalog, read-only, 2026-10-17). public.posts has THREE
 * keys to public.profiles: posts_author_id_fkey (author_id), posts_created_by_fkey
 * (created_by), posts_updated_by_fkey (updated_by). public.live_place_recaps and
 * public.live_place_recap_versions key each other both ways:
 * live_place_recaps_current_version_fk (recaps.current_version_id → versions) and
 * live_place_recap_versions_recap_id_fkey (versions.recap_id → recaps). So:
 *   GET  /places/:id/place-days/:date/feed       routes/placeDays.ts:101   posts → profiles(...)
 *   POST /place-recaps (moment) and regenerate   routes/placeRecaps.ts:41  contributions → posts → profiles(...)
 *   POST /place-recaps (place day) and regenerate routes/placeRecaps.ts:59 posts → profiles(...)
 *   GET  /places/:placeId/recaps                 routes/placeRecaps.ts:151 recaps → live_place_recap_versions!inner(...)
 *   GET  /shared-moments/:id/feed                routes/sharedMoments.ts:314 contributions → posts → profiles(...)
 * every one answered PGRST201. No error was swallowed: each route turned it into
 * `db_error` (500), so in production the Place Day feed, the Shared Moment feed
 * and the place's recap list always failed, and no recap could be created or
 * regenerated (collectSources reported "could not be verified"). The doubles
 * accepted all five: the guard did not model ambiguity.
 *
 * THE FIX. A one-token hint on the same line (no cited line moves):
 *   - `profiles!author_id(...)`: every caller hands the embedded profile to
 *     excludePrivateAuthorPosts as the AUTHOR's privacy (keyed by author_id, or
 *     by contributor_id, which POST /shared-moments/:id/contributions requires to
 *     be the post's author: sharedMoments.ts:243);
 *   - `live_place_recap_versions!live_place_recap_versions_recap_id_fkey!inner(...)`:
 *     the client reads EVERY version as an array and shows the highest
 *     version_number's title (PlaceRecapsSection `latestTitle`; the service type
 *     `PlaceRecapListItem.live_place_recap_versions: Array<...>`). The current-
 *     version key would answer one object and drop every recap with no current
 *     version.
 * And the guard (helpers/migrationForeignKeys.ts) now refuses an ambiguous embed
 * on every double, as PostgREST does; schemaStrictSupabase's opt-in
 * `joinEmbeds` materialises each embed from flat seeded tables along the one key
 * it resolves to, so a wrong hint shows up as the wrong person or the wrong shape.
 *
 * Mutation proofs (2026-10-17; each source restored and checked by sha256): see
 * the handback for the table. Every route case below is RED on the unhinted
 * source (the double throws PGRST201 and the route answers 500), and RED with
 * the wrong key hinted (`profiles!created_by`, `profiles!updated_by`, the
 * current-version key).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import { makeFailClosedClient, noopLog } from "./helpers/failClosedSupabase.js";
import { makeFakeMapDb } from "./helpers/fakeMapDb.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";
import { describeRelationship, resolveSelectEmbeds, selectEmbedRefusalDetails } from "./helpers/migrationForeignKeys.js";
import placeDaysRouter from "../routes/placeDays.js";
import placeRecapsRouter from "../routes/placeRecaps.js";
import sharedMomentsRouter from "../routes/sharedMoments.js";

// ── 1. The guard: ambiguity is refused on every double, a hint resolves it ────

describe("the embed guard refuses what PostgREST refuses as ambiguous (PGRST201), on every double", () => {
  const AMBIGUOUS: ReadonlyArray<[string, string]> = [
    ["posts", "id, profiles(id, is_private)"],
    ["shared_moment_contributions", "id, posts(id, profiles(id))"],
    ["live_place_recaps", "id, live_place_recap_versions!inner(title)"],
    ["live_place_recaps", "id, live_place_recap_versions(title)"],
    ["posts", "id, profiles!id(id)"], // `id` is the referenced column of all three keys: still three
  ];
  const doubles: ReadonlyArray<[string, () => { from: (t: string) => any }]> = [
    ["schemaStrictSupabase", () => makeSchemaStrictClient({})],
    ["failClosedSupabase", () => makeFailClosedClient({})],
    ["fakeMapDb", () => makeFakeMapDb({}, { token: "t", userId: "u" })],
    ["fakeLayoverDb", () => makeLayoverDb({})],
  ];

  for (const [name, make] of doubles) {
    it(`PLANTED: ${name} throws PGRST201 on each ambiguous embed`, () => {
      for (const [table, cols] of AMBIGUOUS) {
        assert.throws(() => make().from(table).select(cols), /PGRST201/, `${name}: ${table} select(${cols})`);
      }
    });
  }

  it("the refusal names every candidate key, both directions included", () => {
    const posts = selectEmbedRefusalDetails("posts", "id, profiles(id)");
    assert.deepEqual(posts.map((r) => r.code), ["PGRST201"]);
    assert.deepEqual(posts[0]!.keys, [
      "posts.author_id → profiles (posts_author_id_fkey, many-to-one)",
      "posts.created_by → profiles (posts_created_by_fkey, many-to-one)",
      "posts.updated_by → profiles (posts_updated_by_fkey, many-to-one)",
    ]);
    const recaps = selectEmbedRefusalDetails("live_place_recaps", "id, live_place_recap_versions!inner(title)");
    assert.deepEqual(recaps[0]!.keys.sort(), [
      "live_place_recap_versions.recap_id → live_place_recaps (live_place_recap_versions_recap_id_fkey, one-to-many)",
      "live_place_recaps.current_version_id → live_place_recap_versions (live_place_recaps_current_version_fk, many-to-one)",
    ]);
  });

  it("CONTROL: a hint by column, by constraint, or at either end of a key resolves to exactly that key; a singly-keyed pair needs none", () => {
    const one = (table: string, cols: string) => {
      const nodes = resolveSelectEmbeds(table, cols);
      assert.deepEqual(selectEmbedRefusalDetails(table, cols), [], `${table} select(${cols})`);
      return nodes.map((n) => describeRelationship(n.relationship!));
    };
    const AUTHOR = "posts.author_id → profiles (posts_author_id_fkey, many-to-one)";
    assert.deepEqual(one("posts", "id, profiles!author_id(id)"), [AUTHOR]);
    assert.deepEqual(one("posts", "id, profiles!posts_author_id_fkey(id)"), [AUTHOR]);
    assert.deepEqual(one("posts", "id, author:profiles!author_id!inner(id)"), [AUTHOR]);
    assert.deepEqual(one("posts", "id, profiles!created_by(id)"), ["posts.created_by → profiles (posts_created_by_fkey, many-to-one)"]);
    const VERSIONS = "live_place_recap_versions.recap_id → live_place_recaps (live_place_recap_versions_recap_id_fkey, one-to-many)";
    const CURRENT = "live_place_recaps.current_version_id → live_place_recap_versions (live_place_recaps_current_version_fk, many-to-one)";
    assert.deepEqual(one("live_place_recaps", "id, live_place_recap_versions!live_place_recap_versions_recap_id_fkey!inner(title)"), [VERSIONS]);
    assert.deepEqual(one("live_place_recaps", "id, live_place_recap_versions!recap_id(title)"), [VERSIONS]);
    assert.deepEqual(one("live_place_recaps", "id, live_place_recap_versions!live_place_recaps_current_version_fk(title)"), [CURRENT]);
    assert.deepEqual(one("live_place_recaps", "id, live_place_recap_versions!current_version_id(title)"), [CURRENT]);
    assert.deepEqual(one("shared_moment_contributions", "id, posts(id)"), ["shared_moment_contributions.post_id → posts (shared_moment_contributions_post_id_fkey, many-to-one)"]);
  });

  it("CONTROL: a key the migration chain AND the baseline both declare is one relationship, not two", () => {
    // posts_author_id_fkey is declared by 2141_post_tombstones.sql and by the baseline.
    assert.deepEqual(selectEmbedRefusalDetails("shared_moment_contributions", "id, posts(id)"), []);
    assert.equal(resolveSelectEmbeds("posts", "id, profiles!author_id(id)")[0]!.relationship!.key.name, "posts_author_id_fkey");
  });
});

describe("schemaStrictSupabase joinEmbeds: an embed is materialised along its key, and checked like a table", () => {
  const seed = (): Seed => ({
    posts: [{ id: "p1", author_id: "a", created_by: "c", updated_by: "c" }],
    profiles: [{ id: "a", is_private: true }, { id: "c", is_private: false }],
  });

  it("many-to-one is an object (or null); the hint decides WHOSE profile", async () => {
    const c = makeSchemaStrictClient(seed(), { joinEmbeds: true });
    assert.deepEqual((await c.from("posts").select("id, profiles!author_id(id, is_private)")).data, [{ id: "p1", profiles: { id: "a", is_private: true } }]);
    assert.deepEqual((await c.from("posts").select("id, editor:profiles!updated_by(id)")).data, [{ id: "p1", editor: { id: "c" } }]);
    const none = makeSchemaStrictClient({ posts: [{ id: "p2", author_id: null }], profiles: [] }, { joinEmbeds: true });
    assert.deepEqual((await none.from("posts").select("id, profiles!author_id(id)")).data, [{ id: "p2", profiles: null }]);
    assert.deepEqual((await none.from("posts").select("id, profiles!author_id!inner(id)")).data, [], "`!inner` drops a parent with no match");
  });

  it("PLANTED: a column the embedded table does not have fails the whole statement (42703), as PostgREST does", async () => {
    const c = makeSchemaStrictClient(seed(), { joinEmbeds: true });
    const r = await c.from("posts").select("id, profiles!author_id(id, not_a_column)");
    assert.equal(r.data, null);
    assert.equal(r.error?.code, "42703");
    assert.match(r.error?.message ?? "", /column profiles\.not_a_column does not exist/);
    assert.deepEqual(c.deadColumnErrors.map((e) => `${e.table}.${e.column}`), ["profiles.not_a_column"]);
  });

  it("what it does not model THROWS rather than guess: a spread, an aggregate", () => {
    const c = makeSchemaStrictClient(seed(), { joinEmbeds: true });
    assert.throws(() => c.from("posts").select("id, ...profiles!author_id(is_private)"), /joinEmbeds\): the spread/);
    assert.throws(() => c.from("posts").select("id, profiles!author_id(count)"), /joinEmbeds\): `count`/);
  });

  it("CONTROL: without the option, the seeded row is returned whole, as before", async () => {
    const c = makeSchemaStrictClient({ posts: [{ id: "p1", author_id: "a", profiles: { seeded: true } }] });
    assert.deepEqual((await c.from("posts").select("id, profiles!author_id(id)")).data, [{ id: "p1", author_id: "a", profiles: { seeded: true } }]);
  });
});

// ── 2. The five reads, on schemaStrictSupabase with joinEmbeds ───────────────

const VIEWER = "b1000000-0000-4000-a000-000000000001";
const PUB_A = "a1000000-0000-4000-a000-00000000000a"; // public author; their post was created by PRIV_R
const PRIV_P = "a2000000-0000-4000-a000-00000000000b"; // private author, not followed; their post was created by PUB_X
const PRIV_F = "a3000000-0000-4000-a000-00000000000c"; // private author the viewer follows
const PUB_X = "a4000000-0000-4000-a000-00000000000d"; // public, creator/editor of PRIV_P's and PRIV_F's posts
const PRIV_R = "a5000000-0000-4000-a000-00000000000e"; // private, creator/editor of PUB_A's post
const OTHER_OWNER = "a6000000-0000-4000-a000-00000000000f";
const PLACE = "c1000000-0000-4000-a000-000000000001";
const PLACE_DAY = "c2000000-0000-4000-a000-000000000002";
const MOMENT = "c3000000-0000-4000-a000-000000000003";
const DATE = "2026-10-01";
const TOKEN = "tok-viewer";

const FLAGS = ["external_places_enabled", "live_places_enabled", "place_days_enabled", "place_recaps_enabled", "shared_moments_enabled", "moment_recaps_enabled"];

function post(id: string, author: string, editor: string, hour: number) {
  return {
    id, author_id: author, created_by: editor, updated_by: editor, canonical_place_id: PLACE,
    content: `content ${id}`, media_urls: [`https://cdn.invalid/${id}.jpg`], media_thumbnail_url: null, media_type: "image",
    created_at: `${DATE}T${String(hour).padStart(2, "0")}:00:00.000Z`, visibility: "public", status: "active",
    post_status: "published", publish_at: null, location_privacy_mode: "none", published_at: null,
  };
}

/** Post ids are chosen so id order is created_at order (the double keeps only the last `.order()`). */
const POSTS = [
  post("d0000000-0000-4000-a000-000000000001", VIEWER, VIEWER, 9),
  post("d0000000-0000-4000-a000-000000000002", PUB_A, PRIV_R, 10),
  post("d0000000-0000-4000-a000-000000000003", PRIV_P, PUB_X, 11),
  post("d0000000-0000-4000-a000-000000000004", PRIV_F, PUB_X, 12),
];
const [OWN, BY_A, BY_P, BY_F] = POSTS.map((p) => p.id) as [string, string, string, string];

function contribution(id: string, contributor: string, postId: string | null, hour: number) {
  return {
    id, moment_id: MOMENT, contributor_id: contributor, post_id: postId, media_asset_id: null,
    caption: postId ? null : "a caption with no post", status: "approved",
    created_at: `${DATE}T${String(hour).padStart(2, "0")}:30:00.000Z`,
  };
}
const CONTRIBUTIONS = [
  contribution("e0000000-0000-4000-a000-000000000001", VIEWER, OWN, 9),
  contribution("e0000000-0000-4000-a000-000000000002", PUB_A, BY_A, 10),
  contribution("e0000000-0000-4000-a000-000000000003", PRIV_P, BY_P, 11),
  contribution("e0000000-0000-4000-a000-000000000004", PRIV_F, BY_F, 12),
  contribution("e0000000-0000-4000-a000-000000000005", PUB_X, null, 13),
];
const [C_OWN, C_A, C_P, C_F, C_CAPTION] = CONTRIBUTIONS.map((c) => c.id) as [string, string, string, string, string];

function version(id: string, recap: string, n: number) {
  return { id, recap_id: recap, version_number: n, title: `title ${n} of ${recap.slice(-1)}`, summary: `summary ${n}`, published_at: n > 1 ? "2026-10-04T00:00:00.000Z" : null, status: "draft" };
}
const R1 = "f0000000-0000-4000-a000-000000000001"; // published; current = its second version
const R2 = "f0000000-0000-4000-a000-000000000002"; // a version, but NO current version
const R3 = "f0000000-0000-4000-a000-000000000003"; // no version at all
const R4 = "f0000000-0000-4000-a000-000000000004"; // someone else's
const R5 = "f0000000-0000-4000-a000-000000000005"; // removed

function world(): Seed {
  return {
    feature_flags: FLAGS.map((flag) => ({ flag, enabled: true })),
    blocks: [],
    profiles: [
      { id: VIEWER, is_private: false }, { id: PUB_A, is_private: false }, { id: PRIV_P, is_private: true },
      { id: PRIV_F, is_private: true }, { id: PUB_X, is_private: false }, { id: PRIV_R, is_private: true },
    ],
    user_follows: [{ follower_id: VIEWER, following_id: PRIV_F }],
    places: [{ id: PLACE, name: "The Place", city: null, latitude: null, longitude: null, merged_into_place_id: null }],
    posts: POSTS.map((p) => ({ ...p })),
    place_days: [{ id: PLACE_DAY, place_id: PLACE, local_date: DATE, timezone: "UTC", status: "closing" }],
    shared_moments: [{ id: MOMENT, owner_id: VIEWER, place_id: PLACE, status: "archived", title: "A moment" }],
    shared_moment_memberships: [{ moment_id: MOMENT, user_id: VIEWER, role: "owner", status: "accepted" }],
    shared_moment_contributions: CONTRIBUTIONS.map((c) => ({ ...c })),
    live_place_recaps: [
      { id: R1, owner_id: VIEWER, place_id: PLACE, status: "published", created_at: "2026-10-05T00:00:00.000Z", current_version_id: "f1000000-0000-4000-a000-000000000002" },
      { id: R2, owner_id: VIEWER, place_id: PLACE, status: "draft", created_at: "2026-10-04T00:00:00.000Z", current_version_id: null },
      { id: R3, owner_id: VIEWER, place_id: PLACE, status: "draft", created_at: "2026-10-03T00:00:00.000Z", current_version_id: null },
      { id: R4, owner_id: OTHER_OWNER, place_id: PLACE, status: "published", created_at: "2026-10-02T00:00:00.000Z", current_version_id: "f1000000-0000-4000-a000-000000000004" },
      { id: R5, owner_id: VIEWER, place_id: PLACE, status: "removed", created_at: "2026-10-01T00:00:00.000Z", current_version_id: "f1000000-0000-4000-a000-000000000005" },
    ],
    live_place_recap_versions: [
      version("f1000000-0000-4000-a000-000000000001", R1, 1), version("f1000000-0000-4000-a000-000000000002", R1, 2),
      version("f1000000-0000-4000-a000-000000000003", R2, 1), version("f1000000-0000-4000-a000-000000000004", R4, 1),
      version("f1000000-0000-4000-a000-000000000005", R5, 1),
    ],
  };
}

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", placeDaysRouter);
  app.use("/api", placeRecapsRouter);
  app.use("/api", sharedMomentsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); _setTestClient(null, false); });

const auth = { getUser: async (token: string) => (token === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

/**
 * schemaStrictSupabase with `joinEmbeds`, mounted. It models no `.or()` (the
 * block read) and no `.rpc()` (the recap writers): `.or` narrows what the double
 * returns through the shared throwing parser, and `rpc` records its arguments
 * and answers success. Everything else — the live-column check, the embed guard,
 * the materialised join — is the double's own. Every read's result is recorded.
 */
function install(seed: Seed) {
  const strict = makeSchemaStrictClient(seed, { joinEmbeds: true });
  const reads: Array<{ table: string; cols: string; data: any }> = [];
  const rpcs: Array<{ fn: string; args: any }> = [];
  const from = (table: string) => {
    const b = strict.from(table);
    const preds: Array<(row: Record<string, any>) => boolean> = [];
    let cols = "";
    const select = b.select;
    b.select = (c?: string, o?: any) => { cols = c ?? ""; return select(c, o); };
    b.or = (expr: string) => { preds.push(orPredicate(expr)); return b; };
    const then = b.then;
    b.then = (onF: any, onR: any) => then((r: any) => {
      let data = r?.data;
      if (Array.isArray(data) && preds.length) data = data.filter((row: any) => preds.every((p) => p(row)));
      reads.push({ table, cols, data });
      return onF({ ...r, data });
    }, onR);
    return b;
  };
  const rpc = async (fn: string, args: any) => {
    rpcs.push({ fn, args });
    return { data: { recap: { id: "new-recap" }, version: { id: "new-version" } }, error: null };
  };
  _setTestClient({ from, auth, rpc }, true);
  return { strict, reads, rpcs };
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed, raw };
}

const sorted = (xs: string[]) => [...xs].sort();

describe("routes/placeDays.ts:101 — GET /places/:id/place-days/:date/feed decides privacy on the AUTHOR's profile", () => {
  it("answers 200; a private author the viewer does not follow is withheld, whoever created or edited the post", async () => {
    const { strict, reads } = install(world());
    const r = await call("GET", `/places/${PLACE}/place-days/${DATE}/feed`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(sorted(r.body.items.map((x: any) => x.id)), sorted([OWN, BY_A, BY_F]), "own post, the public author's and the followed private author's; not the unfollowed private author's");
    const postRead = reads.find((x) => x.table === "posts")!;
    for (const row of postRead.data) assert.deepEqual(row.profiles, { id: row.author_id, is_private: [PRIV_P, PRIV_F].includes(row.author_id) }, "the embedded profile is the author's, as an object");
  });
});

describe("routes/placeRecaps.ts:59 — POST /place-recaps (a Place Day) collects sources on the AUTHOR's profile", () => {
  it("answers 201; the recap's sources leave out the unfollowed private author's post and keep the public author's", async () => {
    const { strict, rpcs } = install(world());
    const r = await call("POST", "/place-recaps", { placeDayId: PLACE_DAY });
    assert.equal(r.status, 201, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(rpcs.length, 1);
    assert.equal(rpcs[0]!.fn, "create_live_place_recap");
    assert.deepEqual(sorted(rpcs[0]!.args.p_sources.map((s: any) => s.postId)), sorted([OWN, BY_A, BY_F]));
  });
});

describe("routes/placeRecaps.ts:41 — POST /place-recaps (a Shared Moment) collects contributions on the post AUTHOR's profile", () => {
  it("answers 201; the unfollowed private author's contribution is left out, a caption-only one is kept", async () => {
    const { strict, rpcs, reads } = install(world());
    const r = await call("POST", "/place-recaps", { momentId: MOMENT });
    assert.equal(r.status, 201, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(rpcs.length, 1);
    assert.deepEqual(sorted(rpcs[0]!.args.p_sources.map((s: any) => s.id)), sorted([C_OWN, C_A, C_F, C_CAPTION]));
    const contributions = reads.find((x) => x.table === "shared_moment_contributions")!;
    for (const row of contributions.data) {
      if (row.post_id === null) { assert.equal(row.posts, null); continue; }
      assert.equal(row.posts.profiles.id, row.contributor_id, "the nested profile is the post's author, who is the contributor");
    }
  });
});

describe("routes/placeRecaps.ts:151 — GET /places/:placeId/recaps lists EVERY version of each recap, as the client reads it", () => {
  it("answers 200; each recap carries an array of its own versions; a recap with no version is not listed", async () => {
    const { strict } = install(world());
    const r = await call("GET", `/places/${PLACE}/recaps`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(r.body.recaps.map((x: any) => x.id), [R1, R2], "the caller's own, not removed, newest first; R3 has no version (!inner), R4 is someone else's, R5 is removed");
    const [r1, r2] = r.body.recaps;
    assert.ok(Array.isArray(r1.live_place_recap_versions), "an ARRAY: the client spreads and sorts it");
    assert.deepEqual(r1.live_place_recap_versions, [
      { version_number: 1, title: "title 1 of 1", summary: "summary 1", published_at: null },
      { version_number: 2, title: "title 2 of 1", summary: "summary 2", published_at: "2026-10-04T00:00:00.000Z" },
    ]);
    assert.deepEqual(r2.live_place_recap_versions, [{ version_number: 1, title: "title 1 of 2", summary: "summary 1", published_at: null }], "a recap with no CURRENT version is still listed with its versions");
    // What the client shows: PlaceRecapsSection's latestTitle sorts the array by version_number, newest first.
    const latest = [...r1.live_place_recap_versions].sort((a: any, b: any) => b.version_number - a.version_number)[0].title;
    assert.equal(latest, "title 2 of 1");
  });
});

describe("routes/sharedMoments.ts:314 — GET /shared-moments/:id/feed answers, and its nested profile is the author's", () => {
  it("answers 200 with the visible contributions (privacy here is a separate profiles read, unchanged)", async () => {
    const { strict, reads } = install(world());
    const r = await call("GET", `/shared-moments/${MOMENT}/feed`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(sorted(r.body.items.map((x: any) => x.id)), sorted([C_OWN, C_A, C_F, C_CAPTION]));
    const contributions = reads.find((x) => x.table === "shared_moment_contributions")!;
    const withPost = contributions.data.filter((row: any) => row.post_id !== null);
    assert.equal(withPost.length, 4);
    for (const row of withPost) assert.equal(row.posts.profiles.id, row.posts.author_id, "the embedded profile is the post's author");
  });
});
