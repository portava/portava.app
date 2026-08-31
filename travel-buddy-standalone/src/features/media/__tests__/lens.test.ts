/**
 * features/media — 6-lens nav + presentation-mode logic tests (§3/§5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LENSES,
  modesForLens,
  defaultModeForLens,
  isModeSupported,
  isLens,
  lensNavReducer,
  INITIAL_LENS_NAV,
} from '../state/lens.ts';

test('the 6 lenses are defined in spec §3 order', () => {
  assert.deepEqual(
    LENSES.map((l) => l.key),
    ['now', 'places', 'experiences', 'gems', 'people', 'my_world'],
  );
});

test('every lens supports at least one mode; defaultModeForLens is the first', () => {
  for (const l of LENSES) {
    const modes = modesForLens(l.key);
    assert.ok(modes.length >= 1, `${l.key} has no modes`);
    assert.equal(defaultModeForLens(l.key), modes[0]);
  }
});

test('mode support matches spec §5 table', () => {
  assert.deepEqual(modesForLens('now'), ['overview', 'map', 'time']);
  assert.deepEqual(modesForLens('places'), ['overview', 'visual', 'map', 'time']);
  assert.deepEqual(modesForLens('people'), ['visual']);
  assert.deepEqual(modesForLens('my_world'), ['grid', 'timeline', 'map']);
  assert.equal(isModeSupported('people', 'map'), false);
  assert.equal(isModeSupported('places', 'time'), true);
});

test('isLens narrows only real lens keys', () => {
  assert.equal(isLens('now'), true);
  assert.equal(isLens('bogus'), false);
});

test('reducer: selecting a lens carries a shared mode over', () => {
  // now(map) → places also supports map, so map is carried.
  const s = lensNavReducer({ lens: 'now', mode: 'map' }, { type: 'select_lens', lens: 'places' });
  assert.deepEqual(s, { lens: 'places', mode: 'map' });
});

test('reducer: selecting a lens resets to default when current mode is unsupported', () => {
  // places(time) → people only supports visual, so reset to visual.
  const s = lensNavReducer({ lens: 'places', mode: 'time' }, { type: 'select_lens', lens: 'people' });
  assert.deepEqual(s, { lens: 'people', mode: 'visual' });
});

test('reducer: selecting an unsupported mode is a no-op', () => {
  const start = { lens: 'people' as const, mode: 'visual' as const };
  const s = lensNavReducer(start, { type: 'select_mode', mode: 'time' });
  assert.equal(s, start); // identity — refused
});

test('reducer: selecting a supported mode updates it', () => {
  const s = lensNavReducer({ lens: 'now', mode: 'overview' }, { type: 'select_mode', mode: 'time' });
  assert.deepEqual(s, { lens: 'now', mode: 'time' });
});

test('reducer: reselecting the same lens/mode returns identity (no rerender churn)', () => {
  const start = INITIAL_LENS_NAV;
  assert.equal(lensNavReducer(start, { type: 'select_lens', lens: 'now' }), start);
  assert.equal(lensNavReducer(start, { type: 'select_mode', mode: start.mode }), start);
});

test('reducer never lands in an invalid lens+mode combination', () => {
  const lenses = LENSES.map((l) => l.key);
  const modes = ['overview', 'visual', 'map', 'time', 'grid', 'timeline'] as const;
  let state = INITIAL_LENS_NAV;
  for (const lens of lenses) {
    state = lensNavReducer(state, { type: 'select_lens', lens });
    for (const mode of modes) {
      state = lensNavReducer(state, { type: 'select_mode', mode });
      assert.ok(isModeSupported(state.lens, state.mode), `invalid: ${state.lens}/${state.mode}`);
    }
  }
});
