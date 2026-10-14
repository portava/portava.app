/**
 * Telegraph §6.3, census-telegraph T62 — the MOUNT, read off disk (node:test).
 *
 * A component test cannot mount expo-router's root layout, and "continues while
 * the user scrolls" is only true if the player lives somewhere no list can
 * unmount. These assertions go red the day:
 *   - the root layout stops mounting the host, or mounts it INSIDE the Stack
 *     (a screen — and a screen's list — could then own it);
 *   - the host starts rendering a list of its own;
 *   - the thread bubble goes back to owning a player (a Modal, a video
 *     component, or expo-av), which is what made playback die with the bubble;
 *   - one of the two thread hooks stops reporting itself as a message source,
 *     which would make every video in that thread unopenable (refused) — or,
 *     worse, a future binding without it would stop nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// …/src/features/telegraph/media/__tests__ → the standalone app root.
const APP_ROOT = join(HERE, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(APP_ROOT, p), 'utf8');

test('the root layout mounts the host once, after the Stack — outside every screen and list', () => {
  const layout = read('app/_layout.tsx');
  const mounts = layout.match(/<CompactPlaybackHost\s*\/>/g) ?? [];
  assert.equal(mounts.length, 1, 'exactly one <CompactPlaybackHost /> in the root layout');
  const stackClose = layout.indexOf('</Stack>');
  const hostAt = layout.indexOf('<CompactPlaybackHost');
  assert.ok(stackClose > 0 && hostAt > stackClose, 'the host is a sibling AFTER </Stack>, not a screen inside it');
  assert.ok(hostAt < layout.indexOf('</CallProvider>'), 'and inside the app tree (session, block lists, safe area)');
  assert.match(
    layout,
    /import \{ CompactPlaybackHost \} from '\.\.\/src\/features\/telegraph\/media\/CompactPlaybackHost'/,
  );
});

test('the host renders no list of its own', () => {
  const host = read('src/features/telegraph/media/CompactPlaybackHost.tsx');
  assert.doesNotMatch(host, /\b(FlatList|SectionList|ScrollView|VirtualizedList|FlashList)\b/);
});

test('the thread bubble owns no player', () => {
  const bubble = read('src/components/MessageMediaBubble.tsx');
  assert.doesNotMatch(bubble, /SharedVideoPlayer|expo-av|<Modal\b|\bModal\b,/);
  assert.match(bubble, /openMessageVideo\(/, 'a video tap hands the playback to the root host');
});

test('both thread hooks report themselves as message sources', () => {
  assert.match(read('src/hooks/useMessaging.ts'), /useCompactPlaybackSource\(threadId, messages\)/);
  assert.match(
    read('src/hooks/useGroupChat.ts'),
    /useCompactPlaybackSource\(thread\?\.id \?\? null, messages, state === 'active' \|\| state === 'loading'\)/,
  );
});
