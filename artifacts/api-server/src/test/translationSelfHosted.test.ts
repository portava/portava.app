import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { _clearTranslationProvider, _setTestTranslationProvider, getTranslationProvider, OpenAITranslationProvider, translatePreservingEntities } from '../lib/translation.js';
import { translateContentFields } from '../services/contentTranslation.js';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { SelfHostedTranslationProvider } from '../lib/selfHostedTranslation.js';
import { createAuthorizedTranslationService, type TranslationSubject } from '../services/platformTranslation.js';

const token = 'local-fixture-token-not-a-secret-123456789';
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

const originalEnvironment = { ...process.env };
test('Unicode navigation hashtags and literal CRLF/newlines survive translation untouched', async () => {
  const input = 'Hola #Viaje_2026 #日本旅行 #cafe\u0301\r\nHola #यात्रा\nHola @alice https://example.test/#sección user@example.test';
  const received: string[] = [];
  const result = await translatePreservingEntities({
    async detectLanguage() { throw new Error('unused'); },
    async translateText(text) {
      received.push(text);
      return { translatedText: text.replaceAll('Hola', 'Hello').replaceAll('#', 'HASH').replaceAll('\n', ' ').replaceAll('\r', ''),
        provider: 'fixture', providerVersion: 'test' };
    },
  }, input, 'es', 'en');
  assert.equal(result.translatedText, input.replaceAll('Hola', 'Hello'));
  assert.equal(received.some(text => /[#@\r\n]/.test(text) || text.includes('http')), false);
});

afterEach(() => {
  process.env = { ...originalEnvironment };
  _clearTranslationProvider();
});

test('real HTTP adapter sends bounded authenticated requests and retains runtime provenance', async () => {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/v1/detect' ? { language: 'es', confidence: 'low' }
      : { translatedText: 'Hello world.', source: 'es', target: 'en', providerVersion: 'contract-fixture-not-model' }));
  });
  try {
    const provider = new SelfHostedTranslationProvider({ url: await listen(server), token });
    assert.deepEqual(await provider.detectLanguage('Hola mundo.'), { language: 'es', confidence: 'low' });
    assert.deepEqual(await provider.translateText('Hola mundo.', 'es', 'en'), {
      translatedText: 'Hello world.', provider: 'self-hosted', providerVersion: 'contract-fixture-not-model',
    });
    assert.deepEqual(requests[1], { text: 'Hola mundo.', source: 'es', target: 'en' });
  } finally { await close(server); }
});

for (const scenario of ['unavailable', 'malformed', 'wrong_pair', 'no_version', 'too_large', 'timeout', 'redirect']) {
  test(`self-hosted ${scenario} fails closed without fallback`, async () => {
    const server = createServer((_request, response) => {
      if (scenario === 'timeout') return;
      if (scenario === 'redirect') { response.writeHead(302, { Location: 'https://example.invalid' }); response.end(); return; }
      if (scenario === 'unavailable') { response.writeHead(503); response.end('unavailable'); return; }
      if (scenario === 'malformed') { response.end('not json'); return; }
      response.end(JSON.stringify({ translatedText: scenario === 'too_large' ? 'x'.repeat(130_000) : 'Hello world.',
        source: scenario === 'wrong_pair' ? 'fr' : 'es', target: 'en', providerVersion: scenario === 'no_version' ? null : 'fixture' }));
    });
    try {
      const provider = new SelfHostedTranslationProvider({ url: await listen(server), token, timeoutMs: 100 });
      await assert.rejects(provider.translateText('Hola mundo.', 'es', 'en'));
    } finally { await close(server); }
  });
}

