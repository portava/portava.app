/**
 * The status line both chat screens draw under one of the caller's own
 * accepted messages (`lifecycle/OwnMessageStatusRow.tsx`).
 *
 * Pins: the words come from the one label function (so the two screens cannot
 * disagree); "read status unavailable" and "they were offline" are drawn MUTED
 * — neither may look like a confident tick; and a local sending/failed state
 * draws nothing here, because each screen already draws those rows itself.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { OwnMessageStatusRow } from '../lifecycle/OwnMessageStatusRow.tsx';
import { color } from '../../../theme/tokens.ts';

function textColor(label: string): string | undefined {
  const node = screen.getByText(label);
  const style = ([] as any[]).concat(node.props.style).reduce((a, s) => ({ ...a, ...(s ?? {}) }), {});
  return style.color;
}

describe('OwnMessageStatusRow', () => {
  it('Seen in a direct chat, Seen by N in a group', async () => {
    await render(<OwnMessageStatusRow status={{ kind: 'seen', seenBy: 1, recipientCount: 1 }} isGroup={false} />);
    expect(screen.getByText('Seen')).toBeTruthy();
    await render(<OwnMessageStatusRow status={{ kind: 'seen', seenBy: 3, recipientCount: 5 }} isGroup />);
    expect(screen.getByText('Seen by 3')).toBeTruthy();
  });

  it('Delivered is drawn as a confirmed state', async () => {
    await render(<OwnMessageStatusRow status={{ kind: 'delivered' }} isGroup={false} />);
    expect(textColor('Delivered')).toBe(color.signal);
  });

  it('THE POINT: an unknown read status is MUTED and never says a bare "Sent"', async () => {
    await render(<OwnMessageStatusRow status={{ kind: 'receipt_unavailable' }} isGroup={false} />);
    expect(screen.queryByText('Sent')).toBeNull();
    expect(textColor('Sent · read status unavailable')).toBe(color.mute);
    expect(screen.getByTestId('telegraph-own-status-receipt_unavailable')).toBeTruthy();
  });

  it('"they were offline" is muted too — it reports an absence, not a success', async () => {
    await render(<OwnMessageStatusRow status={{ kind: 'recipient_offline' }} isGroup={false} />);
    expect(textColor('Sent · they were offline')).toBe(color.mute);
  });

  it('draws nothing for a message still sending or refused — the screens own those rows', async () => {
    await render(<OwnMessageStatusRow status={{ kind: 'sending' }} isGroup={false} />);
    expect(screen.toJSON()).toBeNull();
    await render(<OwnMessageStatusRow status={{ kind: 'failed' }} isGroup={false} />);
    expect(screen.toJSON()).toBeNull();
  });
});
