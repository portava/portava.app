/**
 * census-telegraph T431 (§30A.16) — the client declares exactly what it RENDERS.
 *
 * Spec §30A.16: "Use client capability negotiation when an interaction requires
 * a minimum supported schema or action version." The server reads
 * `x-telegraph-client-schemas` / `x-telegraph-client-actions` and takes a
 * present header literally: an undeclared schema or action is served as a TEXT
 * row with a fixed sentence. So a header that claims more than the client draws
 * hands it payloads it prints raw, and one that claims less blanks what it could
 * draw. negotiation/clientCapabilities.ts derives both from the renderers; this
 * file holds the derivation to the renderers themselves.
 *
 * WHAT TURNS THIS RED: a declared schema the surface does not draw as itself (or
 * a drawn one left out); a coordination kind declared for a stream that prints
 * it as "can't be shown"; an action declared that no control performs; a
 * coordination post naming a schema for a kind the client does not know.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional stub — lib/supabase builds a client at import time, which fails outside an Expo runtime.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentional stub — AccessibilityInfo is not backed by the jest preset; the renderer's use of it is not under test here.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({ useReducedMotionSetting: jest.fn(() => false) }));
// NOTE: intentional stub — the voice player hydrates a signed URL over the network; what is under test is that the
// typed renderer DISPATCHES a VOICE envelope to it (and not to its unreadable/unknown branches).
jest.mock('../voice/VoiceMessagePlayer.tsx', () => {
  const { Text: T } = require('react-native');
  return { VoiceMessagePlayer: () => <T testID="telegraph-kind-voice-player">voice</T> };
});

import {
  CLIENT_SCHEMA_MIRROR,
  CLIENT_SCHEMAS_HEADER,
  CLIENT_ACTIONS_HEADER,
  SURFACE_STRUCTURED_MSG_TYPES,
  cardPerformedActions,
  coordinationSchemaFor,
  declaredSchemaTokens,
  shareProjectionHeaders,
  storedMsgTypeOf,
  telegraphReadHeaders,
  withCoordinationSchema,
} from '../negotiation/clientCapabilities.ts';
import { TypedMessageRenderer, rendersTypedKind } from '../kinds/TypedMessageRenderer.tsx';
import { rendersKnownMessageType } from '../kinds/unsupportedPayload.ts';
import { parsePortavaObjectBody } from '../sharing/shareApi.ts';
import { offeredCardActions } from '../sharing/legacyCardView.ts';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const env = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: '1', payload });

const SHARE_FAMILIES = ['place.share.v1', 'event.share.v1', 'trip.share.v1', 'object.share.v1'];

describe('T431 — the headers, by surface', () => {
  it('the conversation declares the typed kinds its renderer draws and the shared card — no coordination kind, no action', () => {
    const h = telegraphReadHeaders('conversation');
    expect(h[CLIENT_SCHEMAS_HEADER].split(',')).toEqual([
      'place.share.v1', 'event.share.v1', 'trip.share.v1', 'memory_note.v1', 'location.scope.v1', 'object.share.v1',
      'media_album.v1', 'gif.v1', 'voice.v1', 'action.v1', 'announcement.v1', 'safety.v1',
    ]);
    expect(h[CLIENT_ACTIONS_HEADER]).toBe('none');
  });

  it('the group chat declares the shared card only: every other structured kind falls to its text bubble there', () => {
    const h = telegraphReadHeaders('group_chat');
    expect(h[CLIENT_SCHEMAS_HEADER].split(',')).toEqual(SHARE_FAMILIES);
    expect(h[CLIENT_ACTIONS_HEADER]).toBe('none');
  });

  it('share projections: the card\'s families, and the actions a card turns into controls', () => {
    const h = shareProjectionHeaders();
    expect(h[CLIENT_SCHEMAS_HEADER].split(',')).toEqual(SHARE_FAMILIES);
    expect(h[CLIENT_ACTIONS_HEADER]).toBe('ADD_TO_TRIP.v1,MEET_HERE.v1');
  });

  it('"none" is present, so the server takes it literally, and parses to no action at all', () => {
    expect('none').not.toMatch(/^([A-Z][A-Z_]*)\.v([1-9][0-9]{0,3})$/);
  });
});

describe('T431 — derived from the renderers, never "everything"', () => {
  const conversation = declaredSchemaTokens(SURFACE_STRUCTURED_MSG_TYPES.conversation);

  it('a schema is declared for the conversation exactly when its stored type is drawn as itself there', () => {
    for (const s of CLIENT_SCHEMA_MIRROR) {
      const type = storedMsgTypeOf(s);
      const drawn = type === 'portava_object' || rendersTypedKind(type);
      expect([s.id, conversation.includes(s.id)]).toEqual([s.id, drawn]);
    }
  });

  it('every coordination kind is a type the bubble does not know, so none is declared (the server then names it)', () => {
    const coordination = CLIENT_SCHEMA_MIRROR.filter((s) => s.carrier === 'coordination');
    expect(coordination.length).toBe(11);
    for (const s of coordination) {
      expect(rendersTypedKind(storedMsgTypeOf(s))).toBe(false);
      expect(rendersKnownMessageType(storedMsgTypeOf(s))).toBe(false);
      expect(conversation).not.toContain(s.id);
    }
  });

  const SAMPLES: Record<string, { payload: unknown; testID: string }> = {
    MEDIA_ALBUM: { payload: { assets: [{ url: 'post-media/a.jpg', type: 'image' }] }, testID: 'telegraph-kind-album' },
    GIF: { payload: { url: 'post-media/g.gif', provider: 'giphy' }, testID: 'telegraph-kind-gif' },
    LOCATION: { payload: { label: 'An Thuong', precision: 'area' }, testID: 'telegraph-kind-location' },
    ACTION: { payload: { action: 'MEET_HERE', title: 'Meet at the bridge', requiresConfirmation: true }, testID: 'telegraph-kind-action' },
    ANNOUNCEMENT: { payload: { title: 'Leaving at eight', requiresAcknowledgement: false }, testID: 'telegraph-kind-announcement' },
    SAFETY: { payload: { kind: 'check_in', label: 'Home safe' }, testID: 'telegraph-kind-safety' },
    MEMORY_NOTE: { payload: { memoryNoteId: 'n1', authorId: 'u1', text: 'The lanterns' }, testID: 'telegraph-kind-memory-note' },
    VOICE: { payload: { url: 'voice-notes/a.m4a', durationSeconds: 4 }, testID: 'telegraph-kind-voice-player' },
  };

  it.each(CLIENT_SCHEMA_MIRROR.filter((s) => s.carrier === 'envelope').map((s) => [s.id, s.kind]))(
    'declared envelope schema %s is drawn by the real TypedMessageRenderer as itself (v1 sample)',
    async (_id, kind) => {
      expect(conversation).toContain(_id);
      const sample = SAMPLES[kind];
      expect(sample).toBeDefined();
      await render(<TypedMessageRenderer msgType={kind.toLowerCase()} body={env(kind, sample!.payload)} mine={false} />);
      expect(screen.getByTestId(sample!.testID)).toBeTruthy();
      expect(screen.queryByTestId('telegraph-typed-unreadable')).toBeNull();
      expect(screen.queryByTestId('telegraph-typed-unknown')).toBeNull();
    },
  );

  it('every declared share family parses through the card\'s own gate, for every object type in it', () => {
    for (const s of CLIENT_SCHEMA_MIRROR.filter((x) => x.carrier === 'portava_object')) {
      expect(conversation).toContain(s.id);
      for (const objectType of s.objectTypes ?? ['POST']) {
        const body = JSON.stringify({ kind: 'PORTAVA_OBJECT', shareProjectionVersion: '1', objectType, objectId: 'x1' });
        expect([s.id, objectType, parsePortavaObjectBody(body) !== null]).toEqual([s.id, objectType, true]);
      }
    }
  });

  it('the declared card actions are exactly the §8.1 actions offeredCardActions turns into a control', () => {
    expect(cardPerformedActions()).toEqual(['ADD_TO_TRIP', 'MEET_HERE']);
    const live = offeredCardActions('live', ['ADD_TO_TRIP', 'MEET_HERE']);
    expect(live.addToTrip && live.meetHere).toBe(true);
  });

  it('the surfaces are the screens\' own dispatch: the conversation mounts the typed renderer WITHOUT onPressAction; the group chat has no typed branch', () => {
    const conversationScreen = read('app/messages/[id].tsx');
    expect(conversationScreen).toMatch(/if \(rendersTypedKind\(item\.msgType\)\) \{/);
    expect(conversationScreen).toMatch(/if \(item\.msgType === 'portava_object'\) \{/);
    const mount = conversationScreen.slice(conversationScreen.indexOf('<TypedMessageRenderer'), conversationScreen.indexOf('/>', conversationScreen.indexOf('<TypedMessageRenderer')));
    expect(mount).not.toMatch(/onPressAction/); // so the stream performs no ACTION, and declares none
    const groupChat = read('src/components/GroupChatScreen.tsx');
    expect(groupChat).toMatch(/if \(m\.msgType === 'portava_object'\) \{/);
    expect(groupChat).not.toMatch(/TypedMessageRenderer|rendersTypedKind/);
    const hook = read('src/hooks/useGroupChat.ts');
    const calls = hook.match(/getThreadMessages\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/'group_chat'\)$/);
  });
});

describe('T431 — the coordination post names its schema only when the client knows the kind', () => {
  it('each coordination kind maps to its own id; anything else to nothing', () => {
    expect(coordinationSchemaFor('COORDINATION')).toBe('coordination.status.v1');
    expect(coordinationSchemaFor('VOTE')).toBe('coordination.vote.v1');
    expect(coordinationSchemaFor('ACKNOWLEDGEMENT')).toBe('coordination.acknowledgement.v1');
    expect(coordinationSchemaFor('COORDINATION_SESSION')).toBe('coordination.session.v1');
    expect(coordinationSchemaFor('SAFETY')).toBeUndefined(); // an envelope kind, not a coordination post
    expect(coordinationSchemaFor('NOT_A_KIND')).toBeUndefined();
    expect(coordinationSchemaFor('coordination')).toBeUndefined(); // exact, never case-folded into a guess
  });

  it('withCoordinationSchema adds the field only when known, and changes nothing else', () => {
    expect(withCoordinationSchema({ kind: 'VOTE', payload: { a: 1 } })).toEqual({ kind: 'VOTE', payload: { a: 1 }, schema: 'coordination.vote.v1' });
    const unknown = withCoordinationSchema({ kind: 'MYSTERY', payload: null });
    expect(unknown).toStrictEqual({ kind: 'MYSTERY', payload: null });
    expect('schema' in unknown).toBe(false);
  });
});
