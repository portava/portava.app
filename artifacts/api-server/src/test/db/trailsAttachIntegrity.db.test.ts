/**
 * trailsAttachIntegrity.db.test.ts — census-discovery DC-20 (§61): `11` §10
 * "every mutation is authorized", the leg that needs no owner rule. An attach
 * or a suggestion must name content that EXISTS in the table its declared type
 * names, that the actor could be served, and whose type has a table at all; a
 * source that cannot be read admits nothing.
 *
 * Over HTTP, through the real router and the real supabase-js client, on the
 * real schema (2910 + 3380/3381 + 3415) with controlled rows:
 *
 *   I1  a nonexistent id is refused, and nothing is written
 *   I2  a real id under the WRONG type is refused (a post called an event, an
 *       event called a place)
 *   I3  every verifiable type is admitted when it exists: a public post, an
 *       event, a route, a community place, a canonical place
 *   I4  `itinerary` has no table: refused as unverifiable, never admitted
 *   I5  a source that cannot be read admits NOTHING (503, retryable), for the
 *       content table, the place tables and the block list alike
 *   I6  what the actor cannot see is refused with the SAME answer as what does
 *       not exist: another author's private post (its author may attach it),
 *       a blocked author in either direction, an inactive creator
 *   I7  retries: a refused request refused identically twice; an admitted one
 *       leaves ONE row
 *   I8  a mixed batch admits the real label and names the refused one
 *   I9  suggest is held to the same rule as attach
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, scalar, seedUser } from "./localDb.js";
import { makeTrailBridge, type BridgeOptions } from "./trailPostgrestBridge.js";
import { _setTestClient, _clearTestClient } from "../../lib/http.js";
import trailsRouter from "../../routes/trails.js";

const TAG = `att${randomUUID().slice(0, 8)}`;
const users: string[] = [];

function user(label: string, accountStatus = "active"): string {
  const id = seedUser(`${TAG}${label}`);
  users.push(id);
  if (accountStatus !== "active") exec(`UPDATE public.profiles SET account_status = '${accountStatus}' WHERE id = '${id}';`);
  return id;
}

function trail(createdBy?: string): string {
  const id = randomUUID();
  exec(`INSERT INTO public.trails (id, slug, title, lifecycle_status, created_by) VALUES ('${id}', '${TAG}-${id.slice(0, 8)}', '${TAG} ${id.slice(0, 8)}', 'active', ${createdBy ? `'${createdBy}'` : "NULL"});`);
  return id;
}

function post(author: string, visibility = "public"): string {
  const id = randomUUID();
  exec(`INSERT INTO public.posts (id, author_id, content, visibility) VALUES ('${id}', '${author}', '${TAG} post', '${visibility}');`);
  return id;
}

function event(host: string): string {
  const id = randomUUID();
  exec(`INSERT INTO public.events (id, title, host_id) VALUES ('${id}', '${TAG} event', '${host}');`);
  return id;
}

function route(owner: string): string {
  const id = randomUUID();
  exec(`INSERT INTO public.route_plans (id, owner_user_id, title) VALUES ('${id}', '${owner}', '${TAG} route');`);
  return id;
}

function communityPlace(submitter: string | null): string {
  const id = randomUUID();
  exec(`INSERT INTO public.discovery_places (id, name, place_type, city, submitted_by) VALUES ('${id}', '${TAG} spot', 'cafe', '${TAG}', ${submitter ? `'${submitter}'` : "NULL"});`);
  return id;
}

function canonicalPlace(): string {
  const id = randomUUID();
  exec(`INSERT INTO public.places (id, name, normalized_name) VALUES ('${id}', '${TAG} place', '${TAG} place');`);
  return id;
}

const members = (t: string) => Number(scalar(`SELECT count(*) FROM public.content_trails WHERE trail_id = '${t}';`));

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";

function useBridge(opts: BridgeOptions = {}) {
  const bridge = makeTrailBridge(opts);
  _setTestClient(bridge.client, true);
  return bridge;
}

async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const attach = (t: string, as: string, labels: unknown[], action: "content" | "suggestions" = "content") =>
  call("POST", `/v1/discovery/trails/${t}/${action}`, as, { labels });
const one = (sourceType: string, sourceId: string, relationship = "supporting") => ({ sourceType, sourceId, relationship });

before(async () => {
  if (!HAVE_DB) return;
  assert.equal(scalar("SELECT to_regclass('public.trails') IS NOT NULL;"), "t", "2910 must be applied");
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
  exec(`DELETE FROM public.trails WHERE slug LIKE '${TAG}-%';`);
  exec(`DELETE FROM public.posts WHERE content = '${TAG} post';`);
  exec(`DELETE FROM public.events WHERE title = '${TAG} event';`);
  exec(`DELETE FROM public.discovery_places WHERE city = '${TAG}';`);
  exec(`DELETE FROM public.places WHERE name = '${TAG} place';`);
  for (const id of users) {
    exec(`DELETE FROM public.route_plans WHERE owner_user_id = '${id}';`);
    exec(`DELETE FROM public.blocks WHERE blocker_id = '${id}' OR blocked_id = '${id}';`);
    exec(`DELETE FROM public.profiles WHERE id = '${id}';\nDELETE FROM auth.users WHERE id = '${id}';`);
  }
});

describe("I — DC-20: attach and suggest name real content the actor may see", { skip: !HAVE_DB }, () => {
  test("I1. a nonexistent id is refused as `unknown_content`, and nothing is written", async () => {
    useBridge();
    const [u, t] = [user("i1"), trail()];
    for (const type of ["post", "event", "route", "place"]) {
      const ghost = randomUUID();
      const r = await attach(t, u, [one(type, ghost)]);
      assert.equal(r.status, 409, `${type}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "content_refused");
      assert.deepEqual(r.body.contentRefusals, [{ sourceType: type, sourceId: ghost, reason: "unknown_content" }]);
    }
    assert.equal(members(t), 0);
  });

  test("I2. a real id under the WRONG type is refused: a post called an event, an event called a place", async () => {
    useBridge();
    const [u, t] = [user("i2"), trail()];
    const [p, e] = [post(u), event(u)];
    const asEvent = await attach(t, u, [one("event", p)]);
    const asPlace = await attach(t, u, [one("place", e)]);
    assert.equal(asEvent.body.contentRefusals[0].reason, "unknown_content");
    assert.equal(asPlace.body.contentRefusals[0].reason, "unknown_content");
    assert.equal(members(t), 0);
  });

  test("I3. every verifiable type is admitted when it exists — including BOTH place tables", async () => {
    useBridge();
    const u = user("i3");
    const t = trail(u); // §86 (D-W10T-9): the canonical place below is authorless, so its owner is the Trail's creator
    const labels = [
      one("post", post(u)), one("event", event(u)), one("route", route(u)),
      one("place", communityPlace(u)), one("place", canonicalPlace()),
    ];
    const r = await attach(t, u, labels);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.attached, labels.length);
    assert.equal(r.body.contentRefusals, undefined, "an all-verified request's body is unchanged");
    assert.equal(members(t), labels.length);
  });

  test("I4. `itinerary` has no table: refused as unverifiable, whatever the id", async () => {
    useBridge();
    const [u, t] = [user("i4"), trail()];
    const r = await attach(t, u, [one("itinerary", randomUUID())]);
    assert.equal(r.status, 409);
    assert.equal(r.body.contentRefusals[0].reason, "unverifiable_source_type");
    assert.equal(members(t), 0);
  });

  test("I5. a source that cannot be read admits NOTHING: 503 degraded_unavailable, retryable, no row", async () => {
    const u = user("i5");
    const t5 = trail();
    const p = post(u);
    const place = canonicalPlace();
    const timeout = { code: "57014", message: "canceling statement due to statement timeout" };
    // Each read fails ALONE. The creator-standing read of `profiles` is failed by
    // its own shape: failing the whole table would also fail the auth gate's ban
    // read (lib/http.ts), which answers 503 on its own and would prove nothing here.
    const cases: Array<[string, BridgeOptions, unknown[]]> = [
      ["posts", { failTables: { posts: timeout } }, [one("post", p)]],
      ["places", { failTables: { places: timeout } }, [one("place", place)]],
      ["discovery_places", { failTables: { discovery_places: timeout } }, [one("place", place)]],
      ["blocks", { failTables: { blocks: timeout } }, [one("post", p)]],
      ["profiles (creator standing)", {
        failWhen: (method, path) => (method === "GET" && path.startsWith("/rest/v1/profiles?") && path.includes("account_status=in.") ? timeout : null),
      }, [one("post", p)]],
    ];
    for (const [read, opts, labels] of cases) {
      useBridge(opts);
      const r = await attach(t5, u, labels);
      assert.equal(r.status, 503, `${read}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.message, "the content could not be verified; nothing was attached", `${read}: the 503 came from somewhere else`);
      assert.equal(r.body.retryable, true);
      assert.equal(members(t5), 0, `${read}: an unverified label was written`);
    }
    // …and once the source reads again, the same request is admitted.
    useBridge();
    assert.equal((await attach(t5, u, [one("post", p)])).status, 201);
  });

  test("I6. what the actor cannot see is refused with the SAME answer as what does not exist", async () => {
    useBridge();
    const [actor, author, blocker, blocked, gone] = [user("i6a"), user("i6b"), user("i6c"), user("i6d"), user("i6e", "deactivated")];
    const t = trail();
    exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${blocker}', '${actor}'), ('${actor}', '${blocked}');`);
    const hidden = [
      one("post", post(author, "private")),          // another author's private post
      one("post", post(blocker)),                      // an author who blocked the actor
      one("post", post(blocked)),                      // an author the actor blocked
      one("event", event(blocker)),                    // a host who blocked the actor
      one("place", communityPlace(blocked)),           // a community place by someone the actor blocked
      one("post", post(gone)),                         // an inactive creator
    ];
    const ghost = one("post", randomUUID());
    const seen = await attach(t, actor, hidden);
    const absent = await attach(t, actor, [ghost]);
    assert.equal(seen.status, absent.status);
    assert.equal(seen.body.error, absent.body.error);
    assert.deepEqual(seen.body.contentRefusals.map((x: any) => x.reason), hidden.map(() => "unknown_content"));
    assert.equal(members(t), 0);

    // Cross-viewer: the private post's own author may attach it (they can see it); the actor may not.
    const mine = post(author, "private");
    assert.equal((await attach(t, actor, [one("post", mine)])).status, 409);
    assert.equal((await attach(t, author, [one("post", mine)])).status, 201);
  });

  test("I7. retries: a refused request is refused identically twice; an admitted one leaves ONE row", async () => {
    useBridge();
    const [u, t] = [user("i7"), trail()];
    const ghost = [one("post", randomUUID())];
    const a = await attach(t, u, ghost);
    const b = await attach(t, u, ghost);
    assert.deepEqual([a.status, a.body], [b.status, b.body]);
    const real = [one("post", post(u), "primary")];
    assert.equal((await attach(t, u, real)).status, 201);
    const again = await attach(t, u, real);
    assert.equal(again.status, 409, "a retried attach is not a second label");
    assert.equal(again.body.refusals[0].reason, "duplicate");
    assert.equal(members(t), 1);
  });

  test("I8. a mixed batch admits the real label and names the refused one", async () => {
    useBridge();
    const [u, t] = [user("i8"), trail()];
    const [real, ghost] = [post(u), randomUUID()];
    const r = await attach(t, u, [one("post", ghost), one("post", real), one("itinerary", ghost)]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.attached, 1);
    assert.deepEqual(r.body.contentRefusals, [
      { sourceType: "post", sourceId: ghost, reason: "unknown_content" },
      { sourceType: "itinerary", sourceId: ghost, reason: "unverifiable_source_type" },
    ]);
    assert.equal(scalar(`SELECT source_id FROM public.content_trails WHERE trail_id = '${t}';`), real);
  });

  test("I9. suggest is held to the same rule as attach", async () => {
    useBridge();
    const [u, author, t] = [user("i9a"), user("i9b"), trail()];
    const r = await attach(t, u, [one("post", post(author, "private"))], "suggestions");
    assert.equal(r.status, 409);
    assert.equal(r.body.contentRefusals[0].reason, "unknown_content");
    // RESTATED by census-discovery §86 (D-W10T-9): a stranger's suggestion of a post they CAN see is held,
    // pending, for its author (202) — it is no longer a membership and spends none of the post's §4 budget.
    const held = await attach(t, u, [one("post", post(author))], "suggestions");
    assert.equal(held.status, 202);
    assert.equal(held.body.suggested, 1);
    assert.equal(members(t), 0);
    assert.equal((await attach(t, author, [one("post", post(author))], "suggestions")).status, 201, "the author's own suggestion is a membership");
    assert.equal(members(t), 1);
  });
});
