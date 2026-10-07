/**
 * trailsService.db.test.ts — TrailService and the Trails routes, run against
 * migration 2910's REAL tables (plus 3380/3381) on the local PostgreSQL
 * harness, with CONTROLLED rows (census-discovery §51).
 *
 * The in-memory suites (`src/test/*Trail*`) prove the rules; this one proves
 * them where a fake cannot lie: real CHECKs, the label-cap trigger, the
 * transition triggers, real `blocks` / `posts` / `places` rows, real timestamp
 * comparison, and `rank_events` rows in the exact shape the Discovery serve log
 * writes — `item_id = 'db/<uuid>'` for a place `GET /discovery` served. The
 * service code talks to the database through the real supabase-js client (see
 * trailPostgrestBridge.ts), so every filter it builds is the one production
 * sends.
 *
 *   H1  the served id space — denominators, trending_now, trending, momentum
 *   H2  DV-13 — one creator cannot dominate any module, on any request
 *   H3  DV-23 — duplicates of one place are clustered, access is preserved
 *   H4  DC-03 — the four checks, across destinations, with hostile input
 *   H5  DC-20 — archived, blocks, report retries, batch attachment, over HTTP
 *   H6  DC-04 — the promotion runs through the transition trigger
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, seedUser } from "./localDb.js";
import { makeTrailBridge } from "./trailPostgrestBridge.js";
import { _setTestClient, _clearTestClient } from "../../lib/http.js";
import trailsRouter from "../../routes/trails.js";
import {
  attachContentToTrail, getTrailModules, trailTrending, proposeTrail, moveTrailLifecycle,
} from "../../services/trails/TrailService.js";
import {
  MAX_PER_CONTRIBUTOR_PER_PAGE, MAX_PER_PLACE_PER_PAGE, TRAIL_EXPLORATION_IMPRESSION_CEILING,
} from "../../lib/discoveryTrailHealth.js";

const TAG = `svc${randomUUID().slice(0, 8)}`;
const users: string[] = [];
const bridge = HAVE_DB ? makeTrailBridge() : null;
const sc = () => bridge!.client;

function user(label: string): string {
  const id = seedUser(`${TAG}${label}`);
  users.push(id);
  return id;
}

function trail(state = "active", over: { destination?: string; title?: string; parent?: string; createdBy?: string } = {}): string {
  const id = randomUUID();
  exec(`INSERT INTO public.trails (id, slug, title, destination, lifecycle_status, parent_trail_id, created_by) VALUES ('${id}', '${TAG}-${id.slice(0, 8)}', '${over.title ?? `${TAG} ${id.slice(0, 8)}`}', ${over.destination ? `'${over.destination}'` : "NULL"}, '${state}', ${over.parent ? `'${over.parent}'` : "NULL"}, ${over.createdBy ? `'${over.createdBy}'` : "NULL"});`);
  return id;
}

function member(trailId: string, sourceType: string, sourceId: string, contributor: string | null, over: { relationship?: string; signal?: string; createdMsAgo?: number } = {}): string {
  const id = randomUUID();
  exec(`INSERT INTO public.content_trails (id, trail_id, source_type, source_id, relationship, signal, contributor_id, created_at) VALUES ('${id}', '${trailId}', '${sourceType}', '${sourceId}', '${over.relationship ?? "primary"}', ${over.signal ? `'${over.signal}'` : "NULL"}, ${contributor ? `'${contributor}'` : "NULL"}, now() - interval '${over.createdMsAgo ?? 60_000} milliseconds');`);
  return id;
}

function post(author: string, over: { canonicalPlace?: string; visibility?: string } = {}): string {
  const id = randomUUID();
  exec(`INSERT INTO public.posts (id, author_id, content, visibility, canonical_place_id) VALUES ('${id}', '${author}', '${TAG} post', '${over.visibility ?? "public"}', ${over.canonicalPlace ? `'${over.canonicalPlace}'` : "NULL"});`);
  return id;
}

function canonicalPlace(): string {
  const id = randomUUID();
  exec(`INSERT INTO public.places (id, name, normalized_name) VALUES ('${id}', '${TAG} place', '${TAG} place');`);
  return id;
}

/** Rows exactly as lib/discoveryServeLog.ts writes a served `GET /discovery` place. */
function servedRows(viewer: string, itemId: string, n: number, outcome = "impression", minutesAgo = 60): void {
  exec(`INSERT INTO public.rank_events (user_id, item_id, item_kind, position, features, outcome, served_at, outcome_at, surface, schema_version, privacy_class)
        SELECT '${viewer}', '${itemId}', 'gem', 0, '{}'::jsonb, '${outcome}', now() - make_interval(mins => ${minutesAgo}) - make_interval(secs => g),
               ${outcome === "impression" ? "NULL" : `now() - make_interval(mins => ${minutesAgo}) - make_interval(secs => g)`}, 'discovery', 1, 'raw_behavioral_event'
          FROM generate_series(1, ${n}) g;`);
}

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";