test('remote endpoints, credentials, queries and provider names never permit paid/network fallback', async () => {
  for (const url of ['https://example.invalid', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/?secret=1']) {
    await assert.rejects(new SelfHostedTranslationProvider({ url, token }).translateText('Hola.', 'es', 'en'));
  }
  for (const provider of ['unknown', 'mock']) {
    process.env.NODE_ENV = 'production';
    process.env.TRANSLATION_PROVIDER = provider;
    _clearTranslationProvider();
    await assert.rejects(getTranslationProvider().translateText('Hola.', 'es', 'en'));
  }
});

test('explicit legacy OpenAI selection is retained without calling its network methods', () => {
  process.env.TRANSLATION_PROVIDER = 'openai';
  _clearTranslationProvider();
  assert.ok(getTranslationProvider() instanceof OpenAITranslationProvider);
});

test('new authorized service never uses the legacy managed factory before or after output validation', async () => {
  process.env.TRANSLATION_PROVIDER = 'openai';
  delete process.env.TRANSLATION_SELF_HOSTED_URL;
  let legacyCalls = 0;
  _setTestTranslationProvider({
    async detectLanguage() { legacyCalls++; throw new Error('private text leaked'); },
    async translateText() { legacyCalls++; throw new Error('private text leaked'); },
  });
  const service = createAuthorizedTranslationService({ async loadAuthorizedSubject() {
    return { revision: 'original', protection: 'server-readable', sourceLanguage: 'es',
      fields: { caption: 'Hola mundo.' }, preferences: { enabled: true } };
  } });
  assert.deepEqual(await service.translate({ viewerId: 'creator', subjectId: 'private', targetLanguage: 'en' }), { status: 'unavailable', fields: {} });
  assert.equal(legacyCalls, 0);
});

function authorizedFixture() {
  let subject: TranslationSubject | null = { revision: 'version-1', protection: 'server-readable', sourceLanguage: 'es',
    fields: { cue1: 'Hola mundo.' }, preferences: { enabled: true, targetLanguage: 'en' } };
  let calls = 0;
  let reads = 0;
  let time = 0;
  let afterTranslate = () => {};
  const service = createAuthorizedTranslationService({
    now: () => time,
    async loadAuthorizedSubject() { reads++; return structuredClone(subject); },
    provider: () => ({
      async detectLanguage() { throw new Error('detection must not be guessed'); },
      async translateText(text) { calls++; afterTranslate(); return { translatedText: text.replace('Hola', 'Hello'), provider: 'fixture', providerVersion: 'fixture-1' }; },
    }),
  });
  return { service, request: { viewerId: 'alice', subjectId: 'caption:1', targetLanguage: 'en' },
    calls: () => calls, reads: () => reads,
    change: (mutate: (subject: TranslationSubject) => void) => { mutate(subject!); },
    delete: () => { subject = null; },
    advance: () => { time += 60_001; },
    during: (callback: () => void) => { afterTranslate = callback; },
  };
}

test('authorized cache partitions viewers, targets and source generation; original is never mutated', async () => {
  const fixture = authorizedFixture();
  const first = await fixture.service.translate(fixture.request);
  assert.equal(first.status, 'translated');
  assert.deepEqual(first.fields, { cue1: 'Hello mundo.' });
  first.fields.cue1 = 'caller mutation';
  assert.deepEqual((await fixture.service.translate(fixture.request)).fields, { cue1: 'Hello mundo.' });
  assert.equal(fixture.calls(), 1);
  assert.equal(fixture.reads(), 4);
  await fixture.service.translate({ ...fixture.request, viewerId: 'bob' });
  assert.equal(fixture.calls(), 2);
  fixture.change(subject => { subject.fields.cue1 = 'Hola otro mundo.'; });
  assert.deepEqual((await fixture.service.translate(fixture.request)).fields, { cue1: 'Hello otro mundo.' });
  assert.equal(fixture.calls(), 3);
  fixture.change(subject => { assert.equal(subject.fields.cue1, 'Hola otro mundo.'); subject.preferences.targetLanguage = 'fr'; });
  assert.equal((await fixture.service.translate(fixture.request)).status, 'skipped');
  await fixture.service.translate({ ...fixture.request, targetLanguage: 'fr' });
  assert.equal(fixture.calls(), 4);
  fixture.advance();
  await fixture.service.translate({ ...fixture.request, targetLanguage: 'fr' });
  assert.equal(fixture.calls(), 5);
});

for (const change of ['blocked', 'deleted', 'e2ee', 'revision', 'preferences']) {
  test(`late ${change} prevents result delivery and cache publication`, async () => {
    const fixture = authorizedFixture();
    fixture.during(() => {
      if (change === 'deleted' || change === 'blocked') fixture.delete();
      else fixture.change(subject => {
        if (change === 'e2ee') subject.protection = 'e2ee';
        if (change === 'revision') subject.revision = 'version-2';
        if (change === 'preferences') subject.preferences.enabled = false;
      });
    });
    assert.deepEqual(await fixture.service.translate(fixture.request), { status: 'denied', fields: {} });
  });
}

test('E2EE and denied loads are rejected before translation/cache; preferences and errors fail closed', async () => {
  const fixture = authorizedFixture();
  fixture.change(subject => { subject.protection = 'e2ee'; });
  assert.equal((await fixture.service.translate(fixture.request)).status, 'denied');
  assert.equal(fixture.calls(), 0);
  fixture.change(subject => { subject.protection = 'server-readable'; subject.preferences.enabled = false; });
  assert.equal((await fixture.service.translate(fixture.request)).status, 'skipped');
  assert.equal(fixture.calls(), 0);
  fixture.delete();
  assert.equal((await fixture.service.translate(fixture.request)).status, 'denied');
  const service = createAuthorizedTranslationService({ async loadAuthorizedSubject() { throw new Error('sensitive error'); } });
  assert.deepEqual(await service.translate(fixture.request), { status: 'unavailable', fields: {} });
});

test('cached translation is not returned after deletion or block', async () => {
  const fixture = authorizedFixture();
  await fixture.service.translate(fixture.request);
  fixture.delete();
  assert.deepEqual(await fixture.service.translate(fixture.request), { status: 'denied', fields: {} });
  assert.equal(fixture.calls(), 1);
});

test('regional language preference matching is case-insensitive without changing source or target identity', async () => {
  const fixture = authorizedFixture();
  fixture.change(subject => { subject.preferences.targetLanguage = 'en-US'; });
  const result = await fixture.service.translate({ ...fixture.request, targetLanguage: 'en-us' });
  assert.equal(result.status, 'translated');
  assert.equal(fixture.calls(), 1);
});

test('actual Python runtime without installed model is authenticated and honestly unavailable', async () => {
  const runtime = spawn('/usr/bin/python3', ['scripts/translation-runtime.py', '--port', '0'], {
    env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', TRANSLATION_SELF_HOSTED_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets: Socket[] = [];
  try {
    const ready = await Promise.race([once(runtime.stdout, 'data'), once(runtime, 'exit').then(() => { throw new Error('runtime exited'); })]);
    const port = JSON.parse(ready[0].toString()).port;
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${url}/health`)).status, 401);
    const health = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { ready: false, pairs: [], detection: false, providerVersion: null });
    await assert.rejects(new SelfHostedTranslationProvider({ url, token }).translateText('Hola mundo.', 'es', 'en'));
    for (let connection = 0; connection < 9; connection++) {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.on('error', () => {});
      sockets.push(socket);
      await once(socket, 'connect');
      socket.write('GET /health HTTP/1.1\r\n');
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(sockets.slice(0, 8).every(socket => !socket.destroyed), true);
    assert.equal(sockets[8].destroyed, true, 'excess slow connections must not create unbounded handler threads');
  } finally {
    for (const socket of sockets) socket.destroy();
    runtime.kill('SIGTERM');
    await once(runtime, 'exit');
  }
});

test('unconfigured production never fabricates a mock translation or invokes a paid fallback', async () => {
  process.env.NODE_ENV = 'production';
  delete process.env.TRANSLATION_PROVIDER;
  delete process.env.TRANSLATION_SELF_HOSTED_URL;
  _clearTranslationProvider();
  await assert.rejects(getTranslationProvider().translateText('Hola mundo.', 'es', 'en'));
});

test('existing content translation keeps mentions and URLs byte-for-byte outside provider input', async () => {
  const inputs: string[] = [];
  _setTestTranslationProvider({
    async detectLanguage() { return { language: 'es', confidence: 'low' }; },
    async translateText(text) {
      inputs.push(text);
      return { translatedText: text.replace('Hola', 'Hello').replace('mira', 'see').replace('@alice', '@changed').replace('https://example.com/a?q=1', 'https://wrong.invalid'), provider: 'fixture', providerVersion: 'fixture-1' };
    },
  });
  const chain: any = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }), upsert: async () => ({ error: null }) };
  const original = 'Hola @alice mira https://example.com/a?q=1';
  const result = await translateContentFields({ from: () => chain } as any, {
    entityType: 'post', entityId: 'post', fields: { content: original }, sourceLanguage: 'es', targetLanguage: 'en',
  });
  assert.equal(result.translatedFields.content, 'Hello @alice see https://example.com/a?q=1');
  assert.ok(inputs.every(text => !text.includes('@alice') && !text.includes('https://')));
  assert.equal(original, 'Hola @alice mira https://example.com/a?q=1');
});
