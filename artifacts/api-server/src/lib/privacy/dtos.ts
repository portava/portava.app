/**
 * Privacy DTOs — explicit response types for each authorization tier.
 *
 * The server selects the correct shape after authorization.
 * Unauthorized viewers NEVER receive the full private object.
 */

// ── Profile ──────────────────────────────────────────────────────────────────

/**
 * Shown to unauthenticated callers or viewers who have not been approved
 * to follow a private profile. Contains only safe, minimal identity fields.
 *
 * `visibility: "private"` is a sentinel that clients use to detect this shape.
 * `avatarUrl` is always null — the avatar is NOT exposed in the limited preview.
 */
export interface PrivateProfilePreview {
  id: string;
  username: string | null;
  displayName: string | null;
  /** Always null — avatar is hidden in the limited preview for privacy. */
  avatarUrl: null;
  isPrivate: boolean;
  isVerified: boolean;
  /** Always "private" — sentinel for clients to identify this shape. */
  visibility: "private";
  /** Backward-compatible relationship flags. */
  is_friend: boolean;
  friend_request_pending: boolean;
  /** Canonical relationship status (superset of the two flags above). */
  relationshipStatus: "none" | "friend" | "outgoing_request";
}

/**
 * Public-safe profile card fields — shown to authenticated viewers of
 * public profiles who are not the owner and have not been approved as
 * followers of a private profile.
 */
export interface PublicProfilePreview {
  id: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverPhotoUrl: string | null;
  homeCity: string | null;
  homeCountry: string | null;
  travelStyle: string | null;
  interests: string[];
  verified: boolean;
  verificationStatus: string;
  isPrivate: boolean;
  passportVisibility: string;
  createdAt: string | null;
  spokenLanguages: string[];
  travelStyles: string[];
  travelPace: string | null;
  lookingFor: string[];
  passportTabOrder: string[] | null;
  openToMeet: boolean;
}

/**
 * Full profile view — returned to the profile owner or an approved
 * follower / friend. Extends PublicProfilePreview with private preference
 * and verification fields.
 */
export interface FullProfileView extends PublicProfilePreview {
  handle: string | null;
  name: string | null;
  currentCity: string | null;
  verifiedAt: string | null;
  usernameUpdatedAt: string | null;
  defaultLanguage: string | null;
  travelGroupStyle: string[];
  comfortLevel: string | null;
  availabilityTags: string[];
  planningStyle: string | null;
  publicSocialLinks: Record<string, string>;
  preferredLanguage: string | null;
  passportSectionOrder: string[] | null;
  passportHiddenSections: string[] | null;
  verificationLevel: string | null;
  idVerifiedAt: string | null;
  selfieVerifiedAt: string | null;
  homeCountryVerifiedAt: string | null;
  safetyFlagsCount: number | null;
  hostVerifiedAt: string | null;
  buddyVerifiedAt: string | null;
}

// ── Event ────────────────────────────────────────────────────────────────────

/**
 * Shown to viewers who can see an event exists (e.g. via a share link or
 * discovery) but are NOT authorized attendees / hosts.
 *
 * Never includes: exact address, coordinates, exact start/end times,
 * attendee data, description, group-chat references, or media.
 */
export interface PrivateEventPreview {
  id: string;
  title: string;
  /**
   * The cover image URL, or the generic private-event placeholder URL when
   * show_header_publicly is false for a private event.
   */
  coverUrl: string | null;
  coverMediaType: string | null;
  /** Always true — signals to the client that this is a restricted preview. */
  isPrivate: true;
  visibility: string;
  state: string;
  hostId: string;
  category: string | null;
  city: string | null;
  country: string | null;
  /** Pending join-request status for the viewer, if any. */
  myJoinRequestStatus: string | null;
  /** Whether the host has opted in to showing the cover to non-members. */
  showHeaderPublicly: boolean;
}

/**
 * Full event detail for the host, an attendee, or an admin.
 * Exact coordinates and priceUrl are scoped to participants only.
 * safetyNotes are scoped to the host only.
 */
