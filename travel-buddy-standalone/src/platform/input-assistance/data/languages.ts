/**
 * §32 G197 / §34 G212 — the SHIPPED language dictionary.
 *
 * ── HOW THIS SET WAS BOUNDED ─────────────────────────────────────────────────
 *
 * It is the API server's own `COMMON_LANGUAGES` list
 * (`artifacts/api-server/src/routes/discoverySearch.ts:363`), copied verbatim,
 * in the same order, with the app's display spelling.
 *
 * WHY A COPY AND NOT AN IMPORT. `artifacts/api-server` is `"type": "module"`
 * and this package is CJS; a runtime import across that boundary does not link
 * under the loader the api-server suite uses, and the one module that crosses
 * it (`contexts/inputContexts.ts`) carries a written rule against exactly that.
 * So the two lists are two artifacts, and the honest thing is to say so here
 * rather than to pretend one is derived from the other.
 *
 * WHAT THAT COSTS, AND WHY IT IS ACCEPTABLE HERE. The two can drift. They
 * cannot drift into a WRONG ANSWER, because this list is only ever consulted
 * when the server is unreachable: while the server answers, its list is the one
 * the user sees, and these rows never appear. Drift shows up as an offline
 * answer that is a little older than the online one, which is what an offline
 * answer is. It is not a privacy or identity claim — see `types.ts`.
 *
 * WHAT IT OMITS: everything outside that list. This is a "common languages"
 * picker, not ISO 639: no dialects, no scripts, no language codes, and no
 * signed languages. A traveller whose language is not among the 30 gets no
 * local row and falls through to the raw text they typed, which is the correct
 * degradation (§2 — the raw query is never discarded in favour of a guess).
 */
import type { LocalDictionaryEntry } from './types.ts';

export const LANGUAGE_DICTIONARY: readonly LocalDictionaryEntry[] = [
  { label: 'English' },
  { label: 'Spanish', aliases: ['Español', 'Castellano'] },
  { label: 'French', aliases: ['Français'] },
  { label: 'German', aliases: ['Deutsch'] },
  { label: 'Mandarin', aliases: ['Chinese', 'Putonghua'] },
  { label: 'Japanese', aliases: ['Nihongo'] },
  { label: 'Arabic' },
  { label: 'Portuguese', aliases: ['Português'] },
  { label: 'Russian' },
  { label: 'Hindi' },
  { label: 'Italian', aliases: ['Italiano'] },
  { label: 'Korean', aliases: ['Hangul'] },
  { label: 'Dutch', aliases: ['Nederlands'] },
  { label: 'Turkish', aliases: ['Türkçe'] },
  { label: 'Polish', aliases: ['Polski'] },
  { label: 'Swedish', aliases: ['Svenska'] },
  { label: 'Danish', aliases: ['Dansk'] },
  { label: 'Norwegian', aliases: ['Norsk'] },
  { label: 'Finnish', aliases: ['Suomi'] },
  { label: 'Tagalog', aliases: ['Filipino'] },
  { label: 'Indonesian', aliases: ['Bahasa Indonesia'] },
  { label: 'Thai' },
  { label: 'Vietnamese', aliases: ['Tiếng Việt'] },
  { label: 'Malay', aliases: ['Bahasa Melayu'] },
  { label: 'Swahili', aliases: ['Kiswahili'] },
  { label: 'Zulu', aliases: ['isiZulu'] },
  { label: 'Greek' },
  { label: 'Czech', aliases: ['Čeština'] },
  { label: 'Romanian' },
  { label: 'Hungarian', aliases: ['Magyar'] },
];
