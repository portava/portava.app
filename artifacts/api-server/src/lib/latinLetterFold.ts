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
