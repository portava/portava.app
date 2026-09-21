/**
 * Telegraph §10.2 — "Save to Memory", on the client.
 *
 *   "A user may EXPLICITLY save a message, voice note, place share or media
 *    item as a PRIVATE Memory draft. Telegraph NEVER AUTOMATICALLY converts
 *    whole conversations into Memories."
 *
 * The server half — the `memories` row being `state='draft'` and
 * `visibility='only_me'` as literals, and the route refusing `threadId`,
 * `messageIds`, `conversationId` and `all` by name — is asserted in
 * `artifacts/api-server/src/test/telegraphMemory.test.ts`. What this file
 * settles is the client half of the same two words.
 *
 * ── WHY THIS FILE NO LONGER RENDERS A COMPONENT ─────────────────────────────
 * It used to mount a `SaveToMemoryAction` button. That component was real,
 * tested, and MOUNTED NOWHERE: the actual save lives on the long-press action
 * sheet in `app/messages/[id].tsx`, beside the "Save message" row it belongs
 * next to. A tested component that no screen renders is the exact failure this
 * census keeps finding — an affordance that exists only in its own test — so
 * the component was deleted and the one decision it carried moved into
 * `draftSavedMessage`, a pure function with one real call site.
 *
 * PRIVATE is therefore tested where it is now decided: `draftSavedMessage`
 * reports what the SERVER returned. A deployment that handed back a published
 * Memory would be described as published, not as "saved privately".
 *
 * EXPLICIT is tested as a property of the module's SHAPE: no array form, no
 * thread form, no "save this conversation" helper for a screen to reach for,
 * and the request the real function builds carries exactly one `messageId`.
 *
 * SHOWN RED before commit (6 pass green), each mutation reverted:
 *   • `draftSavedMessage` hard-coded to the private sentence
 *       -> 2 failed / 4 passed ("describes what the SERVER returned, not what
 *          it hoped for", "a draft that is a draft but not only-me is still not
 *          called private")
 *   • `saveMessageAsMemoryDraft` also spreading `messageIds: [messageId]` into
 *     the body alongside the singular key
 *       -> 2 failed / 4 passed ("the request the real module builds carries ONE
 *          messageId and no thread", "a title and caption travel, but nothing
 *          that names a set does")
 */

// NOTE: intentional stub — memoryApi reaches lib/supabase, which builds a
// client at import time and fails outside an Expo runtime. Everything asserted
// below is the real module.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import * as memoryApi from '../memory/memoryApi.ts';
import { draftSavedMessage, type MemoryDraft } from '../memory/memoryApi.ts';

const privateDraft: MemoryDraft = {
  id: 'd1',
  ownerId: 'u1',
  state: 'draft',
  visibility: 'only_me',
  title: 'A message from that night',
  occurredAt: '2026-05-01T20:00:00.000Z',
  fromMessageId: 'm1',
  source: 'message',
};

describe('§10.2 — the draft is PRIVATE, and the message reads it back', () => {
  it('says private only when the server said draft + only_me', () => {
    const text = draftSavedMessage(privateDraft);
    expect(text).toContain('private Memory drafts');
    expect(text).toContain('Only you can see it');
  });

  it('describes what the SERVER returned, not what it hoped for', () => {
    const text = draftSavedMessage({ ...privateDraft, state: 'published', visibility: 'public' });
    // If a deployment ever published what should be a draft, the user is told.
    expect(text).toContain('published');
    expect(text).toContain('public');
    expect(text).not.toContain('Only you can see it');
  });

  it('a draft that is a draft but not only-me is still not called private', () => {
    const text = draftSavedMessage({ ...privateDraft, visibility: 'friends_only' });
    expect(text).not.toContain('Only you can see it');
    expect(text).toContain('friends_only');
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
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    const calls: Array<[string, any]> = [];
    const realFetch = global.fetch;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ draft: privateDraft }) } as any;
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

  it('a title and caption travel, but nothing that names a set does', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    const calls: Array<[string, any]> = [];
    const realFetch = global.fetch;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ draft: privateDraft }) } as any;
    });
    try {
      await memoryApi.saveMessageAsMemoryDraft('m1', { title: 'The pier', caption: null });
      const body = JSON.parse(calls[0][1].body);
      expect(body).toEqual({ messageId: 'm1', title: 'The pier', caption: null });
    } finally {
      (global as any).fetch = realFetch;
      delete process.env.EXPO_PUBLIC_API_BASE_URL;
    }
  });
});
