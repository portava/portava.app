/**
 * §20 / §28 — a Memory item may not claim another user's storage object.
 *
 * ## The defect, stated before the fix
 *
 * `POST /memories/:id/items` typed `mediaUrl` as `z.string().url()`
 * (routes/memories.ts addItemSchema) and wrote it straight into
 * `memory_items.media_url`. No storage-origin check and no ownership check —
 * the same shape `src/test/storyMediaOwnership.test.ts` documents for
 * `POST /stories`, which that lane closed at both ends.
 *
 * On this surface the consequence is not byte exfiltration: `lib/mediaAccess.ts`
 * has no `memory_items` branch, so the relay never authorises memory item bytes
 * by a Memory's visibility, and `DELETE /memories/:id/items/:itemId` already
 * refuses to remove an object outside `memories/<owner>/`. What an attacker
 * gets is ATTRIBUTION: a public Memory of their own whose photograph is another
 * user's object, served with the attacker's caption, place and date, to the
 * attacker's audience — and to every surface that renders a Memory cover.
 *
 * CENSUS: H181 ("Memory media bypasses all of it: `routes/memories.ts` inserts a
 * client-supplied `media_url` straight into `memory_items`"). This closes the
 * ownership leg. The staged pipeline — fingerprint, thumbnail, moderation
 * status — is not built by this change and H181 stays W on it.
 *
 * RED BEFORE GREEN: at `7d1f2d498` the module below does not exist and the
 * route test's attacker request answers 201.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import memoriesRouter from "../../routes/memories.js";
import { classifyMemoryMediaUrl } from "./memoryMediaOrigin.js";

const MEM = "11111111-1111-1111-1111-111111111111";
const ATTACKER = "aaaaaaaa-0000-4000-a000-000000000001";
const VICTIM = "aaaaaaaa-0000-4000-a000-000000000002";
const SB = "http://sb.example.test";

const own = (uid: string) => `${SB}/storage/v1/object/public/post-media/memories/${uid}/1785019420319.jpg`;
const flatOwn = (uid: string) => `${SB}/storage/v1/object/public/post-media/${uid}/1785019420319.jpg`;
const signed = (uid: string) => `${SB}/storage/v1/object/sign/post-media/memories/${uid}/x.jpg?token=abc`;

describe("classifyMemoryMediaUrl", () => {
  it("recognises the owner's own object in both path conventions", () => {
    assert.equal(classifyMemoryMediaUrl(own(ATTACKER), ATTACKER).verdict, "own_storage");
    assert.equal(classifyMemoryMediaUrl(flatOwn(ATTACKER), ATTACKER).verdict, "own_storage");
    assert.equal(classifyMemoryMediaUrl(signed(ATTACKER), ATTACKER).verdict, "own_storage");
  });

  it("refuses an object whose path names a DIFFERENT user", () => {
    const v = classifyMemoryMediaUrl(own(VICTIM), ATTACKER);
    assert.equal(v.verdict, "foreign_storage");
    assert.equal((v as any).pathOwner, VICTIM);
  });

  it("leaves a URL that is not ours alone — this guard is about attribution, not an allowlist", () => {
    assert.equal(classifyMemoryMediaUrl("https://images.example.com/a.jpg", ATTACKER).verdict, "external");
  });

  it("an object in our bucket with no owner segment is unattributable, not foreign", () => {
    const v = classifyMemoryMediaUrl(`${SB}/storage/v1/object/public/post-media/shared/banner.jpg`, ATTACKER);
    assert.equal(v.verdict, "unattributable_storage");
  });

  it("is not fooled by the victim's id appearing somewhere other than the owner segment", () => {
    // The attacker's own object, with the victim's id in the FILENAME. Owner is
    // still the attacker; a substring match would have said otherwise.
    const u = `${SB}/storage/v1/object/public/post-media/memories/${ATTACKER}/${VICTIM}.jpg`;
    assert.equal(classifyMemoryMediaUrl(u, ATTACKER).verdict, "own_storage");
    // And the reverse: the attacker's id in the filename does not launder the
    // victim's directory.
    const u2 = `${SB}/storage/v1/object/public/post-media/memories/${VICTIM}/${ATTACKER}.jpg`;
    assert.equal(classifyMemoryMediaUrl(u2, ATTACKER).verdict, "foreign_storage");
  });

  it("handles a bare storage key, which is how 2081 canonicalised these columns", () => {
    assert.equal(classifyMemoryMediaUrl(`post-media/memories/${VICTIM}/x.jpg`, ATTACKER).verdict, "foreign_storage");
    assert.equal(classifyMemoryMediaUrl(`post-media/memories/${ATTACKER}/x.jpg`, ATTACKER).verdict, "own_storage");
  });

  it("never throws on a malformed input", () => {
    for (const bad of ["", "not a url", "://", "post-media/"]) {
      assert.doesNotThrow(() => classifyMemoryMediaUrl(bad, ATTACKER));
    }
  });
});

// ── The wiring ───────────────────────────────────────────────────────────────

interface FakeState { [t: string]: any[] }

function baseState(): FakeState {
  return {
    memories: [{
      id: MEM, owner_id: ATTACKER, title: "t", caption: null, visibility: "public",
      allowed_user_ids: [], hidden_user_ids: [], trip_id: null, event_id: null, place_id: null,
      canonical_location_id: null, location_city: null, location_country: null,
      location_lat: null, location_lng: null, starts_at: null, ends_at: null, state: "published",
      created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z",
    }],
    memory_items: [], memory_tags: [], memory_likes: [], memory_saves: [],
    user_follows: [], circle_memberships: [], trips: [], trip_members: [],
    profiles: [], blocks: [], feature_flags: [],
    compass_feed_cache: [], compass_cache_invalidations: [],
  };
}

function makeClient(state: FakeState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    const builder: any = {
      select() { return builder; },
      insert(r: any) { pendingInsert = r; return builder; },
      update() { return builder; }, upsert() { return builder; }, delete() { return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      is() { return builder; }, in() { return builder; }, gt() { return builder; }, lt() { return builder; },
      not() { return builder; }, order() { return builder; }, limit() { return builder; },
      maybeSingle: async () => {
        if (pendingInsert) { const row = { id: "new", ...pendingInsert }; (state[table] ??= []).push(row); return { data: row, error: null }; }
        return { data: rows()[0] ?? null, error: null };
      },
      single: async () => {
        if (pendingInsert) { const row = { id: "new", ...pendingInsert }; (state[table] ??= []).push(row); return { data: row, error: null }; }
        return { data: rows()[0] ?? null, error: null };
      },
      then(onF: any, onR: any) {
        if (pendingInsert) {
          const row = { id: "new", ...pendingInsert }; (state[table] ??= []).push(row);
          return Promise.resolve({ data: [row], error: null, count: 1 }).then(onF, onR);
        }
        return Promise.resolve({ data: rows(), error: null, count: rows().length }).then(onF, onR);
      },
    };
    function rows() { return (state[table] ?? []).filter((r) => filters.every((f) => f(r))); }
    return builder;
  }
  return {
    from,
    auth: {
      getUser: async (tok: string) =>
        tok === "attacker-tok" ? { data: { user: { id: ATTACKER } }, error: null } : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

async function startApp(state: FakeState) {
  _setTestClient(makeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", memoriesRouter);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

async function post(base: string, path: string, tok: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, connection: "close" },
    body: JSON.stringify(body),
  });
  const b: any = await res.json().catch(() => null);
  return { status: res.status, body: b };
}

describe("POST /api/memories/:id/items refuses another user's storage object", () => {
  it("refuses the victim's object, and writes NOTHING", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status, body } = await post(app.baseUrl, `/api/memories/${MEM}/items`, "attacker-tok", {
        mediaUrl: own(VICTIM), mediaType: "image/jpeg",
      });
      assert.equal(status, 400);
      assert.equal(body?.error, "invalid_payload");
      assert.equal(state.memory_items.length, 0, "a refused item must not be written");
    } finally { await app.close(); }
  });

  it("accepts the caller's own object", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await post(app.baseUrl, `/api/memories/${MEM}/items`, "attacker-tok", {
        mediaUrl: own(ATTACKER), mediaType: "image/jpeg",
      });
      assert.equal(status, 201);
      assert.equal(state.memory_items.length, 1);
    } finally { await app.close(); }
  });

  it("still accepts a URL that is not one of our storage objects — behaviour unchanged", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await post(app.baseUrl, `/api/memories/${MEM}/items`, "attacker-tok", {
        mediaUrl: "https://images.example.com/a.jpg", mediaType: "image/jpeg",
      });
      assert.equal(status, 201);
    } finally { await app.close(); }
  });
});
