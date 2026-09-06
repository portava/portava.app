/**
 * Stories + Close Friends — backend tests
 *
 * Tests cover:
 * - Story creation
 * - Story not returned after expiry
 * - Privacy enforcement (close-friends-only story not returned to non-member)
 * - View recording idempotency
 * - Hide-viewer setting respected in viewers endpoint
 * - Close-friends list private to owner only
 * - Story soft-delete
 * - Save to highlight (refused — Highlights always expire; see the block at the
 *   bottom of this file. This list claimed coverage that did not exist.)
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

interface Row { [k: string]: any; }
interface FakeTable { rows: Row[]; nextInsertError?: string; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    feature_flags:    tables.feature_flags    ?? { rows: [{ flag: "stories_enabled", enabled: true }] },
    stories:          tables.stories          ?? { rows: [] },
    story_views:      tables.story_views      ?? { rows: [] },
    story_reactions:  tables.story_reactions  ?? { rows: [] },
    story_replies:    tables.story_replies    ?? { rows: [] },
    close_friends:    tables.close_friends    ?? { rows: [] },
    highlights:       tables.highlights       ?? { rows: [] },
    blocks:           tables.blocks           ?? { rows: [] },
    profiles:         tables.profiles         ?? { rows: [] },
    user_follows:     tables.user_follows     ?? { rows: [] },
    circle_memberships: tables.circle_memberships ?? { rows: [] },
    trip_members:     tables.trip_members     ?? { rows: [] },
    ...tables,
  };

  function chain(tableName: string, filtered: Row[]) {
    let limitCount: number | null = null;
    let singleMode = false;
    let upsertMode = false;
    let countMode = false;

    const obj: any = {
      select(cols?: string, opts?: any) {
        if (opts?.count) countMode = true;
        return obj;
      },
      insert(data: Row | Row[]) {
        const table = db[tableName] ?? (db[tableName] = { rows: [] });
        if (table.nextInsertError) {
          const msg = table.nextInsertError;
          table.nextInsertError = undefined;
          return Promise.resolve({ data: null, error: { message: msg } });
        }
        const rows = Array.isArray(data) ? data : [data];
        const inserted: Row[] = rows.map((r) => ({ id: `gen-${Math.random().toString(36).slice(2)}`, ...r }));
        table.rows.push(...inserted);
        filtered = inserted;
        return obj;
      },
      upsert(data: Row | Row[], opts?: any) {
        const table = db[tableName] ?? (db[tableName] = { rows: [] });
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) {
          const conflict = opts?.onConflict;
          if (conflict) {
            const keys = conflict.split(",").map((k: string) => k.trim());
            const idx = table.rows.findIndex((r) => keys.every((k: string) => r[k] === row[k]));
            if (idx !== -1) { table.rows[idx] = { ...table.rows[idx], ...row }; }
            else { table.rows.push({ id: `gen-${Math.random().toString(36).slice(2)}`, ...row }); }
          } else {
            table.rows.push({ id: `gen-${Math.random().toString(36).slice(2)}`, ...row });
          }
        }
        filtered = rows;
        upsertMode = true;
        return obj;
      },
      update(data: Row) {
        const table = db[tableName];
        if (!table) return obj;
        for (const row of filtered) {
          const idx = table.rows.indexOf(row);
          if (idx !== -1) Object.assign(table.rows[idx], data);
        }
        filtered = filtered.map((r) => ({ ...r, ...data }));
        return obj;
      },
      delete() {
        const table = db[tableName];
        if (table) {
          for (const row of filtered) {
            const idx = table.rows.indexOf(row);
            if (idx !== -1) table.rows.splice(idx, 1);
          }
        }
        filtered = [];
        return obj;
      },
      eq(col: string, val: any)    { filtered = filtered.filter((r) => r[col] === val); return obj; },
      neq(col: string, val: any)   { filtered = filtered.filter((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return obj; },
      gt(col: string, val: any)    { filtered = filtered.filter((r) => r[col] > val); return obj; },
      lt(col: string, val: any)    { filtered = filtered.filter((r) => r[col] < val); return obj; },
      gte(col: string, val: any)   { filtered = filtered.filter((r) => r[col] >= val); return obj; },
      lte(col: string, val: any)   { filtered = filtered.filter((r) => r[col] <= val); return obj; },
      is(col: string, val: any)    { filtered = filtered.filter((r) => val === null ? r[col] == null : r[col] === val); return obj; },
      ilike(col: string, pat: string) {
        const re = new RegExp(pat.replace(/%/g, ".*"), "i");
        filtered = filtered.filter((r) => re.test(String(r[col] ?? "")));
        return obj;
      },
      order()          { return obj; },
      limit(n: number) { limitCount = n; return obj; },
      head()           { return obj; },
      single() { singleMode = true; return obj; },
      maybeSingle() {
        const row = filtered[0] ?? null;
        return Promise.resolve({ data: row, error: null, count: row ? 1 : 0 });
      },
      then(resolve: any, reject?: any) {
        let result = filtered;
        if (limitCount !== null) result = result.slice(0, limitCount);
        if (countMode) {
          return Promise.resolve({ data: null, error: null, count: result.length }).then(resolve, reject);
        }
        if (singleMode) {
          if (result.length === 0) return Promise.resolve({ data: null, error: { message: "No rows" } }).then(resolve, reject);
          return Promise.resolve({ data: result[0], error: null }).then(resolve, reject);
        }
        if (upsertMode) return Promise.resolve({ data: result, error: null }).then(resolve, reject);
        return Promise.resolve({ data: result, error: null, count: result.length }).then(resolve, reject);
      },
    };
    return obj;
  }

  const auth: any = {
    getUser: async (token: string) => {
      const user = db._users?.rows.find((u) => u.token === token) ?? null;
      if (!user) return { data: { user: null }, error: { message: "Invalid token" } };
      return { data: { user: { id: user.id, email: user.email } }, error: null };
    },
  };

  return {
    auth,
    from(table: string) {
      const t = db[table] ?? (db[table] = { rows: [] });
      return chain(table, [...t.rows]);
    },
    _db: db,
  };
}

// Canonical UUIDs for tests — keep predictable to debug easily
const U = {
  owner1:  "aaaaaaaa-0000-0000-0000-000000000001",
  owner2:  "aaaaaaaa-0000-0000-0000-000000000002",
  owner3:  "aaaaaaaa-0000-0000-0000-000000000003",
  viewer1: "bbbbbbbb-0000-0000-0000-000000000001",
  viewer2: "bbbbbbbb-0000-0000-0000-000000000002",
  viewer3: "bbbbbbbb-0000-0000-0000-000000000003",
  story1:  "cccccccc-0000-0000-0000-000000000001",
  story2:  "cccccccc-0000-0000-0000-000000000002",
  story3:  "cccccccc-0000-0000-0000-000000000003",
  story4:  "cccccccc-0000-0000-0000-000000000004",
  story5:  "cccccccc-0000-0000-0000-000000000005",
  story6:  "cccccccc-0000-0000-0000-000000000006",
  story7:  "cccccccc-0000-0000-0000-000000000007",
};

function makeUser(id: string, token: string) {
  return { id, email: `${id}@test.com`, token };
}

function futureExpiry() {
  return new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
}
function pastExpiry() {
  return new Date(Date.now() - 1000).toISOString();
}

function baseStory(overrides: Record<string, any> = {}): Row {
  return {
    media_url: "https://example.com/story.jpg",
    media_type: "image/jpeg",
    caption: null,
    visibility: "public",
    close_friends_only: false,
    state: "active",
    expires_at: futureExpiry(),
    allowed_user_ids: [],
    hidden_user_ids: [],
    trip_id: null,
    event_id: null,
    place_id: null,
    hide_viewer_list: false,
    saved_to_highlight_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

let server: Server;
let port: number;

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterEach(async () => {
  _setTestClient(null, false);
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve()))
  );
});

async function req(method: string, path: string, body?: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

// ── Story creation ─────────────────────────────────────────────────────────────

describe("POST /api/stories", () => {
  it("creates a story for an authenticated user", async () => {
    const owner = makeUser(U.owner1, "tok-owner-create");
    const client = makeFakeClient({ _users: { rows: [owner] } });
    _setTestClient(client, true);

    const { status, json } = await req("POST", "/api/stories", {
      // The bare key POST /api/media/upload returns: `post-media/<uid>/<ts>.<ext>`.
      // Was "https://example.com/story.jpg" — an external URL the create path
      // used to accept, which is the hole storyMediaOwnership.test.ts covers.
      mediaUrl: `post-media/${owner.id}/1785019420319.jpg`,
      mediaType: "image/jpeg",
      caption: "My first story",
      visibility: "public",
    }, owner.token);

    assert.equal(status, 201, JSON.stringify(json));
    assert.equal(json.owner_id, owner.id);
    assert.equal(json.visibility, "public");
    assert.ok(json.expires_at, "expires_at should be set");
    assert.equal(json.state, "active");
  });

  it("returns 400 for missing mediaUrl", async () => {
    const owner = makeUser(U.owner2, "tok-owner-400");
    const client = makeFakeClient({ _users: { rows: [owner] } });
    _setTestClient(client, true);

    const { status, json } = await req("POST", "/api/stories", {
      mediaType: "image/jpeg",
    }, owner.token);

    assert.equal(status, 400, JSON.stringify(json));
    assert.equal(json.error, "invalid_payload");
  });

  it("returns 401 without token", async () => {
    const client = makeFakeClient({ _users: { rows: [] } });
    _setTestClient(client, true);
    const { status } = await req("POST", "/api/stories", {
      // Valid object key so a 401 here proves auth rejects first, rather than
      // the media guard masking it with a 400.
      mediaUrl: `post-media/${U.owner1}/1785019420319.jpg`,
      mediaType: "image/jpeg",
    });
    assert.equal(status, 401);
  });
});

// ── Story GET — expiry enforcement ────────────────────────────────────────────

describe("GET /api/stories/:id — expiry", () => {
  it("returns 404 for an expired story", async () => {
    const owner  = makeUser(U.owner1, "tok-exp-owner");
    const viewer = makeUser(U.viewer1, "tok-exp-viewer");

    const client = makeFakeClient({
      _users: { rows: [owner, viewer] },
      stories: { rows: [baseStory({ id: U.story1, owner_id: owner.id, expires_at: pastExpiry() })] },
      blocks:  { rows: [] },
    });
    _setTestClient(client, true);

    const { status } = await req("GET", `/api/stories/${U.story1}`, undefined, viewer.token);
    assert.equal(status, 404);
  });

  it("returns 200 for an active (non-expired) story", async () => {
    const owner  = makeUser(U.owner2, "tok-act-owner");
    const viewer = makeUser(U.viewer2, "tok-act-viewer");

    const client = makeFakeClient({
      _users: { rows: [owner, viewer] },
      stories: { rows: [baseStory({ id: U.story2, owner_id: owner.id })] },
      blocks:  { rows: [] },
    });
    _setTestClient(client, true);

    const { status, json } = await req("GET", `/api/stories/${U.story2}`, undefined, viewer.token);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.id, U.story2);
  });
});

// ── Privacy enforcement: close_friends ───────────────────────────────────────

describe("GET /api/stories/:id — close-friends privacy", () => {
  it("returns 404 to a non-close-friend when close_friends_only=true", async () => {
    const owner  = makeUser(U.owner1, "tok-cf-owner");
    const viewer = makeUser(U.viewer1, "tok-cf-viewer");

    const client = makeFakeClient({
      _users: { rows: [owner, viewer] },
      stories: { rows: [baseStory({
        id: U.story3, owner_id: owner.id,
        visibility: "close_friends", close_friends_only: true,
      })] },
      close_friends: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);

    const { status } = await req("GET", `/api/stories/${U.story3}`, undefined, viewer.token);
    assert.equal(status, 404);
  });

  it("returns 200 to a close friend", async () => {
    const owner  = makeUser(U.owner2, "tok-cf-owner2");
    const viewer = makeUser(U.viewer2, "tok-cf-viewer2");

    const client = makeFakeClient({
      _users: { rows: [owner, viewer] },
      stories: { rows: [baseStory({
        id: U.story4, owner_id: owner.id,
        visibility: "close_friends", close_friends_only: true,
      })] },
      close_friends: { rows: [{ owner_id: owner.id, friend_user_id: viewer.id }] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);

    const { status, json } = await req("GET", `/api/stories/${U.story4}`, undefined, viewer.token);
    assert.equal(status, 200, JSON.stringify(json));
  });
});

// ── View recording idempotency ────────────────────────────────────────────────

describe("GET /api/stories/:id — view recording idempotency", () => {
  it("records a view exactly once even when called twice", async () => {
    const owner  = makeUser(U.owner1, "tok-view-owner");
    const viewer = makeUser(U.viewer1, "tok-view-viewer");

    const client = makeFakeClient({
      _users: { rows: [owner, viewer] },
      stories: { rows: [baseStory({ id: U.story5, owner_id: owner.id })] },
      story_views: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);

    await req("GET", `/api/stories/${U.story5}`, undefined, viewer.token);
    await req("GET", `/api/stories/${U.story5}`, undefined, viewer.token);

    const views = (client as any)._db.story_views.rows.filter(
      (r: any) => r.story_id === U.story5 && r.viewer_id === viewer.id,
    );
    assert.equal(views.length, 1, "should have exactly one view record");
  });
});

// ── Viewers endpoint: hide_viewer_list ────────────────────────────────────────

describe("GET /api/stories/:id/viewers", () => {
  it("returns hidden:true when hide_viewer_list is set", async () => {
    const owner = makeUser(U.owner1, "tok-hvl-owner");

    const client = makeFakeClient({
      _users: { rows: [owner] },
      stories: { rows: [baseStory({ id: U.story6, owner_id: owner.id, hide_viewer_list: true })] },
    });
    _setTestClient(client, true);

    const { status, json } = await req("GET", `/api/stories/${U.story6}/viewers`, undefined, owner.token);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.hidden, true);
    assert.deepEqual(json.viewers, []);
  });

  it("returns 403 to a non-owner", async () => {
    const owner = makeUser(U.owner2, "tok-hvl-owner2");
    const other = makeUser(U.viewer2, "tok-hvl-other2");

    const client = makeFakeClient({
      _users: { rows: [owner, other] },
      stories: { rows: [baseStory({ id: U.story7, owner_id: owner.id, hide_viewer_list: false })] },
    });
    _setTestClient(client, true);

    const { status } = await req("GET", `/api/stories/${U.story7}/viewers`, undefined, other.token);
    assert.equal(status, 403);
  });
});

// ── Close Friends list: private to owner only ─────────────────────────────────

describe("Close Friends — privacy", () => {
  it("GET /api/users/me/close-friends returns only the caller's list", async () => {
    const alice = makeUser(U.owner1, "tok-alice-get");
    const bob   = makeUser(U.viewer1, "tok-bob-get");

    const client = makeFakeClient({
      _users: { rows: [alice, bob] },
      close_friends: { rows: [{ owner_id: alice.id, friend_user_id: bob.id, created_at: new Date().toISOString() }] },
      profiles: { rows: [{ id: bob.id, handle: "bob", name: "Bob", avatar_url: null }] },
    });
    _setTestClient(client, true);

    const { status, json } = await req("GET", "/api/users/me/close-friends", undefined, alice.token);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.closeFriends.length, 1);
    assert.equal(json.closeFriends[0].userId, bob.id);
  });

  it("GET /api/users/me/close-friends for bob returns empty (alice's list is private)", async () => {
    const alice = makeUser(U.owner1, "tok-alice-priv");
    const bob   = makeUser(U.viewer1, "tok-bob-priv");

    const client = makeFakeClient({
      _users: { rows: [alice, bob] },
      close_friends: { rows: [{ owner_id: alice.id, friend_user_id: bob.id, created_at: new Date().toISOString() }] },
      profiles: { rows: [] },
    });
    _setTestClient(client, true);

    // Bob calls GET /me/close-friends → returns Bob's (empty) list, not Alice's
    const { status, json } = await req("GET", "/api/users/me/close-friends", undefined, bob.token);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.closeFriends.length, 0, "Bob's list is empty — Alice's list is private to Alice");
  });

  it("POST /api/users/me/close-friends adds a user", async () => {
    const alice = makeUser(U.owner1, "tok-alice-add");
    const bob   = makeUser(U.viewer1, "tok-bob-add");

    const client = makeFakeClient({
      _users: { rows: [alice, bob] },
      close_friends: { rows: [] },
      profiles: { rows: [{ id: bob.id, handle: "bob-add", name: "Bob", avatar_url: null }] },
      // Alice follows Bob — required by the follow constraint in POST /close-friends
      user_follows: { rows: [{ follower_id: alice.id, following_id: bob.id }] },
    });
    _setTestClient(client, true);

    const { status, json } = await req("POST", "/api/users/me/close-friends", { userId: bob.id }, alice.token);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.ok, true);
  });

  it("DELETE /api/users/me/close-friends/:userId removes a user", async () => {
    const alice = makeUser(U.owner1, "tok-alice-del");
    const bob   = makeUser(U.viewer1, "tok-bob-del");

    const client = makeFakeClient({
      _users: { rows: [alice, bob] },
      close_friends: { rows: [{ owner_id: alice.id, friend_user_id: bob.id, created_at: new Date().toISOString() }] },
    });
    _setTestClient(client, true);

    const { status } = await req("DELETE", `/api/users/me/close-friends/${bob.id}`, undefined, alice.token);
    assert.equal(status, 204);
  });
});

// ── Story soft-delete ─────────────────────────────────────────────────────────

describe("DELETE /api/stories/:id", () => {
  it("owner can soft-delete their story", async () => {
    const owner = makeUser(U.owner1, "tok-del-owner");

    const client = makeFakeClient({
      _users: { rows: [owner] },
      stories: { rows: [baseStory({ id: U.story1, owner_id: owner.id })] },
    });
    _setTestClient(client, true);

    const { status } = await req("DELETE", `/api/stories/${U.story1}`, undefined, owner.token);
    assert.equal(status, 204);

    const story = (client as any)._db.stories.rows.find((r: any) => r.id === U.story1);
    assert.equal(story?.state, "deleted");
  });

  it("non-owner gets 403 when trying to delete", async () => {
    const owner = makeUser(U.owner1, "tok-del-owner2");
    const other = makeUser(U.viewer1, "tok-del-other");

    const client = makeFakeClient({
      _users: { rows: [owner, other] },
      stories: { rows: [baseStory({ id: U.story2, owner_id: owner.id })] },
    });
    _setTestClient(client, true);

    const { status } = await req("DELETE", `/api/stories/${U.story2}`, undefined, other.token);
    assert.equal(status, 403);
  });
});

// ── Save to highlight ─────────────────────────────────────────────────────────
//
// `highlights.expires_at` is NOT NULL and every read path gates on it (both RLS
// SELECT policies on the table, and every `.gt("expires_at", now)` filter in
// routes/highlights.ts). The endpoint used to insert `now + 24h` and call that a
// save, so the "saved" highlight went dark a day later with no error anywhere —
// and flipping the story to state='saved' also excluded it permanently from
// sweepExpiredStories(), the only code that deletes story bytes from
// post-media, stranding the file as publicly fetchable forever. There is no
// permanent highlight in this product to route the save into, so the endpoint
// refuses.

describe("POST /api/stories/:id/save-to-highlight", () => {
  it("refuses instead of granting a silent 24h term", async () => {
    const owner = makeUser(U.owner1, "tok-s2h-refuse");
    const client = makeFakeClient({
      _users: { rows: [owner] },
      stories: { rows: [baseStory({ id: U.story1, owner_id: owner.id })] },
    });
    _setTestClient(client, true);

    const { status, json } = await req(
      "POST", `/api/stories/${U.story1}/save-to-highlight`, {}, owner.token,
    );

    assert.equal(status, 410, JSON.stringify(json));
    assert.equal(json.error, "gone");
    assert.match(
      String(json.message ?? ""),
      /expire/i,
      "the refusal must say WHY — a bare code leaves the caller unable to tell the user anything",
    );
  });

  it("writes no highlight row — nothing is created that will silently vanish", async () => {
    const owner = makeUser(U.owner2, "tok-s2h-nohighlight");
    const client = makeFakeClient({
      _users: { rows: [owner] },
      stories: { rows: [baseStory({ id: U.story2, owner_id: owner.id })] },
    });
    _setTestClient(client, true);

    await req("POST", `/api/stories/${U.story2}/save-to-highlight`, {}, owner.token);

    assert.deepEqual(
      (client as any)._db.highlights.rows,
      [],
      "a refused save must not leave a highlight behind",
    );
  });

  it("leaves the story active, so the media sweep can still reach its bytes", async () => {
    const owner = makeUser(U.owner3, "tok-s2h-story-intact");
    const client = makeFakeClient({
      _users: { rows: [owner] },
      stories: { rows: [baseStory({ id: U.story3, owner_id: owner.id })] },
    });
    _setTestClient(client, true);

    await req("POST", `/api/stories/${U.story3}/save-to-highlight`, {}, owner.token);

    const story = (client as any)._db.stories.rows.find((r: any) => r.id === U.story3);
    // sweepExpiredStories() filters state='active' AND saved_to_highlight_id IS
    // NULL. Either write below would exclude this story from the sweep forever,
    // and nothing else deletes story media.
    assert.equal(story?.state, "active", "a refused save must not consume the story");
    assert.equal(story?.saved_to_highlight_id, null, "a refused save must not link a highlight");
  });

  it("still reports the highlight id of a story saved under the old behaviour", async () => {
    const owner = makeUser(U.owner1, "tok-s2h-legacy");
    const client = makeFakeClient({
      _users: { rows: [owner] },
      stories: {
        rows: [baseStory({
          id: U.story4,
          owner_id: owner.id,
          state: "saved",
          saved_to_highlight_id: "dddddddd-0000-0000-0000-000000000001",
        })],
      },
    });
    _setTestClient(client, true);

    const { status, json } = await req(
      "POST", `/api/stories/${U.story4}/save-to-highlight`, {}, owner.token,
    );

    // Reporting a link that already exists is a fact, not a new promise — the
    // refusal must not swallow it.
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.highlightId, "dddddddd-0000-0000-0000-000000000001");
  });

  it("still returns 403 to a non-owner — the refusal must not run before authz", async () => {
    const owner = makeUser(U.owner1, "tok-s2h-owner-authz");
    const other = makeUser(U.viewer1, "tok-s2h-other-authz");
    const client = makeFakeClient({
      _users: { rows: [owner, other] },
      stories: { rows: [baseStory({ id: U.story5, owner_id: owner.id })] },
    });
    _setTestClient(client, true);

    const { status, json } = await req(
      "POST", `/api/stories/${U.story5}/save-to-highlight`, {}, other.token,
    );
    assert.equal(status, 403, JSON.stringify(json));
  });

  it("still returns 404 for a story that does not exist", async () => {
    const owner = makeUser(U.owner1, "tok-s2h-missing");
    const client = makeFakeClient({ _users: { rows: [owner] }, stories: { rows: [] } });
    _setTestClient(client, true);

    const { status, json } = await req(
      "POST", `/api/stories/${U.story6}/save-to-highlight`, {}, owner.token,
    );
    assert.equal(status, 404, JSON.stringify(json));
  });
});