async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  if (!HAVE_DB) return;
  assert.equal(scalar("SELECT to_regclass('public.trails') IS NOT NULL;"), "t", "2910 must be applied");
  assert.equal(scalar("SELECT to_regprocedure('public.trails_lifecycle_transition()') IS NOT NULL;"), "t", "3381 must be applied");
  // §61: proposeTrail decides through trail_propose and fails closed without it.
  assert.equal(scalar("SELECT to_regprocedure('public.trail_propose(text,text,text,uuid,uuid)') IS NOT NULL;"), "t", "3415 must be applied");
  _setTestClient(bridge!.client, true);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  if (!HAVE_DB) return;
  server.close();
  _clearTestClient();
  exec(`DELETE FROM public.trails WHERE slug LIKE '${TAG}-%' OR title LIKE '${TAG}%';`);
  exec(`DELETE FROM public.posts WHERE content = '${TAG} post';`);
  exec(`DELETE FROM public.places WHERE name = '${TAG} place';`);
  for (const id of users) {
    exec(`DELETE FROM public.blocks WHERE blocker_id = '${id}' OR blocked_id = '${id}';`);
    exec(`DELETE FROM public.profiles WHERE id = '${id}';\nDELETE FROM auth.users WHERE id = '${id}';`);
  }
});

describe("H1 — the Trails reads count the `db/<uuid>` exposures GET /discovery writes", { skip: !HAVE_DB }, () => {
  test("a place served past the ceiling as `db/<uuid>` takes no exploration slot; the unexposed one does", async () => {
    const [feedViewer, viewer, c] = [user("h1f"), user("h1v"), user("h1c")];
    const t = trail();
    const [hot, cold] = [randomUUID(), randomUUID()];
    const mHot = member(t, "place", hot, c, { createdMsAgo: 60_000 });
    const mCold = member(t, "place", cold, c, { createdMsAgo: 120_000 });
    servedRows(feedViewer, `db/${hot}`, TRAIL_EXPLORATION_IMPRESSION_CEILING + 100);
    const r = await getTrailModules(sc(), t, { viewerId: viewer, pageSize: 8 });
    assert.equal(r.refusal, null);
    assert.deepEqual(r.modules[0]!.explorationSlots, [mCold], `hot=${mHot}`);
  });

  test("`db/` saves order trending_now and make GET …/trending say `trending: true`", async () => {
    const [feedViewer, viewer, c] = [user("h1g"), user("h1w"), user("h1d")];
    const t = trail();
    const place = randomUUID();
    const m = member(t, "place", place, c);
    servedRows(feedViewer, `db/${place}`, 8, "save");
    const mods = await getTrailModules(sc(), t, { viewerId: viewer });
    assert.deepEqual(mods.modules.find((x) => x.key === "trending_now")!.items.map((i) => i.id), [m]);
    const tr = await call("GET", `/v1/discovery/trails/${t}/trending`, viewer);
    assert.equal(tr.status, 200);
    assert.equal(tr.body.trending, true);
    assert.deepEqual(tr.body.items.map((i: any) => i.id), [m]);
  });
});

