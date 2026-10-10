/**
 * Layover return phrases — census-layover L155, §16 "Translation — cache
 * context phrases required by the active plan".
 *
 * WHAT WAS THERE. The offline bundle answered `translationPhrases:
 * unavailable("no_phrase_catalogue")` for every session: there was no catalogue
 * at all, so a traveller whose phone lost its connection in a city whose
 * language they do not speak had nothing to show a taxi driver.
 *
 * WHAT THIS IS. A small, STATIC catalogue — no provider, no machine
 * translation, no network — of the five sentences a traveller needs to get
 * back to their flight, in the language of the airport's country, each with
 * the English beside it. The first one names THIS airport (its name and IATA
 * code), so it is the sentence the plan actually requires, not a generic one.
 *
 * WHEN THE PLAN REQUIRES THEM. Only a plan that leaves the airport: a landside
 * stop, or a traveller who said they want to leave. An airside-only plan gets
 * `plan_stays_airside` — nothing is needed, and the bundle says so rather than
 * carrying phrases nobody asked for.
 *
 * WHAT IT DOES NOT DO, said rather than papered over:
 *   - a country whose language is not in the catalogue (or an airport with no
 *     country code) gets `language_not_in_catalogue` — never English dressed as
 *     a translation, never a machine guess;
 *   - countries with more than one everyday language (BE, CH, CA, IN, ...) and
 *     English-speaking countries are deliberately absent;
 *   - phrases are keyed to the RETURN, not to each stop's category: a stop's
 *     category does not reach the bundle.
 *
 * Pure: no I/O, decidable from its arguments.
 */

export const LAYOVER_PHRASE_KEYS = [
  "take_me_to_airport",
  "flight_soon",
  "how_long_to_airport",
  "where_transport_to_airport",
  "please_help",
] as const;
export type LayoverPhraseKey = (typeof LAYOVER_PHRASE_KEYS)[number];

export interface LayoverPhrase {
  key: LayoverPhraseKey;
  /** What the sentence says, in English, so the traveller knows what they are showing. */
  english: string;
  /** The sentence in the local language, to show or read out. */
  local: string;
}

export interface LayoverPhraseSet {
  /** BCP-47 tag of `local`. */
  language: string;
  /** The language's English name, for the card's heading. */
  languageName: string;
  phrases: LayoverPhrase[];
}

export type LayoverPhrasesUnavailable = "language_not_in_catalogue" | "plan_stays_airside";

type Template = Record<LayoverPhraseKey, string>;

/** `{A}` is replaced by the airport's name and `{IATA}` by its code. */
const ENGLISH: Template = {
  take_me_to_airport: "Please take me to {A} ({IATA}).",
  flight_soon: "I have a flight to catch soon.",
  how_long_to_airport: "How long does it take to get to the airport?",
  where_transport_to_airport: "Where can I get a taxi or a train to the airport?",
  please_help: "Please help me.",
};

