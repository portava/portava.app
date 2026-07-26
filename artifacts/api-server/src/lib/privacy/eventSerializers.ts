/**
 * Event serializers — one function per authorization tier.
 *
 * toPrivateEventPreview — for viewers who can see an event exists but are
 *   not authorized (not an attendee, host, or member of the linked circle/trip).
 *   Never exposes exact address, coordinates, exact times, attendee data,
 *   description, group-chat references, or media.
 *
 * toAuthorizedEventView — for the host, an attendee (going/maybe), co-host,
 *   or admin. Includes all event fields with host-only and participant-only
 *   sub-gates applied server-side.
 */

import type { PrivateEventPreview, AuthorizedEventView } from "./dtos.js";
import {
  PRIVATE_EVENT_COVER_PLACEHOLDER,
} from "./coverPlaceholders.js";

/**
 * Minimal event card for unauthorized viewers.
 * Pending join requests grant NO additional access.
 *
 * When the host has set show_header_publicly = false on a private event the
 * cover URL is replaced with the generic branded placeholder so sensitive
 * ticket art, addresses, or personal photos are not leaked to non-members.
 *
 * @param ev                  Raw events DB row
 * @param myJoinRequestStatus Viewer's pending join-request status, or null
 */
export function toPrivateEventPreview(
  ev: any,
  myJoinRequestStatus: string | null = null,
): PrivateEventPreview {
  const showHeaderPublicly = Boolean(ev.show_header_publicly);
  return {
    id: ev.id as string,
    title: ev.title as string,
    // Respect show_header_publicly: replace the cover with a generic placeholder
    // when the host has opted out of showing it to non-members.
    coverUrl: showHeaderPublicly
      ? ((ev.cover_url as string | null) ?? null)
      : PRIVATE_EVENT_COVER_PLACEHOLDER,
    coverMediaType: showHeaderPublicly
      ? ((ev.cover_media_type as string | null) ?? null)
      : "image",
    isPrivate: true,
    visibility: ev.visibility as string,
    state: ev.state as string,
    hostId: ev.host_id as string,
    category: (ev.category as string | null) ?? null,
    city: (ev.city as string | null) ?? null,
    country: (ev.country as string | null) ?? null,
    myJoinRequestStatus,
    showHeaderPublicly,
  };
}

/**
 * Full event detail for an authorized viewer.
 *
 * Field gates applied server-side:
 *   - locationLat / locationLng: host or confirmed attendee only (when
 *     show_exact_location is false)
 *   - priceUrl: host or confirmed attendee only
 *   - safetyNotes: host only
 *   - chatThreadId: always returned (clients may gate rendering by role)
 *
 * @param ev         Raw events DB row
 * @param viewerId   Authenticated viewer's user ID
 * @param opts.goingRsvp  True when the viewer has a going/maybe RSVP
 */
export function toAuthorizedEventView(
  ev: any,
  viewerId: string,
  opts: { goingRsvp?: boolean } = {},
): AuthorizedEventView {
  const isHost = (ev.host_id as string) === viewerId;
  const isParticipant = isHost || Boolean(opts.goingRsvp);
  // Exact coordinates — visible to host or confirmed attendees, or when the
  // host has opted-in to showing the exact location to all viewers.
  const showCoords = isParticipant || (ev.show_exact_location !== false);

  return {
    id: ev.id as string,
    hostId: ev.host_id as string,
    title: ev.title as string,
    description: (ev.description as string | null) ?? null,
    locationName: (ev.location_name as string | null) ?? null,
    locationLat: showCoords ? ((ev.location_lat as number | null) ?? null) : null,
    locationLng: showCoords ? ((ev.location_lng as number | null) ?? null) : null,
    startsAt: (ev.starts_at as string | null) ?? null,
    endsAt: (ev.ends_at as string | null) ?? null,
    coverUrl: (ev.cover_url as string | null) ?? null,
    coverMediaType: (ev.cover_media_type as string | null) ?? null,
    coverSource: (ev.cover_source as string | null) ?? null,
    maxAttendees: (ev.max_attendees as number | null) ?? null,
    ageMin: (ev.age_min as number | null) ?? null,
    ageMax: (ev.age_max as number | null) ?? null,
    trustScoreMin: (ev.trust_score_min as number | null) ?? null,
    verifiedOnly: Boolean(ev.verified_only),
    visibility: ev.visibility as string,
    state: ev.state as string,
    chatEnabled: ev.chat_enabled !== false,
    chatThreadId: (ev.chat_thread_id as string | null) ?? null,
    waitlistEnabled: ev.waitlist_enabled !== false,
    priceType: (ev.price_type as string | null) ?? null,
    // priceUrl: participants only (informs payment intent)
    priceUrl: isParticipant ? ((ev.price_url as string | null) ?? null) : null,
    // safetyNotes: host only (internal moderation / safety planning)
    safetyNotes: isHost ? ((ev.safety_notes as string | null) ?? null) : null,
    rsvpOptions: (ev.rsvp_options as string[]) ?? [
      "going",
      "maybe",
      "interested",
      "cant_go",
    ],
    goingCount: (ev.going_count as number) ?? 0,
    waitlistCount: (ev.waitlist_count as number) ?? 0,
    category: (ev.category as string | null) ?? null,
    city: (ev.city as string | null) ?? null,
    country: (ev.country as string | null) ?? null,
    showExactLocation: Boolean(ev.show_exact_location),
    rsvpClosed: Boolean(ev.rsvp_closed),
    tags: (ev.tags as string[]) ?? [],
    isHost,
    showHeaderPublicly: Boolean(ev.show_header_publicly),
    createdAt: ev.created_at as string,
    updatedAt: ev.updated_at as string,
  };
}
