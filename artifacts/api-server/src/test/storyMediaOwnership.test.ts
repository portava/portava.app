/**
 * Story media — storage-origin and ownership, at both ends.
 *
 * ## The defect
 *
 * POST /stories typed mediaUrl as `z.string().min(1)` (routes/stories.ts
 * createStorySchema) and wrote `d.mediaUrl` straight into `stories.media_url`.
 * No storage-origin check, no ownership check.
 *
 * lib/mediaAccess.ts branch 3d then resolved story media by looking the story
 * up BY media_url and returning `story.visibility === "public"`, without ever
 * asking whether the story's owner owns that object.
 *
 * Those two facts compose into a read primitive: create a public story whose
 * media_url is another user's object key, and the relay serves that user's
 * bytes to anyone. The attacker needs the victim's exact key, so this is not
 * mass extraction — but a key leaks through any surface that ever rendered the
 * object, and "public story" is precisely the surface designed to hand URLs out.
 *
 * ## Why both ends are tested
 *
 * Fixing only the create path leaves every row written before the fix live, and
 * branch 3d would go on serving them. Fixing only 3d leaves the database
 * accumulating rows that assert a false claim. The two guards are not redundant:
 * one refuses the write, the other refuses the read.
 *
 * ## The path shape these assertions encode
 *
 * `post-media/<uid>/<timestamp>.<ext>` — built server-side by
 * POST /api/media/upload (routes/posts.ts:172-173, bucket at :59) and returned
 * as a bare key (:216). Stories ride that transport; lib/mediaPipeline.ts:6-19
 * documents it as transport A and names postcards as the only consumer of
 * transport B, whose `<uid>/<postId>/<mediaId>.<ext>` convention is NOT this one.
 * No client constructs a story path, so there is no client convention to drift.
 *
 * Run: node --import tsx/esm --test src/test/storyMediaOwnership.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { authorizeMediaAccess, _clearMediaAccessCache } from "../lib/mediaAccess.js";

const SB = "http://sb.example.test";
const OLD_SUPABASE_URL = process.env.SUPABASE_URL;

const ATTACKER = "aaaaaaaa-0000-4000-a000-000000000001";
const VICTIM   = "aaaaaaaa-0000-4000-a000-000000000002";
const VIEWER   = "bbbbbbbb-0000-4000-a000-000000000001";

/** An object key exactly as POST /api/media/upload mints it. */
const keyFor = (uid: string, ts = "1785019420319") => `${uid}/${ts}.jpg`;
/** The bare-key media_url form the upload endpoint returns. */
const bare = (uid: string, ts?: string) => `post-media/${keyFor(uid, ts)}`;
/** The absolute public-URL form held by rows predating migration 2081. */
const pub = (uid: string, ts?: string) =>
  `${SB}/storage/v1/object/public/post-media/${keyFor(uid, ts)}`;

// ══════════════════════════════════════════════════════════════════════════════
// Part 1 — POST /stories refuses to write the row
// ══════════════════════════════════════════════════════════════════════════════

interface Row { [k: string]: any; }

