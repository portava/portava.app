/**
 * §44 — the sink is ATTACHED, and the attachment is a behaviour, not a comment.
 *
 * `census-input-intelligence.md` §3 fact 5 is the thing these tests exist to
 * refute: "The telemetry sink is a no-op and is never attached … Every §44
 * event the platform emits goes nowhere." Every assertion below is written so
 * that it goes RED if the attachment is removed, the AppState flush is dropped,
 * the install stops being idempotent, or dispose stops restoring the default.
 *
 * WHAT THESE TESTS DO NOT CLAIM. They prove the client chain from
 * `emitInputEvent` to a poster. They say nothing about whether a row lands in
 * `input_assistance_telemetry_events`, because migration 2950 is unapplied on
 * every deployment and no test in this tree can make it otherwise.
 *
 * node:test — the whole module is dependency-injected for exactly this reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emitInputEvent,
  resetTelemetrySink,
  type InputTelemetryEvent,
} from '../inputTelemetry.ts';
import {
  createTelemetryBatcher,
  type TelemetryBatch,
  type TelemetryBatcher,
} from '../telemetryBatcher.ts';
import {
  installInputTelemetry,
  currentInputTelemetry,
  type AppStateLike,
} from '../installInputTelemetry.ts';

/** A poster that records what it was handed and never touches the network. */
function recordingPoster() {
  const batches: TelemetryBatch[] = [];
  return {
    batches,
    post: async (b: TelemetryBatch) => {
      batches.push({ sessionId: b.sessionId, events: [...b.events] });
      return { ok: true };
    },
  };
}

/** An AppState double with a hand-cranked 'change' notification. */
function fakeAppState() {
  const handlers: ((s: string) => void)[] = [];
  let removed = 0;
  const appState: AppStateLike = {
    addEventListener: (_type, handler) => {
      handlers.push(handler);
      return {
        remove: () => {
          removed += 1;
        },
      };
    },
  };
  return {
    appState,
    emit: (s: string) => handlers.forEach((h) => h(s)),
    subscriberCount: () => handlers.length,
    removeCount: () => removed,
  };
}

/**
 * A batcher with NO timer at all: `schedule` is swallowed, so nothing leaves
 * except on an explicit flush or on reaching `maxBatch`. That is what makes the
 * AppState-flush assertion meaningful — without it a passing test could just be
 * a timer that happened to fire.
 */
function unscheduledBatcher(post: (b: TelemetryBatch) => Promise<{ ok: boolean }>): TelemetryBatcher {
  return createTelemetryBatcher({
    post,
    sessionId: 'test-session',
    maxBatch: 50,
    schedule: () => {
      /* never fires — flushes are explicit in these tests */
    },
  });
}

function emitOne(name: InputTelemetryEvent['name'] = 'input_opened'): void {
  emitInputEvent(name, 'discovery.search', 'global_search', { length: 3 });
}

test.afterEach(() => {
  currentInputTelemetry()?.dispose();
  resetTelemetrySink();
});

test('§44/G263: before install, an emitted event reaches NOTHING', async () => {
  const p = recordingPoster();
  const batcher = unscheduledBatcher(p.post);

  // The batcher exists and is willing, but nobody has called setTelemetrySink.
  emitOne();
  await batcher.flush();

  assert.equal(batcher.pending(), 0, 'nothing was buffered — the default sink dropped it');
  assert.equal(p.batches.length, 0, 'and nothing was posted');
});

test('§44/G263: after install, an emitted event reaches the poster', async () => {
  const p = recordingPoster();
  const handle = installInputTelemetry({ createBatcher: () => unscheduledBatcher(p.post) });

  emitOne('suggestion_rendered');
  assert.equal(handle.batcher.pending(), 1, 'the installed sink buffered the event');

  await handle.batcher.flush();
  assert.equal(p.batches.length, 1);
  assert.equal(p.batches[0].events.length, 1);
  assert.equal(p.batches[0].events[0].name, 'suggestion_rendered');
  assert.equal(p.batches[0].sessionId, 'test-session');
});

