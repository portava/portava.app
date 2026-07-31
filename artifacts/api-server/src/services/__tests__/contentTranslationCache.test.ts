/**
 * contentTranslationCache.test.ts
 *
 * Confirms that the content translation service caches results correctly:
 *
 *   1. A second call for the same (entityType, entityId, targetLanguage)
 *      returns cached translated_fields without calling the translation
 *      provider again.
 *
 *   2. Calling `invalidateContentTranslations` removes the cache row so the
 *      next call re-translates (provider is called again).
 *
 *   3. The GET /api/content/:entityType/:entityId/translation endpoint returns
 *      `{ ok: true, skipped: true }` when sourceLanguage === targetLanguage.
 *
 * Uses node:test + a hand-written fake Supabase client — no live database or
 * real OpenAI key required.  The MockTranslationProvider from translation.ts
 * is used; its translateText() calls are counted via a spy wrapper.
 *
 * Run: node --import tsx/esm --test
 *        src/services/__tests__/contentTranslationCache.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../../app.js";
import { _setTestClient } from "../../lib/http.js";
import {
  MockTranslationProvider,
  _setTestTranslationProvider,
  type TranslationProvider,
  type TranslateTextResult,
  type DetectLanguageResult,
} from "../../lib/translation.js";
import {
  translateContentFields,
  invalidateContentTranslations,
  type ContentEntityType,
} from "../contentTranslation.js";

// ── UUIDs ─────────────────────────────────────────────────────────────────────

const ENTITY_ID = "aaaaaaaa-3179-0000-0000-000000000001";
const USER_ID   = "bbbbbbbb-3179-0000-0000-000000000001";
const POST_ID   = "cccccccc-3179-0000-0000-000000000001";
const RAW_TOKEN = `fake-token-${USER_ID}`;

// ── Spy provider ──────────────────────────────────────────────────────────────

/**
 * Wraps MockTranslationProvider and counts translateText() calls.
 */
class SpyTranslationProvider implements TranslationProvider {
  private inner = new MockTranslationProvider();
  public translateCallCount = 0;

  async detectLanguage(text: string): Promise<DetectLanguageResult> {
    return this.inner.detectLanguage(text);
  }

  async translateText(
    text: string,
    source: string,
    target: string,
  ): Promise<TranslateTextResult> {
    this.translateCallCount++;
    return this.inner.translateText(text, source, target);
  }
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface Row { [k: string]: any }
type FakeDb = Record<string, Row[]>;

/**
 * Minimal fake client that supports the query surface used by
 * translateContentFields and invalidateContentTranslations.
 */
function makeFakeClient(db: FakeDb, tokens?: Record<string, string>) {
  function chain(tableName: string, initialRows: Row[]) {
    let filtered: Row[] = [...initialRows];
    let pendingOp:
      | null
      | { type: "delete" }
      | { type: "update"; data: Row }
      | { type: "upsert"; data: Row; onConflict?: string } = null;
    const eqConditions: Array<{ col: string; val: any }> = [];

    const obj: any = {
      select()                   { return obj; },
      eq(col: string, val: any)  {
        filtered = filtered.filter((r) => r[col] === val);
        eqConditions.push({ col, val });
        return obj;
      },
      neq(col: string, val: any) { filtered = filtered.filter((r) => r[col] !== val); return obj; },
      is(col: string, val: any)  {
        filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return obj;
      },
      in(col: string, vals: any[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return obj; },
      or()      { return obj; },
      order()   { return obj; },
      limit(n: number) { filtered = filtered.slice(0, n); return obj; },
      not()     { return obj; },
      contains(){ return obj; },

      update(data: Row) { pendingOp = { type: "update", data }; return obj; },
      delete()          { pendingOp = { type: "delete" };       return obj; },

      upsert(data: Row | Row[], opts?: { onConflict?: string }) {
        const table = db[tableName] ?? (db[tableName] = []);
        const rows  = Array.isArray(data) ? data : [data];
        rows.forEach((r) => {
          // Conflict key: entity_type + entity_id + target_language
          const idx = table.findIndex(
            (row) =>
              r.entity_type      !== undefined &&
              row.entity_type    === r.entity_type &&
              row.entity_id      === r.entity_id &&
              row.target_language === r.target_language,
          );
          if (idx >= 0) Object.assign(table[idx], r);
          else table.push({ id: `fake-${tableName}-${Date.now()}`, ...r });
        });
        filtered = rows;
        pendingOp = null;
        return obj;
      },

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
        const toRemove = new Set(filtered.map((r) => r.id));
        db[tableName] = table.filter((r) => !toRemove.has(r.id));
        pendingOp = null;
        return Promise.resolve({ data: [], error: null });
      }

      if (pendingOp?.type === "update") {
        const updateData = (pendingOp as { type: "update"; data: Row }).data;
        const updated: Row[] = [];
        for (const row of filtered) {
          const idx = table.findIndex((r) => r.id === row.id);
          if (idx >= 0) {
            table[idx] = { ...table[idx], ...updateData };
            updated.push(table[idx]);
          }
        }
        pendingOp = null;
        return Promise.resolve({ data: updated, error: null });
      }

      pendingOp = null;
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
        const userId = (tokens ?? {})[token];
        if (!userId) return { data: { user: null }, error: { message: "Invalid token" } };
        return { data: { user: { id: userId } }, error: null };
      },
    },
  };
}