function makeFakeClient(users: Row[]) {
  const db: Record<string, { rows: Row[] }> = {
    feature_flags: { rows: [{ flag: "stories_enabled", enabled: true }] },
    stories: { rows: [] },
  };

  function chain(tableName: string, filtered: Row[]) {
    let singleMode = false;
    const obj: any = {
      select() { return obj; },
      insert(data: Row | Row[]) {
        const table = db[tableName] ?? (db[tableName] = { rows: [] });
        const rows = Array.isArray(data) ? data : [data];
        const inserted = rows.map((r, i) => ({ id: `gen-${i}`, ...r }));
        table.rows.push(...inserted);
        filtered = inserted;
        return obj;
      },
      eq(col: string, val: any) { filtered = filtered.filter((r) => r[col] === val); return obj; },
      is(col: string, val: any) {
        filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return obj;
      },
      order() { return obj; },
      limit() { return obj; },
      single() { singleMode = true; return obj; },
      maybeSingle() { return Promise.resolve({ data: filtered[0] ?? null, error: null }); },
      then(resolve: any, reject?: any) {
        if (singleMode) {
          if (filtered.length === 0) {
            return Promise.resolve({ data: null, error: { message: "No rows" } }).then(resolve, reject);
          }
          return Promise.resolve({ data: filtered[0], error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(resolve, reject);
      },
    };
    return obj;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        const u = users.find((x) => x.token === token) ?? null;
        return u
          ? { data: { user: { id: u.id, email: `${u.id}@test.com` } }, error: null }
          : { data: { user: null }, error: { message: "Invalid token" } };
      },
    },
    from(table: string) {
      const t = db[table] ?? (db[table] = { rows: [] });
      return chain(table, [...t.rows]);
    },
    _db: db,
  } as any;
}

let server: Server;
let port: number;

before(() => { process.env.SUPABASE_URL = SB; });
after(() => { process.env.SUPABASE_URL = OLD_SUPABASE_URL; });

beforeEach(async () => {
  _clearMediaAccessCache();
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(body: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}/api/stories`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

/** Sets up an authenticated attacker and returns the fake client for inspection. */
function asAttacker() {
  const client = makeFakeClient([{ id: ATTACKER, token: "tok-attacker" }]);
  _setTestClient(client, true);
  return client;
}

describe("POST /stories — mediaUrl must be an object this user uploaded", () => {
  it("accepts the bare key that /api/media/upload actually returns", async () => {
    // The legitimate shape. If this ever fails, the guard has become stricter
    // than the upload endpoint and story creation is broken for everyone —
    // which is worse than the leak, because it hits every user rather than one
    // with a known object key.
    const client = asAttacker();

    const { status, json } = await post({
      mediaUrl: bare(ATTACKER),
      mediaType: "image/jpeg",
      visibility: "public",
    }, "tok-attacker");

    assert.equal(status, 201, JSON.stringify(json));
    assert.equal(client._db.stories.rows.length, 1);
    assert.equal(client._db.stories.rows[0].media_url, bare(ATTACKER));
  });

  it("accepts the absolute public URL form for the same object", async () => {
    // Rows predating migration 2081 hold this spelling, and a client on an old
    // build may still send it. Both spellings name the same object, so both
    // must pass the same ownership test.
    const client = asAttacker();

    const { status, json } = await post({
      mediaUrl: pub(ATTACKER),
      mediaType: "image/jpeg",
    }, "tok-attacker");

    assert.equal(status, 201, JSON.stringify(json));
    assert.equal(client._db.stories.rows.length, 1);
  });

  it("rejects another user's object key", async () => {
    // The defect, stated directly. Well-formed, in our bucket, correct path
    // shape — and not the caller's.
    const client = asAttacker();

    const { status, json } = await post({
      mediaUrl: bare(VICTIM),
      mediaType: "image/jpeg",
      visibility: "public",
    }, "tok-attacker");

    assert.equal(status, 400, JSON.stringify(json));
    assert.equal(json.error, "invalid_payload");
    assert.equal(client._db.stories.rows.length, 0, "no row may be written");
  });

  it("rejects an external URL", async () => {
    // Hotlink / tracker / SSRF-on-render. Same class events.ts and messaging.ts
    // already closed.
    const client = asAttacker();

    const { status, json } = await post({
      mediaUrl: "https://evil.example.com/tracker.jpg",
      mediaType: "image/jpeg",
    }, "tok-attacker");

    assert.equal(status, 400, JSON.stringify(json));
    assert.equal(client._db.stories.rows.length, 0);
  });

  it("uses the same error string as the events and messaging siblings", async () => {
    // The whole point of this fix is that stories is the sibling that did not
    // get the guard. A third spelling of the same rejection would make the next
    // audit harder, not easier — grepping the string must find all three.
    asAttacker();

    const { json } = await post({
      mediaUrl: "https://evil.example.com/tracker.jpg",
      mediaType: "image/jpeg",
    }, "tok-attacker");

    assert.equal(
      json.message,
      "mediaUrl must be an uploaded app media URL (use /api/media/upload first)",
    );
  });

  it("rejects a bucket outside the media allow-list", async () => {
    const client = asAttacker();

    const { status } = await post({
      mediaUrl: `stamp-artwork/${ATTACKER}/x.png`,
      mediaType: "image/jpeg",
    }, "tok-attacker");

    assert.equal(status, 400);
    assert.equal(client._db.stories.rows.length, 0);
  });

  it("rejects an object key carrying no bucket at all", async () => {
    // This is the one input the ownership check alone cannot catch: strip the
    // bucket and the remaining `<uid>/<ts>.jpg` is a path ownerFromPath happily
    // attributes to the caller. Only the storage-origin check knows it names no
    // bucket we allow. Without it a story could reference an object outside the
    // media buckets entirely.
    const client = asAttacker();

    const { status } = await post({
      mediaUrl: keyFor(ATTACKER),
      mediaType: "image/jpeg",
    }, "tok-attacker");

    assert.equal(status, 400);
    assert.equal(client._db.stories.rows.length, 0);
  });

  it("rejects a path whose owner cannot be determined", async () => {
    // `generated-visuals/...` is a real path shape in post-media, written by the
    // AI visuals service. ownerFromPath returns null for it, and a story must
    // not be able to claim an object nothing attributes to the caller.
    const client = asAttacker();

    const { status } = await post({
      mediaUrl: "post-media/generated-visuals/event/abc/def/hero.webp",
      mediaType: "image/jpeg",
    }, "tok-attacker");

    assert.equal(status, 400);
    assert.equal(client._db.stories.rows.length, 0);
  });

  it("rejects a traversal attempt", async () => {
    const client = asAttacker();

    const { status } = await post({
      mediaUrl: `post-media/${ATTACKER}/../${VICTIM}/1785019420319.jpg`,
      mediaType: "image/jpeg",
    }, "tok-attacker");

    assert.equal(status, 400);
    assert.equal(client._db.stories.rows.length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 2 — branch 3d refuses to serve a row that already exists
// ══════════════════════════════════════════════════════════════════════════════

interface RelayState {
  stories?: any[];
  mediaAssets?: any[];
  blocks?: any[];
}

function makeRelayClient(state: RelayState = {}) {
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const src = () =>
      table === "stories" ? state.stories ?? [] :
      table === "media_assets" ? state.mediaAssets ?? [] :
      table === "blocks" ? state.blocks ?? [] : [];
    const rows = () => src().filter((r: any) => filters.every((f) => f(r)));
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      contains() { return b; },
      overlaps() { return b; },
      or() { filters.push(() => false); return b; },
      limit() { return b; }, not() { return b; }, order() { return b; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return { from: builder } as any;
}

/** A live public story row pointing at `mediaUrl`, owned by `ownerId`. */
function publicStory(ownerId: string, mediaUrl: string, over: any = {}) {
  return {
    owner_id: ownerId,
    state: "active",
    visibility: "public",
    close_friends_only: false,
    expires_at: null,
    media_url: mediaUrl,
    ...over,
  };
}

describe("mediaAccess 3d — a story only authorizes media its owner owns", () => {
  it("authorizes a public story over its owner own object", async () => {
    // The behaviour that must survive: this is every real story.
    const sc = makeRelayClient({ stories: [publicStory(VICTIM, bare(VICTIM))] });

    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", keyFor(VICTIM)),
      true,
    );
  });

  it("denies a public story pointing at someone else object", async () => {
    // The leak. The row is live, public and unexpired — everything branch 3d
    // used to check — and it names an object the story owner does not own.
    const sc = makeRelayClient({ stories: [publicStory(ATTACKER, bare(VICTIM))] });

    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", keyFor(VICTIM)),
      false,
      "a story must not publish bytes its owner does not own",
    );
  });

  it("denies it in the absolute-URL spelling too", async () => {
    // Both encodings reach branch 3d through urlForms; the ownership test must
    // not be reachable-around by choosing the other spelling.
    const sc = makeRelayClient({ stories: [publicStory(ATTACKER, pub(VICTIM))] });

    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", keyFor(VICTIM)),
      false,
    );
  });

  it("attributes ownership from media_assets when that layer is lit", async () => {
    // §1 prefers the canonical owner over the path owner. A story owned by the
    // canonical owner authorizes even though the path segment says otherwise,
    // so the check follows the same source of truth the rest of decide() does.
    const sc = makeRelayClient({
      stories: [publicStory(VICTIM, bare(ATTACKER))],
      mediaAssets: [{
        storage_bucket: "post-media",
        storage_path: keyFor(ATTACKER),
        owner_user_id: VICTIM,
      }],
    });

    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", keyFor(ATTACKER)),
      true,
    );
  });

  it("denies when the object owner cannot be determined at all", async () => {
    // Fail-closed, matching decide()'s posture for profile-media at :131.
    const sc = makeRelayClient({
      stories: [publicStory(ATTACKER, "post-media/generated-visuals/event/a/b/hero.webp")],
    });

    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", "generated-visuals/event/a/b/hero.webp"),
      false,
    );
  });

  it("still denies a close-friends story to a non-friend when ownership is valid", async () => {
    // The ownership gate must run alongside the visibility rules, not replace
    // them — a correctly-owned story is not thereby public.
    const sc = makeRelayClient({
      stories: [publicStory(VICTIM, bare(VICTIM), { close_friends_only: true })],
    });

    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", keyFor(VICTIM)),
      false,
    );
  });
});