describe("H2 — DV-13: one creator cannot dominate any module, on any request", { skip: !HAVE_DB }, () => {
  test("six posts by one author (attached by three other people) against one each by two others", async () => {
    const [a, b, c, viewer] = [user("h2a"), user("h2b"), user("h2c"), user("h2v")];
    const attachers = [user("h2x"), user("h2y"), user("h2z")];
    const t = trail();
    const aPosts = Array.from({ length: 6 }, () => post(a));
    const [bPost, cPost] = [post(b), post(c)];
    // RESTATED by census-discovery §86 (D-W10T-9): a third party's suggestion is now PENDING for the author
    // and never a membership, so rows whose contributor is NOT the author are seeded directly — the shape
    // any membership written before §86 has — and DV-13's cap must still key on the author.
    for (const [i, p] of aPosts.entries()) member(t, "post", p, attachers[i % 3]!);
    const pending = await attachContentToTrail(sc(), t, [{ sourceType: "post", sourceId: post(a), relationship: "primary" }],
      { userId: attachers[0]!, mode: "suggest" });
    assert.equal(pending.attached, 0, "a stranger's suggestion is held for the author");
    assert.equal(pending.suggested, 1);
    await attachContentToTrail(sc(), t, [{ sourceType: "post", sourceId: bPost, relationship: "primary" }], { userId: b, mode: "attach" });
    await attachContentToTrail(sc(), t, [{ sourceType: "post", sourceId: cPost, relationship: "primary" }], { userId: c, mode: "attach" });
    // Move three of the author's posts along §7's relation into `evergreen`, through the 3381 trigger.
    exec(`UPDATE public.content_trails SET content_state = 'growing' WHERE trail_id = '${t}' AND source_id IN ('${aPosts.slice(0, 3).join("','")}');
          UPDATE public.content_trails SET content_state = 'featured' WHERE trail_id = '${t}' AND source_id IN ('${aPosts.slice(0, 3).join("','")}');
          UPDATE public.content_trails SET content_state = 'evergreen' WHERE trail_id = '${t}' AND source_id IN ('${aPosts.slice(0, 3).join("','")}');`);

    const authorOf = new Map<string, string>([...aPosts.map((p) => [p, a] as const), [bPost, b], [cPost, c]]);
    const pages: string[] = [];
    for (let request = 0; request < 5; request++) {
      const r = await call("GET", `/v1/discovery/trails/${t}/modules`, viewer);
      assert.equal(r.status, 200);
      for (const mod of r.body.modules) {
        const fromA = mod.items.filter((i: any) => authorOf.get(i.sourceId) === a).length;
        assert.ok(fromA <= MAX_PER_CONTRIBUTOR_PER_PAGE, `request ${request}, module ${mod.key}: ${fromA} of the author's items`);
      }
      const ja = r.body.modules.find((m: any) => m.key === "just_arrived");
      assert.ok(ja.items.some((i: any) => i.sourceId === bPost) && ja.items.some((i: any) => i.sourceId === cPost),
        "the other creators get the room the cap frees");
      pages.push(JSON.stringify(r.body.modules.map((m: any) => m.items.map((i: any) => i.id))));
    }
    assert.equal(new Set(pages).size, 1, "the bound holds identically on every request — there is no page on which it lapses");
  });
});

describe("H3 — DV-23: near-duplicates of one place are clustered and stay reachable", { skip: !HAVE_DB }, () => {
  test("five authors' posts about ONE canonical place: two served, three counted under `more from this place`", async () => {
    const viewer = user("h3v");
    const authors = Array.from({ length: 5 }, (_, i) => user(`h3a${i}`));
    const place = canonicalPlace();
    const t = trail();
    for (const a of authors) member(t, "post", post(a, { canonicalPlace: place }), a);
    const r = await getTrailModules(sc(), t, { viewerId: viewer, pageSize: 8 });
    const ja = r.modules.find((m) => m.key === "just_arrived")!;
    assert.equal(ja.items.length, MAX_PER_PLACE_PER_PAGE);
    assert.deepEqual(ja.moreFromThisPlace, { [place]: 5 - MAX_PER_PLACE_PER_PAGE });
  });

  test("one place attached as primary and two Signals in ONE request is one item on the page", async () => {
    const [viewer, c] = [user("h3w"), user("h3c")];
    const t = trail("active", { createdBy: c }); // §86 (D-W10T-9): an authorless place is attached by the Trail's creator
    const place = canonicalPlace(); // §61: attach requires the place to exist
    const res = await attachContentToTrail(sc(), t, [
      { sourceType: "place", sourceId: place, relationship: "primary" },
      { sourceType: "place", sourceId: place, relationship: "signal", signal: "rooftop" },
      { sourceType: "place", sourceId: place, relationship: "signal", signal: "food" },
    ], { userId: c, mode: "attach" });
    assert.equal(res.attached, 3);
    const r = await getTrailModules(sc(), t, { viewerId: viewer });
    assert.equal(r.modules[0]!.items.filter((i) => i.sourceId === place).length, 1);
  });
});

