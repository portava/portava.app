/**
 * features/media — the owner's F1/F2 surface decisions as flags
 * (census-media §34). Every flag reads as TODAY until its row says true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMediaSurfaceDecisions, TODAY } from '../state/mediaSurfaceFlags.ts';

const reader = (on: Record<string, unknown>) => (key: string) => on[key] as boolean;

test('no flag set — the seeded state — is exactly TODAY', () => {
  assert.deepEqual(resolveMediaSurfaceDecisions(reader({})), { ...TODAY });
  assert.deepEqual({ ...TODAY }, { worldDefault: false, contextOverlay: false, tapToPlay: false });
});

test('F1: the World default needs BOTH its own flag and the shell flag', () => {
  assert.equal(resolveMediaSurfaceDecisions(reader({ MEDIA_TAB_WORLD_DEFAULT_ENABLED: true })).worldDefault, false);
  assert.equal(resolveMediaSurfaceDecisions(reader({ MEDIA_WORLD_SHELL_ENABLED: true })).worldDefault, false);
  assert.equal(
    resolveMediaSurfaceDecisions(reader({ MEDIA_WORLD_SHELL_ENABLED: true, MEDIA_TAB_WORLD_DEFAULT_ENABLED: true })).worldDefault,
    true,
  );
});

test('F2: each Watch flag turns on its own decision and nothing else', () => {
  assert.deepEqual(resolveMediaSurfaceDecisions(reader({ MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: true })), {
    worldDefault: false, contextOverlay: true, tapToPlay: false,
  });
  assert.deepEqual(resolveMediaSurfaceDecisions(reader({ MEDIA_WATCH_TAP_TO_PLAY_ENABLED: true })), {
    worldDefault: false, contextOverlay: false, tapToPlay: true,
  });
});

test('fail-closed: only a literal `true` turns a decision on, and a throwing reader is TODAY', () => {
  const truthy = reader({
    MEDIA_WORLD_SHELL_ENABLED: 'true', MEDIA_TAB_WORLD_DEFAULT_ENABLED: 1,
    MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED: {}, MEDIA_WATCH_TAP_TO_PLAY_ENABLED: 'yes',
  });
  assert.deepEqual(resolveMediaSurfaceDecisions(truthy), { ...TODAY });
  assert.deepEqual(resolveMediaSurfaceDecisions(() => { throw new Error('flags unavailable'); }), { ...TODAY });
});

test('TODAY cannot be mutated by a caller', () => {
  assert.ok(Object.isFrozen(TODAY));
});

test('every name read here is seeded FALSE by the lane\'s migrations (the server flag, 3343, is read server-side)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrations = join(here, '..', '..', '..', '..', '..', 'artifacts', 'api-server', 'src', 'migrations');
  for (const [file, flag] of [
    ['3340_media_tab_world_default_flag.sql', 'MEDIA_TAB_WORLD_DEFAULT_ENABLED'],
    ['3341_media_watch_context_overlay_flag.sql', 'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED'],
    ['3342_media_watch_tap_to_play_flag.sql', 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED'],
  ] as const) {
    const sql = readFileSync(join(migrations, file), 'utf8');
    assert.match(sql, new RegExp(`'${flag}',\\s*false,`), `${file} seeds ${flag} FALSE`);
    const src = readFileSync(join(here, '..', 'state', 'mediaSurfaceFlags.ts'), 'utf8');
    assert.ok(src.includes(`isEnabled('${flag}')`), `mediaSurfaceFlags reads ${flag} as a literal`);
  }
});
