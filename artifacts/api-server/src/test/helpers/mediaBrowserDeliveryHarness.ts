/** Local, synthetic browser acceptance harness. No database or real storage.
 * Run with tsx, use the printed loopback URL, then POST /_test/stop. */
import express from 'express';
import { _setTestClient } from '../../lib/http.js';
import { _setTestServiceClient } from '../../lib/supabase.js';
import mediaFileRouter from '../../routes/mediaFile.js';

const viewer = 'a1000000-0000-4000-a000-000000000002';
const token = `e30.${Buffer.from(JSON.stringify({ sub: viewer, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.c2ln`;
let active = true;
const reads: { method: string; site?: string; cookie: boolean; header: boolean }[] = [];
const sc = {
  auth: { getUser: async (value: string) => ({ data: { user: value === token ? { id: viewer } : null }, error: null }) },
  rpc: async () => ({ data: { userId: viewer, accountStatus: active ? 'active' : 'deactivated', mediaAccessAllowed: active }, error: null }),
  from() {
    const b = { select: () => b, eq: () => b, in: () => b, limit: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve) };
    return b;
  },
};
_setTestClient(sc, true); _setTestServiceClient(sc as unknown as Parameters<typeof _setTestServiceClient>[0]);
process.env.SUPABASE_URL = 'https://synthetic-storage.example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-key';
const wave = Buffer.alloc(44 + 16000);
wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(16000, 40);
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith('https://synthetic-storage.example.test/storage/v1/object/profile-media/')) throw new Error('Unexpected fixture provider');
  return new Response(init?.method === 'HEAD' ? null : wave, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wave.length) } });
};
const app = express(); app.use(express.json());
app.use((req, _res, next) => {
  if (req.path.includes('/file/profile-media/')) reads.push({ method: req.method, site: req.headers['sec-fetch-site'] as string, cookie: !!req.headers.cookie, header: !!req.headers.authorization });
  next();
});
app.get('/', (_req, res) => res.type('html').send('<!doctype html><title>Media browser acceptance</title><audio id="media" controls></audio>'));
app.get('/_test/fixture', (_req, res) => res.json({ viewer, token, uri: `/api/media/file/profile-media/avatars/${viewer}/test.wav?viewer=${viewer}`, reads }));
app.post('/_test/state', (req, res) => { active = req.body.active === true; res.sendStatus(204); });
app.post('/_test/stop', (_req, res) => { res.sendStatus(204); setTimeout(() => server.close(), 50); });
app.use('/api', mediaFileRouter);
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});
setTimeout(() => server.close(), 300_000).unref();
