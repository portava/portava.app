/**
 * Telegraph §6.1 — the composer's `+` menu, and the two typed-compose sheets.
 *
 *   "[ + ]  Message…  [🎤]
 *    + menu: Camera Photos / Video GIF / Voice Memory Note / Location Portava
 *    The composer remains visually calm; rich actions live behind the + menu."
 *
 * MODAL RULE 6 (src/components/__tests__/TESTING.md): react-native's `Modal`
 * posts a macrotask on mount that corrupts RNTL's act scope, so it is replaced
 * with a synchronous View through a Proxy, and ONE Modal-rooted component per
 * file — a second one in the same file does not mount. The two compose sheets
 * live in `typedCompose.component.test.tsx` for that reason.
 *
 * VOICE MOVED. It was the file's example of an honestly-disabled entry, with
 * the reason "messages.media_type allows only image and video". Migration 2989
 * and `routes/telegraphVoice.ts` closed that, so Voice is AVAILABLE and GIF is
 * now the entry these cases exercise. The assertions did not get weaker: the
 * unavailable list is still checked exhaustively, every remaining reason must
 * still be a real sentence, and the available count is still pinned.
 *
 * SHOWN RED before commit: the VOICE entry's `available` flipped back to false
 * → "names all EIGHT, and says which cannot complete" and the VOICE-selects
 * case RED.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6. Only the `Modal` key is
// intercepted; every other react-native export falls through via Reflect.get.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react');
        return ({ children, visible }: any) =>
          visible ? R.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

import { ComposerPlusMenu } from '../composer/ComposerPlusMenu.tsx';
import { COMPOSER_ENTRIES, availableEntryCount, composerEntry } from '../composer/composerMenu.ts';

describe('§6.1 — the menu is §6.1s eight, with honest availability', () => {
  it('names all EIGHT of §6.1, in the spec order, and says which cannot complete', () => {
    expect(COMPOSER_ENTRIES.map((e) => e.id)).toEqual([
      'CAMERA', 'PHOTOS', 'VIDEO', 'GIF', 'VOICE', 'MEMORY_NOTE', 'LOCATION', 'PORTAVA',
    ]);
    const unavailable = COMPOSER_ENTRIES.filter((e) => !e.available);
    expect(unavailable.map((e) => e.id).sort()).toEqual(['GIF', 'PORTAVA']);
    for (const e of unavailable) {
      // A reason, not a shrug. Long enough to name the actual obstacle.
      expect((e.unavailableReason ?? '').length).toBeGreaterThan(40);
    }
    expect(availableEntryCount()).toBe(6);
  });

  it('VOICE is available, and carries NO leftover reason', () => {
    // A stale reason beside `available: true` is how a menu ends up telling a
    // traveler why something does not work while it works.
    expect(composerEntry('VOICE').available).toBe(true);
    expect(composerEntry('VOICE').unavailableReason).toBeNull();
    expect(composerEntry('VOICE').kind).toBe('VOICE');
  });

  it('renders every entry, and an unavailable one states its reason INLINE', async () => {
    const onSelect = jest.fn();
    const onUnavailable = jest.fn();
    await render(
      <ComposerPlusMenu visible onClose={() => {}} onSelect={onSelect} onUnavailable={onUnavailable} />,
    );
    for (const e of COMPOSER_ENTRIES) {
      expect(screen.getByTestId(`telegraph-composer-entry-${e.id}`)).toBeTruthy();
    }
    // The reason is visible without tapping — a traveler should not have to
    // discover it by trying.
    expect(screen.getByTestId('telegraph-composer-reason-GIF')).toBeTruthy();
    expect(screen.getByTestId('telegraph-composer-reason-PORTAVA')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-composer-reason-CAMERA')).toBeNull();
    // VOICE works now, so it must NOT still be carrying an explanation.
    expect(screen.queryByTestId('telegraph-composer-reason-VOICE')).toBeNull();

    fireEvent.press(screen.getByTestId('telegraph-composer-entry-GIF'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({ id: 'GIF' }));

    // §6.1's Voice entry SELECTS — it no longer refuses.
    fireEvent.press(screen.getByTestId('telegraph-composer-entry-VOICE'));
    expect(onSelect).toHaveBeenCalledWith('VOICE');

    fireEvent.press(screen.getByTestId('telegraph-composer-entry-LOCATION'));
    expect(onSelect).toHaveBeenCalledWith('LOCATION');
  });

  it('renders nothing when closed', async () => {
    await render(<ComposerPlusMenu visible={false} onClose={() => {}} onSelect={() => {}} />);
    expect(screen.queryByTestId('telegraph-composer-plus-menu')).toBeNull();
  });
});
