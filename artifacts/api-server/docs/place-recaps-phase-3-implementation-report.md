# Phase 3 implementation report — Live Places Recaps

## Reused systems

The implementation reuses Place Day lifecycle eligibility, Shared Moment
membership/contribution approval, canonical places, public post lifecycle
fields, bidirectional block resolution, feature flags, and the established
service-role API/RLS boundary. Compass-style output is deliberately a
deterministic, source-labelled chapter proposal rather than a statement of
verified travel history.

## Added contract

Migrations `2065_live_places_recaps.sql`,
`2066_live_place_recap_lifecycle_rpc.sql`, and
`2067_live_place_recap_integrity_hardening.sql` introduce recap identity, immutable
versions, chapter proposals/approval, source provenance, immutable display
snapshots, and service-only transactional lifecycle functions. They index
owner/context, versions, and source ordering and enable RLS on every new table
with service-only policies.

The API supports create, draft review, publish, regenerate, archive, remove,
restore, list, and detail operations. Creation only accepts a closing/archived
Place Day or archived Moment. Place Day sources are constrained to that exact
stored local calendar day and timezone, then filtered by canonical place,
publish lifecycle, bidirectional blocks, and private-author visibility.
Because a Place Day is a shared canonical place/date anchor, its recap owner
must have an eligible source in that exact day; an arbitrary contributor cannot
claim it. The transactional functions independently re-check the parent/place,
snapshot identity, source identity/status, and chapter source references before
persisting evidence. Restore is available only for an archived version that was
previously published, so a draft or reviewed version can never be promoted by
an archive/restore cycle.
Regeneration creates a linked next version and leaves an existing published
version unchanged. The create, regenerate, and lifecycle pointer/status writes
are database transactions. All reads are owner-only until a later sharing
policy can be designed safely.

The mobile Place Day screen offers recap creation only after the dedicated
capability flag is on and the day is no longer active. The recap detail view
shows lifecycle, source-backed chapter suggestions, immutable snapshots, and
review/publish/regenerate/archive/restore actions.

## Risk decisions and Phase 4 prerequisites

* New source collection fails closed on unknown block state and excludes
  blocked, non-public, inactive, delayed, unapproved, and moderated posts.
* Snapshot records preserve provenance; the current release does not add a
  public recap surface, avoiding ambiguity when a source later changes privacy.
* Flags remain off. Before Phase 4, apply/verify the migration, add explicit
  audience and current-view source-visibility policy for every sharing
  surface, decide the archival retention policy, and roll out flags gradually.