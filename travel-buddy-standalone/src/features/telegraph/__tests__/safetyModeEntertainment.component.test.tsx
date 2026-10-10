/**
 * Telegraph §15.2 — while a conversation's safety mode is raised, ENTERTAINMENT is put away.
 *
 * census-telegraph T218 (§45.3, verifier F3 on §44): "Now only the AI suggestion tray is held
 * away, for the whole raised mode; the Ask Compass tray, the GIF entry and reactions are not
 * demoted." This file pins the other three:
 *   - the + menu's GIF entry is not offered while the mode is raised, and is offered again when
 *     it is not (the real ComposerPlusMenu over composerEntriesFor);
 *   - the thread screen hands the menu the raised state, and holds the Ask Compass chip AND its
 *     tray away for the whole raised mode (source level: app/messages/[id].tsx cannot be mounted
 *     under jest-expo, §41.7 — safetyModeBar.component.test.tsx pins the same state variable);
 *   - reactions: the thread screen has no reaction affordance at all, so there is nothing to
 *     demote — pinned, so one cannot arrive un-demoted.
 *
 * MODAL RULE 6 (src/components/__tests__/TESTING.md): Modal is a synchronous View here, and the
 * only Modal-rooted component in this file is ComposerPlusMenu. Every press is awaited (RNTL v14
 * fireEvent is async; an unawaited one voids every later render in the file).
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { COMPOSER_ENTRIES, ENTERTAINMENT_ENTRY_IDS, composerEntriesFor } from '../composer/composerMenu.ts';

const dm: string = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
const group: string = readFileSync(join(__dirname, '../../../components/GroupChatScreen.tsx'), 'utf8');

describe('§15.2 — the + menu while safety mode is raised', () => {
  it('composerEntriesFor: raised → every entry but the entertainment ones, in the same order; calm → all eight', () => {
    expect(ENTERTAINMENT_ENTRY_IDS).toEqual(['GIF']);
    expect(composerEntriesFor({ deprioritizeEntertainment: false })).toEqual(COMPOSER_ENTRIES);
    expect(composerEntriesFor({ deprioritizeEntertainment: true }).map((e) => e.id)).toEqual([
      'CAMERA', 'PHOTOS', 'VIDEO', 'VOICE', 'MEMORY_NOTE', 'LOCATION', 'PORTAVA',
    ]);
  });

  it('the real menu does not offer GIF while the mode is raised — and still offers everything a person in trouble uses', async () => {
    const onSelect = jest.fn();
    await render(<ComposerPlusMenu visible deprioritizeEntertainment onClose={() => {}} onSelect={onSelect} />);
    expect(screen.queryByTestId('telegraph-composer-entry-GIF')).toBeNull();
    for (const id of ['CAMERA', 'PHOTOS', 'VIDEO', 'VOICE', 'MEMORY_NOTE', 'LOCATION', 'PORTAVA']) {
      expect(screen.getByTestId(`telegraph-composer-entry-${id}`)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId('telegraph-composer-entry-LOCATION'));
    expect(onSelect).toHaveBeenCalledWith('LOCATION');
  });

  it('the same menu offers GIF again once the mode is down (nothing is put away for good)', async () => {
    await render(<ComposerPlusMenu visible deprioritizeEntertainment={false} onClose={() => {}} onSelect={() => {}} />);
    expect(screen.getByTestId('telegraph-composer-entry-GIF')).toBeTruthy();
    expect(screen.getByTestId('telegraph-composer-entry-CAMERA')).toBeTruthy();
  });
});

describe('§15.2 — the thread screen puts Ask Compass away and tells the menu (source level)', () => {
  it('the + menu is handed the raised state', () => {
    expect(dm).toContain('visible={showPlusMenu} deprioritizeEntertainment={safetyQuiet}');
  });

  it('the Ask Compass chip is not drawn while the mode is raised, and an open tray is held closed', () => {
    expect(dm).toContain('{compassTelegraphEnabled === true && !safetyQuiet && (');
    expect(dm).toContain('visible={showCompassTray && !safetyQuiet}');
    // The one way the tray opens is that chip.
    expect((dm.match(/setShowCompassTray\(true\)/g) ?? []).length).toBe(1);
  });

  it('safetyQuiet is the state SafetyModeBar sets from the served mode (the same one the AI tray uses)', () => {
    expect(dm).toContain('onModeChange={(s) => setSafetyQuiet(s.deprioritizeEntertainment)}');
  });

  it('reactions: the thread screen has no reaction affordance, so nothing is left un-demoted', () => {
    expect(dm).not.toMatch(/ReactionPicker|addReaction|toggleReaction|onReact\b/);
  });
});

describe('§15.2 — the trip and circle chat raises the same bar (source level; the screen has never mounted under jest)', () => {
  const line = group.split('\n').find((l) => l.includes('<SafetyModeBar ')) ?? '';

  it('mounts SafetyModeBar for the thread, re-read on each new message, above the rail', () => {
    expect(line).toContain('<SafetyModeBar threadId={thread.id} refreshKey={messages[messages.length - 1]?.id ?? null}');
    expect(line).toContain('senderLabel={(uid) => senderLabelFor(messages, uid, userId ?? null)}');
    expect(line.indexOf('<SafetyModeBar ')).toBeGreaterThanOrEqual(0);
    expect(line.indexOf('<SafetyModeBar ')).toBeLessThan(line.indexOf('<SharedContextRail '));
  });

  it('the group surface carries none of the entertainment the thread screen puts away (so there is nothing left un-demoted there)', () => {
    expect(group).not.toMatch(/<CompassTelegraphTray|<ComposerPlusMenu|AiSuggestion|ReactionPicker/);
  });
});
