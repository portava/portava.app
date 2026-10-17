import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { _setTestOpenAI } from '../lib/openai.js';
import {
  _setTestTranslationProvider,
  OPENAI_TRANSLATION_MODEL,
  OpenAITranslationProvider,
} from '../lib/translation.js';
import {
  __resetConfidenceColumnProbe,
  buildDisplayFields,
  translateMessageForThread,
  type TranslationStatusValue,
} from '../services/messageTranslation.js';
import { makeSchemaStrictClient } from './helpers/schemaStrictSupabase.js';
import { makeFailClosedClient } from './helpers/failClosedSupabase.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const SENDER_ID = '22222222-2222-4222-8222-222222222222';
const RECIPIENT_ID = '33333333-3333-4333-8333-333333333333';
const THREAD_ID = '44444444-4444-4444-8444-444444444444';
const ORIGINAL = 'Nos vemos en el muelle a las ocho. No salgas todavía.';
const TRANSLATED = 'We will meet at the pier at eight. Do not leave yet.';
let networkAttempts = 0;

function completion(content: unknown) {
  return { choices: [{ message: { content } }] };
}

function responses(...results: unknown[]) {
  let responseIndex = 0;
  const create = mock.fn(async (_request: unknown) => {
    const result = results[Math.min(responseIndex, results.length - 1)];
    responseIndex += 1;
    if (result instanceof Error) throw result;
    return result;
  });
  _setTestOpenAI({ chat: { completions: { create } } } as unknown as OpenAI);
  return create;
}

async function translate(senderPreferenceUnreadable = false) {
  const database = makeSchemaStrictClient({
    messages: [{ id: MESSAGE_ID, body: ORIGINAL, thread_id: THREAD_ID, sender_id: SENDER_ID,
      created_at: '2026-10-01T00:00:00.000Z', edited_at: null, deleted_at: null, ciphertext: null,
      original_language: null, language_detection_source: null }],
    message_threads: [{ id: THREAD_ID, is_e2ee: false }],
    message_thread_members: [{ thread_id: THREAD_ID, user_id: RECIPIENT_ID, left_at: null }],
    profiles: [{ id: RECIPIENT_ID, preferred_language: 'en', auto_translate_messages: true }],
  }, { unchecked: ['message_translations'] });
  const originalFrom = database.from.bind(database);
  const blocks = makeFailClosedClient({ rows: { blocks: [] } });
  database.from = table => table === 'blocks' ? blocks.from(table) : originalFrom(table);
  await translateMessageForThread(database as unknown as SupabaseClient, {
    messageId: MESSAGE_ID,
    body: ORIGINAL,
    senderId: SENDER_ID,
    threadId: THREAD_ID,
    senderPreferredLanguage: null,
    senderPreferenceUnreadable,
  });
  const translationWrites = database.writes.filter((write) => write.table === 'message_translations');
  const messageWrites = database.writes.filter((write) => write.table === 'messages');
  assert.equal(translationWrites.length, 1);
  assert.equal(messageWrites.length, 1);
  assert.deepEqual(database.deadColumnErrors, []);
  assert.ok(database.writes.every((write) => write.rows.every((row) => !('body' in row))));
  return { row: translationWrites[0].rows[0], stamp: messageWrites[0].rows[0] };
}

beforeEach(() => {
  networkAttempts = 0;
  __resetConfidenceColumnProbe();
  _setTestTranslationProvider(new OpenAITranslationProvider());
  mock.method(globalThis, 'fetch', async () => {
    networkAttempts += 1;
    throw new Error('network_forbidden');
  });
});

afterEach(() => {
  _setTestOpenAI(null);
  _setTestTranslationProvider(null);
  mock.restoreAll();
  assert.equal(networkAttempts, 0);
});

