/**
 * Regression tests for the production web server (server/serve.js):
 * - malformed percent-encoded paths must not crash the process (URIError guard)
 * - /u/<username> serves HTML with Open Graph tags
 * - unknown usernames get generic metadata (no name leakage)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 19894;
const API_PORT = 19895;
let apiStub: http.Server;
let serveProc: ChildProcess;

before(async () => {
  // Stub API server: only one known public user.
  apiStub = http.createServer((req, res) => {
    if (req.url === '/api/users/knownuser/profile') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', username: 'knownuser', displayName: 'Known User',
        bio: null, avatarUrl: null, coverUrl: null,
        tripCount: 3, stampCount: 7, visibility: 'public',
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((r) => apiStub.listen(API_PORT, r));

  const serverPath = path.resolve(import.meta.dirname, '../../../server/serve.js');
  serveProc = spawn('node', [serverPath], {
    env: { ...process.env, PORT: String(PORT), API_ORIGIN: `http://localhost:${API_PORT}` },
    stdio: 'ignore',
  });

  // Wait until the server accepts connections.
  for (let i = 0; i < 50; i++) {
    try {
      await rawRequest('/');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('serve.js did not start');
});

after(() => {
  serveProc?.kill('SIGTERM');
  // Force-close any keep-alive connections so apiStub.close() can drain
  // immediately and the node:test process can exit. Without this the
  // http.globalAgent retains pooled sockets to PORT and the process hangs.
  (apiStub as any).closeAllConnections?.();
  apiStub.close();
  http.globalAgent.destroy();
});

function rawRequest(rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: 'localhost', port: PORT, path: rawPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('malformed percent-encoding does not crash the server', async () => {
  const res = await rawRequest('/u/%C0%AF%ZZ');
  assert.ok(res.status === 404 || res.status === 400, `expected 4xx, got ${res.status}`);
  // Server must still be alive and serving afterwards.
  const alive = await rawRequest('/u/knownuser');
  assert.equal(alive.status, 200);
});

test('public profile gets personalized OG tags', async () => {
  const res = await rawRequest('/u/knownuser');
  assert.equal(res.status, 200);
  assert.match(res.body, /og:title" content="Known User/);
  assert.match(res.body, /3 trips · 7 stamps/);
  assert.match(res.body, /og-image\.png/);
});

test('unknown profile gets generic OG tags without leaking the handle in metadata', async () => {
  const res = await rawRequest('/u/ghostuser');
  assert.equal(res.status, 200);
  assert.match(res.body, /og:title" content="Travel Buddy Passport"/);
  assert.doesNotMatch(res.body, /og:title" content="[^"]*ghostuser/);
  assert.match(res.body, /users\/_\/og-image\.png/);
});
