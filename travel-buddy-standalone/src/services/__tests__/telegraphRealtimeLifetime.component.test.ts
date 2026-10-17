jest.mock('@supabase/supabase-js', () => ({
  ...jest.requireActual('@supabase/supabase-js'),
  createClient: jest.fn(() => ({})),
}));

const originalXHR = global.XMLHttpRequest;
const originalFetch = global.fetch;
const originalApi = process.env.EXPO_PUBLIC_API_BASE_URL;
const stops: Array<() => void> = [];
const instances: TestXHR[] = [];
let realtime: typeof import('../telegraphRealtimeService.ts').telegraphRealtime;
let tokens: typeof import('../apiToken.ts');
let cursors: typeof import('../../features/telegraph/connection/sequenceCursorStore.ts');
const auth = { getSession: jest.fn(), refreshSession: jest.fn() };

class TestXHR {
  readyState = 0;
  status = 0;
  responseText = '';
  aborts = 0;
  abortCallback: (() => void) | null = null;
  sends = 0;
  url = '';
  headers: Record<string, string> = {};
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() { instances.push(this); }
  open(method: string, url: string) {
    expect(method).toBe('GET');
    expect(url).toBe('http://127.0.0.1:9/api/telegraph/stream');
    this.url = url;
  }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send() { this.sends += 1; }
  abort() { this.aborts += 1; this.abortCallback?.(); }
  callbacks() {
    return { onreadystatechange: this.onreadystatechange, onerror: this.onerror, ontimeout: this.ontimeout };
  }
  state(readyState: number, text = '', callback = this.onreadystatechange) {
    this.readyState = readyState;
    this.status = 200;
    this.responseText = text;
    callback?.();
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
}
function session(token = 'current-token') {
  return { data: { session: { access_token: token, expires_at: 4_000_000_000 } } };
}
async function flush() {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}
function subscribe(listener = jest.fn()) {
  const stop = realtime.subscribe(listener);
  stops.push(stop);
  return { stop, listener };
}
function frame(type: string, marker = '') {
  return `data: ${JSON.stringify({ type, threadId: 'thread-one', payload: { marker }, ts: '2026-10-16T00:00:00Z' })}\n\n`;
}
async function replacedConnection() {
  const previous = subscribe();
  await flush();
  const old = instances[0];
  old.state(2);
  const callbacks = old.callbacks();
  previous.stop();
  const current = subscribe();
  await flush();
  return { old, callbacks, current: instances[1], listener: current.listener };
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  instances.length = 0;
  stops.length = 0;
  auth.getSession.mockReset().mockResolvedValue(session());
  auth.refreshSession.mockReset().mockResolvedValue({ data: { session: null } });
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  global.XMLHttpRequest = TestXHR as unknown as typeof XMLHttpRequest;
  global.fetch = jest.fn(async () => { throw new Error('Network is forbidden'); });
  tokens = require('../apiToken.ts');
  tokens._setTestSupabase({ auth });
  realtime = require('../telegraphRealtimeService.ts').telegraphRealtime;
  cursors = require('../../features/telegraph/connection/sequenceCursorStore.ts');
});

