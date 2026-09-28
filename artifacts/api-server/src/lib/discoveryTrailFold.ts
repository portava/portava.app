/**
 * discoveryTrailFold — the letter fold a Trail's identity is computed over
 * (census-discovery DV-20, §61).
 *
 * `canonicalTrailSlug` decomposes a title (NFKD), strips combining marks and
 * turns everything outside [a-z0-9] into a separator. A Latin letter with NO
 * decomposition is therefore DELETED, not folded, and two spellings of one theme
 * become two canonical Trails. §59 found it for the stroke letters: "Đà Nẵng
 * street food" slugged to `a-nang-street-food` beside "Da Nang street food"'s
 * `da-nang-street-food`, and both were admitted.
 *
 * Two folds, applied before the decomposition:
 *
 *   the STROKE fold   lib/canonicalLocations.strokeFold — B01's table, reused
 *                     rather than restated: every "LATIN … LETTER X WITH …" (§73),
 *                     applied as typed and after decomposition (Ǿ = Ø + acute).
 *   the LETTER fold   the Latin letters that have neither a decomposition nor a
 *                     stroke, each to its conventional ASCII spelling (the
 *                     Unicode CLDR Latin-ASCII transliteration): ß ẞ → ss,
 *                     æ Æ → ae, œ Œ → oe, þ Þ → th, ŋ Ŋ → ng. Without it
 *                     "Straße Food" was `stra-e-food` beside "Strasse Food"'s
 *                     `strasse-food` — §59's defect for another letter.
 *
 * Migration 3415 applies the same two folds in SQL (trail_canonical_slug and
 * trail_normalised_destination; 3441 decomposes first), and
 * src/test/discoveryLetterFoldCompleteness.test.ts pins the SQL tables to these.
 *
 * A DESTINATION is compared by `trailDestinationKey`: the letter fold, then
 * lib/canonicalLocations.searchKey — the geographic key B01 and 2220 already use
 * (stroke fold, accents, case, punctuation, "City of …" / "… City"). The letter
 * fold is added in front because searchKey has the same gap for ß, æ, œ, þ and ŋ;
 * extending searchKey itself is that module's owner's (§61 names the hunk).
 */
import { searchKey, strokeFold } from "./canonicalLocations.js";

/** Latin letters with no Unicode decomposition and no stroke, to their CLDR Latin-ASCII spelling. */
export const TRAIL_LETTER_FOLD: Readonly<Record<string, string>> = Object.freeze({
  "ß": "ss", "ẞ": "ss",
  "æ": "ae", "Æ": "ae",
  "œ": "oe", "Œ": "oe",
  "þ": "th", "Þ": "th",
  "ŋ": "ng", "Ŋ": "ng",
});
const LETTER_FOLD_RE = new RegExp(`[${Object.keys(TRAIL_LETTER_FOLD).join("")}]`, "gu"), LETTER_FOLD_ANY = new RegExp(LETTER_FOLD_RE.source, "u");

/** Stroke fold, then letter fold, each also inside a decomposition. Pure, idempotent. */
export function trailLetterFold(s: string): string {
  const folded = strokeFold(s), nfd = folded.normalize("NFD"); // §73: decomposed too, so ǽ (æ + acute) meets the letter fold
  return LETTER_FOLD_ANY.test(nfd) ? nfd.replace(LETTER_FOLD_RE, (ch) => TRAIL_LETTER_FOLD[ch] ?? ch).normalize("NFC") : folded;
}

/** One destination whatever its spelling: the letter fold, then B01's geographic search key. */
export function trailDestinationKey(d: string): string {
  return searchKey(trailLetterFold(d));
}
