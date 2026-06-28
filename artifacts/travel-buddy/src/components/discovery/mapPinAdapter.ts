/**
 * mapPinAdapter — PROPOSED, NEEDS REPLIT VERIFICATION (not yet typechecked).
 *
 * Purpose: let the EXISTING PlaceDetailSheet handle future rich map pins (people,
 * events, etc.) WITHOUT duplicating the bottom sheet and WITHOUT requiring new
 * backend fields today. It is a pure, presentation-only normalization layer.
 *
 * Why this shape:
 *   PlaceDetailSheet is tightly bound to DiscoveryPlace and works well for venue
 *   pins (real save via discoveryBookmarks, OSM attribution, Directions/Add-to-Plan
 *   footer). It cannot directly render a person/buddy pin (different fields, different
 *   primary action). Rather than fork the sheet, this adapter:
 *     1. Defines a minimal, provider-agnostic MapPin type for future rich pins.
 *     2. Converts a MapPin → DiscoveryPlace-compatible object for display reuse.
 *     3. Surfaces an `actionType` so the caller can choose the right primary action
 *        (View Place / View Event / Book Buddy / View Profile…) WITHOUT the sheet
 *        needing to know about every entity type.
 *
 * IMPORTANT honesty constraints baked in:
 *   - No fabricated images: imageUrl/avatarUrl are optional; absence → caller uses
 *     the category-icon fallback (already implemented in DiscoveryMapLibreView).
 *   - No fabricated backend fields: every rich field is optional. Venue pins keep
 *     working unchanged because they never go through this adapter.
 *   - This does NOT create a second bottom sheet or a second map/location service.
 *
 * INTEGRATION (later, on Replit — do not wire blindly):
 *   - For venue pins: keep passing DiscoveryPlace straight to PlaceDetailSheet (no
 *     change). This adapter is only for NON-venue rich pins.
 *   - To support non-venue pins in the sheet, PlaceDetailSheet needs a small,
 *     additive change: accept an optional `primaryAction?: { label: string; onPress:
 *     () => void }` and, when present, render it INSTEAD of the default
 *     "Add to Plan" button. That change is described at the bottom of this file but
 *     intentionally NOT applied here, since it must be typechecked against the live
 *     project first.
 */
import type { DiscoveryPlace } from '../../services/discovery';

/** Provider-agnostic pin types Travel Buddy may render on the map later. */
export type MapPinType =
  | 'place'
  | 'event'
  | 'hidden_gem'
  | 'food'
  | 'nightlife'
  | 'postcard'
  | 'saved'
  | 'compass_pick'
  | 'person'
  | 'buddy';

/** The action a pin's primary button should perform. Caller maps this to a handler. */
export type MapPinAction =
  | 'view_place'
  | 'view_event'
  | 'join_event'
  | 'open_postcard'
  | 'view_profile'
  | 'book_buddy'
  | 'add_to_trip';

/**
 * Minimal rich pin. EVERY rich field is optional so nothing is fabricated and
 * venue pins are unaffected. Coordinates are required (no map pin without them).
 */
export interface MapPin {
  id: string;
  pinType: MapPinType;
  title: string;
  latitude: number;
  longitude: number;

  // Optional display — absence is honest, not an error.
  subtitle?: string | null;
  imageUrl?: string | null;   // places/events/postcards
  avatarUrl?: string | null;  // people/buddies
  category?: string | null;
  city?: string | null;
  country?: string | null;
  neighborhood?: string | null;
  distanceMeters?: number | null;
  trustLabel?: string | null;
  verified?: boolean;
  description?: string | null;
  actionType?: MapPinAction | null;

  // Linkage for navigation / detail routing.
  linkedEntityType?: string | null;
  linkedEntityId?: string | null;
  source?: string | null;
}

/** True for venue-style pins that the existing PlaceDetailSheet handles natively. */
export function isVenuePin(pin: MapPin): boolean {
  return (
    pin.pinType === 'place' ||
    pin.pinType === 'food' ||
    pin.pinType === 'nightlife' ||
    pin.pinType === 'hidden_gem' ||
    pin.pinType === 'saved' ||
    pin.pinType === 'compass_pick'
  );
}

