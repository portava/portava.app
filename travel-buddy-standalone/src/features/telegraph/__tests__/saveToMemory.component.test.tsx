/**
 * Telegraph §10.2 — "Save to Memory", rendered.
 *
 *   "A user may EXPLICITLY save a message, voice note, place share or media
 *    item as a PRIVATE Memory draft. Telegraph NEVER AUTOMATICALLY converts
 *    whole conversations into Memories."
 *
 * The server half — the `memories` row being `state='draft'` and
 * `visibility='only_me'` as literals, and the route refusing `threadId`,
 * `messageIds`, `conversationId` and `all` by name — is asserted in
 * `artifacts/api-server/src/test/telegraphMemory.test.ts`. What this file
 * settles is the client half of the same two words:
 *
 *   EXPLICITLY — mounting the button saves nothing; only a press does.
 *   PRIVATE    — the confirmation reports what the server actually returned.
 *                A deployment that handed back a published Memory would be
 *                described as published, not as "saved privately".
 *
 * And the ABSENCE of a bulk path is tested as a property of the module, not as
 * a comment: `SaveToMemoryActionProps` has no list prop, and the API module
 * exports no array or thread form for a screen to reach for.
 *
 * No Modal here, so this file is free of Rule 6.
 *
 * SHOWN RED before commit (8 pass green), each mutation reverted:
 *   • `isPrivateDraft` hard-coded to `true`, so the confirmation always says
 *     "Saved to your private Memory drafts" whatever came back
 *       -> 1 failed / 7 passed ("describes what the SERVER returned, not what
 *          it hoped for")
 *   • a `useEffect(() => { void onPress(); })` added — i.e. §10.2's
 *     "automatically converts" as a one-line accident
 *       -> 5 failed / 3 passed ("saves nothing until it is pressed", "saves
 *          exactly one message…", "says private only when…", "describes what
 *          the SERVER returned…", "a second save is a second explicit press")
 *
 * The second count is the useful one: an automatic save is not a subtle
 * regression here, it breaks five of eight. That is the property this file was
 * written to have.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — memoryApi reaches lib/supabase, which builds a
// client at import time and fails outside an Expo runtime. The component's own
// logic is the real one, and `save` is injected per test rather than mocked.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import { SaveToMemoryAction } from '../memory/SaveToMemoryAction.tsx';
import * as memoryApi from '../memory/memoryApi.ts';

const privateDraft = {
  ok: true as const,
  data: {
    draft: {
      id: 'd1',
      ownerId: 'u1',
      state: 'draft',
      visibility: 'only_me',
      title: 'A message from that night',
      occurredAt: '2026-05-01T20:00:00.000Z',
      fromMessageId: 'm1',
      source: 'message',
    },
  },
};

describe('§10.2 — save to Memory is EXPLICIT', () => {
  it('saves nothing until it is pressed', async () => {
    const save = jest.fn().mockResolvedValue(privateDraft);
    await render(<SaveToMemoryAction messageId="m1" save={save as any} />);
    expect(screen.getByTestId('telegraph-save-memory-button')).toBeTruthy();
    // Mount, effects, layout — none of it is a save.
    expect(save).not.toHaveBeenCalled();
  });

  it('saves exactly one message, named singularly, when pressed', async () => {
    const save = jest.fn().mockResolvedValue(privateDraft);
    await render(<SaveToMemoryAction messageId="m1" save={save as any} />);
    fireEvent.press(screen.getByTestId('telegraph-save-memory-button'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toBe('m1');
    // Not an array, not a thread id — the first argument IS the message id.
    expect(Array.isArray(save.mock.calls[0][0])).toBe(false);
  });

  it('reports a failure without claiming a save', async () => {
    const save = jest.fn().mockResolvedValue({ ok: false, error: 'forbidden', message: 'You no longer have access to that message' });
    await render(<SaveToMemoryAction messageId="m1" save={save as any} />);
    fireEvent.press(screen.getByTestId('telegraph-save-memory-button'));
    await waitFor(() => expect(screen.getByTestId('telegraph-save-memory-failed')).toBeTruthy());
    expect(screen.queryByTestId('telegraph-save-memory-saved')).toBeNull();
  });
});

describe('§10.2 — the draft is PRIVATE, and the label reads it back', () => {
  it('says private only when the server said draft + only_me', async () => {
    const save = jest.fn().mockResolvedValue(privateDraft);
    await render(<SaveToMemoryAction messageId="m1" save={save as any} />);
    fireEvent.press(screen.getByTestId('telegraph-save-memory-button'));
    await waitFor(() => expect(screen.getByTestId('telegraph-save-memory-saved')).toBeTruthy());
    const text = String(screen.getByTestId('telegraph-save-memory-saved').props.children);
    expect(text).toContain('private Memory drafts');
    expect(text).toContain('Only you can see it');
  });

  it('describes what the SERVER returned, not what it hoped for', async () => {
    const save = jest.fn().mockResolvedValue({
      ok: true,
      data: { draft: { ...privateDraft.data.draft, state: 'published', visibility: 'public' } },
    });
    await render(<SaveToMemoryAction messageId="m1" save={save as any} />);
    fireEvent.press(screen.getByTestId('telegraph-save-memory-button'));
    await waitFor(() => expect(screen.getByTestId('telegraph-save-memory-saved')).toBeTruthy());
    const text = String(screen.getByTestId('telegraph-save-memory-saved').props.children);
    // If a deployment ever published what should be a draft, the user is told.
    expect(text).toContain('published');
    expect(text).toContain('public');
    expect(text).not.toContain('Only you can see it');
  });
});

describe('§10.2 — there is no bulk path to reach for', () => {
  it('the API module exports no list or thread form', () => {
    const names = Object.keys(memoryApi);
    expect(names).toContain('saveMessageAsMemoryDraft');
    for (const n of names) {
      expect(/saveMessages|saveThread|saveConversation|MemoryDrafts?Bulk/i.test(n)).toBe(false);
    }
  });

  it('the request the real module builds carries ONE messageId and no thread', async () => {
    // Not the component's injected seam — the actual exported function, with
    // fetch stubbed, so what is asserted is the wire body it really sends.
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    const calls: Array<[string, any]> = [];
    const realFetch = global.fetch;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push([url, init]);
      return { ok: true, json: async () => privateDraft.data } as any;
    });
    try {
      const r = await memoryApi.saveMessageAsMemoryDraft('m1');
      expect(r.ok).toBe(true);
      expect(calls).toHaveLength(1);
      const [url, init] = calls[0];
      expect(url).toBe('https://api.test/api/me/memory-drafts');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body).toEqual({ messageId: 'm1' });
      expect(body.messageIds).toBeUndefined();
      expect(body.threadId).toBeUndefined();
      expect(body.conversationId).toBeUndefined();
      expect(body.all).toBeUndefined();
    } finally {
      (global as any).fetch = realFetch;
      delete process.env.EXPO_PUBLIC_API_BASE_URL;
    }
  });

  it('a second save is a second explicit press', async () => {
    const save = jest.fn().mockResolvedValue(privateDraft);
    await render(<SaveToMemoryAction messageId="m1" save={save as any} />);
    fireEvent.press(screen.getByTestId('telegraph-save-memory-button'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // Once saved the button is replaced by the confirmation: nothing here can
    // loop over a thread's messages on the user's behalf.
    expect(screen.queryByTestId('telegraph-save-memory-button')).toBeNull();
  });
});
