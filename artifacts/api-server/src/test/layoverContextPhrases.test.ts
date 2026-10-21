import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoverPhrasesFor } from '../services/airport/layoverPhrases.js';
const input = { airportName: 'Test Airport', iataCode: 'TST', wantsToLeave: true,
  stops: [{ title: 'Garden', insideAirport: false }, { title: 'Airside lounge', insideAirport: true }, { title: 'Museum', insideAirport: false }] };
for (const [countryCode, language, sentence] of [
  ['JP', 'ja', 'Gardenはどこですか？'], ['TH', 'th', 'Garden อยู่ที่ไหน'], ['VN', 'vi', 'Garden ở đâu?'],
  ['KR', 'ko', 'Garden은 어디에 있나요?'], ['CN', 'zh-Hans', 'Garden在哪里？'], ['TW', 'zh-Hant', 'Garden在哪裡？'],
  ['ES', 'es', '¿Dónde está Garden?'], ['FR', 'fr', 'Où se trouve Garden ?'], ['DE', 'de', 'Wo ist Garden?'],
  ['IT', 'it', "Dov'è Garden?"], ['BR', 'pt-BR', 'Onde fica Garden?'], ['PT', 'pt-PT', 'Onde fica Garden?'], ['ID', 'id', 'Di mana Garden?'],
] as const) test(`${language}: the selected stop's name is localized in context, without translating its proper name`, () => {
  const r = layoverPhrasesFor({ ...input, countryCode }); assert.ok(r.ok); if (!r.ok) return;
  const option = r.value.languageOptions!.find(o => o.language === language)!;
  assert.deepEqual(option.stops.map(s => s.stopTitle), ['Garden', 'Museum']);
  assert.equal(option.stops[0]!.phrases.find(p => p.key === 'where_is_stop')!.local, sentence);
  assert.equal(option.stops[0]!.phrases[0]!.english, 'Please take me to Garden.');
  assert.ok(option.phrases[0]!.local.includes('Test Airport'));
  assert.equal(r.value.reviewStatus, 'native_review_pending');
});
test('multilingual countries expose available alternatives, including the English source, without claiming a single local language', () => {
  for (const [countryCode, expected] of [['CA', ['en', 'fr']], ['CH', ['de', 'fr', 'it']], ['BE', ['fr', 'de']], ['SG', ['en', 'zh-Hans']]] as const) {
    const r = layoverPhrasesFor({ ...input, countryCode }); assert.ok(r.ok); if (!r.ok) continue;
    assert.deepEqual(r.value.languageOptions!.map(o => o.language), expected);
  }
});
test('unknown languages stay unavailable; no phrase is invented for a missing or airside stop', () => {
  assert.deepEqual(layoverPhrasesFor({ ...input, countryCode: 'XX' }), { ok: false, reason: 'language_not_in_catalogue' });
  const r = layoverPhrasesFor({ ...input, countryCode: 'JP', stops: [{ insideAirport: false }, { title: ' Lounge ', insideAirport: true }] });
  assert.ok(r.ok); if (r.ok) assert.deepEqual(r.value.languageOptions![0]!.stops, []);
});