export interface AuthorizedEventView {
  id: string;
  hostId: string;
  title: string;
  description: string | null;
  locationName: string | null;
  locationLat: number | null;
  locationLng: number | null;
  startsAt: string | null;
  endsAt: string | null;
  coverUrl: string | null;
  coverMediaType: string | null;
  maxAttendees: number | null;
  ageMin: number | null;
  ageMax: number | null;
  trustScoreMin: number | null;
  verifiedOnly: boolean;
  visibility: string;
  state: string;
  chatEnabled: boolean;
  chatThreadId: string | null;
  waitlistEnabled: boolean;
  priceType: string | null;
  /** null for non-participants */
  priceUrl: string | null;
  /** null for non-hosts */
  safetyNotes: string | null;
  rsvpOptions: string[];
  goingCount: number;
  waitlistCount: number;
  category: string | null;
  city: string | null;
  country: string | null;
  showExactLocation: boolean;
  rsvpClosed: boolean;
  tags: string[];
  isHost: boolean;
  /** Whether the host has opted in to showing the cover image to non-members. */
  showHeaderPublicly: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Locked previews (deep-link surfaces) ────────────────────────────────────

/**
 * Returned for private/invite-only events when an unauthorized authenticated
 * viewer hits GET /events/:id via a deep link.
 *
 * The `locked` sentinel tells the mobile client to render the private-wall
 * component instead of attempting to render a full event detail screen with
 * missing data. No title, venue, date, or attendee information is exposed.
 */
export interface LockedEventPreview {
  /** Sentinel: always true — clients test this to identify the shape. */
  locked: true;
  eventId: string;
}

/**
 * Returned for private/invite-only trips when an unauthorized authenticated
 * viewer hits GET /trips/:tripId via a deep link.
 *
 * The `locked` sentinel tells the mobile client to render the private-wall
 * component. No title, destination, dates, or member information is exposed.
 */
export interface LockedTripPreview {
  /** Sentinel: always true — clients test this to identify the shape. */
  locked: true;
  tripId: string;
}

// ── Trip ────────────────────────────────────────────────────────────────────

/**
 * Shown to non-members who can see a trip exists (public trips, mutual-follow
 * "buddies" trips). Never includes exact dates, accommodation, route, member
 * list, budget, documents, itinerary, or invite codes.
 */
export interface PrivateTripPreview {
  id: string;
  title: string;
  destinationCity: string | null;
  destinationCountry: string | null;
  status: string;
  visibility: string;
  /**
   * The cover image URL, or the generic private-trip placeholder URL when
   * show_header_publicly is false for a private trip.
   */
  coverUrl: string | null;
  tripType: string;
  openToMeet: boolean;
  /** Always true — signals to the client that full details are restricted. */
  isPrivate: true;
  createdAt: string;
  updatedAt: string;
  /** null when show_exact_dates is false */
  startDate: string | null;
  endDate: string | null;
  destinationLat?: number | null;
  destinationLng?: number | null;
  /** Pending join-request status for the viewer, if any. */
  myJoinRequestStatus: string | null;
  /** Whether the host has opted in to showing the cover to non-members. */
  showHeaderPublicly: boolean;
}

/**
 * Full trip detail for the owner, an accepted member, or an admin.
 */
export interface AuthorizedTripView {
  id: string;
  ownerId: string;
  title: string;
  destinationCity: string | null;
  destinationCountry: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
  destinationPlaceId: string | null;
  neighborhoods: string[];
  startDate: string | null;
  endDate: string | null;
  status: string;
  visibility: string;
  tripType: string;
  timezone: string | null;
  travelStyle: string | null;
  openToMeet: boolean;
  coverUrl: string | null;
  progress: number;
  planEditPermission: string;
  tripNotes: string | null;
  showOnProfile: boolean;
  showInDiscovery: boolean;
  allowFriendSuggestions: boolean;
  allowTripCrewInvites: boolean;
  allowJoinRequests: boolean;
  showExactDates: boolean;
  showDestinationCity: boolean;
  delayedPostingDefault: boolean;
  preciseLocationVisible: boolean;
  /** Whether the owner has opted in to showing the cover image to non-members. */
  showHeaderPublicly: boolean;
  createdAt: string;
  updatedAt: string;
}