afterEach(async () => {
  for (const stop of stops) stop();
  await flush();
  jest.clearAllTimers();
  jest.restoreAllMocks();
  jest.useRealTimers();
  tokens._resetTestSupabase();
  expect(global.fetch).not.toHaveBeenCalled();
  global.fetch = originalFetch;
  global.XMLHttpRequest = originalXHR;
  if (originalApi === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApi;
});

describe('Telegraph realtime attempt lifetime with the real token helper', () => {
  it('token completion from a retired subscription must not create a second stream after restart', async () => {
    const pending = deferred<ReturnType<typeof session>>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    const previous = subscribe();
    previous.stop();
    subscribe();
    await flush();
    expect(instances).toHaveLength(1);
    pending.resolve(session('retired-token'));
    await flush();
    expect(instances).toHaveLength(1);
  });

  it('retired no-token completion must not schedule a retry over a healthy replacement', async () => {
    const pending = deferred<{ data: { session: null } }>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    const previous = subscribe();
    previous.stop();
    subscribe();
    await flush();
    instances[0].state(2);
    pending.resolve({ data: { session: null } });
    await flush();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['onerror', 'ontimeout'] as const)('retired %s must not abort the current stream', async (callback) => {
    const { callbacks, current } = await replacedConnection();
    current.state(2);
    callbacks[callback]?.();
    expect(current.aborts).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([3, 4])('retired readyState %i must not deliver old events into new subscribers', async (state) => {
    const { old, callbacks, current, listener } = await replacedConnection();
    old.state(state, frame('typing.started', 'retired-frame'), callbacks.onreadystatechange);
    expect(listener).not.toHaveBeenCalled();
    expect(current.aborts).toBe(0);
    expect(realtime.getStatus()).toBe('connecting');
  });

  it('a retired response cannot report open after the last listener leaves', async () => {
    const consumer = subscribe();
    await flush();
    const callback = instances[0].onreadystatechange;
    consumer.stop();
    instances[0].state(2, '', callback);
    expect(realtime.getStatus()).toBe('idle');
  });

  it('duplicate disconnect callbacks count as one connection failure', async () => {
    subscribe();
    await flush();
    const old = instances[0];
    const callbacks = old.callbacks();
    callbacks.onerror?.();
    callbacks.ontimeout?.();
    expect(realtime.getStatus()).not.toBe('polling');
    expect(jest.getTimerCount()).toBe(1);
  });

  it.each(['reconnect', 'access.revoked'])('a %s retirement stops later frames from the retired response batch', async (type) => {
    const { listener } = subscribe();
    await flush();
    instances[0].state(3, frame(type) + frame('typing.started', 'after-retirement'));
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([type]);
  });

  it('stopping with no replacement prevents a late token from opening a stream', async () => {
    const pending = deferred<ReturnType<typeof session>>();
    auth.getSession.mockReturnValueOnce(pending.promise);
    const consumer = subscribe();
    consumer.stop();
    pending.resolve(session('retired-token'));
    await flush();
    expect(instances).toHaveLength(0);
    expect(realtime.getStatus()).toBe('idle');
  });

  it('concurrent subscribers share one stream until the last leaves', async () => {
    const first = subscribe();
    const second = subscribe();
    await flush();
    expect(instances).toHaveLength(1);
    first.stop();
    expect(instances[0].aborts).toBe(0);
    second.stop();
    expect(instances[0].aborts).toBe(1);
    expect(realtime.getStatus()).toBe('idle');
  });

  it('current partial SSE bytes dispatch once and retain the cursor header', async () => {
    cursors.noteThreadCursor('thread-one', 12);
    const { listener } = subscribe();
    await flush();
    const current = instances[0];
    expect(current.headers).toEqual({ Authorization: 'Bearer current-token', Accept: 'text/event-stream', 'X-Telegraph-Sequence-Cursors': 'thread-one:12' });
    const message = frame('message.created', 'current');
    current.state(3, message.slice(0, 16));
    expect(listener).not.toHaveBeenCalled();
    current.state(3, message);
    current.state(3, message);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(realtime.getStatus()).toBe('open');
  });

  it('current failures use bounded backoff and a healthy open resets the failure count', async () => {
    subscribe();
    await flush();
    instances[0].onerror?.();
    await jest.advanceTimersByTimeAsync(1999);
    expect(instances).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(instances).toHaveLength(2);
    instances[1].onerror?.();
    expect(realtime.getStatus()).toBe('polling');
    await jest.advanceTimersByTimeAsync(4000);
    instances[2].state(2);
    expect(realtime.getStatus()).toBe('open');
    instances[2].onerror?.();
    expect(realtime.getStatus()).not.toBe('polling');
    await jest.advanceTimersByTimeAsync(2000);
    expect(instances).toHaveLength(4);
  });

  it('current reconnect control dispatches first, waits 100ms and refreshes its token', async () => {
    const { listener } = subscribe();
    await flush();
    instances[0].state(3, frame('reconnect'));
    expect(listener).toHaveBeenCalledTimes(1);
    auth.getSession.mockResolvedValue(session('refreshed-token'));
    await jest.advanceTimersByTimeAsync(99);
    expect(instances).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(instances[1].headers.Authorization).toBe('Bearer refreshed-token');
  });

  it('stops old fanout and remaining frames when a listener replaces the last subscription', async () => {
    const replacement = jest.fn();
    let stopPrevious = () => {};
    const previous = jest.fn(() => {
      stopPrevious();
      subscribe(replacement);
    });
    stopPrevious = subscribe(previous).stop;
    await flush();
    instances[0].state(3, frame('message.created', 'old-first') + frame('typing.started', 'old-second'));
    expect(previous).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    await flush();
    expect(instances).toHaveLength(2);
    instances[1].state(3, frame('message.created', 'new'));
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement.mock.calls[0][0].payload.marker).toBe('new');
  });

  it.each(['reconnect', 'access.revoked'])('does not reconnect over a replacement created by a %s listener', async (type) => {
    const replacement = jest.fn();
    let stopPrevious = () => {};
    stopPrevious = subscribe(jest.fn(() => {
      stopPrevious();
      subscribe(replacement);
    })).stop;
    await flush();
    instances[0].state(3, frame(type));
    await flush();
    expect(instances).toHaveLength(2);
    expect(replacement).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(100);
    expect(instances).toHaveLength(2);
  });

  it('does not create an XHR after connecting status synchronously retires its attempt', async () => {
    let replaced = false;
    let stopPrevious = () => {};
    stops.push(realtime.onStatus((status) => {
      if (status !== 'connecting' || replaced) return;
      replaced = true;
      stopPrevious();
      subscribe();
    }));
    stopPrevious = subscribe().stop;
    await flush();
    expect(instances).toHaveLength(1);
    expect(instances[0].sends).toBe(1);
  });

  it('does not deliver retired open status after nested idle and replacement notifications', async () => {
    let stopPrevious = () => {};
    let replaced = false;
    stops.push(realtime.onStatus((status) => {
      if (status !== 'open' || replaced) return;
      replaced = true;
      stopPrevious();
      subscribe();
    }));
    const statuses = jest.fn();
    stops.push(realtime.onStatus(statuses));
    stopPrevious = subscribe().stop;
    await flush();
    instances[0].state(2);
    await flush();
    expect(statuses.mock.calls.map(([status]) => status)).toEqual(['idle', 'connecting', 'idle', 'connecting']);
    expect(instances).toHaveLength(2);
    expect(instances[1].aborts).toBe(0);
  });

  it('does not consume bytes when the open status listener retires the attempt', async () => {
    let stopPrevious = () => {};
    const replacement = jest.fn();
    let replaced = false;
    stops.push(realtime.onStatus((status) => {
      if (status !== 'open' || replaced) return;
      replaced = true;
      stopPrevious();
      subscribe(replacement);
    }));
    stopPrevious = subscribe().stop;
    await flush();
    instances[0].state(3, frame('typing.started', 'retired-during-status'));
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(['failure', 'control'] as const)('ignores a queued %s reconnect timer from a retired lifetime', async (cause) => {
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const previous = subscribe();
    await flush();
    if (cause === 'control') instances[0].state(3, frame('reconnect'));
    else instances[0].onerror?.();
    const callback = timerSpy.mock.calls[timerSpy.mock.calls.length - 1][0];
    expect(typeof callback).toBe('function');
    previous.stop();
    subscribe();
    await flush();
    instances[1].state(2);
    const reads = auth.getSession.mock.calls.length;
    if (typeof callback === 'function') callback();
    await flush();
    expect(auth.getSession).toHaveBeenCalledTimes(reads);
    expect(instances).toHaveLength(2);
    expect(realtime.getStatus()).toBe('open');
  });

  it('does not clear a replacement reconnect timer when a retired timer callback arrives', async () => {
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const previous = subscribe();
    await flush();
    instances[0].onerror?.();
    const callback = timerSpy.mock.calls[timerSpy.mock.calls.length - 1][0];
    previous.stop();
    subscribe();
    await flush();
    instances[1].state(2);
    instances[1].onerror?.();
    if (typeof callback === 'function') callback();
    await flush();
    expect(instances).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(instances).toHaveLength(3);
  });

  it('retired parsing cannot advance the replacement partial-frame offset', async () => {
    const { old, callbacks, current, listener } = await replacedConnection();
    const currentFrame = frame('message.created', 'current-frame');
    current.state(3, currentFrame.slice(0, 20));
    old.state(3, frame('typing.started', 'retired'.repeat(50)), callbacks.onreadystatechange);
    listener.mockClear();
    current.state(3, currentFrame);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].payload.marker).toBe('current-frame');
  });

  it.each(['failure', 'control', 'stop'] as const)('invalidates before synchronous abort callbacks during %s', async (cause) => {
    const consumer = subscribe();
    await flush();
    const current = instances[0];
    const callbacks = current.callbacks();
    current.abortCallback = () => {
      if (current.aborts > 2) return;
      callbacks.onerror?.();
      callbacks.ontimeout?.();
    };
    if (cause === 'stop') consumer.stop();
    else if (cause === 'control') current.state(3, frame('reconnect'));
    else callbacks.onerror?.();
    expect(current.aborts).toBe(1);
    expect(jest.getTimerCount()).toBe(cause === 'stop' ? 0 : 1);
    expect(realtime.getStatus()).not.toBe('polling');
  });

  it('does not let a queued retired callback disconnect a normal control replacement', async () => {
    subscribe();
    await flush();
    const retiredError = instances[0].onerror;
    instances[0].state(3, frame('access.revoked'));
    await jest.advanceTimersByTimeAsync(100);
    instances[1].state(2);
    retiredError?.();
    expect(instances[1].aborts).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves current control fanout and isolates throwing event/status listeners', async () => {
    const statuses = jest.fn();
    stops.push(realtime.onStatus((status) => { if (status === 'open') throw new Error('listener'); }));
    stops.push(realtime.onStatus(statuses));
    subscribe(jest.fn(() => { throw new Error('listener'); }));
    const second = subscribe();
    await flush();
    instances[0].state(3, frame('access.revoked'));
    expect(statuses).toHaveBeenCalledWith('open');
    expect(second.listener).toHaveBeenCalledTimes(1);
    expect(second.listener.mock.calls[0][0].type).toBe('access.revoked');
    expect(jest.getTimerCount()).toBe(1);
  });

  it('keeps no-token retries at one second and missing configuration in polling', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } });
    const consumer = subscribe();
    await flush();
    expect(instances).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(999);
    expect(auth.getSession).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(auth.getSession).toHaveBeenCalledTimes(2);
    consumer.stop();
    process.env.EXPO_PUBLIC_API_BASE_URL = '';
    subscribe();
    await flush();
    expect(realtime.getStatus()).toBe('polling');
    expect(jest.getTimerCount()).toBe(0);
    expect(auth.getSession).toHaveBeenCalledTimes(2);
  });

  it('preserves the 30 second backoff cap and ignores malformed/current comment frames', async () => {
    const { listener } = subscribe();
    await flush();
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = instances.length;
      instances[count - 1].onerror?.();
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(instances).toHaveLength(count);
      await jest.advanceTimersByTimeAsync(1);
      expect(instances).toHaveLength(count + 1);
    }
    instances[instances.length - 1].state(3, ': heartbeat\n\ndata: not-json\n\ndata: {"type":3}\n\n' + frame('message.created'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(realtime.getStatus()).toBe('open');
  });
});
