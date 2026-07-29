/**
 * contentTranslationInvalidation.test.ts
 *
 * Confirms that editing a post caption, event title/description, or trip
 * title/notes:
 *   1. Deletes the existing content_translations cache rows for that entity.
 *   2. Calls detectAndStoreLanguage (observable via the service-client
 *      `original_language` update on the entity table).
 *
 * Uses node:test + fake-client pattern — no live database required.
 * The mock translation provider (default when TRANSLATION_PROVIDER is unset)
 * always returns 'en' for language detection, so detectAndStoreLanguage runs
 * synchronously inside the fake without needing any real API key.
 *
 * All three translation-aware PATCH handlers are covered:
 *   - PATCH /api/posts/:postId
 *   - PATCH /api/events/:id
 *   - PATCH /api/trips/:tripId
 *
 * Run: node --import tsx/esm --test src/test/contentTranslationInvalidation.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
// _setTestClient also calls _setTestServiceClient internally — no separate import needed.
import { _setTestClient } from "../lib/http.js";
import { MockTranslationProvider, _setTestTranslationProvider } from "../lib/translation.js";

// ── UUID constants ─────────────────────────────────────────────────────────────

const POST_ID  = "aaaaaaaa-0001-0000-0000-000000000001";
const EVENT_ID = "bbbbbbbb-0001-0000-0000-000000000001";
const TRIP_ID  = "cccccccc-0001-0000-0000-000000000001";
const USER_ID  = "dddddddd-0001-0000-0000-000000000001";

// Raw token value (no "Bearer " prefix) — the patch() helper adds the prefix.
const RAW_TOKEN = `fake-token-${USER_ID}`;

// ── Tracking ──────────────────────────────────────────────────────────────────

interface TrackRecord {
  deletedTranslations: Array<{ entity_type: string; entity_id: string }>;
  langDetectUpdates:   Array<{ table: string; id: string; lang: string }>;
}

// ── Fake client builder ────────────────────────────────────────────────────────

interface Row { [k: string]: any }
type FakeDb = Record<string, Row[]>;

function makeFakeClient(db: FakeDb, tokens: Record<string, string>, track: TrackRecord) {
  function chain(tableName: string, initialRows: Row[]) {
    let filtered: Row[] = [...initialRows];
    let pendingOp: null | { type: "delete" } | { type: "update"; data: Row } = null;
    const eqConditions: Array<{ col: string; val: any }> = [];

    const obj: any = {
      select()                    { return obj; },
      insert(data: Row | Row[]) {
        const table = db[tableName] ?? (db[tableName] = []);
        const rows  = Array.isArray(data) ? data : [data];
        rows.forEach((r) => table.push({ id: `fake-${tableName}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...r }));
        filtered = rows;
        return obj;
      },
      upsert(data: Row | Row[]) {
        const table = db[tableName] ?? (db[tableName] = []);
        const rows  = Array.isArray(data) ? data : [data];
        rows.forEach((r) => {
          const idx = table.findIndex((row) => {
            if (r.entity_type && row.entity_type === r.entity_type &&
                r.entity_id   && row.entity_id   === r.entity_id   &&
                r.target_language && row.target_language === r.target_language) return true;
            if (r.id !== undefined && row.id === r.id) return true;
            return false;
          });
          if (idx >= 0) Object.assign(table[idx], r);
          else table.push({ id: `fake-${tableName}-${Date.now()}`, ...r });
        });
        return obj;
      },
      update(data: Row) { pendingOp = { type: "update", data }; return obj; },
      delete()          { pendingOp = { type: "delete" }; return obj; },
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        eqConditions.push({ col, val });
        return obj;
      },
      neq(col: string, val: any)   { filtered = filtered.filter((r) => r[col] !== val); return obj; },
      not(col: string, op: string) { if (op === "is") filtered = filtered.filter((r) => r[col] != null); return obj; },
      in(col: string, vals: any[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return obj; },
      is(col: string, val: any)    {
        filtered = filtered.filter((r) => val === null ? r[col] == null : r[col] === val);
        return obj;
      },
      or()            { return obj; },
      order()         { return obj; },
      limit(n: number){ filtered = filtered.slice(0, n); return obj; },
      range(a: number, b: number) { filtered = filtered.slice(a, b + 1); return obj; },
      ilike(col: string, pattern: string) {
        const q = pattern.replace(/%/g, "").toLowerCase();
        filtered = filtered.filter((r) => String(r[col] ?? "").toLowerCase().includes(q));
        return obj;
      },
      contains()  { return obj; },
      overlaps()  { return obj; },
      textSearch(){ return obj; },
      maybeSingle() {
        if (pendingOp) return executeOp().then((r: any) => ({ data: r.data?.[0] ?? null, error: r.error }));
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        if (pendingOp) return executeOp().then((r: any) => ({ data: r.data?.[0] ?? null, error: r.error }));
        const row = filtered[0] ?? null;
        return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "Not found" } });
      },
      then(resolve: any, reject: any) {
        return executeOp().then(resolve, reject);
      },
    };

    function executeOp(): Promise<{ data: Row[]; error: null }> {
      const table = db[tableName] ?? (db[tableName] = []);

      if (pendingOp?.type === "delete") {
        // Track content_translations invalidation
        if (tableName === "content_translations") {
          const entityType = eqConditions.find((c) => c.col === "entity_type")?.val as string | undefined;
          const entityId   = eqConditions.find((c) => c.col === "entity_id")?.val   as string | undefined;
          if (entityType && entityId) {
            track.deletedTranslations.push({ entity_type: entityType, entity_id: entityId });
          }
        }
        const toRemove = new Set(filtered.map((r) => r.id));
        db[tableName] = table.filter((r) => !toRemove.has(r.id));
        pendingOp = null;
        return Promise.resolve({ data: [], error: null });
      }

      if (pendingOp?.type === "update") {
        const updateData = (pendingOp as { type: "update"; data: Row }).data;
        // Track original_language updates (detectAndStoreLanguage observable effect)
        if (updateData.original_language !== undefined) {
          const idCond = eqConditions.find((c) => c.col === "id");
          if (idCond) {
            track.langDetectUpdates.push({
              table: tableName,
              id:    idCond.val as string,
              lang:  updateData.original_language as string,
            });
          }
        }
        const updated: Row[] = [];
        for (const row of filtered) {
          const idx = table.findIndex((r) => r.id === row.id);
          if (idx >= 0) {
            table[idx] = { ...table[idx], ...updateData };
            updated.push(table[idx]);
          } else {
            updated.push({ ...row, ...updateData });
          }
        }
        pendingOp = null;
        return Promise.resolve({ data: updated, error: null });
      }

      return Promise.resolve({ data: filtered, error: null });
    }

    return obj;
  }

  return {
    from(tableName: string) {
      const table = db[tableName] ?? (db[tableName] = []);
      return chain(tableName, [...table]);
    },
    auth: {
      getUser: async (token: string) => {
        const userId = tokens[token];
        if (!userId) return { data: { user: null }, error: { message: "Invalid token" } };
        return { data: { user: { id: userId } }, error: null };
      },
    },
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function doPatch(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RAW_TOKEN}` },
    body:    JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Let fire-and-forget async ops settle before asserting */
