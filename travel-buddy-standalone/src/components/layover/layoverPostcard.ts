/**
 * A postcard of a COMPLETED layover — census-layover L275, the postcard half.
 *
 * Layover spec §25: "convert a completed session into an optional
 * stamp/postcard/memory". The stamp rides on the close, the Memory is
 * `createMemoryFromLayover`; the postcard belongs to Passport (census §49.3,
 * "the POSTCARD is Passport's"). So the layover surface never hosts the
 * composer — lead ruling LP-2: it hands off BY ROUTE to the Passport tab,
 * passing only the layover session id, and Passport opens its own composer.
 *
 * WHY THIS MODULE IMPORTS NOTHING. Every file the layover surface reaches is
 * walked by census-layover L168's guard
 * (src/lib/__tests__/layoverSensingCadence.test.ts, "nothing the layover
 * surface reaches asks for photos or contacts — no exception"). The composer
 * reaches the photo picker; this module, and therefore the dashboard, must not.
 *
 * The server takes the place from the layover (city and country only) and
 * refuses any location sent alongside it; nothing here decides presence.
 */

export interface LayoverPostcardSource {
  sessionId: string;
  /** For the composer's label only. The server decides what the postcard carries. */
  city: string | null;
}

/** Offered only for a layover that ended with the flight. `cancelled`, `expired` and `active` are not. */
export function layoverPostcardOffered(status: string | null | undefined): boolean {
  return status === 'completed';
}

/** The Passport route that opens the composer for this layover. It carries the id and nothing else. */
export function layoverPostcardHref(sessionId: string): { pathname: '/(tabs)/passport'; params: { layoverPostcard: string } } {
  return { pathname: '/(tabs)/passport', params: { layoverPostcard: sessionId } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Passport side: a route param is a layover id only if it is one uuid. Anything else opens nothing. */
export function layoverPostcardParam(raw: unknown): string | null {
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
}

export function layoverPostcardPlaceLabel(layover: LayoverPostcardSource): string {
  return layover.city ? `Layover in ${layover.city}` : 'Your layover';
}
