/**
 * latinLetterFold (client) — the stroke / hook / bar letter table, a COPY of
 * the server's `artifacts/api-server/src/lib/latinLetterFold.ts` (census-
 * discovery §73), made so the client's place-name lookup folds user text the
 * way the server's search key does (census-discovery §76, lane P34).
 *
 * A Latin letter whose mark is a stroke, bar, hook, curl, tail or loop THROUGH
 * or ON the glyph (đ ø ł ı ħ ƀ ȥ …) has no canonical decomposition, so NFD
 * leaves it whole. This table folds it to its base letter. Apply it AFTER NFD
 * and mark-stripping (the only table letter NFD decomposes is İ, to an ASCII
 * I), then lowercase: "Ǿ" → Ø + acute → Ø → o.
 *
 * DO NOT EDIT BY HAND. The server's table is generated from UnicodeData.txt by
 * a rule, and api-server's `src/test/clientLetterFoldParity.test.ts` fails the
 * moment this copy and that table differ in any key, value or order. Change the
 * server's table, then copy it here.
 *
 * The client cannot import the server file: the app bundle does not reach into
 * artifacts/api-server, so the copy plus its parity test is the arrangement.
 */
export const LATIN_LETTER_FOLD: Readonly<Record<string, string>> = Object.freeze({
  "Ⱥ": "a", "ᶏ": "a", "ⱥ": "a", "ƀ": "b", "Ɓ": "b", "Ƃ": "b", "ƃ": "b", "Ƀ": "b", "ɓ": "b", "ᵬ": "b", "ᶀ": "b",
  "Ꞗ": "b", "ꞗ": "b", "Ƈ": "c", "ƈ": "c", "Ȼ": "c", "ȼ": "c", "ɕ": "c", "Ꞓ": "c", "ꞓ": "c", "ꞔ": "c", "Ꞔ": "c",
  "𝼝": "c", "Ð": "d", "ð": "d", "Đ": "d", "đ": "d", "Ɖ": "d", "Ɗ": "d", "Ƌ": "d", "ƌ": "d", "ȡ": "d", "ɖ": "d",
  "ɗ": "d", "ᵭ": "d", "ᶁ": "d", "ᶑ": "d", "Ꟈ": "d", "ꟈ": "d", "𝼥": "d", "Ɇ": "e", "ɇ": "e", "ᶒ": "e", "ⱸ": "e",
  "ꬳ": "e", "ꬴ": "e", "Ƒ": "f", "ƒ": "f", "ᵮ": "f", "ᶂ": "f", "Ꞙ": "f", "ꞙ": "f", "Ɠ": "g", "Ǥ": "g", "ǥ": "g",
  "ɠ": "g", "ᶃ": "g", "Ꞡ": "g", "ꞡ": "g", "Ħ": "h", "ħ": "h", "ɦ": "h", "Ⱨ": "h", "ⱨ": "h", "ꞕ": "h", "Ɦ": "h",
  "İ": "i", "ı": "i", "Ɨ": "i", "ɨ": "i", "ᶖ": "i", "𝼚": "i", "Ɉ": "j", "ɉ": "j", "ʝ": "j", "Ʝ": "j", "Ƙ": "k",
  "ƙ": "k", "ᶄ": "k", "Ⱪ": "k", "ⱪ": "k", "Ꝁ": "k", "ꝁ": "k", "Ꝃ": "k", "ꝃ": "k", "Ꝅ": "k", "ꝅ": "k", "Ꞣ": "k",
  "ꞣ": "k", "Ł": "l", "ł": "l", "ƚ": "l", "ȴ": "l", "Ƚ": "l", "ɫ": "l", "ɬ": "l", "ɭ": "l", "ᶅ": "l", "Ⱡ": "l",
  "ⱡ": "l", "Ɫ": "l", "Ꝉ": "l", "ꝉ": "l", "ꞎ": "l", "Ɬ": "l", "ꬷ": "l", "ꬸ": "l", "ꬹ": "l", "𝼑": "l", "𝼓": "l",
  "𝼦": "l", "ɱ": "m", "ᵯ": "m", "ᶆ": "m", "Ɱ": "m", "ꬺ": "m", "Ɲ": "n", "ƞ": "n", "Ƞ": "n", "ȵ": "n", "ɲ": "n",
  "ɳ": "n", "ᵰ": "n", "ᶇ": "n", "Ꞑ": "n", "ꞑ": "n", "Ꞥ": "n", "ꞥ": "n", "ꬻ": "n", "𝼧": "n", "Ø": "o", "ø": "o",
  "Ɵ": "o", "ɵ": "o", "ⱺ": "o", "Ꝋ": "o", "ꝋ": "o", "Ꝍ": "o", "ꝍ": "o", "𝼛": "o", "Ƥ": "p", "ƥ": "p", "ᵱ": "p",
  "ᵽ": "p", "ᶈ": "p", "Ᵽ": "p", "Ꝑ": "p", "ꝑ": "p", "Ꝓ": "p", "ꝓ": "p", "Ꝕ": "p", "ꝕ": "p", "Ɋ": "q", "ɋ": "q",
  "ʠ": "q", "Ꝗ": "q", "ꝗ": "q", "Ꝙ": "q", "ꝙ": "q", "Ɍ": "r", "ɍ": "r", "ɼ": "r", "ɽ": "r", "ɾ": "r", "ᵲ": "r",
  "ᵳ": "r", "ᶉ": "r", "Ɽ": "r", "Ꞧ": "r", "ꞧ": "r", "ꭉ": "r", "𝼖": "r", "𝼨": "r", "ſ": "s", "ȿ": "s", "ʂ": "s",
  "ᵴ": "s", "ᶊ": "s", "ẜ": "s", "ẝ": "s", "Ȿ": "s", "Ꞩ": "s", "ꞩ": "s", "Ʂ": "s", "Ꟊ": "s", "ꟊ": "s", "Ꟍ": "s",
  "ꟍ": "s", "𝼞": "s", "𝼩": "s", "Ŧ": "t", "ŧ": "t", "ƫ": "t", "Ƭ": "t", "ƭ": "t", "Ʈ": "t", "ȶ": "t", "Ⱦ": "t",
  "ʈ": "t", "ᵵ": "t", "ⱦ": "t", "𝼉": "t", "𝼪": "t", "Ʉ": "u", "ʉ": "u", "ᶙ": "u", "Ꞹ": "u", "ꞹ": "u", "ꭎ": "u",
  "ꭏ": "u", "ꭒ": "u", "Ʋ": "v", "ʋ": "v", "ᶌ": "v", "ⱱ": "v", "ⱴ": "v", "Ꝟ": "v", "ꝟ": "v", "Ⱳ": "w", "ⱳ": "w",
  "ᶍ": "x", "ꭖ": "x", "ꭗ": "x", "ꭘ": "x", "ꭙ": "x", "Ƴ": "y", "ƴ": "y", "Ɏ": "y", "ɏ": "y", "Ỿ": "y", "ỿ": "y",
  "ꭚ": "y", "Ƶ": "z", "ƶ": "z", "Ȥ": "z", "ȥ": "z", "ɀ": "z", "ʐ": "z", "ʑ": "z", "ᵶ": "z", "ᶎ": "z", "Ⱬ": "z",
  "ⱬ": "z", "Ɀ": "z", "Ᶎ": "z", "ẚ": "aʾ", "Ŀ": "l·", "ŀ": "l·", "ᵺ": "th", "Ꝥ": "Þ", "Ꝧ": "Þ", "ꝥ": "þ", "ꝧ": "þ",
  "ꬼ": "ŋ", "𝼔": "ŋ", "Ǆ": "Ǳ", "ǆ": "ǳ",
});

/**
 * The combining-mark strip, applied to an NFD string (census-discovery §76,
 * after §74). It removes U+0300–U+036F (Combining Diacritical Marks, the
 * server's range until then) PLUS every mark carrying the Unicode `Diacritic`
 * property in U+1AB0–U+1AFF (Combining Diacritical Marks Extended),
 * U+1DC0–U+1DFF (… Supplement) and U+FE20–U+FE2F (Combining Half Marks):
 * §74 found those split the server's key while U+0300–U+036F did not.
 *
 * This rule is written here, not copied: the server's rule lives inside
 * lib/canonicalLocations.normalizeLocationName and is not exported. api-server's
 * clientLetterFoldParity P3 compares the two BY BEHAVIOUR over every mark and
 * Diacritic code point, so a server change the client does not follow fails.
 */
export const COMBINING_MARK_RE =
  /[̀-ͯ]|(?=\p{Diacritic})[᪰-᫿᷀-᷿︠-︯]/gu;

/** Remove the combining marks `COMBINING_MARK_RE` names from an NFD string. */
export function stripCombiningMarks(nfd: string): string {
  return nfd.replace(COMBINING_MARK_RE, '');
}
