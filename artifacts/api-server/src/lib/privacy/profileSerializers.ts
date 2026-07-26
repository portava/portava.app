/**
 * Profile serializers — one function per authorization tier.
 *
 * Each function accepts a raw DB row and returns EXACTLY the fields
 * permitted for that tier — no extra fields, no null placeholders for
 * restricted fields.
 */

import type {
  PrivateProfilePreview,
  PublicProfilePreview,
  FullProfileView,
} from "./dtos.js";

/**
 * Minimal preview returned to unauthorized viewers of a private profile.
 *
 * Only id, username, displayName (if opted-in), isPrivate, isVerified,
 * relationshipStatus, and backward-compat sentinel fields are included.
 * `avatarUrl` is always null — the avatar is NOT exposed in limited_preview.
 * Pending requests grant NO additional access.
 */
export function toPrivateProfilePreview(
  r: any,
  opts: {
    relationshipStatus?: "none" | "friend" | "outgoing_request";
    /** Show real name only when the subject has opted-in (show_real_name=true). */
    showRealName?: boolean;
  } = {},
): PrivateProfilePreview {
  const rel = opts.relationshipStatus ?? "none";
  return {
    id: r.id as string,
    username: (r.username as string | null) ?? null,
    displayName: opts.showRealName
      ? ((r.display_name ?? r.name) as string | null) ?? null
      : null,
    // Always null — avatar must NOT be exposed in limited_preview.
    avatarUrl: null,
    isPrivate: Boolean(r.is_private),
    isVerified: Boolean(r.verified),
    // "private" sentinel lets clients identify this shape without inspecting isPrivate.
    visibility: "private",
    // Backward-compat flat flags (clients derive CTA state from these).
    is_friend: rel === "friend",
    friend_request_pending: rel === "outgoing_request",
    relationshipStatus: rel,
  };
}

/**
 * Public-safe profile card returned to authenticated viewers of a
 * public profile (non-owner, not a pending or approved follower of a
 * private profile).
 *
 * When the subject has set show_profile_picture_publicly = false, the
 * avatarUrl is replaced with null so unauthorized viewers cannot access
 * the profile photo.
 */
export function toPublicProfilePreview(
  r: any,
  opts: { showRealName?: boolean } = {},
): PublicProfilePreview {
  // Respect show_profile_picture_publicly: default is true (existing behaviour).
  const showProfilePicPublicly = r.show_profile_picture_publicly !== false;
  return {
    id: r.id as string,
    username: (r.username as string | null) ?? null,
    displayName: opts.showRealName
      ? ((r.display_name ?? r.name) as string | null) ?? null
      : null,
    bio: (r.bio as string | null) ?? null,
    avatarUrl: showProfilePicPublicly
      ? ((r.avatar_url as string | null) ?? null)
      : null,
    coverPhotoUrl: (r.cover_photo_url as string | null) ?? null,
    homeCity: (r.home_city as string | null) ?? null,
    homeCountry: (r.home_country as string | null) ?? null,
    travelStyle: (r.travel_style as string | null) ?? null,
    interests: (r.interests as string[]) ?? [],
    verified: Boolean(r.verified),
    verificationStatus: (r.verification_status as string) ?? "unverified",
    isPrivate: Boolean(r.is_private),
    passportVisibility: (r.passport_visibility as string) ?? "public",
    createdAt: (r.created_at as string | null) ?? null,
    spokenLanguages: (r.spoken_languages as string[]) ?? [],
    travelStyles: (r.travel_styles as string[]) ?? [],
    travelPace: (r.travel_pace as string | null) ?? null,
    lookingFor: (r.looking_for as string[]) ?? [],
    passportTabOrder: (r.passport_tab_order as string[] | null) ?? null,
    openToMeet: Boolean(r.open_to_meet),
  };
}

/**
 * Full profile view returned to the profile owner or an approved
 * follower/friend.
 */
export function toFullProfileView(
  r: any,
  opts: { showRealName?: boolean } = {},
): FullProfileView {
  return {
    ...toPublicProfilePreview(r, opts),
    // Full-view recipients (owner / approved follower / friend) always receive the
    // avatar URL — show_profile_picture_publicly only gates public/unauthorized viewers.
    avatarUrl: (r.avatar_url as string | null) ?? null,
    handle: (r.handle as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    currentCity: (r.current_city as string | null) ?? null,
    verifiedAt: (r.verified_at as string | null) ?? null,
    usernameUpdatedAt: (r.username_updated_at as string | null) ?? null,
    defaultLanguage: (r.default_language as string | null) ?? null,
    travelGroupStyle: (r.travel_group_style as string[]) ?? [],
    comfortLevel: (r.comfort_level as string | null) ?? null,
    availabilityTags: (r.availability_tags as string[]) ?? [],
    planningStyle: (r.planning_style as string | null) ?? null,
    publicSocialLinks: (r.public_social_links as Record<string, string>) ?? {},
    preferredLanguage: (r.preferred_language as string | null) ?? null,
    passportSectionOrder: (r.passport_section_order as string[] | null) ?? null,
    passportHiddenSections:
      (r.passport_hidden_sections as string[] | null) ?? null,
    verificationLevel: (r.verification_level as string | null) ?? null,
    idVerifiedAt: (r.id_verified_at as string | null) ?? null,
    selfieVerifiedAt: (r.selfie_verified_at as string | null) ?? null,
    homeCountryVerifiedAt:
      (r.home_country_verified_at as string | null) ?? null,
    safetyFlagsCount: (r.safety_flags_count as number | null) ?? null,
    hostVerifiedAt: (r.host_verified_at as string | null) ?? null,
    buddyVerifiedAt: (r.buddy_verified_at as string | null) ?? null,
  };
}