/** True for people-style pins (different primary action, approximate location). */
export function isPersonPin(pin: MapPin): boolean {
  return pin.pinType === 'person' || pin.pinType === 'buddy';
}

/** Default primary action per pin type, when the pin doesn't specify one. */
export function defaultActionFor(pinType: MapPinType): MapPinAction {
  switch (pinType) {
    case 'event':       return 'view_event';
    case 'postcard':    return 'open_postcard';
    case 'person':      return 'view_profile';
    case 'buddy':       return 'book_buddy';
    default:            return 'view_place';
  }
}

/** Human label for a primary action (used by the optional sheet button). */
export function actionLabel(action: MapPinAction): string {
  switch (action) {
    case 'view_event':   return 'View Event';
    case 'join_event':   return 'Join Event';
    case 'open_postcard':return 'Open Postcard';
    case 'view_profile': return 'View Profile';
    case 'book_buddy':   return 'Book Buddy';
    case 'add_to_trip':  return 'Add to Trip';
    case 'view_place':
    default:             return 'View Place';
  }
}

/**
 * Convert a rich MapPin into a DiscoveryPlace-compatible object so the EXISTING
 * PlaceDetailSheet can render it. Only fills fields the sheet reads; everything the
 * pin lacks stays undefined/empty (honest absence, not fabricated values).
 *
 * NOTE: cast is intentional and localized — DiscoveryPlace has more fields than a
 * non-venue pin can supply. The sheet guards each optional field, so undefined is
 * safe. This must still be verified against the live DiscoveryPlace type on Replit.
 */
export function pinToDisplayPlace(pin: MapPin): DiscoveryPlace {
  const distanceKm =
    pin.distanceMeters != null ? Math.round((pin.distanceMeters / 1000) * 10) / 10 : null;

  const display: Partial<DiscoveryPlace> = {
    id: pin.id,
    name: pin.title,
    category: (pin.category ?? pin.pinType) as DiscoveryPlace['category'],
    type: pin.pinType,
    description: pin.description ?? undefined,
    address: pin.neighborhood ?? pin.city ?? undefined,
    lat: pin.latitude,
    lng: pin.longitude,
    distanceKm: distanceKm ?? undefined,
    tags: [],
  };

  return display as DiscoveryPlace;
}

/* ───────────────────────────────────────────────────────────────────────────
 * PROPOSED additive change to PlaceDetailSheet.tsx (DO NOT APPLY UNTIL VERIFIED)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 1. Extend props:
 *      interface PlaceDetailSheetProps {
 *        place: DiscoveryPlace | null;
 *        visible: boolean;
 *        onClose: () => void;
 *        onAddToPlan: (place: DiscoveryPlace) => void;
 *        // NEW (optional — venue pins ignore it, behavior unchanged):
 *        primaryAction?: { label: string; onPress: () => void };
 *      }
 *
 * 2. In the footer, when primaryAction is provided, render it instead of the
 *    default Add-to-Plan button:
 *
 *      {primaryAction ? (
 *        <Pressable style={styles.addBtn} onPress={primaryAction.onPress}>
 *          <Text style={styles.addText}>{primaryAction.label}</Text>
 *        </Pressable>
 *      ) : (
 *        <Pressable style={styles.addBtn} onPress={() => onAddToPlan(place)}>
 *          <Plus size={18} color={color.onInk} />
 *          <Text style={styles.addText}>Add to Plan</Text>
 *        </Pressable>
 *      )}
 *
 * 3. Caller wiring (in the map view), for a non-venue pin:
 *      const place = pinToDisplayPlace(pin);
 *      const action = pin.actionType ?? defaultActionFor(pin.pinType);
 *      <PlaceDetailSheet
 *        place={place}
 *        visible
 *        onClose={...}
 *        onAddToPlan={...}
 *        primaryAction={{ label: actionLabel(action), onPress: () => routeFor(pin) }}
 *      />
 *
 * This keeps ONE bottom sheet, adds zero required backend fields, and leaves the
 * existing venue flow byte-for-byte unchanged. Verify types + render on Replit
 * before relying on it.
 * ─────────────────────────────────────────────────────────────────────────── */
