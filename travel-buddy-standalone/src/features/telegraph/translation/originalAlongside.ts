/**
 * Telegraph §18.2 / census T242 — "low-confidence operational translation
 * shows original plus translation".
 *
 * The server takes the decision (`buildDisplayFields` in
 * `artifacts/api-server/src/services/messageTranslation.ts`, from the stored
 * confidence and nothing else) and both thread readers now send it as
 * `showOriginalAlongside`. This module decides only whether THIS bubble, as the
 * reader is currently viewing it, should draw the original under the
 * translation:
 *
 *  - never for the reader's own message (the server never sets it there, and a
 *    stale optimistic copy must not either);
 *  - only while the TRANSLATION is the text on screen. If auto-translate is off,
 *    or the reader tapped "Show original", the original IS the bubble, and
 *    drawing it twice would be noise;
 *  - never when there is no original text, or when it is identical to what is
 *    already shown.
 *
 * An absent flag (an older server) is treated as false: the client does not
 * invent a confidence the server did not state.
 */
export interface OriginalAlongsideInput {
  translated: boolean;
  displayBody: string | null;
  originalBody: string | null;
  showOriginalAlongside?: boolean | null;
}

export interface OriginalAlongsideView {
  mine: boolean;
  autoTranslate: boolean;
  showingOriginal: boolean;
}

export function originalAlongsideText(
  item: OriginalAlongsideInput,
  view: OriginalAlongsideView,
): string | null {
  if (view.mine) return null;
  if (item.showOriginalAlongside !== true) return null;
  if (!item.translated || !view.autoTranslate || view.showingOriginal) return null;
  const original = item.originalBody ?? '';
  if (original.trim() === '') return null;
  if (original.trim() === (item.displayBody ?? '').trim()) return null;
  return original;
}

/** The words above the original. States the reason without claiming a number. */
export const ORIGINAL_ALONGSIDE_LABEL = 'Translation may not be exact · original';
