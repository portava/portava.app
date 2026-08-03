# Live Places Recaps — Phase 3

## Scope and flags

Recaps are versioned, owner-controlled archives over one completed Place Day or
one archived Shared Moment. Every API request requires the parent Live Places
flags (`external_places_enabled`, `place_days_enabled`) plus
`place_recaps_enabled`; Moment parents additionally require
`shared_moments_enabled` and `moment_recaps_enabled`. All flags default off.

## Provenance and immutability

The recap identity, versions, chapters, source records, and place/post/media
snapshots are separate records. A published version is never updated. Review
and publish act only on a draft/reviewed current version; regeneration inserts
a new draft version linked to the prior version. The current version pointer
can move, but historical version payloads cannot be rewritten by that action.

Every source has its type, stable ID, source post ID when applicable,
contributor attribution, ordinal, capture metadata, and deterministic source
hash. Snapshots capture display-safe place and source fields at creation.

## Safety decisions

Source assembly accepts only active, public, already-published Place Day posts
and approved Moment contributions whose attached post is active/public and
published. Sources are ordered deterministically. Blocks, private content,
moderation, deleted content, and unapproved contributions are never used as
new sources. Owner-only reads avoid making recap existence a social graph
signal; RLS allows only the API service role, which performs the capability
and ownership checks.

Compass chapter proposals are explicitly marked as suggestions and include
their source IDs. They use only the deterministic eligible source set and
require review before publication. Empty/error conditions create no claims.

## Operational behavior

Archive, remove, and restore change recap lifecycle metadata without deleting
the immutable source/version evidence. To halt exposure, turn off the relevant
feature flag; do not delete published versions. Phase 4 must decide whether
any non-owner sharing surface is safe, add its audience policy and source
re-evaluation contract, and enable flags gradually.