test('§44: the installed sink carries NO raw text onto the wire', async () => {
  const p = recordingPoster();
  const handle = installInputTelemetry({ createBatcher: () => unscheduledBatcher(p.post) });

  // A caller that tries to attach the user's text to a field whose policy does
  // not permit raw capture. The scrub is in inputTelemetry.ts; this asserts the
  // INSTALLED path does not route around it.
  emitInputEvent(
    'query_length_changed',
    'telegraph.message',
    'telegraph_message',
    { length: 22, text: 'meet me at the secret bar', query: 'secret bar' },
    { events: 'all', captureRawText: false },
  );
  await handle.batcher.flush();

  const props = p.batches[0].events[0].props ?? {};
  assert.equal(props.length, 22);
  assert.ok(!('text' in props), 'raw text must not survive the installed path');
  assert.ok(!('query' in props), 'raw query must not survive the installed path');
});

test('§44: backgrounding the app flushes the buffer', async () => {
  const p = recordingPoster();
  const app = fakeAppState();
  installInputTelemetry({ createBatcher: () => unscheduledBatcher(p.post), appState: app.appState });

  assert.equal(app.subscriberCount(), 1, 'install subscribed to AppState exactly once');

  emitOne('suggestion_selected');
  assert.equal(p.batches.length, 0, 'nothing has left yet — no timer is running');

  app.emit('background');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(p.batches.length, 1, 'backgrounding sent the buffered event');
  assert.equal(p.batches[0].events[0].name, 'suggestion_selected');
});

test('§44: returning to the foreground does NOT flush an empty buffer', async () => {
  const p = recordingPoster();
  const app = fakeAppState();
  installInputTelemetry({ createBatcher: () => unscheduledBatcher(p.post), appState: app.appState });

  app.emit('active');
  await Promise.resolve();
  assert.equal(p.batches.length, 0);
});

test('§44: install is idempotent — a re-mounting root layout cannot double-subscribe', () => {
  const p = recordingPoster();
  const app = fakeAppState();
  let built = 0;
  const create = () => {
    built += 1;
    return unscheduledBatcher(p.post);
  };

  const first = installInputTelemetry({ createBatcher: create, appState: app.appState });
  const second = installInputTelemetry({ createBatcher: create, appState: app.appState });

  assert.equal(built, 1, 'the second install built no second batcher (and minted no second sessionId)');
  assert.equal(second, first, 'the live handle is returned');
  assert.equal(app.subscriberCount(), 1);
});

test('§44: dispose flushes, unsubscribes and restores the no-op sink', async () => {
  const p = recordingPoster();
  const app = fakeAppState();
  const handle = installInputTelemetry({
    createBatcher: () => unscheduledBatcher(p.post),
    appState: app.appState,
  });

  emitOne('manual_value_kept');
  handle.dispose();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(p.batches.length, 1, 'dispose did not strand the buffered event');
  assert.equal(app.removeCount(), 1, 'dispose unsubscribed AppState');
  assert.equal(currentInputTelemetry(), null);

  // And the sink really is back to the default: a further event goes nowhere.
  emitOne('manual_value_kept');
  assert.equal(handle.batcher.pending(), 0);
  assert.equal(p.batches.length, 1);
});

test('§44: a STALE handle cannot reset a sink it no longer owns', async () => {
  const first = recordingPoster();
  const stale = installInputTelemetry({ createBatcher: () => unscheduledBatcher(first.post) });
  stale.dispose();

  const second = recordingPoster();
  const live = installInputTelemetry({ createBatcher: () => unscheduledBatcher(second.post) });

  stale.dispose(); // the old handle tries again

  emitOne('validation_shown');
  await live.batcher.flush();
  assert.equal(second.batches.length, 1, 'the live sink survived the stale dispose');
});

