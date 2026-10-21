/** Static localization resources. Place names are preserved exactly; none is presented as a translated official name. */
export const STOP_PHRASE_LOCALES: Readonly<Record<string, { take_me_to_stop: string; where_is_stop: string }>> = {
  en: { take_me_to_stop: 'Please take me to {STOP}.', where_is_stop: 'Where is {STOP}?' },
  ja: { take_me_to_stop: '{STOP}までお願いします。', where_is_stop: '{STOP}はどこですか？' },
  th: { take_me_to_stop: 'กรุณาพาฉันไปที่ {STOP}', where_is_stop: '{STOP} อยู่ที่ไหน' },
  vi: { take_me_to_stop: 'Làm ơn đưa tôi đến {STOP}.', where_is_stop: '{STOP} ở đâu?' },
  ko: { take_me_to_stop: '{STOP}까지 가 주세요.', where_is_stop: '{STOP}은 어디에 있나요?' },
  'zh-Hans': { take_me_to_stop: '请带我去{STOP}。', where_is_stop: '{STOP}在哪里？' },
  'zh-Hant': { take_me_to_stop: '請帶我去{STOP}。', where_is_stop: '{STOP}在哪裡？' },
  es: { take_me_to_stop: 'Por favor, lléveme a {STOP}.', where_is_stop: '¿Dónde está {STOP}?' },
  fr: { take_me_to_stop: "S'il vous plaît, emmenez-moi à {STOP}.", where_is_stop: 'Où se trouve {STOP} ?' },
  de: { take_me_to_stop: 'Bitte bringen Sie mich zu {STOP}.', where_is_stop: 'Wo ist {STOP}?' },
  it: { take_me_to_stop: 'Per favore, mi porti a {STOP}.', where_is_stop: "Dov'è {STOP}?" },
  'pt-BR': { take_me_to_stop: 'Por favor, me leve para {STOP}.', where_is_stop: 'Onde fica {STOP}?' },
  'pt-PT': { take_me_to_stop: 'Por favor, leve-me a {STOP}.', where_is_stop: 'Onde fica {STOP}?' },
  id: { take_me_to_stop: 'Tolong antar saya ke {STOP}.', where_is_stop: 'Di mana {STOP}?' },
};
/** Available catalogue choices, not a claim that every person or locality uses these languages. */
export const MULTILINGUAL_PHRASE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  CA: ['en', 'fr'], CH: ['de', 'fr', 'it'], BE: ['fr', 'de'], SG: ['en', 'zh-Hans'],
};
export const PHRASE_REVIEW_STATUS = 'native_review_pending' as const;

export function stopContextPhrases(language: string, title: string) {
  const local = STOP_PHRASE_LOCALES[language];
  if (!local) return [];
  return (['take_me_to_stop', 'where_is_stop'] as const).map(key => ({ key,
    english: STOP_PHRASE_LOCALES.en![key].split('{STOP}').join(title), local: local[key].split('{STOP}').join(title) }));
}
