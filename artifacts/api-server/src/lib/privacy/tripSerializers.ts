/**
 * Trip serializers — one function per authorization tier.
 *
 * toPrivateTripPreview — for non-members who can see a trip exists (e.g.
 *   public trips or "buddies"-visibility trips for mutual followers).
 *   Never exposes exact dates, accommodation, route, member list, budget,
 *   documents, itinerary, or invite codes.
 *
 * toAuthorizedTripView — for the owner, an accepted member, or an admin.
 *   Returns all trip fields.
 */

import type { PrivateTripPreview, AuthorizedTripView } from "./dtos.js";
import {
  PRIVATE_TRIP_COVER_PLACEHOLDER,
} from "./coverPlaceholders.js";

/**
 * Stripped trip shape for non-member viewers.
 * Pending join requests grant NO additional access.
 *
 * When the owner has set show_header_publicly = false on a private trip the
 * cover URL is replaced with the generic branded placeholder so sensitive
 * images (tickets, hotel details, exact meeting points) are not leaked to
 * non-members.
 *
 * @param t                   Raw trips DB row
 * @param myJoinRequestStatus Viewer's pending join-request status, or null
 */
export function toPrivateTripPreview(
  t: any,
  myJoinRequestStatus: string | null = null,
): PrivateTripPreview {
  const showHeaderPublicly = Boolean(t.show_header_publicly);

  const preview: PrivateTripPreview = {
    id: t.id as string,
    title: t.title as string,
    // Destination city respects the host's show_destination_city toggle.
    destinationCity:
      t.show_destination_city !== false
        ? ((t.destination_city as string | null) ?? null)
        : null,
    destinationCountry: (t.destination_country as string | null) ?? null,
    status: t.status as string,
    visibility: t.visibility as string,
    // Respect show_header_publicly: replace the cover with a generic placeholder
    // when the owner has opted out of showing it to non-members.
    coverUrl: showHeaderPublicly
      ? ((t.cover_url as string | null) ?? null)
      : PRIVATE_TRIP_COVER_PLACEHOLDER,
    tripType: (t.trip_type as string) ?? "leisure",
    openToMeet: Boolean(t.open_to_meet),
    isPrivate: true,
    createdAt: t.created_at as string,
    updatedAt: t.updated_at as string,
    // Exact dates respect the host's show_exact_dates toggle.
    startDate:
      t.show_exact_dates !== false
        ? ((t.start_date as string | null) ?? null)
        : null,
    endDate:
      t.show_exact_dates !== false
        ? ((t.end_date as string | null) ?? null)
        : null,
    myJoinRequestStatus,
    showHeaderPublicly,
  };

  // Coordinates only when the host has opted-in to sharing the precise location.
  if (t.precise_location_visible === true) {
    preview.destinationLat = (t.destination_lat as number | null) ?? null;
    preview.destinationLng = (t.destination_lng as number | null) ?? null;
  }

  return preview;
}

/**
 * Full trip shape for authorized viewers (owner, accepted member, admin).
 * All fields — including exact dates, notes, and privacy settings — are
 * included because the viewer has already passed authorization.
 */
export function toAuthorizedTripView(t: any): AuthorizedTripView {
  return {
    id: t.id as string,
    ownerId: t.owner_id as string,
    title: t.title as string,
    destinationCity: (t.destination_city as string | null) ?? null,
    destinationCountry: (t.destination_country as string | null) ?? null,
    destinationLat: (t.destination_lat as number | null) ?? null,
    destinationLng: (t.destination_lng as number | null) ?? null,
    destinationPlaceId: (t.destination_place_id as string | null) ?? null,
    neighborhoods: (t.neighborhoods as string[]) ?? [],
    startDate: (t.start_date as string | null) ?? null,
    endDate: (t.end_date as string | null) ?? null,
    status: t.status as string,
    visibility: t.visibility as string,
    tripType: (t.trip_type as string) ?? "leisure",
    timezone: (t.timezone as string | null) ?? null,
    travelStyle: (t.travel_style as string | null) ?? null,
    openToMeet: Boolean(t.open_to_meet),
    coverUrl: (t.cover_url as string | null) ?? null,
    coverMediaType: (t.cover_media_type as 'image' | 'video' | null) ?? null,
    progress: (t.progress as number) ?? 0,
    planEditPermission:
      (t.plan_edit_permission as string) ?? "all_members",
    tripNotes: (t.trip_notes as string | null) ?? null,
    showOnProfile: t.show_on_profile !== false,
    showInDiscovery: Boolean(t.show_in_discovery),
    allowFriendSuggestions: t.allow_friend_suggestions !== false,
    allowTripCrewInvites: t.allow_trip_crew_invites !== false,
    allowJoinRequests: Boolean(t.allow_join_requests),
    showExactDates: t.show_exact_dates !== false,
    showDestinationCity: t.show_destination_city !== false,
    delayedPostingDefault: Boolean(t.delayed_posting_default),
    preciseLocationVisible: Boolean(t.precise_location_visible),
    showHeaderPublicly: Boolean(t.show_header_publicly),
    createdAt: t.created_at as string,
    updatedAt: t.updated_at as string,
  };
}
