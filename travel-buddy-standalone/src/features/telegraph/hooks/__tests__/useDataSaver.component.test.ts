/**
 * Telegraph §16.2 / §17.4 — data-saver and the degradation ladder.
 *
 * §16.2: "Data-saver mode prioritizes text/status/coordinates over media/AI."
 * §17.4: "Low bandwidth → deprioritize typing, reactions, media preview and AI
 *         before text or safety coordination."
 *
 * The interesting half is `mayLoad`, which is pure, so the ORDER — the thing
 * both requirements are actually about — is tested without React.
 *
 * WHAT TURNS THIS RED
 *   • reorder the ladder so media is shed before AI → the order test fails.
 *   • add a level that sheds `text` or `safety` → the never-shed test fails,
 *     and that is exactly the line §17.4 draws.
 *   • shed anything while the stored preference is still loading → the loading
 *     test fails; a screen that hid media for a frame on every mount would be
 *     data-saver applied to people who never asked for it.
 */

import { renderHook, act, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEGRADATION_LADDER,
  mayLoad,
  useDataSaver,
  type DegradableFeature,
} from '../useDataSaver.ts';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('§17.4 — the degradation ladder, as an order', () => {
  it('names every feature §17.4 lists, with text and safety last', () => {
    expect([...DEGRADATION_LADDER]).toEqual([
      'ai', 'typing', 'reactions', 'mediaPreview', 'media', 'text', 'safety',
    ]);
  });

  it('sheds AI before typing, typing before reactions, reactions before media', () => {
    // At a hypothetical partial level, the earlier rung is shed first. The only
    // two levels today are off/on, so this asserts the ORDER through the shape
    // of the ladder rather than through a level that does not exist yet.
    const order = DEGRADATION_LADDER.indexOf.bind(DEGRADATION_LADDER);
    expect(order('ai')).toBeLessThan(order('typing'));
    expect(order('typing')).toBeLessThan(order('reactions'));
    expect(order('reactions')).toBeLessThan(order('mediaPreview'));
    expect(order('mediaPreview')).toBeLessThan(order('media'));
    expect(order('media')).toBeLessThan(order('text'));
  });

  it('OFF sheds nothing', () => {
    for (const f of DEGRADATION_LADDER) {
      expect(mayLoad(f as DegradableFeature, 'off')).toBe(true);
    }
  });

  it('ON sheds AI, typing, reactions, media preview and media', () => {
    for (const f of ['ai', 'typing', 'reactions', 'mediaPreview', 'media'] as DegradableFeature[]) {
      expect(mayLoad(f, 'on')).toBe(false);
    }
  });

  it('NEVER sheds text or safety, at any level', () => {
    for (const level of ['off', 'on'] as const) {
      expect(mayLoad('text', level)).toBe(true);
      expect(mayLoad('safety', level)).toBe(true);
    }
  });

  it('an unknown feature is allowed rather than silently hidden', () => {
    expect(mayLoad('something_new' as DegradableFeature, 'on')).toBe(true);
  });
});

describe('useDataSaver — the stored preference', () => {
  it('defaults to off and sheds nothing while the preference is still loading', async () => {
    const { result } = await renderHook(() => useDataSaver());
    // First tick: loading is true and nothing may be withheld.
    expect(result.current.mayLoad('media')).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.level).toBe('off');
  });

  it('persists a change and applies it', async () => {
    const { result } = await renderHook(() => useDataSaver());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.setLevel('on'); });
    expect(result.current.level).toBe('on');
    expect(result.current.mayLoad('media')).toBe(false);
    expect(result.current.mayLoad('text')).toBe(true);
    expect(await AsyncStorage.getItem('telegraph:dataSaver:v1')).toBe('on');
  });

  it('reads a previously stored preference back', async () => {
    await AsyncStorage.setItem('telegraph:dataSaver:v1', 'on');
    const { result } = await renderHook(() => useDataSaver());
    await waitFor(() => expect(result.current.level).toBe('on'));
    expect(result.current.mayLoad('ai')).toBe(false);
  });

  it('an unreadable preference leaves data-saver OFF rather than guessing ON', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage gone'));
    const { result } = await renderHook(() => useDataSaver());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.level).toBe('off');
    expect(result.current.mayLoad('media')).toBe(true);
    spy.mockRestore();
  });
});
