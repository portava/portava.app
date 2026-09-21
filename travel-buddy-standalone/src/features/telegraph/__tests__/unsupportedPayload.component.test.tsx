/**
 * Telegraph §30A.13 / census T430 — "Unknown future message types render a
 * SAFE generic fallback on older clients rather than crashing or silently
 * disappearing."
 *
 * THE DEFECT THIS PINS. The census scored T430 "two thirds": a fallback did
 * exist and nothing crashed or disappeared, but neither fallback was safe.
 * Telegraph's structured payloads live in `messages.body` as a JSON string
 * (census T157), and both fallbacks — the centred system pill and the ordinary
 * bubble — rendered `body` as literal text. A client that met a kind it did
 * not know showed the reader the wire format.
 *
 * WHAT IS EXERCISED. The REAL `TelegraphSystemNotice`, which is the pill all
 * three of its mounts pass a raw `m.body` to, plus the pure rule the
 * conversation screen's bubble applies to an unrecognised `msgType`. The
 * screen itself (`app/messages/[id].tsx`) is not mountable in this preset, so
 * its half is covered by the rule it calls and by the component that receives
 * the same string — not by a claim that the screen was rendered.
 *
 * THE ASSERTION THAT MATTERS is not "the notice says the new sentence" but
 * "the payload is NOT on screen". A test that only checked for the friendly
 * text would pass a component that printed both.
 *
 * SHOWN RED before green (15 pass / 0 fail). Three mutations, each applied,
 * run, reverted, and the file compared byte-for-byte with `cmp`:
 *
 *   C1  `safeUnknownBody(text)` in TelegraphSystemNotice reverted to `text` —
 *       the state before this change.                      12 pass / 3 fail.
 *   C2  `isMachinePayload`'s closing `typeof parsed === 'object'` check
 *       deleted.                                  **STAYED GREEN**, 15 / 0.
 *   C3  the first-character `{`/`[` test deleted.           14 pass / 1 fail
 *       ("does NOT treat what a person types as a payload" — `42`, `true`,
 *       `null` and `"hi"` all became payloads).
 *
 * C2 IS THE ONE WORTH READING. The type check could not be reached and be
 * false: by JSON's grammar a value that starts with `{` or `[` and parses is
 * an object or an array. It was decoration, it was deleted, and C3 is the
 * mutation that shows which line actually carries the rule. The finding is
 * recorded here rather than the check quietly replaced.
 *
 * Run: ./node_modules/.bin/jest --forceExit \
 *        src/features/telegraph/__tests__/unsupportedPayload.component.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { TelegraphSystemNotice } from '../../../components/TelegraphSystemNotice.tsx';
import {
  UNSUPPORTED_MESSAGE_TEXT,
  isMachinePayload,
  rendersKnownMessageType,
  safeUnknownBody,
} from '../kinds/unsupportedPayload.ts';

/** A future typed kind, in the exact envelope this tree already emits. */
const FUTURE_ENVELOPE = JSON.stringify({
  kind: 'ITINERARY_HANDOFF',
  envelopeVersion: '2',
  payload: {
    tripId: 'trip-9f2a',
    assetUrl: 'https://cdn.example.test/private/itinerary.pdf',
    note: 'pick up the keys from Mara',
  },
});

/** A legacy bespoke card payload, the shape census T35 names. */
const LEGACY_CARD = JSON.stringify({
  subtype: 'discovery_card',
  placeId: 'place-771',
  title: 'Kiosko Verde',
});

