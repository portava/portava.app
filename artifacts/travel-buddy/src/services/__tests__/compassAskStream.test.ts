/**
 * postCompassAskStream — SSE consumption, progressive message extraction,
 * done-event finalization, and non-streaming fallback.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPartialCompassMessage,
  finalizeCompassMessage,
  splitCompassSseBuffer,
  postCompassAskStream,
  _setTestAuthToken,
  _setTestStreamFetch,
} from '../compass.ts';

// postCompassAskStream requires isSupabaseConfigured + apiBase(); provide both.
process.env['EXPO_PUBLIC_API_BASE_URL'] = process.env['EXPO_PUBLIC_API_BASE_URL'] || 'http://test.local';

describe('extractPartialCompassMessage', () => {
  it('returns empty until the message field starts', () => {
    assert.equal(extractPartialCompassMessage('{'), '');
    assert.equal(extractPartialCompassMessage('{"mess'), '');
    assert.equal(extractPartialCompassMessage('{"message"'), '');
    assert.equal(extractPartialCompassMessage('{"message": '), '');
  });

  it('decodes the partial message as it grows', () => {
    assert.equal(extractPartialCompassMessage('{"message":"Hel'), 'Hel');
    assert.equal(extractPartialCompassMessage('{"message":"Hello wor'), 'Hello wor');
  });

  it('stops at the closing quote and hides trailing envelope fields', () => {
    const raw = '{"message":"Try Lantaw.","quickActions":[{"label":"Add"';
    assert.equal(extractPartialCompassMessage(raw), 'Try Lantaw.');
  });

  it('decodes escapes, including split-mid-escape safety', () => {
    assert.equal(extractPartialCompassMessage('{"message":"a\\nb"'), 'a\nb');
    assert.equal(extractPartialCompassMessage('{"message":"say \\"hi\\""'), 'say "hi"');
    // dangling escape at the end of the stream must not throw or emit garbage
    assert.equal(extractPartialCompassMessage('{"message":"abc\\'), 'abc');
    assert.equal(extractPartialCompassMessage('{"message":"abc\\u00'), 'abc');
    assert.equal(extractPartialCompassMessage('{"message":"caf\\u00e9"'), 'café');
  });

  it('strips markdown fences around the envelope', () => {
    assert.equal(extractPartialCompassMessage('```json\n{"message":"Hi the'), 'Hi the');
  });

  it('passes plain-text (non-envelope) output through as-is', () => {
    assert.equal(extractPartialCompassMessage('Just a plain ans'), 'Just a plain ans');
  });
});

describe('finalizeCompassMessage', () => {
  it('parses the full envelope', () => {
    assert.equal(finalizeCompassMessage('{"message":"Done!","quickActions":[]}'), 'Done!');
  });
  it('strips code fences before parsing', () => {
    assert.equal(finalizeCompassMessage('```json\n{"message":"Fenced"}\n```'), 'Fenced');
  });
  it('falls back to raw text when not JSON', () => {
    assert.equal(finalizeCompassMessage('plain reply'), 'plain reply');
  });
});

describe('splitCompassSseBuffer', () => {
  it('parses complete events and keeps the unterminated remainder', () => {
    const { events, rest } = splitCompassSseBuffer(
      'data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\ndata: {"del',
    );
    assert.deepEqual(events, [{ delta: 'a' }, { delta: 'b' }]);
    assert.equal(rest, 'data: {"del');
  });
  it('skips malformed events without throwing', () => {
    const { events } = splitCompassSseBuffer('data: not-json\n\ndata: {"done":true}\n\n');
    assert.deepEqual(events, [{ done: true }]);
  });
});

// ── postCompassAskStream integration (fake streaming fetch) ─────────────────

function sseResponse(eventStrings: string[], contentType = 'text/event-stream'): any {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= eventStrings.length) return { value: undefined, done: true };
          return { value: encoder.encode(eventStrings[i++]), done: false };
        },
      }),
    },
  };
}

describe('postCompassAskStream', () => {
  beforeEach(() => { _setTestAuthToken('tok'); });
  afterEach(() => { _setTestAuthToken(null); _setTestStreamFetch(undefined); });

  it('streams deltas progressively and finalizes from the done event', async () => {
    const chunks = [
      'data: {"delta":"{\\"message\\":\\"Hel"}\n\n',
      'data: {"delta":"lo!\\""}\n\n',
      'data: {"delta":",\\"quickActions\\":[]}"}\n\n',
      'data: {"done":true,"conversationId":"c1","promptVersion":"v9","payload":null,'
        + '"quickActions":[{"label":"Explore","actionType":"explore"}],'
        + '"pendingProposals":[{"proposalId":"p1"}],"uiBlocks":[{"type":"map","places":[]}]}\n\n',
    ];
    const seen: string[] = [];
    _setTestStreamFetch((async () => sseResponse(chunks)) as any);
    const r = await postCompassAskStream('hi', {}, { onDelta: (m) => seen.push(m) });
    assert.equal(r.ok, true);
    assert.equal(r.streamed, true);
    assert.deepEqual(seen, ['Hel', 'Hello!', 'Hello!']);
    assert.equal(r.data?.message, 'Hello!');
    assert.equal(r.data?.conversationId, 'c1');
    assert.equal(r.data?.promptVersion, 'v9');
    assert.deepEqual(r.data?.quickActions, [{ label: 'Explore', actionType: 'explore' }]);
    assert.equal(r.data?.pendingProposals?.length, 1);
    assert.equal(r.data?.uiBlocks?.length, 1);
  });

  it('handles SSE events split across chunk boundaries', async () => {
    const chunks = [
      'data: {"delta":"{\\"message\\":\\"pa',       // event cut mid-line…
      'rt\\"}"}\n\ndata: {"done":true,"conversationId":null,"promptVersion":"v1","quickActions":[]}\n\n',
    ];
    _setTestStreamFetch((async () => sseResponse(chunks)) as any);
    const r = await postCompassAskStream('hi');
    assert.equal(r.ok, true);
    assert.equal(r.data?.message, 'part');
  });

  it('falls back to the plain request when the stream errors', async () => {
    let calls = 0;
    _setTestStreamFetch((async () => {
      calls++;
      return sseResponse(['data: {"error":true,"message":"unavailable"}\n\n']);
    }) as any);
    // The fallback path uses the GLOBAL fetch (postCompassAsk); stub it.
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ conversationId: 'c2', message: 'fallback answer', payload: null, quickActions: [], promptVersion: 'v1' }),
    });
    try {
      const r = await postCompassAskStream('hi');
      assert.equal(calls, 1);
      assert.equal(r.ok, true);
      assert.equal(r.streamed, false);
      assert.equal(r.data?.message, 'fallback answer');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('falls back when the response has no readable stream body', async () => {
    _setTestStreamFetch((async () => ({ ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: null })) as any);
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ conversationId: null, message: 'plain', payload: null, quickActions: [], promptVersion: 'v1' }),
    });
    try {
      const r = await postCompassAskStream('hi');
      assert.equal(r.ok, true);
      assert.equal(r.streamed, false);
      assert.equal(r.data?.message, 'plain');
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it('does not fall back on an HTTP error status', async () => {
    _setTestStreamFetch((async () => ({ ok: false, status: 429 })) as any);
    const r = await postCompassAskStream('hi');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'http_429');
  });
});