const flush = () => new Promise<void>((r) => setTimeout(r, 80));

// ── Server lifecycle ───────────────────────────────────────────────────────────

let server: Server;
let port: number;

async function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      server.unref();
      resolve();
    });
    server.on("error", reject);
  });
}

async function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((e) => (e ? reject(e) : resolve()));
  });
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

function makeDb(): FakeDb {
  return {
    posts: [],
    events: [],
    trips: [],
    event_roles: [],
    event_rsvps: [],
    event_attendees: [],
    event_cohosts: [],
    event_saves: [],
    event_invites: [],
    event_join_requests: [],
    event_waitlist: [],
    event_attendee_states: [],
    trip_members: [],
    feature_flags: [
      { id: "ff1", flag: "disable_posting",           enabled: false },
      { id: "ff2", flag: "events_enabled",             enabled: true  },
      { id: "ff3", flag: "events_trust_gates_enabled", enabled: false },
    ],
    content_translations: [],
    profiles: [],
    post_edits: [],
    notifications: [],
    blocks: [],
    message_threads: [],
    message_thread_members: [],
    trust_events: [],
    trust_profiles: [],
    trust_settings: [],
    trust_caps: [],
    compass_outcomes: [],
    passport_postcards: [],
    stamp_definitions: [],
    user_stamps: [],
  };
}

function seedPost(db: FakeDb) {
  db.posts.push({
    id: POST_ID, author_id: USER_ID, trip_id: null,
    content: "original caption", visibility: "public", status: "active",
    original_language: null,
  });
}

function seedPostTranslation(db: FakeDb) {
  db.content_translations.push({
    id: "ct-post-1",
    entity_type: "post", entity_id: POST_ID, target_language: "es",
    translated_fields: { content: "subtítulo" }, status: "translated",
  });
}

