/**
 * Telegraph §18.2 / census T242 on the client — a translation the server could
 * not call certain is drawn WITH its original, on both chat screens.
 *
 * The server half is `artifacts/api-server/src/test/telegraphTranslationConfidenceForwarded.test.ts`:
 * both thread readers now send `showOriginalAlongside`. Before this change no
 * client file read the field, so the decision reached the phone and was
 * dropped there too.
 *
 * A node:test file on purpose (the pattern of `sendFailure.test.ts`): the rule
 * is a pure function, and the two chat screens cannot be mounted under
 * jest-expo (census-telegraph §41.7), so their wiring is held by source
 * assertions. WHAT THIS DOES NOT SHOW: the row drawn on a device.
 *
 * SHOWN RED FIRST: on `2e46835263` the module does not exist, so the file does
 * not load (all cases fail). Mutations, each applied alone and restored:
 *   • `!== true` loosened to a truthy check on an absent flag → A2.
 *   • the `showingOriginal` arm removed                         → A3.
 *   • the `mine` arm removed                                    → A4.
 *   • the identical-text arm removed                            → A5.
 *   • either screen's `<OriginalAlongside` removed              → B1.
 *
 * Run: node --import tsx --test src/features/telegraph/__tests__/originalAlongside.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { originalAlongsideText } from '../translation/originalAlongside.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../../../..');
const read = (rel: string) => readFileSync(resolve(APP, rel), 'utf8');

const ORIGINAL = 'nos vemos en el muelle a las ocho';
const TRANSLATED = 'see you at the pier at eight';
const reading = { mine: false, autoTranslate: true, showingOriginal: false };
const low = { translated: true, displayBody: TRANSLATED, originalBody: ORIGINAL, showOriginalAlongside: true };

describe('A. when the original is drawn beside a translation', () => {
  it('A1. the server asked for it and the translation is what is on screen → the original', () => {
    assert.equal(originalAlongsideText(low, reading), ORIGINAL);
  });

  it('A2. no flag (high confidence) or an absent flag (older server) → nothing; the client invents no confidence', () => {
    assert.equal(originalAlongsideText({ ...low, showOriginalAlongside: false }, reading), null);
    const older = { translated: true, displayBody: TRANSLATED, originalBody: ORIGINAL };
    assert.equal(originalAlongsideText(older, reading), null);
    assert.equal(originalAlongsideText({ ...low, showOriginalAlongside: null }, reading), null);
  });

  it('A3. the reader is already looking at the original (tapped it, or auto-translate off) → not drawn twice', () => {
    assert.equal(originalAlongsideText(low, { ...reading, showingOriginal: true }), null);
    assert.equal(originalAlongsideText(low, { ...reading, autoTranslate: false }), null);
    assert.equal(originalAlongsideText({ ...low, translated: false }, reading), null);
  });

  it('A4. never under the reader\'s own message', () => {
    assert.equal(originalAlongsideText(low, { ...reading, mine: true }), null);
  });

  it('A5. no original, a blank one, or one identical to the shown text → nothing', () => {
    assert.equal(originalAlongsideText({ ...low, originalBody: null }, reading), null);
    assert.equal(originalAlongsideText({ ...low, originalBody: '   ' }, reading), null);
    assert.equal(originalAlongsideText({ ...low, originalBody: ` ${TRANSLATED} ` }, reading), null);
  });
});

describe('B. both chat screens draw it, from the same rule', () => {
  it('B1. the thread screen and the trip/circle chat mount OriginalAlongside with the bubble\'s own view state', () => {
    for (const rel of ['app/messages/[id].tsx', 'src/components/GroupChatScreen.tsx']) {
      const src = read(rel);
      assert.match(src, /<OriginalAlongside item=\{item\} view=\{\{ mine, autoTranslate, showingOriginal: showOriginal \}\} \/>/, rel);
    }
  });

  it('B2. the message type carries the two server fields, so the screens are not reading an untyped extra', () => {
    const src = read('src/services/messaging.ts');
    assert.match(src, /showOriginalAlongside\?: boolean;/);
    assert.match(src, /translationConfidence\?: 'high' \| 'low' \| null;/);
  });
});