describe('OpenAI language detection response validation', () => {
  for (const [label, content] of [
    ['invalid JSON', 'not JSON'],
    ['empty content', ''],
    ['whitespace content', '   '],
    ['empty object', '{}'],
    ['null object', 'null'],
    ['array', '[{"language":"en"}]'],
    ['string', '"en"'],
    ['number', '12'],
    ['boolean', 'true'],
    ['wrong field', '{"lang":"en"}'],
    ['null language', '{"language":null}'],
    ['numeric language', '{"language":123}'],
    ['boolean language', '{"language":true}'],
    ['object language', '{"language":{"code":"en"}}'],
    ['array language', '{"language":["en"]}'],
    ['empty language', '{"language":""}'],
    ['whitespace language', '{"language":"  "}'],
    ['language name instead of code', '{"language":"English"}'],
    ['unrecognized language code', '{"language":"zz"}'],
    ['undetermined language', '{"language":"und"}'],
    ['no linguistic content', '{"language":"zxx"}'],
    ['malformed locale', '{"language":"en_US"}'],
  ]) {
    it(`rejects ${label} instead of inventing a language`, async () => {
      responses(completion(content));
      await assert.rejects(new OpenAITranslationProvider().detectLanguage(ORIGINAL), {
        message: 'invalid_language_detection',
      });
    });
  }

  for (const [label, result] of [
    ['missing choices', {}],
    ['empty choices', { choices: [] }],
    ['missing message', { choices: [{}] }],
    ['missing content', completion(undefined)],
    ['null content', completion(null)],
    ['non-string content', completion({ language: 'en' })],
  ] as const) {
    it(`rejects ${label}`, async () => {
      responses(result);
      await assert.rejects(new OpenAITranslationProvider().detectLanguage(ORIGINAL), {
        message: 'invalid_language_detection',
      });
    });
  }

  it('preserves valid language codes, locale variants and languages beyond the target-name map', async () => {
    for (const language of [
      'en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'zh-TW', 'pt', 'it', 'ru',
      'ar', 'th', 'vi', 'id', 'tl', 'sv', 'nl', 'pl', 'tr', 'hi',
      'uk', 'eu', 'fa', 'lo', 'km', 'my', 'zh-Hant', 'pt-BR',
    ]) {
      responses(completion(` \n${JSON.stringify({ language, confidence: 'high', extra: true })}\n `));
      assert.deepEqual(await new OpenAITranslationProvider().detectLanguage(ORIGINAL), {
        language, confidence: 'high',
      });
    }
  });

  it('keeps the conservative confidence default only for a valid language', async () => {
    for (const confidence of ['low', undefined, null, 'unrecognized', 0]) {
      responses(completion(JSON.stringify({ language: 'es', confidence })));
      assert.deepEqual(await new OpenAITranslationProvider().detectLanguage(ORIGINAL), {
        language: 'es', confidence: 'low',
      });
    }
  });

  it('keeps detection requests bounded and uses the configured model', async () => {
    const create = responses(completion('{"language":"es","confidence":"high"}'));
    await new OpenAITranslationProvider().detectLanguage(ORIGINAL.repeat(10));
    const request = create.mock.calls[0].arguments[0] as {
      model: string; messages: Array<{ content: string }>; max_completion_tokens: number;
    };
    assert.equal(request.model, OPENAI_TRANSLATION_MODEL);
    assert.equal(request.messages[1].content, ORIGINAL.repeat(10).slice(0, 200));
    assert.equal(request.max_completion_tokens, 200);
  });

  it('propagates provider failures instead of inventing English', async () => {
    responses(new Error('offline_provider_failure'));
    await assert.rejects(new OpenAITranslationProvider().detectLanguage(ORIGINAL), {
      message: 'offline_provider_failure',
    });
  });

  it('preserves translation text and provider metadata', async () => {
    const create = responses(completion(` ${TRANSLATED} `));
    assert.deepEqual(await new OpenAITranslationProvider().translateText(ORIGINAL, 'es', 'en'), {
      translatedText: TRANSLATED,
      provider: 'openai',
      providerVersion: OPENAI_TRANSLATION_MODEL,
    });
    assert.equal((create.mock.calls[0].arguments[0] as { model: string }).model, OPENAI_TRANSLATION_MODEL);
  });
});

describe('actual provider parsing through the message fallback pipeline', () => {
  for (const content of ['{}', 'not JSON']) {
    for (const unreadable of [false, true]) {
      it(`${content}, preference ${unreadable ? 'unreadable' : 'absent'}: retains the original as unavailable`, async () => {
        const create = responses(completion(content));
        const { row, stamp } = await translate(unreadable);
        assert.equal(row.status, 'failed');
        assert.equal(stamp.language_detection_source, unreadable ? 'sender_preference_unreadable' : 'default');
        assert.equal(row.error_message, 'source_language_unverified');
        assert.equal(row.source_language, 'und');
        assert.equal(row.target_language, 'en');
        assert.equal(row.translated_body, null);
        assert.equal(row.provider, null);
        assert.equal(row.provider_version, null);
        assert.equal(row.confidence, null);
        assert.equal(create.mock.callCount(), 2);
        const display = buildDisplayFields({
          body: ORIGINAL, senderId: SENDER_ID, deleted: false, originalLanguage: 'en',
        }, RECIPIENT_ID, {
          source_language: String(row.source_language),
          target_language: String(row.target_language),
          translated_body: row.translated_body as string | null,
          status: row.status as TranslationStatusValue,
        });
        assert.equal(display.displayBody, ORIGINAL);
        assert.equal(display.originalBody, ORIGINAL);
        assert.equal(display.originalLanguage, 'und');
        assert.equal(display.translationStatus, 'failed');
        assert.equal(display.translated, false);
        assert.equal(display.translationLabel, null);
        assert.equal(display.translationConfidence, null);
      });
    }
  }

  it('allows a valid English detection to establish a same-language skip', async () => {
    const create = responses(completion('{"language":"en","confidence":"low"}'));
    const { row, stamp } = await translate();
    assert.equal(create.mock.callCount(), 1);
    assert.equal(stamp.language_detection_source, 'provider');
    assert.equal(stamp.original_language, 'en');
    assert.equal(row.status, 'skipped');
    assert.equal(row.source_language, 'en');
    assert.equal(row.error_message, null);
    assert.equal(row.translated_body, null);
  });

  it('recovers on valid retry and retains actual translation provenance', async () => {
    const create = responses(
      completion('{}'),
      completion('{"language":"es","confidence":"high"}'),
      completion(TRANSLATED),
    );
    const { row, stamp } = await translate();
    assert.equal(create.mock.callCount(), 3);
    assert.equal(stamp.language_detection_source, 'provider');
    assert.equal(stamp.original_language, 'es');
    assert.equal(row.status, 'translated');
    assert.equal(row.source_language, 'es');
    assert.equal(row.error_message, null);
    assert.equal(row.translated_body, TRANSLATED);
    assert.equal(row.provider, 'openai');
    assert.equal(row.provider_version, OPENAI_TRANSLATION_MODEL);
  });
});
