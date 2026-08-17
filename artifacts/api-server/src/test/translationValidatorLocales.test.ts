/**
 * validateTranslation - target-language awareness.
 *
 * WHY THIS FILE EXISTS
 * Rule 4 required the translation to end in sentence-terminal punctuation, using a
 * character class of . ! ? and the CJK forms. Thai uses NO terminal punctuation at
 * all, Hindi declaratives end with the danda U+0964, and Arabic questions end with
 * U+061F. All three are in SUPPORTED_LANGUAGE_CODES, so users in those locales got
 * an app that silently translated nothing, forever, with no error surfaced.
 *
 * Rule 2 rejected anything under 20% of the source length, which systematically
 * false-positives Latin -> CJK because those scripts compress hard.
 *
 * THE LOAD-BEARING TEST is the last one: a genuinely truncated translation must
 * still be REJECTED. The easy way to make the others pass is to weaken the rule
 * into uselessness, and that test is what stops it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslation } from '../lib/translation.js';

const EN = 'Hello there, how are you doing today?';

describe('validateTranslation - locales without Latin terminal punctuation', () => {
  it('accepts Thai, which has no sentence-terminal punctuation at all', () => {
    const thai = 'สวัสดี วันนี้เป็นอย่างไรบ้าง';
    assert.equal(validateTranslation(EN, thai, 'th').valid, true);
  });

  it('accepts Hindi ending in the danda U+0964', () => {
    const hindi = 'नमस्ते आप आज कैसे हैं।';
    assert.equal(validateTranslation(EN, hindi, 'hi').valid, true);
  });

  it('accepts Arabic ending in U+061F', () => {
    const arabic = 'مرحبا، كيف حالك اليوم؟';
    assert.equal(validateTranslation(EN, arabic, 'ar').valid, true);
  });

  it('accepts a legitimately compact CJK translation below the 20% floor', () => {
    // 4 chars against a 37-char source = 10.8%, genuinely BELOW the old 20% floor.
    // The previous sample was 8 chars = 21.6% and passed even before the fix,
    // i.e. it proved nothing. This one dies under mutation.
    const zh = '你好吗？';
    const r = validateTranslation(EN, zh, 'zh');
    assert.equal(r.valid, true, 'reason was: ' + String(r.reason));
  });

  it('STILL REJECTS a genuinely truncated translation - the mutation guard', () => {
    assert.equal(validateTranslation(EN, 'Hola', 'es').valid, false);
    assert.equal(validateTranslation(EN, 'Bonjour, comment', 'fr').valid, false);
  });

  it('omitting targetLanguage preserves the previous language-agnostic behaviour', () => {
    assert.equal(validateTranslation(EN, 'Bonjour, comment allez-vous aujourd hui?').valid, true);
    assert.equal(validateTranslation(EN, 'Hola').valid, false);
  });
});
