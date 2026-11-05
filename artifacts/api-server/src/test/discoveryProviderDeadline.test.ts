import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';
import { readDiscoveryProvider } from '../lib/discoveryProviderDeadline.js';

describe('Discovery provider complete-response deadlines', () => {
  let server: http.Server;
  let base: string;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/headers') return; // Real socket stays open without headers.
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/body') { res.write('{"items":'); return; }
      if (req.url === '/bad') { res.end('{'); return; }
      if (req.url === '/error') { res.statusCode = 503; res.end('{"error":"busy"}'); return; }
      res.end('{"items":["place"]}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const json = (response: Response) => response.json();
  for (const path of ['/headers', '/body']) {
    it(`bounds a stalled ${path.slice(1)} without returning an empty success`, async () => {
      const started = performance.now();
      await assert.rejects(readDiscoveryProvider(`${base}${path}`, {}, json, 40), { name: 'TimeoutError' });
      assert.ok(performance.now() - started < 1000, 'the provider cannot hold the request indefinitely');
    });
  }
  it('delivers a complete response and permits the next request after a timeout', async () => {
    await assert.rejects(readDiscoveryProvider(`${base}/body`, {}, json, 25));
    assert.deepEqual(await readDiscoveryProvider(base, {}, json, 1000), { items: ['place'] });
  });
  it('honors caller cancellation during response-body reading', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25);
    try { await assert.rejects(readDiscoveryProvider(`${base}/body`, { signal: controller.signal }, json, 1000), { name: 'AbortError' }); }
    finally { clearTimeout(timer); }
  });
  it('does not dispatch an already-cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readDiscoveryProvider('http://127.0.0.1:1', { signal: controller.signal }, json), { name: 'AbortError' });
  });
  it('keeps HTTP and invalid-JSON failures visible to the source adapter', async () => {
    assert.equal(await readDiscoveryProvider(`${base}/error`, {}, async response => response.status), 503);
    await assert.rejects(readDiscoveryProvider(`${base}/bad`, {}, json), SyntaxError);
  });
  it('refuses invalid budgets before dispatch', async () => {
    for (const duration of [0, -1, Infinity, NaN]) await assert.rejects(readDiscoveryProvider(base, {}, json, duration), RangeError);
  });
});