function seedEvent(db: FakeDb) {
  db.events.push({
    id: EVENT_ID, host_id: USER_ID,
    title: "Original Title", description: "Original description",
    location_name: "Venue",
    starts_at: new Date(Date.now() + 86400000).toISOString(), ends_at: null,
    state: "open", visibility: "public",
    chat_enabled: false, chat_thread_id: null, waitlist_enabled: false,
    max_attendees: null, age_min: null, age_max: null,
    trust_score_min: null, verified_only: false,
    cover_url: null, cover_media_type: null, cover_image_width: null, cover_image_height: null,
    price_type: "free", price_url: null,
    going_count: 0, waitlist_count: 0,
    attendee_comments_enabled: false,
    rsvp_options: ["going"], original_language: null,
    category: null, city: "Testville", country: "Testland",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

function seedEventTranslation(db: FakeDb) {
  db.content_translations.push({
    id: "ct-event-1",
    entity_type: "event", entity_id: EVENT_ID, target_language: "fr",
    translated_fields: { title: "Titre", description: "Descriptif" }, status: "translated",
  });
}

function seedTrip(db: FakeDb) {
  db.trips.push({
    id: TRIP_ID, owner_id: USER_ID,
    title: "Original Trip", destination_city: "Paris", destination_country: "France",
    start_date: null, end_date: null, status: "planning",
    trip_notes: null, visibility: "private",
    plan_edit_permission: "owner_only", original_language: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

function seedTripTranslation(db: FakeDb) {
  db.content_translations.push({
    id: "ct-trip-1",
    entity_type: "trip", entity_id: TRIP_ID, target_language: "de",
    translated_fields: { title: "Originalreise" }, status: "translated",
  });
}

function makeTrack(): TrackRecord {
  return { deletedTranslations: [], langDetectUpdates: [] };
}

// ── Tests — single outer describe so node:test runs suites sequentially ───────

describe("translation cache invalidation on edit — all routes", () => {

  // ── PATCH /api/posts/:postId ───────────────────────────────────────────────

  describe("PATCH /api/posts/:postId", () => {
    beforeEach(async () => {
      _setTestTranslationProvider(new MockTranslationProvider());
      await startServer();
    });
    afterEach(async () => {
      _setTestClient(null as any, false);
      _setTestTranslationProvider(null);
      await stopServer();
    });

    it("invalidates content_translations cache when caption changes", async () => {
      const db = makeDb(); seedPost(db); seedPostTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      assert.equal(db.content_translations.length, 1, "pre: translation row seeded");

      const { status } = await doPatch(port, `/api/posts/${POST_ID}`, { content: "updated caption" });
      assert.equal(status, 200, `PATCH failed: ${status}`);
      await flush();

      assert.ok(
        track.deletedTranslations.some((d) => d.entity_type === "post" && d.entity_id === POST_ID),
        "invalidateContentTranslations must delete the post's cache rows",
      );
    });

    it("re-detects language after caption change (original_language updated on posts table)", async () => {
      const db = makeDb(); seedPost(db); seedPostTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      const { status } = await doPatch(port, `/api/posts/${POST_ID}`, { content: "updated caption text" });
      assert.equal(status, 200, `PATCH failed: ${status}`);
      await flush();

      const upd = track.langDetectUpdates.find((u) => u.table === "posts" && u.id === POST_ID);
      assert.ok(upd, "detectAndStoreLanguage must update original_language on the post row");
      assert.equal(upd!.lang, "en", "MockTranslationProvider returns 'en' for ASCII text");
    });

    it("does NOT invalidate translations when only non-text fields are updated", async () => {
      const db = makeDb(); seedPost(db); seedPostTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      await doPatch(port, `/api/posts/${POST_ID}`, { visibility: "public" });
      await flush();

      assert.equal(
        track.deletedTranslations.filter((d) => d.entity_type === "post" && d.entity_id === POST_ID).length,
        0,
        "non-text-field PATCH must not invalidate translations",
      );
    });

    it("does NOT invalidate translations when the new content is identical to the old", async () => {
      const db = makeDb(); seedPost(db); seedPostTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      await doPatch(port, `/api/posts/${POST_ID}`, { content: "original caption" });
      await flush();

      assert.equal(
        track.deletedTranslations.filter((d) => d.entity_type === "post" && d.entity_id === POST_ID).length,
        0,
        "same-content PATCH must not invalidate translations",
      );
    });
  });

  // ── PATCH /api/events/:id ─────────────────────────────────────────────────

  describe("PATCH /api/events/:id", () => {
    beforeEach(async () => {
      _setTestTranslationProvider(new MockTranslationProvider());
      await startServer();
    });
    afterEach(async () => {
      _setTestClient(null as any, false);
      _setTestTranslationProvider(null);
      await stopServer();
    });

    it("invalidates content_translations cache when event title changes", async () => {
      const db = makeDb(); seedEvent(db); seedEventTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      const { status } = await doPatch(port, `/api/events/${EVENT_ID}`, { title: "Updated Event Title" });
      assert.equal(status, 200, `PATCH failed: ${status}`);
      await flush();

      assert.ok(
        track.deletedTranslations.some((d) => d.entity_type === "event" && d.entity_id === EVENT_ID),
        "invalidateContentTranslations must delete the event's cache rows",
      );
    });

    it("invalidates content_translations cache when event description changes", async () => {
      const db = makeDb(); seedEvent(db); seedEventTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      const { status } = await doPatch(port, `/api/events/${EVENT_ID}`, {
        description: "Completely revised description for the event.",
      });
      assert.equal(status, 200, `PATCH failed: ${status}`);
      await flush();

      assert.ok(
        track.deletedTranslations.some((d) => d.entity_type === "event" && d.entity_id === EVENT_ID),
        "invalidateContentTranslations must fire when description changes",
      );
    });

    it("re-detects language after event title change", async () => {
      const db = makeDb(); seedEvent(db); seedEventTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      const { status } = await doPatch(port, `/api/events/${EVENT_ID}`, { title: "A new English title for this event" });
      assert.equal(status, 200, `PATCH failed: ${status}`);
      await flush();

      const upd = track.langDetectUpdates.find((u) => u.table === "events" && u.id === EVENT_ID);
      assert.ok(upd, "detectAndStoreLanguage must update original_language on the event row");
      assert.equal(upd!.lang, "en");
    });

    it("does NOT invalidate translations when only non-text fields are updated", async () => {
      const db = makeDb(); seedEvent(db); seedEventTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      await doPatch(port, `/api/events/${EVENT_ID}`, { coverUrl: "https://example.com/new-cover.jpg" });
      await flush();

      assert.equal(
        track.deletedTranslations.filter((d) => d.entity_type === "event" && d.entity_id === EVENT_ID).length,
        0,
        "non-text-field PATCH must not trigger translation invalidation",
      );
    });
  });

  // ── PATCH /api/trips/:tripId ──────────────────────────────────────────────

  describe("PATCH /api/trips/:tripId", () => {
    beforeEach(async () => {
      _setTestTranslationProvider(new MockTranslationProvider());
      await startServer();
    });
    afterEach(async () => {
      _setTestClient(null as any, false);
      _setTestTranslationProvider(null);
      await stopServer();
    });

    it("invalidates content_translations cache when trip title changes", async () => {
      const db = makeDb(); seedTrip(db); seedTripTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      const { status } = await doPatch(port, `/api/trips/${TRIP_ID}`, { title: "Updated Trip Title" });
      assert.equal(status, 200, `PATCH failed: ${status}`);
      await flush();

      assert.ok(
        track.deletedTranslations.some((d) => d.entity_type === "trip" && d.entity_id === TRIP_ID),
        "invalidateContentTranslations must delete the trip's cache rows",
      );
    });

    it("invalidates content_translations cache when trip_notes changes", async () => {
      const db = makeDb(); seedTrip(db); seedTripTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      const { status } = await doPatch(port, `/api/trips/${TRIP_ID}`, {
        tripNotes: "Added notes about packing for Paris.",
      });
      assert.equal(status, 200, `PATCH failed: ${status}`);
      await flush();

      assert.ok(
        track.deletedTranslations.some((d) => d.entity_type === "trip" && d.entity_id === TRIP_ID),
        "invalidateContentTranslations must fire when trip_notes changes",
      );
    });

    it("re-detects language after trip title change", async () => {
      const db = makeDb(); seedTrip(db); seedTripTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      const { status } = await doPatch(port, `/api/trips/${TRIP_ID}`, { title: "A fully revised trip title in English" });
      assert.equal(status, 200, `PATCH failed: ${status}`);
      await flush();

      const upd = track.langDetectUpdates.find((u) => u.table === "trips" && u.id === TRIP_ID);
      assert.ok(upd, "detectAndStoreLanguage must update original_language on the trip row");
      assert.equal(upd!.lang, "en");
    });

    it("does NOT invalidate translations when only non-text fields are updated", async () => {
      const db = makeDb(); seedTrip(db); seedTripTranslation(db);
      const track = makeTrack();
      _setTestClient(makeFakeClient(db, { [RAW_TOKEN]: USER_ID }, track), true);

      await doPatch(port, `/api/trips/${TRIP_ID}`, { visibility: "public" });
      await flush();

      assert.equal(
        track.deletedTranslations.filter((d) => d.entity_type === "trip" && d.entity_id === TRIP_ID).length,
        0,
        "non-text-field PATCH must not trigger translation invalidation",
      );
    });
  });
});