describe('§30A.13 T430 — the fallback is safe, not just present', () => {
  it('the system pill does NOT print a future kind’s payload', async () => {
    await render(<TelegraphSystemNotice text={FUTURE_ENVELOPE} />);
    expect(screen.queryByText(FUTURE_ENVELOPE)).toBeNull();
    expect(screen.queryByText(/ITINERARY_HANDOFF/)).toBeNull();
    expect(screen.queryByText(/cdn\.example\.test/)).toBeNull();
    expect(screen.getByText(UNSUPPORTED_MESSAGE_TEXT)).toBeTruthy();
  });

  it('nor a legacy bespoke card payload', async () => {
    await render(<TelegraphSystemNotice text={LEGACY_CARD} />);
    expect(screen.queryByText(/place-771/)).toBeNull();
    expect(screen.getByText(UNSUPPORTED_MESSAGE_TEXT)).toBeTruthy();
  });

  it('an EMPTY body still renders a message — §30A.13’s "silently disappearing"', async () => {
    await render(<TelegraphSystemNotice text="" />);
    expect(screen.getByText(UNSUPPORTED_MESSAGE_TEXT)).toBeTruthy();
  });

  it('but real prose is untouched — the regression this fix must not cause', async () => {
    await render(<TelegraphSystemNotice text="Trip plan updated" />);
    expect(screen.getByText('Trip plan updated')).toBeTruthy();
    expect(screen.queryByText(UNSUPPORTED_MESSAGE_TEXT)).toBeNull();
  });

  // One case per test rather than a loop: react-native-testing-library's
  // `screen` is bound to the last render, and an in-test `cleanup()` detaches
  // it for every render after it — a loop here silently queried a dead tree.
  it.each([
    ['a future envelope', FUTURE_ENVELOPE],
    ['a legacy card payload', LEGACY_CARD],
    ['an empty body', ''],
    ['real prose', 'Trip plan updated'],
    ['a lone brace', '{'],
  ])('renders SOMETHING for %s — it never returns null', async (_label, body) => {
    await render(<TelegraphSystemNotice text={body} />);
    expect(screen.getByTestId('telegraph-system-notice')).toBeTruthy();
  });
});

describe('the rule itself — conservative on purpose', () => {
  it('treats JSON objects and arrays as payloads', () => {
    expect(isMachinePayload(FUTURE_ENVELOPE)).toBe(true);
    expect(isMachinePayload('[{"a":1}]')).toBe(true);
    expect(isMachinePayload('  {"a":1}  ')).toBe(true);
  });

  it('does NOT treat what a person types as a payload', () => {
    // Each of these is something a human can and does send. None parses to a
    // container, and a rule that ate any of them would be worse than the leak.
    for (const typed of ['hello', '42', 'true', 'null', '"hi"', '{', '{ not json }', ':-)', '']) {
      expect(isMachinePayload(typed)).toBe(false);
    }
  });

  it('passes prose through and replaces payloads', () => {
    expect(safeUnknownBody('see you at six')).toBe('see you at six');
    expect(safeUnknownBody(FUTURE_ENVELOPE)).toBe(UNSUPPORTED_MESSAGE_TEXT);
    expect(safeUnknownBody(null)).toBe(UNSUPPORTED_MESSAGE_TEXT);
    expect(safeUnknownBody('   ')).toBe(UNSUPPORTED_MESSAGE_TEXT);
  });

  it('knows which msgTypes this build actually has a branch for', () => {
    for (const known of ['text', 'media', 'system', 'portava_object', 'announcement', 'SAFETY']) {
      expect(rendersKnownMessageType(known)).toBe(true);
    }
    expect(rendersKnownMessageType('itinerary_handoff')).toBe(false);
    expect(rendersKnownMessageType('poll')).toBe(false);
  });

  it('an absent msgType is ordinary text, not an unknown future type', () => {
    // The server defaults msg_type to 'text'; a client that read an older
    // payload with the field missing must not blank the message.
    expect(rendersKnownMessageType(null)).toBe(true);
    expect(rendersKnownMessageType(undefined)).toBe(true);
    expect(rendersKnownMessageType('')).toBe(true);
  });

  it('a future type with a PROSE body keeps its prose', () => {
    // The bubble guard fires on the TYPE and the replacement fires on the
    // BODY. Both conditions are needed, and this is the case that proves the
    // second one is not redundant.
    expect(rendersKnownMessageType('poll')).toBe(false);
    expect(safeUnknownBody('Which night works?')).toBe('Which night works?');
  });
});
