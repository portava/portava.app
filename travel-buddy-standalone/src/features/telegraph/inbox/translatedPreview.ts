/**
 * Telegraph §18.2 / census T242 — what an inbox row says about a translated
 * last message.
 *
 * The server decides (`buildDisplayFields`, the same helper both thread
 * readers use) and sends `translated` and `showOriginalAlongside` on the
 * preview. This only words it: a translation is MARKED as one, and when the
 * server cannot call it certain the original rides along, as it does in both
 * chat screens. An older server sends neither field and gets the preview it
 * always got — the client does not invent a translation state it was not told.
 */
export const TRANSLATED_PREVIEW_PREFIX = 'Translated · ';
export const ORIGINAL_PREVIEW_SEPARATOR = ' · Original: ';

export interface TranslatedPreviewInput {
  body: string;
  displayBody: string | null;
  translated?: boolean;
  showOriginalAlongside?: boolean;
}

export function translatedPreviewText(p: TranslatedPreviewInput): string {
  const shown = p.displayBody ?? p.body;
  if (p.translated !== true) return shown;
  const original = (p.body ?? '').trim();
  if (p.showOriginalAlongside === true && original !== '' && original !== shown.trim()) {
    return `${TRANSLATED_PREVIEW_PREFIX}${shown}${ORIGINAL_PREVIEW_SEPARATOR}${original}`;
  }
  return `${TRANSLATED_PREVIEW_PREFIX}${shown}`;
}
