/**
 * PendingTagInbox — the "Ask me first" inbox (census-discovery §95, lane
 * W11-X3; §81.4 routed hunk R3; DV-76).
 *
 *   B1  each pending tag is listed by the tagger's @handle, with Approve and Decline
 *   B2  Approve calls the approve route and, once accepted, the tag leaves
 *   B3  Decline calls the self-removal and, once accepted, the tag leaves
 *   B4  a refused answer keeps the tag and shows the server's reason
 *   B5  nothing pending: an empty-state line, no buttons
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { PendingTagInbox } from '../PendingTagInbox.tsx';
import { approvePendingTag, declinePendingTag, type PendingTag } from '../../services/tagging.ts';

// NOTE: requireActual keeps pendingTagLine and the types real; only the two
// network calls are replaced.
jest.mock('../../services/tagging.ts', () => ({
  ...jest.requireActual('../../services/tagging.ts'),
  approvePendingTag: jest.fn(),
  declinePendingTag: jest.fn(),
}));

// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo (tagging.ts imports it).
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));

const approve = approvePendingTag as jest.Mock;
const decline = declinePendingTag as jest.Mock;
const TAGS: PendingTag[] = [
  { id: 't1', sourceType: 'post', sourceId: 's1', taggedAt: null, taggerId: 'u1', taggerHandle: 'ana' },
  { id: 't2', sourceType: 'comment', sourceId: 's2', taggedAt: null, taggerId: 'u2', taggerHandle: null },
];

beforeEach(() => {
  approve.mockReset(); decline.mockReset();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { (Alert.alert as jest.Mock).mockRestore(); });

describe('B — the inbox', () => {
  it('B1 lists each tag by @handle with its two answers', async () => {
    await render(<PendingTagInbox tags={TAGS} onAnswered={() => {}} />);
    expect(screen.getByText('@ana tagged you in a post')).toBeTruthy();
    expect(screen.getByText('Someone tagged you in a comment')).toBeTruthy();
    expect(screen.getByTestId('pending-tag-approve-t1')).toBeTruthy();
    expect(screen.getByTestId('pending-tag-decline-t2')).toBeTruthy();
  });

  it('B2 Approve: the approve call, then the tag leaves', async () => {
    approve.mockResolvedValue({ ok: true });
    const onAnswered = jest.fn();
    await render(<PendingTagInbox tags={TAGS} onAnswered={onAnswered} />);
    await fireEvent.press(screen.getByTestId('pending-tag-approve-t1'));
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith('t1'));
    expect(approve).toHaveBeenCalledWith('t1');
    expect(decline).not.toHaveBeenCalled();
  });

  it('B3 Decline: the self-removal, then the tag leaves', async () => {
    decline.mockResolvedValue({ ok: true });
    const onAnswered = jest.fn();
    await render(<PendingTagInbox tags={TAGS} onAnswered={onAnswered} />);
    await fireEvent.press(screen.getByTestId('pending-tag-decline-t2'));
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith('t2'));
    expect(decline).toHaveBeenCalledWith('t2');
    expect(approve).not.toHaveBeenCalled();
  });

  it('B4 a refused answer keeps the tag and says why', async () => {
    approve.mockResolvedValue({ ok: false, error: 'This tag was removed' });
    const onAnswered = jest.fn();
    await render(<PendingTagInbox tags={TAGS} onAnswered={onAnswered} />);
    await fireEvent.press(screen.getByTestId('pending-tag-approve-t1'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Could not approve', 'This tag was removed'));
    expect(onAnswered).not.toHaveBeenCalled();
    expect(screen.getByTestId('pending-tag-approve-t1')).toBeTruthy();
  });

  it('B5 nothing pending: an empty-state line, no buttons', async () => {
    await render(<PendingTagInbox tags={[]} onAnswered={() => {}} />);
    expect(screen.getByTestId('pending-tag-inbox-empty')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
  });
});