/**
 * THE RATCHET. Everything above proves the seam works when something calls it.
 * This proves something DOES — by reading the real root layout off disk, because
 * a unit test cannot mount expo-router. §3 fact 5 of the census is a statement
 * about this exact file, and this is the assertion that goes red the day the
 * line is deleted or the transport is swapped for a stub.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
// …/src/platform/input-assistance/services/__tests__ → the standalone app root.
const APP_ROOT = join(HERE, '..', '..', '..', '..', '..');

test('§44/G263: app/_layout.tsx really installs the sink at boot', () => {
  const layout = readFileSync(join(APP_ROOT, 'app', '_layout.tsx'), 'utf8');

  assert.match(
    layout,
    /installInputTelemetry\s*\(/,
    'the root layout must call installInputTelemetry — without it the §44 sink is () => {} in every build',
  );
  assert.match(
    layout,
    /createBatcher:\s*\(\)\s*=>\s*installInputTelemetryTransport\(\)/,
    'it must be attached to the REAL transport, not to a stub',
  );
  assert.match(
    layout,
    /<InputTelemetrySetup\s*\/>/,
    'and the setup component must actually be mounted in the tree',
  );
  assert.match(
    layout,
    /appState:\s*AppState/,
    'the background flush needs the real AppState, or a buffered selection dies with the app',
  );
});

test('§44: a refused post is DROPPED and COUNTED, never retried into the UI', async () => {
  // This is the state every deployment is actually in today: migration 2950 is
  // unapplied, so the ingest answers 503 retryable. The client's answer is to
  // lose the batch and say so, not to loop against a server incident.
  let calls = 0;
  const refusing = async () => {
    calls += 1;
    return { ok: false, retryable: true };
  };
  const handle = installInputTelemetry({ createBatcher: () => unscheduledBatcher(refusing) });

  emitOne();
  emitOne();
  await handle.batcher.flush();

  assert.equal(calls, 1, 'one attempt');
  assert.equal(handle.batcher.dropped(), 2, 'both events counted as lost');
  assert.equal(handle.batcher.pending(), 0, 'and not left buffered to be resent');
});

/**
 * §44 `action_completed` (census G319) — the OTHER wiring ratchet.
 *
 * `TripWishlistPicker.actionCompleted.component.test.tsx` proves the picker
 * reports both arms. This proves the global-search SCREEN turns them into §44
 * events — the half no component test can see, because a unit test cannot mount
 * expo-router. G319's own "WHAT WOULD TURN THIS RED" names this exact call
 * site: "the global-search screen calling `emitActionCompleted` after the trip
 * picker CONFIRMS."
 */
test('§44/G319: app/search.tsx emits action_completed on BOTH picker outcomes', () => {
  const screen = readFileSync(join(APP_ROOT, 'app', 'search.tsx'), 'utf8');

  assert.match(
    screen,
    /import \{ emitActionCompleted \}/,
    'the global-search screen must import the §44 emitter',
  );
  assert.match(
    screen,
    /onSaved=\{\(\) => emitInputAssistActionCompleted\(true\)\}/,
    'a confirmed add-to-trip must report ok:true',
  );
  assert.match(
    screen,
    /onSaveFailed=\{\(\) => emitInputAssistActionCompleted\(false\)\}/,
    'a FAILED add-to-trip must report ok:false — an emitter wired only to the ' +
      'success arm reports a metric that cannot go red',
  );
  assert.match(
    screen,
    /emitActionCompleted\(\s*\{[\s\S]*?\},\s*'add_to_trip',\s*ok,\s*\)/,
    'the event must carry the action type and the outcome the caller was given',
  );
  // And the tap that OPENS the picker must not itself be a completion: §21
  // actions are propose-only, and an abandoned picker is not a success.
  assert.ok(
    !/getAddToTripTarget\([\s\S]{0,400}?emitActionCompleted/.test(screen),
    'selecting the action row must not emit action_completed — only the picker outcome does',
  );
});
