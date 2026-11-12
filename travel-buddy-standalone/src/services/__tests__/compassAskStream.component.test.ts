/**
 * postCompassAskStream — SSE consumption, progressive message extraction,
 * done-event finalization, and non-streaming fallback.
 */
import assert from 'node:assert/strict';

// postCompassAskStream requires isSupabaseConfigured + apiBase(). Supabase's
// config is read when lib/supabase.ts loads, so the env is set first and the
// service is required after it (a static import is hoisted above these lines,
// which left every stream case answering "not configured").
process.env['EXPO_PUBLIC_API_BASE_URL'] = process.env['EXPO_PUBLIC_API_BASE_URL'] || 'http://test.local';
process.env['EXPO_PUBLIC_SUPABASE_URL'] ??= 'https://test.supabase.co';
process.env['EXPO_PUBLIC_SUPABASE_ANON_KEY'] ??= 'test-anon-key';

const {
  extractPartialCompassMessage,
  finalizeCompassMessage,
  splitCompassSseBuffer,
  postCompassAskStream,
  _setTestAuthToken,
  _setTestStreamFetch,
} = require('../compass.ts') as typeof import('../compass.ts');

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

  it('uses the grounded terminal message, including when no deltas arrive and the native connection stays open', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"delta":"draft"}\r\n\r',
      '\ndata: {"done":true,\r\ndata: "message":"Try Đà Nẵng.","conversationId":"c2"}\r\n\r\n',
    ];
    let readCount = 0;
    const read = async () => {
      if (readCount === chunks.length) throw new Error('reader remained open after done');
      return { value: encoder.encode(chunks[readCount++]), done: false };
    };
    const response = sseResponse([]);
    response.body.getReader = () => ({ read });
    _setTestStreamFetch((async () => response) as any);
    const withDelta = await postCompassAskStream('hi');
    assert.equal(withDelta.data?.message, 'Try Đà Nẵng.');
    assert.equal(withDelta.data?.conversationId, 'c2');
    _setTestStreamFetch((async () => sseResponse(['data: {"done":true,"message":"Only final"}\n\n'])) as any);
    assert.equal((await postCompassAskStream('hi')).data?.message, 'Only final');
  });

  it('surfaces the server refusal from the original request without posting the prompt again', async () => {
    let calls = 0;
    _setTestStreamFetch((async () => {
      calls++;
      return sseResponse(['data: {"error":true,"message":"Could not check this layover.","conversationId":"c1","fallbackReason":"layover_state_unreadable"}\n\n']);
    }) as any);
    const realFetch = globalThis.fetch;
    const repost = jest.fn();
    globalThis.fetch = repost;
    try {
      const r = await postCompassAskStream('hi');
      assert.equal(calls, 1);
      assert.equal(repost.mock.calls.length, 0);
      assert.equal(r.data?.message, 'Could not check this layover.');
      assert.equal(r.data?.fallback, true);
      assert.equal(r.data?.fallbackReason, 'layover_state_unreadable');
      assert.equal(r.data?.conversationId, 'c1');
    } finally { globalThis.fetch = realFetch; }
  });

  it('reads the same buffered response on clients without a body reader', async () => {
    _setTestStreamFetch((async () => ({
      ok: true, headers: { get: () => 'text/event-stream' }, body: null,
      text: async () => 'data: {"done":true,"message":"Buffered tip"}\n\n',
    })) as any);
    const result = await postCompassAskStream('hi');
    assert.equal(result.data?.message, 'Buffered tip');
    assert.equal(result.streamed, false);
  });

  it('renders JSON fallbacks returned before the event stream opens', async () => {
    _setTestStreamFetch((async () => ({
      ok: true, headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ message: 'Compass is unavailable.', fallback: true, fallbackReason: 'conversation_error' }),
    })) as any);
    const result = await postCompassAskStream('hi');
    assert.equal(result.data?.message, 'Compass is unavailable.');
    assert.equal(result.data?.fallback, true);
  });

  it('turns incomplete and empty successes into visible errors without a second POST', async () => {
    _setTestStreamFetch((async () => sseResponse(['data: {"delta":"partial"}\n\n'])) as any);
    assert.equal((await postCompassAskStream('hi')).error, 'stream_incomplete');
    _setTestStreamFetch((async () => sseResponse(['data: {"done":true,"message":" "}\n\n'])) as any);
    assert.equal((await postCompassAskStream('hi')).error, 'empty_response');
  });

  it('settles on the deadline even when native reader.read ignores abort', async () => {
    jest.useFakeTimers();
    try {
      const response = sseResponse([]);
      const read = jest.fn(() => new Promise(() => {}));
      response.body.getReader = () => ({ read });
      _setTestStreamFetch((async () => response) as any);
      const turn = postCompassAskStream('hi');
      await jest.advanceTimersByTimeAsync(1);
      assert.equal(read.mock.calls.length, 1);
      await jest.advanceTimersByTimeAsync(30_000);
      assert.equal((await turn).error, 'timeout');
    } finally { jest.useRealTimers(); }
  });

  it('does not fall back on an HTTP error status', async () => {
    _setTestStreamFetch((async () => ({ ok: false, status: 429 })) as any);
    const r = await postCompassAskStream('hi');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'http_429');
  });
});

describe('Compass account changes during a streamed reply', () => {
  const scope = require('../discoveryViewerScope.ts') as typeof import('../discoveryViewerScope.ts');
  afterEach(() => { scope._resetDiscoveryViewerScopeForTests(); _setTestAuthToken(null); _setTestStreamFetch(undefined); });

  it('withholds both incremental text and the terminal result after an account switch', async () => {
    scope._resetDiscoveryViewerScopeForTests();
    scope.noteDiscoveryViewer('t:first');
    _setTestAuthToken('first');
    const seen: string[] = [];
    _setTestStreamFetch((async () => {
      scope.noteDiscoveryViewer('t:second');
      return sseResponse(['data: {"delta":"Private reply"}\n\ndata: {"done":true,"message":"Private reply"}\n\n']);
    }) as typeof fetch);
    const result = await postCompassAskStream('My private question', {}, { onDelta: value => seen.push(value) });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'session_changed');
    assert.deepEqual(seen, []);
    assert.equal(result.data, undefined);
  });

  it('does not send the previous account prompt using the new account token', async () => {
    scope._resetDiscoveryViewerScopeForTests();
    scope.noteDiscoveryViewer('t:first');
    _setTestAuthToken('second');
    let calls = 0;
    _setTestStreamFetch((async () => { calls += 1; return sseResponse([]); }) as typeof fetch);
    const result = await postCompassAskStream('My private question');
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  });
});
