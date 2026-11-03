/**
 * playbackUri — the one rule for what a player may be handed (owner-reported 2026-10-24: "video media still not
 * playing"), and the guard that every <Video> in the app goes through it.
 *
 *   P1  a bare private-bucket ref is never loadable; a signed URL, a file and a same-origin path are
 *   P2  playbackUriState: resolving while the signature is pending, ready once it lands, unavailable on refusal
 *   P3  production's exact row shape for 1792727980484.mov: resolving, then ready with the signed URL
 *   P4  GUARD: every file that imports expo-av's Video decides through isLoadablePlaybackUri / playbackUriState
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoadablePlaybackUri, isPrivateMediaRefOf, playbackUriState } from '../playbackUri.ts';

const MOV = 'post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov';
const SIGNED = 'https://ajrurzioarfkagpuxfnb.supabase.co/storage/v1/object/sign/post-media/d47c09d6-0000-4000-8000-00000000a001/1792727980484.mov?token=t';

test('P1 a bare private ref is never loadable; signed, file and same-origin URIs are', () => {
  assert.equal(isLoadablePlaybackUri(MOV), false);
  assert.equal(isLoadablePlaybackUri('profile-media/u/a.mp4'), false);
  assert.equal(isLoadablePlaybackUri('https://x.supabase.co/storage/v1/object/public/post-media/u/a.mp4'), false, 'a public URL into a private bucket must be signed first');
  assert.equal(isLoadablePlaybackUri(SIGNED), true);
  assert.equal(isLoadablePlaybackUri('file:///var/mobile/clip.mov'), true);
  assert.equal(isLoadablePlaybackUri('ph://ABC/L0/001'), true);
  assert.equal(isLoadablePlaybackUri('/api/media/file/post-media/u/a.mp4'), true, 'a same-origin path keeps its old behaviour');
  assert.equal(isLoadablePlaybackUri('//cdn.example/a.mp4'), false);
  assert.equal(isLoadablePlaybackUri(''), false);
  assert.equal(isLoadablePlaybackUri(null), false);
  assert.equal(isPrivateMediaRefOf(MOV), true);
});

test('P2 resolving while the signature is pending, ready once it lands, unavailable on refusal', () => {
  assert.deepEqual(playbackUriState(MOV, {}), { state: 'resolving' });
  assert.deepEqual(playbackUriState(MOV, { [MOV]: SIGNED }), { state: 'ready', uri: SIGNED });
  assert.deepEqual(playbackUriState(MOV, { [MOV]: null }), { state: 'unavailable' });
  assert.deepEqual(playbackUriState(MOV, { [MOV]: MOV }), { state: 'unavailable' }, 'a "signature" that is still bare is not loadable');
  assert.deepEqual(playbackUriState('https://cdn.example/a.mp4', {}), { state: 'ready', uri: 'https://cdn.example/a.mp4' });
  assert.deepEqual(playbackUriState('clip.mov', {}), { state: 'unavailable' }, 'no bucket and no scheme: nothing could ever load it');
  assert.deepEqual(playbackUriState(null, {}), { state: 'unavailable' });
});

test('P3 production row shape (post_media.public_url for e4bbf335, 2026-10-24): resolving, then the signed URL', () => {
  const row = { media_type: 'video', url: MOV, thumbnail_url: `${MOV}.poster.jpg` };
  assert.equal(playbackUriState(row.url, {}).state, 'resolving');
  assert.deepEqual(playbackUriState(row.url, { [row.url]: SIGNED }), { state: 'ready', uri: SIGNED });
});

test('P4 GUARD: every expo-av Video mount decides through the playback rule', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === '__tests__' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e) && !/\.test\./.test(e)) files.push(p);
    }
  };
  walk(join(root, 'src')); walk(join(root, 'app'));
  const mounts = files.map((f) => relative(root, f)).filter((rel) => {
    const t = readFileSync(join(root, rel), 'utf8');
    return /import\s*\{[^}]*\bVideo\b[^}]*\}\s*from\s*'expo-av'/.test(t) && /<Video\b/.test(t);
  }).sort();
  assert.ok(mounts.length >= 9, `expected the app's Video mounts, found ${mounts.length}: ${mounts.join(', ')}`);
  // USED, not merely imported: import lines and comments are stripped before looking (mutant RM8 removed the only
  // call in WatchVideoCell and the import alone kept an earlier version of this guard green).
  const code = (f: string) => readFileSync(join(root, f), 'utf8').replace(/^\s*import\b.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const unguarded = mounts.filter((f) => !/\b(isLoadablePlaybackUri|playbackUriState)\s*\(/.test(code(f)));
  assert.deepEqual(unguarded, [], `a <Video> that can be handed a bare bucket ref: ${unguarded.join(', ')} — decide through services/playbackUri.ts`);
});
