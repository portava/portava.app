---
name: Universal display-name privacy rule
description: How person names are gated app-wide; exemptions that must not be "fixed"
---

# The rule
Every user reference app-wide shows `@handle` by default; a real name appears only if that user opted in via `profile_privacy_settings.show_real_name` (default false). Gating is server-side and fail-closed. The viewer must always see their own name (self-exemption before the opt-in check).

# How to apply
- All API-side gating goes through the shared `publicIdentity` helper (`nameVisibilitySet` batched lookup; errors → empty set = fail closed). Never inline-query the privacy table.
- In user-scoped routes the privacy lookup may need the service client (`getServiceClient() ?? client`) — RLS can hide other users' opt-in rows and would wrongly fail-closed opted-in names. Use it only for the privacy lookup, never to widen data access.
- Mobile has a matching resolver (`displayIdentity`: name → `@handle` → 'Traveler') used by name-rendering components.
- Any NEW route/service emitting another user's name must batch ids → `nameVisibilitySet` → null the name for non-opted-in users, with viewer-self exempt.

# Intentional exemptions (do NOT "fix" these)
- Rent-a-buddy marketplace `display_name` — self-authored public persona, never redacted.
- Admin/moderation routes — unredacted by design.
- SafeReturn SOS sender-name flows — sender's own name goes to their chosen trusted contacts.
- Non-person names (trips, events, places, circles, stamps, hashtags, cities) — never redacted.

# Related behaviors
- Hidden names are not searchable: search routes post-filter so a hidden-name match survives only if handle/username matched.
- Push notification bodies use `@handle` unless the actor opted in.
