/**
 * The location half of a postcard's create body — census-layover L275.
 *
 * A postcard of a COMPLETED layover sends ONLY the layover id: never a picked
 * place, a coordinate or an id. The server takes city/country from the layover
 * and refuses a location sent alongside it. Without a layover, the ordinary
 * place mapping is unchanged.
 */
import type { CreatePostcardParams } from '../services/postcards.ts';
import type { Place } from '../lib/location/placeTypes.ts';
import { placeToLocationFields } from '../lib/location/locationPayload.ts';
import type { LayoverPostcardSource } from './layover/layoverPostcard.ts';

export function postcardLocationFields(place: Place | null, layover: LayoverPostcardSource | null | undefined): CreatePostcardParams {
  if (layover) return { layoverSessionId: layover.sessionId };
  return placeToLocationFields(place);
}
