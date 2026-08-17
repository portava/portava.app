/**
 * The gate on the message re-translation sweep.
 *
 * retranslateForUser pushes up to 200 messages through the translation provider.
 * Both call sites -- routes/messaging.ts and routes/profile.ts -- fired it purely
 * on a display-language change, with no reference to whether the user had ever
 * enabled message translation. Switching the app to Spanish with auto-translate
 * off still bought you a 200-message provider sweep.
 *
 * MUTATION REQUIREMENT: removing the auto_translate_messages check must fail
 * "refuses when auto-translate is off" and "fails closed when the preference is
 * unknown". If it does not, this file is not doing its job.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetranslateOnLanguageChange as gate } from '../lib/retranslateGate.js';

describe('shouldRetranslateOnLanguageChange', () => {
  it('refuses when auto-translate is off, even on a real language change', () => {
    assert.equal(gate({ newLanguage: 'es', oldLanguage: 'en', autoTranslateMessages: false }), false);
  });

  it('fails closed when the preference is unknown', () => {
    assert.equal(gate({ newLanguage: 'es', oldLanguage: 'en', autoTranslateMessages: null }), false);
    assert.equal(gate({ newLanguage: 'es', oldLanguage: 'en', autoTranslateMessages: undefined }), false);
  });

  it('allows a genuine change when auto-translate is on', () => {
    assert.equal(gate({ newLanguage: 'es', oldLanguage: 'en', autoTranslateMessages: true }), true);
  });

  it('refuses when the language did not actually change', () => {
    assert.equal(gate({ newLanguage: 'en', oldLanguage: 'en', autoTranslateMessages: true }), false);
  });

  it('refuses when there is no new language', () => {
    assert.equal(gate({ newLanguage: null, oldLanguage: 'en', autoTranslateMessages: true }), false);
    assert.equal(gate({ newLanguage: '', oldLanguage: 'en', autoTranslateMessages: true }), false);
  });

  it('treats an unknown prior language as a change - profile.ts cannot see the old value', () => {
    assert.equal(gate({ newLanguage: 'es', autoTranslateMessages: true }), true);
    assert.equal(gate({ newLanguage: 'es', autoTranslateMessages: false }), false);
  });
});
