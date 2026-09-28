/**
 * latinLetterFold — the stroke / hook / bar table (census-discovery §73, lane
 * P27: DV-20 and B01). lib/canonicalLocations.strokeFold applies it, as typed
 * and inside a decomposition, for B01's search key (and 2220/3440's stored
 * `search_key`) and for DV-20's Trail slug and destination key (3415/3441).
 *
 * A Latin letter whose mark is a stroke, bar, hook, curl, tail or loop THROUGH
 * or ON the glyph has no canonical decomposition, so NFD leaves it whole and the
 * `[^a-z0-9]` step then DELETES it: "Ƀerlin" keyed `erlin`. This table is what
 * lets such a letter fold as its base letter.
 *
 * THE RULE, applied mechanically to every Latin-script letter in UnicodeData.txt
 * 17.0 (the Unicode version this Node runtime's regular expressions use) that NFD
 * does not already reduce to an ASCII letter plus combining marks. Its name is
 * "LATIN … LETTER X WITH …", "LATIN … LETTER BARRED X" or "LATIN … LETTER X BAR":
 *   - X is one letter A–Z ("SMALL Q" in Ɋ is q)       → that letter, lowercase;
 *     where the letter has a compatibility decomposition, that spelling
 *     instead (Ŀ ŀ → l·, ẚ → aʾ), which the Trail slug's NFKD already gave it;
 *   - X is itself a Latin letter (AE, THORN, ENG, EZH, SMALL CAPITAL L, …) → it
 *     folds exactly as that letter does. The entry exists only where that
 *     letter survives some fold (Ꝥ → þ, ꬼ → ŋ, Ǆ → Ǳ, ẜ → s, ꭏ → u); where every
 *     fold deletes X, it deletes the letter too, with no entry;
 *   - X is TH (ᵺ, no letter is named TH) → th; X names no letter (ƻ TWO,
 *     ɿ REVERSED R) → not folded, and recorded.
 * Plus: the other case of every folded letter (Ɖ, the capital of ɖ D WITH TAIL);
 * ſ and ı, whose uppercase is ASCII (Unicode case-folds ſ to s); and the eth
 * (ð Ð → d) and İ that 2220's fourteen always had.
 *
 * NOT here: ß æ œ þ ŋ (census-discovery §66.9 owner question 4 is open; the
 * Trail's own TRAIL_LETTER_FOLD spells them, searchKey still deletes them), and
 * MODIFIER LETTER … forms, whose names are not "LATIN …".
 *
 * Generated from UnicodeData.txt 17.0 by the rule above; the rule, not this
 * list, is what src/test/discoveryLetterFoldCompleteness.test.ts enforces over
 * every Latin letter Node knows. 3440 and 3441 carry the same table to SQL (L7).
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
 * The combining marks every fold strips (census-discovery §77, lane P35: DV-20 and B01).
 *
 * Unicode encodes Latin's combining diacritics in FOUR blocks, and until §77 the folds stripped only
 * the first: Combining Diacritical Marks U+0300–U+036F. §74 (lane P32) found the other three —
 * … Extended U+1AB0–U+1AFF, … Supplement U+1DC0–U+1DFF and Combining Half Marks U+FE20–U+FE2F —
 * left in place, where the `[^a-z0-9]` step turned each into a word break. 91 of their marks carry
 * Unicode's Diacritic property. "I︠A︡roslavl" (ALA-LC's tie, as the half marks U+FE20/U+FE21) keyed
 * `i a roslavl` and slugged `i-a-roslavl`; "Zu" + U+1DC4 (macron-acute, a tone mark no precomposed
 * letter carries) + "rich" keyed `zu rich`.
 *
 * THE RULE: each of the four blocks is stripped WHOLE, exactly as U+0300–U+036F always was, by one
 * code point range per block. Whole blocks rather than the Diacritic property mark by mark, because
 * (1) U+0300–U+036F was always stripped whole, 19 marks without the property among them (the combining
 * small letters above), and the other blocks hold the same kinds (U+1DD3 … U+1DF4, and U+1DC0's
 * dotted grave, which lacks the property although it is an accent); (2) every assigned code point of
 * the four blocks is a combining mark, so stripping one never deletes a letter; (3) a range needs no
 * Unicode data, so the SQL twins, on PostgreSQL's older Unicode, strip exactly the same code points,
 * the block's still-unassigned ones included, which Unicode reserves for more combining diacritics.
 * In Unicode 17 that is 112 + 138 assigned marks (91 of the 138 Diacritic) in 272 code points.
 *
 * NOT stripped, and stated so the owner can overrule it (§77): U+20D0–U+20FF, Combining Diacritical
 * Marks for Symbols (none has the Diacritic property); the variation selectors; and the combining
 * marks of other scripts (U+0485 U+0486 U+0951 U+0952, whose Script_Extensions also name Latin,
 * among them). Each stays a word break, as it was.
 *
 * lib/canonicalLocations.normalizeLocationName (so searchKey and trailDestinationKey) and
 * lib/discoveryTrailObject.canonicalTrailSlug strip with LATIN_MARKS_RE; 3440's
 * input_normalize_city_key and 3441's trail_canonical_slug and trail_normalised_destination strip
 * the same four ranges as chr() bounds. src/test/discoveryLetterFoldCompleteness.test.ts L9 checks
 * the rule over every code point, and L10 pins the SQL to it. The client's own fold
 * (travel-buddy-standalone) must follow this set; census-discovery §77 routes that hunk.
 */
export const LATIN_MARK_BLOCKS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0xfe20, 0xfe2f],
] as const);
export const LATIN_MARKS_RE = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\ufe20-\ufe2f]/g;
