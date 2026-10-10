/**
 * Lead ruling PR-D2-5 (census G224/G212) — the words the SERVER rewrites before
 * it searches.
 *
 * The no-request answer for `language` / `interest` (`services/localDictionary.ts`
 * `sufficientLocalRows`) must be exactly what the gateway would serve. The
 * gateway's normalizer rewrites a query that contains one of these words as a
 * whole word (`lib/inputAssistance/searchQueryHelpers.ts#SEARCH_ALIASES`, applied
 * by `applyAliases`): "nightlif" is searched as "nightlife", "gl" as "general
 * luna". So a query containing one of them is never answered locally — the
 * request goes out and the server answers it.
 *
 * WHY A COPY. The api-server and this app are separate packages and this one
 * cannot import the other at runtime (see `data/languages.ts`). A copy can
 * drift, so `artifacts/api-server/src/test/inputLocalSufficiencyParity.test.ts`
 * fails the moment this list and the server's alias keys differ in either
 * direction, and it also fails if the server's other rewrite (native-script city
 * names) ever gains an ASCII key.
 */
export const SERVER_REWRITTEN_TOKENS: ReadonlySet<string> = new Set([
  'travler', 'tarveler', 'traveller', 'backpaker', 'restaurnt', 'reataurant', 'resturant', 'restrant',
  'restraunt', 'resterant', 'coctail', 'coctails', 'siargou', 'siargow', 'borocay', 'phlippines',
  'philippnes', 'davou', 'ceboo', 'manilla', 'maniila', 'gensan', 'tokoyo', 'tokio',
  'bankok', 'bangok', 'phuket', 'pukhet', 'barcalona', 'singapor', 'istambul', 'bech',
  'beachh', 'musem', 'museam', 'hotell', 'hostle', 'hiing', 'hikng', 'treking',
  'swiming', 'snorkling', 'divng', 'nightlif', 'nighlife', 'clubing', 'evnt', 'evenet',
  'festval', 'festivel', 'acivity', 'activty', 'adveture', 'adventur', 'photograpy', 'photigraphy',
  'wknd', 'tonite', 'tmrw', 'gl',
]);
