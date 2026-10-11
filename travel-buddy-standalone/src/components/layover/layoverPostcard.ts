/**
 * A postcard of a COMPLETED layover — census-layover L275, the postcard half.
 *
 * Layover spec §25: "convert a completed session into an optional
 * stamp/postcard/memory". The stamp rides on the close, the Memory is
 * `createMemoryFromLayover`; the postcard is the EXISTING composer and the
 * EXISTING `POST /api/postcards`, told which layover it is of. The server takes
 * the place from the layover (city and country only — the layover proved the
 * traveller made their flight from that airport, not where they went) and
 * refuses any location sent alongside it, so the composer sends none.
 *
 * Nothing here decides presence: the passport postcard the server writes is
 * unverified and not stamp-eligible, like every postcard.
 */
import type { CreatePostcardParams } from '../../services/postcards.ts';
import type { Place } from '../../lib/location/placeTypes.ts';
import { placeToLocationFields } from '../../lib/location/locationPayload.ts';

export interface LayoverPostcardSource {
  sessionId: string;
  /** For the composer's label only. The server decides what the postcard carries. */
  city: string | null;
}

/** Offered only for a layover that ended with the flight. `cancelled`, `expired` and `active` are not. */
export function layoverPostcardOffered(status: string | null | undefined): boolean {
  return status === 'completed';
}

/**
 * The location half of the create body. A layover postcard sends ONLY the
 * layover id — never a picked place, a coordinate or an id.
 */
export function postcardLocationFields(place: Place | null, layover: LayoverPostcardSource | null | undefined): CreatePostcardParams {
  if (layover) return { layoverSessionId: layover.sessionId };
  return placeToLocationFields(place);
}

export function layoverPostcardPlaceLabel(layover: LayoverPostcardSource): string {
  return layover.city ? `Layover in ${layover.city}` : 'Your layover';
}