const CATALOGUE: Record<string, { languageName: string; t: Template }> = {
  ja: {
    languageName: "Japanese",
    t: {
      take_me_to_airport: "{A}（{IATA}）までお願いします。",
      flight_soon: "もうすぐ飛行機に乗らなければなりません。",
      how_long_to_airport: "空港までどのくらいかかりますか？",
      where_transport_to_airport: "空港行きのタクシーか電車はどこで乗れますか？",
      please_help: "助けてください。",
    },
  },
  th: {
    languageName: "Thai",
    t: {
      take_me_to_airport: "กรุณาพาฉันไปที่ {A} ({IATA})",
      flight_soon: "ฉันต้องรีบไปขึ้นเครื่องบิน",
      how_long_to_airport: "ไปสนามบินใช้เวลานานเท่าไหร่",
      where_transport_to_airport: "จะขึ้นแท็กซี่หรือรถไฟไปสนามบินได้ที่ไหน",
      please_help: "ช่วยด้วย",
    },
  },
  vi: {
    languageName: "Vietnamese",
    t: {
      take_me_to_airport: "Làm ơn đưa tôi đến {A} ({IATA}).",
      flight_soon: "Tôi cần kịp chuyến bay sắp tới.",
      how_long_to_airport: "Đi đến sân bay mất bao lâu?",
      where_transport_to_airport: "Tôi có thể bắt taxi hoặc tàu đến sân bay ở đâu?",
      please_help: "Xin hãy giúp tôi.",
    },
  },
  ko: {
    languageName: "Korean",
    t: {
      take_me_to_airport: "{A}({IATA})까지 가 주세요.",
      flight_soon: "곧 비행기를 타야 해요.",
      how_long_to_airport: "공항까지 얼마나 걸려요?",
      where_transport_to_airport: "공항 가는 택시나 기차는 어디서 탈 수 있어요?",
      please_help: "도와주세요.",
    },
  },
  "zh-Hans": {
    languageName: "Chinese (Simplified)",
    t: {
      take_me_to_airport: "请带我去{A}（{IATA}）。",
      flight_soon: "我马上要赶飞机。",
      how_long_to_airport: "去机场要多长时间？",
      where_transport_to_airport: "在哪里可以坐出租车或火车去机场？",
      please_help: "请帮帮我。",
    },
  },
  "zh-Hant": {
    languageName: "Chinese (Traditional)",
    t: {
      take_me_to_airport: "請帶我去{A}（{IATA}）。",
      flight_soon: "我馬上要趕飛機。",
      how_long_to_airport: "去機場要多久？",
      where_transport_to_airport: "在哪裡可以搭計程車或火車去機場？",
      please_help: "請幫幫我。",
    },
  },
  es: {
    languageName: "Spanish",
    t: {
      take_me_to_airport: "Por favor, lléveme a {A} ({IATA}).",
      flight_soon: "Tengo que tomar un vuelo pronto.",
      how_long_to_airport: "¿Cuánto se tarda en llegar al aeropuerto?",
      where_transport_to_airport: "¿Dónde puedo tomar un taxi o un tren al aeropuerto?",
      please_help: "Por favor, ayúdeme.",
    },
  },
  fr: {
    languageName: "French",
    t: {
      take_me_to_airport: "S'il vous plaît, emmenez-moi à {A} ({IATA}).",
      flight_soon: "Je dois prendre un vol bientôt.",
      how_long_to_airport: "Combien de temps faut-il pour aller à l'aéroport ?",
      where_transport_to_airport: "Où puis-je prendre un taxi ou un train pour l'aéroport ?",
      please_help: "Aidez-moi, s'il vous plaît.",
    },
  },
  de: {
    languageName: "German",
    t: {
      take_me_to_airport: "Bitte bringen Sie mich zu {A} ({IATA}).",
      flight_soon: "Ich muss bald einen Flug erreichen.",
      how_long_to_airport: "Wie lange braucht man zum Flughafen?",
      where_transport_to_airport: "Wo bekomme ich ein Taxi oder einen Zug zum Flughafen?",
      please_help: "Bitte helfen Sie mir.",
    },
  },
  it: {
    languageName: "Italian",
    t: {
      take_me_to_airport: "Per favore, mi porti a {A} ({IATA}).",
      flight_soon: "Devo prendere un volo tra poco.",
      how_long_to_airport: "Quanto tempo ci vuole per arrivare all'aeroporto?",
      where_transport_to_airport: "Dove posso prendere un taxi o un treno per l'aeroporto?",
      please_help: "Mi aiuti, per favore.",
    },
  },
  "pt-BR": {
    languageName: "Portuguese (Brazil)",
    t: {
      take_me_to_airport: "Por favor, me leve para {A} ({IATA}).",
      flight_soon: "Preciso pegar um voo daqui a pouco.",
      how_long_to_airport: "Quanto tempo leva até o aeroporto?",
      where_transport_to_airport: "Onde posso pegar um táxi ou um trem para o aeroporto?",
      please_help: "Por favor, me ajude.",
    },
  },
  "pt-PT": {
    languageName: "Portuguese (Portugal)",
    t: {
      take_me_to_airport: "Por favor, leve-me a {A} ({IATA}).",
      flight_soon: "Tenho de apanhar um voo daqui a pouco.",
      how_long_to_airport: "Quanto tempo demora até ao aeroporto?",
      where_transport_to_airport: "Onde posso apanhar um táxi ou um comboio para o aeroporto?",
      please_help: "Por favor, ajude-me.",
    },
  },
  id: {
    languageName: "Indonesian",
    t: {
      take_me_to_airport: "Tolong antar saya ke {A} ({IATA}).",
      flight_soon: "Saya harus segera naik pesawat.",
      how_long_to_airport: "Berapa lama ke bandara?",
      where_transport_to_airport: "Di mana saya bisa naik taksi atau kereta ke bandara?",
      please_help: "Tolong bantu saya.",
    },
  },
};

/**
 * ISO 3166-1 alpha-2 → the catalogue language a taxi driver there reads. Only
 * countries with ONE everyday language that is in the catalogue.
 */
export const COUNTRY_LANGUAGE: Readonly<Record<string, string>> = {
  JP: "ja", TH: "th", VN: "vi", KR: "ko", CN: "zh-Hans", TW: "zh-Hant",
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es", EC: "es", UY: "es", VE: "es",
  CR: "es", PA: "es", GT: "es", DO: "es", SV: "es", HN: "es", NI: "es", CU: "es", BO: "es",
  FR: "fr", MC: "fr", DE: "de", AT: "de", IT: "it", BR: "pt-BR", PT: "pt-PT", ID: "id",
};

function fill(s: string, airportName: string, iata: string): string {
  return s.split("{A}").join(airportName).split("{IATA}").join(iata);
}

/**
 * The phrases this session's plan requires, or why there are none.
 */
export function layoverPhrasesFor(input: {
  countryCode: string | null | undefined;
  airportName: string;
  iataCode: string;
  wantsToLeave: boolean;
  stops: ReadonlyArray<{ insideAirport: boolean }>;
}): { ok: true; value: LayoverPhraseSet } | { ok: false; reason: LayoverPhrasesUnavailable } {
  const leaves = input.wantsToLeave || input.stops.some((s) => s.insideAirport !== true);
  if (!leaves) return { ok: false, reason: "plan_stays_airside" };
  const code = typeof input.countryCode === "string" ? input.countryCode.trim().toUpperCase() : "";
  const language = COUNTRY_LANGUAGE[code];
  const entry = language ? CATALOGUE[language] : undefined;
  if (!language || !entry) return { ok: false, reason: "language_not_in_catalogue" };
  return {
    ok: true,
    value: {
      language,
      languageName: entry.languageName,
      phrases: LAYOVER_PHRASE_KEYS.map((key) => ({
        key,
        english: fill(ENGLISH[key], input.airportName, input.iataCode),
        local: fill(entry.t[key], input.airportName, input.iataCode),
      })),
    },
  };
}

/** The catalogue's languages, for tests and the census. */
export const LAYOVER_PHRASE_LANGUAGES: readonly string[] = Object.keys(CATALOGUE);
