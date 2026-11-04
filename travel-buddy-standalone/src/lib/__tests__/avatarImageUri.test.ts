/**
 * avatarImageUri — a person's avatar is Portava storage or nothing
 * (lane PRIV-FIX-3; census-telegraph §97). Pure; no React, no network.
 *
 * The same rule as the server's storageImageOrNull (TM-1) and the message
 * tree's telegraphMediaUri (TM-2): kept only a URL on the configured storage
 * origin under /storage/v1/, or a bare `<bucket>/<path>` reference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarImageUri, avatarStorageOrigin } from '../avatarImageUri.ts';
import { resolveAvatarUrl } from '../../utils/identity.ts';

const ORIGIN = 'https://abcd.supabase.co';
const OWN = 'profile-media/avatars/aa000000-0000-4000-a000-000000000099/1b9d6bcd.jpg';

const KEPT: ReadonlyArray<[string, string]> = [
  [OWN, 'the bare reference the upload answers'],
  [`${OWN}?width=100&quality=80`, 'a bare reference with the transform params withStorageParams adds'],
  ['post-media/aa000000-0000-4000-a000-000000000099/cover.jpg', 'another app bucket (a group or trip image drawn through an avatar primitive)'],
  [`${ORIGIN}/storage/v1/object/public/profile-media/avatars/x/a.jpg`, 'a legacy public URL of Portava storage'],
  [`${ORIGIN}/storage/v1/object/sign/profile-media/avatars/x/a.jpg?token=t`, 'a signed URL of Portava storage'],
  [`${ORIGIN}/storage/v1/render/image/sign/profile-media/avatars/x/a.jpg?token=t&width=100`, 'a signed render URL'],
];
const REFUSED: ReadonlyArray<[unknown, string]> = [
  ['https://tracker.example/p.gif?u=me', 'an outside host — the beacon'],
  ['https://api.dicebear.com/9.x/adventurer/svg?seed=x', 'a seeded avatar generator'],
  ['https://images.unsplash.com/photo-1?w=400', 'an outside photo host'],
  ['http://abcd.supabase.co/storage/v1/object/public/profile-media/a.jpg', 'the storage host over the wrong scheme'],
  [`${ORIGIN}.evil.example/storage/v1/object/public/a.jpg`, 'the storage host as a prefix of another host'],
  [`${ORIGIN}@evil.example/storage/v1/object/public/a.jpg`, 'userinfo naming the storage host'],
  [`${ORIGIN}/rest/v1/profiles`, 'the storage origin outside /storage/v1/'],
  ['https://other.supabase.co/storage/v1/object/public/profile-media/a.jpg', "another project's storage"],
  ['//tracker.example/p.gif', 'scheme-relative'],
  ['data:image/png;base64,iVBORw0KGgo=', 'a data: URI'],
  ['javascript:alert(1)', 'javascript:'],
  ['file:///etc/hosts', 'file:'],
  ['tracker.example/p.gif', 'a bare host name (a dot in the first segment)'],
  ['profile-media/../../etc/passwd', 'traversal'],
  ['profile-media/a b.jpg', 'whitespace'],
  ['profile-media/a\\b.jpg', 'a backslash'],
  ['profile-media/a.jpg\u0000', 'a control character'],
  ['', 'empty'],
  ['   ', 'blank'],
  [null, 'null'],
  [undefined, 'undefined'],
  [42, 'not a string'],
];

test('keeps Portava storage', () => {
  for (const [v, what] of KEPT) assert.equal(avatarImageUri(v, ORIGIN), v, what);
});

test('refuses everything else, so no viewer device fetches it', () => {
  for (const [v, what] of REFUSED) assert.equal(avatarImageUri(v, ORIGIN), null, what);
});

test('with no configured storage origin, an absolute URL is refused and a bare reference is kept', () => {
  assert.equal(avatarImageUri(`${ORIGIN}/storage/v1/object/public/a/b.jpg`, null), null);
  assert.equal(avatarImageUri(OWN, null), OWN);
});

test('the configured origin is read from EXPO_PUBLIC_SUPABASE_URL, lowercased, and only for http(s)', () => {
  const was = process.env.EXPO_PUBLIC_SUPABASE_URL;
  try {
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'HTTPS://ABCD.Supabase.co/';
    assert.equal(avatarStorageOrigin(), 'https://abcd.supabase.co');
    assert.equal(avatarImageUri(`https://abcd.supabase.co/storage/v1/object/public/a/b.jpg`), 'https://abcd.supabase.co/storage/v1/object/public/a/b.jpg');
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'ftp://abcd.supabase.co';
    assert.equal(avatarStorageOrigin(), null);
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    assert.equal(avatarStorageOrigin(), null);
  } finally {
    if (was === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL; else process.env.EXPO_PUBLIC_SUPABASE_URL = was;
  }
});

test('resolveAvatarUrl (utils/identity.ts) is the same door: storage or null', () => {
  assert.equal(resolveAvatarUrl(OWN), OWN);
  assert.equal(resolveAvatarUrl('https://tracker.example/p.gif'), null);
  assert.equal(resolveAvatarUrl('  '), null);
  assert.equal(resolveAvatarUrl(null), null);
});
