/**
 * Telegraph §18.2 / census T242 — the inbox row for a translated last message.
 * The server decides (`translated`, `showOriginalAlongside` from
 * buildDisplayFields); the row MARKS a translation and keeps the original of an
 * uncertain one, and an older server's preview is unchanged.
 */
import { translatedPreviewText } from '../inbox/translatedPreview.ts';
import { systemMessageInboxPreview } from '../../../components/TelegraphInboxScreen.tsx';

const base = { body: 'nos vemos en el muelle', displayBody: 'see you at the pier' };

describe('translatedPreviewText', () => {
  it('an uncertain translation is marked AND keeps its original', () => {
    expect(translatedPreviewText({ ...base, translated: true, showOriginalAlongside: true }))
      .toBe('Translated · see you at the pier · Original: nos vemos en el muelle');
  });

  it('a translation the server calls certain is still marked as a translation', () => {
    expect(translatedPreviewText({ ...base, translated: true, showOriginalAlongside: false }))
      .toBe('Translated · see you at the pier');
  });

  it('an untranslated preview is shown as it is', () => {
    expect(translatedPreviewText({ body: 'hi', displayBody: 'hi', translated: false })).toBe('hi');
  });

  it('an older server (no fields) gets the preview it always got — no translation state is invented', () => {
    expect(translatedPreviewText(base)).toBe('see you at the pier');
  });

  it('an original identical to what is shown is not repeated', () => {
    expect(translatedPreviewText({ body: 'OK', displayBody: 'OK', translated: true, showOriginalAlongside: true }))
      .toBe('Translated · OK');
  });
});

describe('the inbox row uses it', () => {
  const lmp = { ...base, senderId: 'a', createdAt: 'x', msgType: 'text', subtype: null, translated: true, showOriginalAlongside: true };

  it('someone else’s translated message reads as a translation with its original', () => {
    expect(systemMessageInboxPreview(lmp, false)).toBe('Translated · see you at the pier · Original: nos vemos en el muelle');
  });

  it('my own message is my own words', () => {
    expect(systemMessageInboxPreview(lmp, true)).toBe('nos vemos en el muelle');
  });
});
