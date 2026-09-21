/**
 * Telegraph §6 on the client — the typed kinds, §6.1's + menu, §6.4's drawer.
 *
 * Spec:
 *   §6.2  the thirteen kinds
 *   §6.3  "GIFs are distinct lightweight looping content with data-saver /
 *          accessibility controls"
 *   §11.3 reduced motion; status is never colour alone
 *
 * WHAT IS EXERCISED: the real renderers. §6.1's menu and §6.4's drawer are
 * Modal-rooted and live in their own files (TESTING.md Rule 6):
 * `composerMenu.component.test.tsx` and `contentDrawer.component.test.tsx`.
 *
 * SHOWN RED before commit, each reverted:
 *   • `isGifAnimated` ignoring `reduceMotion` → "a GIF shows its still frame
 *     under reduced motion" RED.
 *   • `safetyWord` returning the same string for every class → the SAFETY
 *     test RED.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentional stub — kindsApi reaches lib/supabase, which builds a client
// at import time and fails outside an Expo runtime. Every renderer, the menu
// data and the drawer's own logic are the real ones.
jest.mock('../kinds/kindsApi.ts', () => {
  const actual = jest.requireActual('../kinds/kindsApi.ts');
  return { ...actual, sendTypedMessage: jest.fn(), fetchDrawer: jest.fn(), searchThread: jest.fn() };
});

// NOTE: intentional stub — AccessibilityInfo is not backed by the jest preset;
// the thing under test is the renderer's USE of the setting.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({
  useReducedMotionSetting: jest.fn(() => false),
}));

import { TypedMessageRenderer, rendersTypedKind, isGifAnimated } from '../kinds/TypedMessageRenderer.tsx';
import { useReducedMotionSetting } from '../../wall/hooks/useReducedMotionSetting.ts';

const mockedReduceMotion = useReducedMotionSetting as jest.MockedFunction<typeof useReducedMotionSetting>;

const env = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: '1', payload });

beforeEach(() => {
  mockedReduceMotion.mockReturnValue(false);
});

describe('§6.2 typed renderers', () => {
  it('knows which kinds it renders', () => {
    for (const k of ['location', 'action', 'announcement', 'safety', 'gif', 'media_album', 'memory_note']) {
      expect(rendersTypedKind(k)).toBe(true);
    }
    expect(rendersTypedKind('text')).toBe(false);
    expect(rendersTypedKind(null)).toBe(false);
  });

  it('LOCATION shows the label AND the precision the sender chose', async () => {
    await render(
      <TypedMessageRenderer
        msgType="location"
        body={env('LOCATION', { label: 'An Thuong', precision: 'area' })}
        mine={false}
      />,
    );
    expect(screen.getByTestId('telegraph-kind-location')).toBeTruthy();
    expect(screen.getByText('An Thuong')).toBeTruthy();
    expect(screen.getByText('Approximate area')).toBeTruthy();
  });

  it('ACTION renders as a PROPOSAL with a confirm control (§8.2)', async () => {
    const onPress = jest.fn();
    await render(
      <TypedMessageRenderer
        msgType="action"
        body={env('ACTION', { action: 'MEET_HERE', title: 'Meet at the bridge', requiresConfirmation: true })}
        mine={false}
        onPressAction={onPress}
      />,
    );
    fireEvent.press(screen.getByTestId('telegraph-kind-action-confirm'));
    expect(onPress).toHaveBeenCalledWith('MEET_HERE', expect.objectContaining({ action: 'MEET_HERE' }));
  });

  it('ANNOUNCEMENT offers acknowledgement when it asks for one AND the surface can write it', async () => {
    // This test used to render WITHOUT onAcknowledge and assert the button was
    // there. It passed for months over a button that did nothing: the only
    // mount in the app, app/messages/[id].tsx, passed no handler, so pressing
    // "Got it" was a no-op. Asserting an affordance EXISTS is not asserting it
    // WORKS, and this is what that gap looked like.
    const onAcknowledge = jest.fn();
    await render(
      <TypedMessageRenderer
        msgType="announcement"
        body={env('ANNOUNCEMENT', { title: 'Leaving at eight', requiresAcknowledgement: true })}
        mine={false}
        onAcknowledge={onAcknowledge}
      />,
    );
    fireEvent.press(screen.getByTestId('telegraph-kind-announcement-ack'));
    expect(onAcknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Leaving at eight', requiresAcknowledgement: true }),
    );
  });

  it('ACTION draws NO confirm control when the surface cannot confirm, and says why', async () => {
    // The same defect as the announcement's: `onPressAction` is optional and
    // the conversation screen passes none, so "Confirm" was inert on every
    // ACTION message. Unlike the announcement, this one is NOT fixed by
    // wiring a handler — an ACTION typed message carries no command id for
    // /telegraph/commands/:id/confirm-action — so the honest move is to stop
    // drawing a button that cannot do anything.
    await render(
      <TypedMessageRenderer
        msgType="action"
        body={env('ACTION', { action: 'MEET_HERE', title: 'Meet at the bridge', requiresConfirmation: true })}
        mine={false}
      />,
    );
    expect(screen.queryByTestId('telegraph-kind-action-confirm')).toBeNull();
    expect(screen.getByTestId('telegraph-kind-action-unconfirmable')).toBeTruthy();
  });

  it('ANNOUNCEMENT draws NO button when the surface cannot acknowledge, and says why', async () => {
    await render(
      <TypedMessageRenderer
        msgType="announcement"
        body={env('ANNOUNCEMENT', { title: 'Leaving at eight', requiresAcknowledgement: true })}
        mine={false}
      />,
    );
    expect(screen.queryByTestId('telegraph-kind-announcement-ack')).toBeNull();
    expect(screen.getByTestId('telegraph-kind-announcement-ack-unavailable')).toBeTruthy();
  });

  it('ANNOUNCEMENT becomes a statement once this viewer has acknowledged', async () => {
    await render(
      <TypedMessageRenderer
        msgType="announcement"
        body={env('ANNOUNCEMENT', { title: 'Leaving at eight', requiresAcknowledgement: true })}
        mine={false}
        acknowledged
        onAcknowledge={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('telegraph-kind-announcement-ack')).toBeNull();
    expect(screen.getByTestId('telegraph-kind-announcement-acked')).toBeTruthy();
  });

  it('the conversation screen actually passes a handler — the mount, not just the prop', () => {
    // §19. The renderer can only be as alive as its mount. Asserted against the
    // file because there is no way to render app/messages/[id].tsx here, and a
    // prop nobody passes is exactly the defect this closes.
    const src = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'app', 'messages', '[id].tsx'),
      'utf8',
    );
    expect(src).toContain('onAcknowledge={');
    expect(src).toContain('useAnnouncementAcknowledgement');
  });

  it('ANNOUNCEMENT offers none when it does not', async () => {
    await render(
      <TypedMessageRenderer msgType="announcement" body={env('ANNOUNCEMENT', { title: 'FYI', requiresAcknowledgement: false })} mine={false} />,
    );
    expect(screen.queryByTestId('telegraph-kind-announcement-ack')).toBeNull();
  });

  it('SAFETY says its class in WORDS, not only in colour (§11.3)', async () => {
    await render(
      <TypedMessageRenderer msgType="safety" body={env('SAFETY', { kind: 'need_help', label: 'At the station' })} mine={false} />,
    );
    expect(screen.getByText('NEEDS HELP')).toBeTruthy();
    expect(screen.getByText('At the station')).toBeTruthy();
  });

  it('MEDIA_ALBUM is ONE message with independent asset references (§6.3)', async () => {
    const assets = Array.from({ length: 6 }, (_, i) => ({ url: `https://x/${i}.jpg`, mediaType: 'image' }));
    await render(<TypedMessageRenderer msgType="media_album" body={env('MEDIA_ALBUM', { assets })} mine={false} />);
    expect(screen.getByTestId('telegraph-kind-album')).toBeTruthy();
    expect(screen.getByText('ALBUM · 6')).toBeTruthy();
    expect(screen.getByText('+2 more')).toBeTruthy();
  });

  it('an unreadable envelope is a neutral placeholder, not a crash', async () => {
    await render(<TypedMessageRenderer msgType="location" body={'not json'} mine={false} />);
    expect(screen.getByTestId('telegraph-typed-unreadable')).toBeTruthy();
  });
});

describe('§6.3 / §11.3 — GIFs and motion', () => {
  it('the rule is pure: animate only when neither reduced motion nor data saver is on', () => {
    expect(isGifAnimated({ reduceMotion: false, dataSaver: false })).toBe(true);
    expect(isGifAnimated({ reduceMotion: true, dataSaver: false })).toBe(false);
    expect(isGifAnimated({ reduceMotion: false, dataSaver: true })).toBe(false);
  });

  it('a GIF shows its still frame under reduced motion, and says why', async () => {
    mockedReduceMotion.mockReturnValue(true);
    await render(
      <TypedMessageRenderer
        msgType="gif"
        body={env('GIF', { url: 'https://g/x.gif', stillUrl: 'https://g/x.jpg', provider: 'giphy' })}
        mine={false}
      />,
    );
    expect(screen.getByTestId('telegraph-kind-gif-still')).toBeTruthy();
    expect(screen.getByText('Still frame — reduced motion is on')).toBeTruthy();
  });

  it('a GIF shows its still frame under data saver, and says why', async () => {
    await render(
      <TypedMessageRenderer
        msgType="gif"
        body={env('GIF', { url: 'https://g/x.gif', stillUrl: 'https://g/x.jpg' })}
        mine={false}
        dataSaver
      />,
    );
    expect(screen.getByText('Still frame — data saver is on')).toBeTruthy();
  });

  it('with neither on, no still-frame notice appears', async () => {
    await render(
      <TypedMessageRenderer msgType="gif" body={env('GIF', { url: 'https://g/x.gif' })} mine={false} />,
    );
    expect(screen.queryByTestId('telegraph-kind-gif-still')).toBeNull();
  });
});
