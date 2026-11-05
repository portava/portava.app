/**
 * playbackUri — the relay URL is a private ref, and every <Video> surface SIGNS (2026-10-24, owner-reported:
 * uploaded videos play only on the post detail screen).
 *
 * The Watch, grid and /media/:id payloads name a private post's video by the API relay
 * (`[https://<api>]/api/media/file/post-media/…`, api-server lib/mediaFeedItem.ts relayUrlFor). The relay answers
 * only a request carrying `Authorization: Bearer`; a player sends none, so handing it the relay URL is a 401.
 *
 *   E1  relayStorageRefOf: relative and absolute relay URLs name their bare ref; query dropped, percent-decoded;
 *       a public or unknown bucket, a traversal and a non-relay path name nothing
 *   E2  the rule: a relay URL is private (never loadable as it is); resolving, then ready with the signed URL
 *   E3  batchSignUrls sends a relay URL to POST /api/media/sign as the bare ref the endpoint accepts
 *       (appStorageUrlInfo refuses the relay form) and answers it under the relay URL the caller asked for
 *   P5  GUARD (the P4 gap — closest equivalent; the verifier's original wording was not available): calling the
 *       rule is not enough. #795's P4 accepted a file that called isLoadablePlaybackUri and never requested a
 *       signature, so Watch, the grid and the viewer refused a private video for ever. Every expo-av <Video> mount
 *       must also SIGN through useHydratedMedia / hydrateMediaUrls, or be listed below with the reason it cannot
 *       receive a private ref. Double-quoted and aliased imports count as mounts too.
 *   P6  GUARD: a ref handed to playbackUriState(...) is never itself a <Video> source — the player gets the state's
 *       uri, not the raw ref the state was computed from.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoadablePlaybackUri, isPrivateMediaRefOf, playbackUriState, relayStorageRefOf, signableMediaRef } from '../playbackUri.ts';
import { batchSignUrls, _resetBatchSignCache, _setTestSignTokenProvider } from '../../lib/batchSignMedia.ts';

const MOV = 'post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov';
const RELAY = `/api/media/file/${MOV}`;
const ABS_RELAY = `https://rumazi.com/api/media/file/${MOV}?width=800`;
const SIGNED = 'https://ajrurzioarfkagpuxfnb.supabase.co/storage/v1/object/sign/post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov?token=t';

test('E1 relayStorageRefOf names the bare ref of a private relay URL, and nothing else', () => {
  assert.equal(relayStorageRefOf(RELAY), MOV);
  assert.equal(relayStorageRefOf(ABS_RELAY), MOV, 'absolute, with a query');
  assert.equal(relayStorageRefOf('/api/media/file/profile-media/u/avatar%20one.jpg'), 'profile-media/u/avatar one.jpg');
  assert.equal(relayStorageRefOf('/api/media/file/public-assets/a.mp4'), null, 'not a private bucket');
  assert.equal(relayStorageRefOf('/api/media/file/post-media/../x.mp4'), null, 'traversal');
  assert.equal(relayStorageRefOf('/api/media/file/post-media/'), null, 'no path');
  assert.equal(relayStorageRefOf('/api/media/sign'), null);
  assert.equal(relayStorageRefOf(MOV), null, 'a bare ref is not a relay URL');
  assert.equal(relayStorageRefOf('https://cdn.example/api/media/files/post-media/a.mp4'), null);
  assert.equal(signableMediaRef(ABS_RELAY), MOV);
  assert.equal(signableMediaRef('https://cdn.example/a.mp4'), 'https://cdn.example/a.mp4');
});

test('E2 a relay URL is a private ref: never loadable as it is; resolving, then the signed URL', () => {
  assert.equal(isPrivateMediaRefOf(RELAY), true);
  assert.equal(isLoadablePlaybackUri(RELAY), false);
  assert.equal(isLoadablePlaybackUri(ABS_RELAY), false);
  assert.deepEqual(playbackUriState(RELAY, {}), { state: 'resolving' });
  assert.deepEqual(playbackUriState(RELAY, { [RELAY]: SIGNED }), { state: 'ready', uri: SIGNED });
  assert.deepEqual(playbackUriState(RELAY, { [RELAY]: null }), { state: 'unavailable' });
  assert.equal(isLoadablePlaybackUri('/api/media/adaptive/abc/playback'), true, 'a same-origin non-relay path keeps its behaviour');
});

const origFetch = globalThis.fetch;
afterEach(() => { (globalThis as any).fetch = origFetch; _setTestSignTokenProvider(null); _resetBatchSignCache(); });

test('E3 batchSignUrls sends the bare ref for a relay URL and answers under the relay URL', async () => {
  _resetBatchSignCache();
  _setTestSignTokenProvider(async () => 'token');
  const sent: string[][] = [];
  (globalThis as any).fetch = async (_url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    sent.push(body.urls);
    // the server's own rule (api-server lib/mediaUrl.ts appStorageUrlInfo): only the bare / storage forms are signed
    const signed: Record<string, string | null> = {};
    for (const u of body.urls as string[]) signed[u] = u.startsWith('/') || u.includes('/api/media/file/') ? null : SIGNED;
    return { ok: true, json: async () => ({ signed, ttlSeconds: 3600 }) };
  };
  const out = await batchSignUrls([RELAY, ABS_RELAY]);
  assert.deepEqual(sent, [[MOV, MOV]]);
  assert.equal(out.get(RELAY), SIGNED);
  assert.equal(out.get(ABS_RELAY), SIGNED);
});

// ── Guards ────────────────────────────────────────────────────────────────────

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '__tests__' || e === '__mocks__' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e) && !/\.test\./.test(e)) files.push(p);
    }
  };
  walk(join(root, 'src')); walk(join(root, 'app'));
  return files;
}
const stripped = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Each file that imports expo-av's Video (any quote style, aliased or not) and mounts it, with the local name. */
function videoMounts(): Array<{ file: string; code: string; local: string }> {
  const out: Array<{ file: string; code: string; local: string }> = [];
  for (const f of sourceFiles()) {
    const text = readFileSync(f, 'utf8');
    const imp = /import\s*\{([^}]*)\}\s*from\s*['"]expo-av['"]/.exec(text);
    if (!imp) continue;
    const spec = (imp[1] ?? '').split(',').map((x) => x.trim()).find((x) => /^Video(\s+as\s+\w+)?$/.test(x));
    if (!spec) continue;
    const local = spec.includes(' as ') ? spec.split(/\s+as\s+/)[1]! : 'Video';
    if (!new RegExp(`<${local}\\b`).test(text)) continue;
    out.push({ file: relative(root, f), code: stripped(text).replace(/^\s*import\b.*$/gm, ''), local });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Mounts that never receive a server ref, and why. Adding to this list needs the same kind of reason. */
const SIGNS_ELSEWHERE: Record<string, string> = {
  'src/features/memories/MemoryVideoSegments.tsx': 'loads only the URL its own segment service signed (loadAsync of signed.uri, checked by the rule)',
  'src/components/ui/VideoStoryTrimSheet.tsx': 'plays only the device asset the picker just returned, before any upload',
};

test('P5 GUARD: every <Video> mount signs a private ref before playing it (calling the rule alone is not enough)', () => {
  const mounts = videoMounts();
  assert.ok(mounts.length >= 9, `expected the app's Video mounts, found ${mounts.length}: ${mounts.map((m) => m.file).join(', ')}`);
  const unsigned = mounts.filter((m) => !SIGNS_ELSEWHERE[m.file] && !/\b(useHydratedMedia|hydrateMediaUrls|batchSignUrls)\s*\(/.test(m.code));
  assert.deepEqual(unsigned.map((m) => m.file), [], 'a <Video> that can be handed a private ref but never asks for its signature — sign through services/mediaUrl.ts useHydratedMedia, then decide with playbackUriState');
  const unruled = mounts.filter((m) => !/\b(isLoadablePlaybackUri|playbackUriState)\s*\(/.test(m.code));
  assert.deepEqual(unruled.map((m) => m.file), [], 'P4 still holds: every mount decides through the rule');
  for (const f of Object.keys(SIGNS_ELSEWHERE)) assert.ok(mounts.some((m) => m.file === f), `${f} is listed in SIGNS_ELSEWHERE but no longer mounts a Video — remove it`);
});

test('P6 GUARD: a <Video> in a file that decides with playbackUriState plays only the READY uri', () => {
  // A source `{{ uri: X }}` (or useAdaptivePlayback's fallback X, behind `source={playback.source}`) must be a name
  // assigned from `<state>.state === 'ready' ? <state>.uri : …` — never the raw ref the state was computed from.
  const offenders: string[] = [];
  let checked = 0;
  for (const m of videoMounts()) {
    if (!/\bplaybackUriState\s*\(/.test(m.code)) continue;
    const names = [
      ...[...m.code.matchAll(new RegExp(`<${m.local}\\b(?:(?!\\/>)[\\s\\S]){0,800}?source=\\{\\{\\s*uri:\\s*([\\w.]+)`, 'g'))].map((x) => x[1] ?? ''),
      ...(new RegExp(`<${m.local}\\b(?:(?!\\/>)[\\s\\S]){0,800}?source=\\{playback\\.source\\}`).test(m.code)
        ? [...m.code.matchAll(/useAdaptivePlayback\([^,]+,\s*([\w.]+)/g)].map((x) => x[1] ?? '') : []),
    ];
    for (const n of names) {
      checked++;
      const ready = new RegExp(`\\b${n.replace(/[.]/g, '\\.')}\\s*=\\s*(\\w+)\\.state === 'ready' \\? \\1\\.uri\\b`);
      if (!ready.test(m.code)) offenders.push(`${m.file}: <${m.local}> plays \`${n}\`, which is not a playbackUriState READY uri`);
    }
  }
  assert.ok(checked >= 7, `expected the rule-deciding mounts' sources, checked ${checked}`);
  assert.deepEqual(offenders, []);
});
