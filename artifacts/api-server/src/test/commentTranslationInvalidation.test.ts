/**
 * commentTranslationInvalidation.test.ts
 *
 * Confirms that PATCH /posts/:postId/comments/:commentId:
 *   1. Deletes all content_translations rows for the edited comment
 *      (so readers never see the old translated text).
 *   2. Calls detectAndStoreLanguage for the new body
 *      (posts_comments.original_language is updated).
 *
 * Both side-effects are fire-and-forget (after the 200 response), so the
 * test waits a tick before asserting in-memory DB state.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import app from '../app.js';
import { _setTestClient } from '../lib/http.js';
import {
  MockTranslationProvider,
  _setTestTranslationProvider,
} from '../lib/translation.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const AUTHOR_ID  = 'aaaa0000-0000-0000-0000-000000000001';
const POST_ID    = 'bbbb0000-0000-0000-0000-000000000001';
const COMMENT_ID = 'cccc0000-0000-0000-0000-000000000001';
const TOKEN      = 'test-token-author';

// ── In-memory DB ──────────────────────────────────────────────────────────────

let comments: Record<string, any>             = {};
let contentTranslations: Record<string, any>  = {};
let languageUpdates: Array<{ id: string; original_language: string }> = [];

function resetDb() {
  comments = {
    [COMMENT_ID]: {
      id:         COMMENT_ID,
      post_id:    POST_ID,
      user_id:    AUTHOR_ID,
      body:       'Original comment text',
      created_at: new Date().toISOString(),
      updated_at: null,
      deleted_at: null,
    },
  };

  // Two cached translation rows for the comment (fr + es).
  contentTranslations = {
    [`comment:${COMMENT_ID}:fr`]: {
      entity_type:       'comment',
      entity_id:         COMMENT_ID,
      target_language:   'fr',
      source_language:   'en',
      translated_fields: { body: 'Texte de commentaire original' },
      status:            'translated',
      updated_at:        new Date(Date.now() - 60_000).toISOString(),
    },
    [`comment:${COMMENT_ID}:es`]: {
      entity_type:       'comment',
      entity_id:         COMMENT_ID,
      target_language:   'es',
      source_language:   'en',
      translated_fields: { body: 'Texto de comentario original' },
      status:            'translated',
      updated_at:        new Date(Date.now() - 60_000).toISOString(),
    },
  };

  languageUpdates = [];
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function buildFakeClient() {
  function builder(table: string, rows: any[]): any {
    let filtered   = [...rows];
    let deleteMode = false;
    let updateData: any = null;
    let upsertData: any = null;

    // Apply updateData to filtered rows and persist them.
    function applyUpdate() {
      if (updateData === null) return;
      for (const row of filtered) {
        Object.assign(row, updateData);
        if (table === 'posts_comments') {
          if (comments[row.id]) Object.assign(comments[row.id], updateData);
          if ('original_language' in updateData) {
            languageUpdates.push({ id: row.id, original_language: updateData.original_language });
          }
        }
      }
    }

    const b: any = {
      select(_cols?: string, _opts?: any) { return b; },
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      is(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      neq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] !== val);
        return b;
      },
      in(col: string, vals: any[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      order()       { return b; },
      limit(n: number) { filtered = filtered.slice(0, n); return b; },
      insert(_data: any) { return b; },
      update(data: any)  { updateData = data; return b; },
      upsert(data: any)  { upsertData = data; return b; },
      delete()           { deleteMode = true; return b; },

      async single() {
        applyUpdate();
        return { data: filtered[0] ?? null, error: null };
      },
      async maybeSingle() {
        applyUpdate();
        return { data: filtered[0] ?? null, error: null };
      },

      then(resolve: (v: any) => void) {
        if (deleteMode) {
          if (table === 'content_translations') {
            for (const key of Object.keys(contentTranslations)) {
              const row = contentTranslations[key];
              if (filtered.some(
                (f) =>
                  f.entity_type === row.entity_type &&
                  f.entity_id   === row.entity_id &&
                  f.target_language === row.target_language,
              )) {
                delete contentTranslations[key];
              }
            }
          }
          return resolve({ data: filtered, error: null });
        }

        if (upsertData !== null) {
          return resolve({ data: [], error: null });
        }

        applyUpdate();
        return resolve({ data: filtered, error: null });
      },
    };
    return b;
  }

  return {
    auth: {
      async getUser(token: string) {
        if (token === TOKEN) return { data: { user: { id: AUTHOR_ID } }, error: null };
        return { data: { user: null }, error: new Error('invalid token') };
      },
    },
    from(table: string) {
      let rows: any[] = [];
      if (table === 'posts_comments')           rows = Object.values(comments);
      else if (table === 'content_translations') rows = Object.values(contentTranslations);
      // Other tables return empty — the handler only touches these two.
      return builder(table, rows);
    },
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

before(async () => {
  // Pin the mock translation provider so detectAndStoreLanguage succeeds
  // even when an OpenAI key is present in the environment.
  _setTestTranslationProvider(new MockTranslationProvider());

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  _setTestClient(buildFakeClient() as any, true);
});

after(async () => {
  _setTestTranslationProvider(null);
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

beforeEach(() => {
  resetDb();
  _setTestClient(buildFakeClient() as any, true);
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function patch(path: string, body: object) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/** Drain the microtask + macrotask queue so fire-and-forget calls resolve. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PATCH /api/posts/:postId/comments/:commentId — translation invalidation', () => {
  it('returns 200 with the updated comment body', async () => {
    const { status, data } = await patch(
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}`,
      { body: 'Updated comment body' },
    );
    assert.equal(status, 200);
    assert.ok(data.ok, 'response should have ok=true');
    assert.ok(data.comment, 'response should include the comment object');
    assert.equal(data.comment.body, 'Updated comment body');
  });

  it('removes all content_translations rows for the comment after a body edit', async () => {
    assert.equal(Object.keys(contentTranslations).length, 2, 'two translation rows seeded');

    await patch(
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}`,
      { body: 'Completely different text now' },
    );

    // Give fire-and-forget operations (invalidate + detect) time to settle.
    await flushAsync();
    await flushAsync();

    const remaining = Object.values(contentTranslations).filter(
      (r: any) => r.entity_type === 'comment' && r.entity_id === COMMENT_ID,
    );
    assert.equal(
      remaining.length,
      0,
      `expected 0 translation rows after edit, found ${remaining.length}`,
    );
  });

  it('calls detectAndStoreLanguage for the new body (original_language updated)', async () => {
    await patch(
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}`,
      { body: 'A new body for language detection' },
    );

    // Allow both fire-and-forget tasks to complete.
    await flushAsync();
    await flushAsync();

    const langUpdate = languageUpdates.find((u) => u.id === COMMENT_ID);
    assert.ok(
      langUpdate,
      'expected a posts_comments.original_language update after PATCH (detectAndStoreLanguage not called)',
    );
    assert.ok(
      typeof langUpdate.original_language === 'string' && langUpdate.original_language.length > 0,
      'original_language must be a non-empty language code',
    );
  });

  it('does not touch translations for a different comment on the same post', async () => {
    const OTHER_COMMENT_ID = 'dddd0000-0000-0000-0000-000000000002';
    contentTranslations[`comment:${OTHER_COMMENT_ID}:fr`] = {
      entity_type:       'comment',
      entity_id:         OTHER_COMMENT_ID,
      target_language:   'fr',
      source_language:   'en',
      translated_fields: { body: 'Autre commentaire' },
      status:            'translated',
      updated_at:        new Date().toISOString(),
    };

    await patch(
      `/api/posts/${POST_ID}/comments/${COMMENT_ID}`,
      { body: 'Editing only the first comment' },
    );
    await flushAsync();
    await flushAsync();

    // The other comment's translation must be untouched.
    assert.ok(
      contentTranslations[`comment:${OTHER_COMMENT_ID}:fr`],
      'translation for OTHER_COMMENT_ID must not be removed',
    );
    // The edited comment's translations must be gone.
    const editedRemaining = Object.values(contentTranslations).filter(
      (r: any) => r.entity_type === 'comment' && r.entity_id === COMMENT_ID,
    );
    assert.equal(editedRemaining.length, 0, 'edited comment translations must all be cleared');
  });
});