// ── DB factory ─────────────────────────────────────────────────────────────────

function makeDb(): FakeDb {
  return {
    content_translations: [],
    posts:      [],
    profiles:   [],
    blocks:     [],
    user_follows: [],
    events:     [],
    event_roles:[],
    event_rsvps:[],
    trips:      [],
    trip_members:[],
    posts_comments: [],
    feature_flags: [],
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

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

async function doGet(path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${RAW_TOKEN}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Seed helpers ───────────────────────────────────────────────────────────────

function seedPost(db: FakeDb, overrides: Partial<Row> = {}) {
  db.posts.push({
    id: POST_ID,
    author_id: USER_ID,
    content: "Hola mundo desde Portava",
    visibility: "public",
    status: "active",
    post_status: "published",
    original_language: "es",
    trip_id: null,
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("content translation cache — translateContentFields", () => {
  let spy: SpyTranslationProvider;
  let db: FakeDb;

  beforeEach(() => {
    spy = new SpyTranslationProvider();
    _setTestTranslationProvider(spy);
    db = makeDb();
  });

  afterEach(() => {
    _setTestClient(null as any, false);
    _setTestTranslationProvider(null);
  });

  it("calls the provider on the first request and stores the result in content_translations", async () => {
    const sc = makeFakeClient(db) as any;

    const result = await translateContentFields(sc, {
      entityType: "post" as ContentEntityType,
      entityId:   ENTITY_ID,
      fields:     { content: "Hola mundo" },
      sourceLanguage: "es",
      targetLanguage: "en",
    });

    assert.equal(result.status, "translated", "first call should translate");
    assert.equal(spy.translateCallCount, 1, "provider must be called exactly once");

    const cached = db.content_translations.find(
      (r: Row) =>
        r.entity_type     === "post" &&
        r.entity_id       === ENTITY_ID &&
        r.target_language === "en",
    );
    assert.ok(cached, "cache row must be written after first translation");
    assert.equal(cached!.status, "translated");
  });

  it("returns cached translated_fields on second call — provider is NOT called again", async () => {
    const sc = makeFakeClient(db) as any;

    const params = {
      entityType: "post" as ContentEntityType,
      entityId:   ENTITY_ID,
      fields:     { content: "Hola mundo" },
      sourceLanguage: "es",
      targetLanguage: "en",
    };

    // First call — populates the cache.
    const first = await translateContentFields(sc, params);
    assert.equal(first.status, "translated");
    assert.equal(spy.translateCallCount, 1);

    // Second call — must hit the cache, not the provider.
    const second = await translateContentFields(sc, params);
    assert.equal(second.status, "translated", "second call must still be 'translated'");
    assert.equal(
      spy.translateCallCount,
      1,
      "provider must NOT be called again on a cache hit",
    );

    // The returned fields must match the first translation.
    assert.deepEqual(
      second.translatedFields,
      first.translatedFields,
      "cached translated_fields must equal the first result",
    );
  });

  it("skips translation (status 'skipped') when sourceLanguage === targetLanguage", async () => {
    const sc = makeFakeClient(db) as any;

    const result = await translateContentFields(sc, {
      entityType: "event" as ContentEntityType,
      entityId:   ENTITY_ID,
      fields:     { title: "Summer Festival" },
      sourceLanguage: "en",
      targetLanguage: "en",
    });

    assert.equal(result.status, "skipped", "same-language pair must be skipped");
    assert.equal(spy.translateCallCount, 0, "provider must not be called for same-language");
    assert.deepEqual(result.translatedFields, {});
  });

  it("invalidateContentTranslations removes the cache row — next call re-translates", async () => {
    const sc = makeFakeClient(db) as any;

    const params = {
      entityType: "post" as ContentEntityType,
      entityId:   ENTITY_ID,
      fields:     { content: "Hola mundo" },
      sourceLanguage: "es",
      targetLanguage: "en",
    };

    // Prime the cache.
    await translateContentFields(sc, params);
    assert.equal(spy.translateCallCount, 1, "first call invokes provider");

    const before = db.content_translations.filter(
      (r: Row) => r.entity_id === ENTITY_ID && r.entity_type === "post",
    );
    assert.equal(before.length, 1, "one cache row must exist before invalidation");

    // Invalidate.
    await invalidateContentTranslations(sc as any, "post", ENTITY_ID);

    const after = db.content_translations.filter(
      (r: Row) => r.entity_id === ENTITY_ID && r.entity_type === "post",
    );
    assert.equal(after.length, 0, "cache row must be deleted by invalidation");

    // Next call must re-translate, not serve a cache hit.
    const reTranslated = await translateContentFields(sc, params);
    assert.equal(reTranslated.status, "translated");
    assert.equal(
      spy.translateCallCount,
      2,
      "provider must be called again after cache invalidation",
    );
  });

  it("a different targetLanguage is a separate cache entry — no cross-language pollution", async () => {
    const sc = makeFakeClient(db) as any;

    const base = {
      entityType: "post" as ContentEntityType,
      entityId:   ENTITY_ID,
      fields:     { content: "Bonjour le monde" },
      sourceLanguage: "fr",
    };

    await translateContentFields(sc, { ...base, targetLanguage: "en" });
    await translateContentFields(sc, { ...base, targetLanguage: "de" });

    // Both entries exist independently.
    const enRow = db.content_translations.find(
      (r: Row) => r.entity_id === ENTITY_ID && r.target_language === "en",
    );
    const deRow = db.content_translations.find(
      (r: Row) => r.entity_id === ENTITY_ID && r.target_language === "de",
    );
    assert.ok(enRow, "English cache entry must exist");
    assert.ok(deRow, "German cache entry must exist");

    // A third call to 'en' must be a cache hit — provider count stays at 2.
    await translateContentFields(sc, { ...base, targetLanguage: "en" });
    assert.equal(spy.translateCallCount, 2, "third call must hit the 'en' cache");
  });
});

// ── HTTP endpoint: source === target → { ok: true, skipped: true } ────────────

describe("GET /api/content/:entityType/:entityId/translation — source == target skips", () => {
  let db: FakeDb;

  beforeEach(async () => {
    _setTestTranslationProvider(new SpyTranslationProvider());
    db = makeDb();
    seedPost(db, { original_language: "en" });
    _setTestClient(
      makeFakeClient(db, { [RAW_TOKEN]: USER_ID }),
      true,
    );
    await startServer();
  });

  afterEach(async () => {
    _setTestClient(null as any, false);
    _setTestTranslationProvider(null);
    await stopServer();
  });

  it("returns { ok: true, skipped: true } when lang matches the entity's original_language", async () => {
    const { status, body } = await doGet(
      `/api/content/post/${POST_ID}/translation?lang=en`,
    );

    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    const b = body as any;
    assert.equal(b?.ok, true, "ok must be true");
    assert.equal(b?.skipped, true, "skipped must be true when source === target");
  });
});