describe("H4 — DC-03: the four checks run over the right catalogue, and hostile input cannot rewrite it", { skip: !HAVE_DB }, () => {
  // 3977 (lead ruling D-66) seeds trail_creation_enabled FALSE, and POST /v1/discovery/trails refuses while it is
  // off. These cases exercise the door with the flag ON, as an operator would turn it on; the seeded value is restored.
  let creationWas: string | null = null;
  before(() => {
    creationWas = scalar("SELECT enabled::text FROM public.feature_flags WHERE flag = 'trail_creation_enabled';");
    assert.equal(creationWas, "false", "3977 seeds the creation flag FALSE");
    exec("UPDATE public.feature_flags SET enabled = TRUE WHERE flag = 'trail_creation_enabled';");
  });
  after(() => {
    exec(`UPDATE public.feature_flags SET enabled = ${creationWas === "true" ? "TRUE" : "FALSE"} WHERE flag = 'trail_creation_enabled';`);
  });
  /** D-66: a person's new Trail is pending until an admin decides; approve it as the admin route would. */
  const approve = (trailId: string, admin: string) =>
    exec(`SET LOCAL ROLE service_role;\nSELECT public.trail_review_decide('${trailId}', '${admin}', 'approve', NULL)::text;`, { single: true });

  test("a re-ordered title filed under ANOTHER destination is still a duplicate (CHECK 1 is destination-independent)", async () => {
    const u = user("h4a");
    const first = await proposeTrail(sc(), { title: `${TAG} After Dark Nights`, destination: `${TAG}-bangkok` }, u);
    assert.ok(first.trail, JSON.stringify(first));
    const again = await proposeTrail(sc(), { title: `Nights After Dark ${TAG}`, destination: `${TAG}-phuket` }, u);
    assert.equal(again.trail, null, "a second canonical Trail for one theme was admitted");
    assert.ok(again.canonicalisation.some((x) => x.check === "duplicate_title_similarity" && x.conflictsWith === first.trail!.id));
  });

  test("a destination carrying PostgREST syntax is data, not filter: no 500, the proposal is judged", async () => {
    const u = user("h4b");
    const r = await call("POST", "/v1/discovery/trails", u, { title: `${TAG} Canal Walks`, destination: `${TAG}, thailand),id.is.null` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  test("a geographic sub-Trail in ANOTHER destination can declare its parent, and the edge is written", async () => {
    const u = user("h4c");
    const parent = await proposeTrail(sc(), { title: `${TAG} Riverside Evenings`, destination: `${TAG}-bangkok` }, u);
    assert.ok(parent.trail);
    const kid = await call("POST", "/v1/discovery/trails", u, {
      title: `${TAG} Thonglor Lanes`, destination: `${TAG}-thonglor`, parentTrailId: parent.trail!.id,
    });
    assert.equal(kid.status, 201, JSON.stringify(kid.body));
    // D-66: neither is navigable until approved — the related read is 404 for the pending sub-Trail, its creator included.
    assert.equal((await call("GET", `/v1/discovery/trails/${kid.body.trail.id}/related`, u)).status, 404);
    const admin = user("h4cadmin");
    approve(parent.trail!.id, admin);
    approve(kid.body.trail.id, admin);
    const up = await call("GET", `/v1/discovery/trails/${kid.body.trail.id}/related`, u);
    assert.deepEqual(up.body.related.map((e: any) => [e.trail.id, e.edgeType, e.direction]), [[parent.trail!.id, "child", "in"]]);
  });

  test("an ARCHIVED parent cannot be declared", async () => {
    const u = user("h4d");
    // Same destination on purpose: the parent is then IN the comparison set,
    // which is where the old lookup found it and accepted it.
    const gone = trail("archived", { destination: `${TAG}-y` });
    const r = await call("POST", "/v1/discovery/trails", u, { title: `${TAG} Orphan Walks`, destination: `${TAG}-y`, parentTrailId: gone });
    assert.equal(r.status, 400);
  });
});

describe("H5 — DC-20 over HTTP on the real schema", { skip: !HAVE_DB }, () => {
  test("an archived Trail is 404 to a reader and takes no follow", async () => {
    const u = user("h5a");
    const t = trail("archived");
    assert.equal((await call("GET", `/v1/discovery/trails/${t}/modules`, u)).status, 404);
    assert.equal((await call("PUT", `/v1/discovery/trails/${t}/follow`, u)).status, 404);
    assert.equal(scalar(`SELECT count(*) FROM public.trail_follows WHERE trail_id = '${t}';`), "0");
  });

  test("a post by an author the viewer blocked is withheld from that viewer only", async () => {
    const [viewer, other, author] = [user("h5v"), user("h5o"), user("h5b")];
    const t = trail();
    const m = member(t, "post", post(author), author);
    exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${viewer}', '${author}');`);
    const mine = await call("GET", `/v1/discovery/trails/${t}/modules`, viewer);
    const theirs = await call("GET", `/v1/discovery/trails/${t}/modules`, other);
    assert.deepEqual(mine.body.modules[0].items, []);
    assert.deepEqual(theirs.body.modules[0].items.map((i: any) => i.id), [m]);
  });

  test("a post made private after it was attached stops being served", async () => {
    const [viewer, author] = [user("h5w"), user("h5p")];
    const t = trail();
    const p = post(author);
    member(t, "post", p, author);
    assert.equal((await call("GET", `/v1/discovery/trails/${t}/modules`, viewer)).body.modules[0].items.length, 1);
    exec(`UPDATE public.posts SET visibility = 'private' WHERE id = '${p}';`);
    assert.equal((await call("GET", `/v1/discovery/trails/${t}/modules`, viewer)).body.modules[0].items.length, 0);
  });

  test("a retried report lands once; two posts attached as primary in one request both land", async () => {
    const u = user("h5r");
    const t = trail();
    const a = await call("POST", `/v1/discovery/trails/${t}/reports`, u, { reason: "stale" });
    const b = await call("POST", `/v1/discovery/trails/${t}/reports`, u, { reason: "stale" });
    assert.equal(a.status, 202);
    assert.equal(b.body.duplicate, true);
    assert.equal(scalar(`SELECT count(*) FROM public.trail_reports WHERE trail_id = '${t}';`), "1");

    const [p1, p2] = [post(u), post(u)];
    const r = await call("POST", `/v1/discovery/trails/${t}/content`, u, {
      labels: [{ sourceType: "post", sourceId: p1, relationship: "primary" }, { sourceType: "post", sourceId: p2, relationship: "primary" }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.attached, 2);
  });
});

describe("H6 — DC-04: the promotion goes through the transition trigger; an archived Trail stays archived", { skip: !HAVE_DB }, () => {
  test("first content promotes proposed → active; archived refuses a move in TypeScript AND at the database", async () => {
    const u = user("h6a");
    const t = trail("proposed", { createdBy: u }); // §86 (D-W10T-9): an authorless place is attached by the Trail's creator
    const res = await attachContentToTrail(sc(), t, [{ sourceType: "place", sourceId: canonicalPlace(), relationship: "primary" }], { userId: u, mode: "attach" });
    assert.equal(res.attached, 1);
    assert.equal(scalar(`SELECT lifecycle_status FROM public.trails WHERE id = '${t}';`), "active");

    exec(`UPDATE public.trails SET lifecycle_status = 'archived' WHERE id = '${t}';`);
    const moved = await moveTrailLifecycle(sc(), t, "active");
    assert.equal(moved.moved, false);
    assert.equal(scalar(`SELECT lifecycle_status FROM public.trails WHERE id = '${t}';`), "archived");
  });
});
