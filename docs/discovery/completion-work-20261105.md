# Discovery engineering reconciliation — 2026-11-05

This report records the current shared worktree, not a production certification or a promotion of the historical architecture census. Earnings remain disabled. No production reads/writes, migration applications, deployments or flag activations were performed by this lane.

## Closed in this completion pass

- Cached place responses no longer treat cached community captions, originals, summary provenance or media IDs as current read grants. HIT, STALE and MISS responses all reproject current post visibility, publication/deletion, place/location policy, author restrictions/private-account audience, blocks and media moderation before serving community content.
- Community original/thumbnail selection uses current attachments and asset state. Removed or rejected attachment bytes, retained moderation-ledger denials and private attachment overrides cannot be recovered through stale cached URLs. Bounded batched reads avoid a serial authorization request per timeline item; the 50-post test uses at most seven batch reads. Byte hydration remains independently authorized.
- Summary text is withheld if its recorded source set is absent, changed or no longer readable. Rejected community sources do not leave stale community hero media, contribution/rating metadata or fabricated zero counts. Query failures are explicitly unavailable and retryable.
- Dedup sample media IDs now resolve to current, eligible image attachments with distinct original/thumbnail contracts. An identifier is never emitted as a URL. Group sample counts describe visible samples; stale worker membership totals cannot imply distinct visible travelers.
- Dedicated timeline reads recheck current policy and fail with 503 on policy-read outage. The client removes its previous five-minute private preview cache, aborts retired requests, rejects superseded period results, remounts on owner/privacy scope, and offers visible Retry states.
- Place-day, event community, Shared Moment and Living dedup content now has full-original viewing; Living timeline and Best Of use canonical post navigation.
- Mobile/desktop active tabs, horizontal swipe source selection and adjacent-tab prefetch now share normalized route matching. Actual `/` and `/trips` warm Discovery as intended; route-group omissions no longer silently bypass prefetch. Six-tab labels also fit ordinary narrow screens, with scaled-height clearance and accessible ellipsis at large text sizes.
- The previously recorded DV-78 missing Trail-open client emitter is present and integrated in `TrailDetailView.tsx`. It sends only a loaded, foreground, focused visit, is owner-bound, and performs no token/network work when the flag is off. This closes the implementation gap; it does not authorize enabling new collection.

## Verification

| Evidence | Result |
| --- | --- |
| `placeLiving`, `placeLivingDedup`, `placeLivingCommunity`, `postLocationModeRemainingReaders`, `placeCollections` | 121 API checks passed (`/tmp/place-living-final-api.log`). |
| Source/author/account/private-follow/block/location/media/retained-ledger and appeal fixtures | Current-source denials, read outages and public-source replacements covered. |
| Cached HIT/STALE/MISS and subsequent withdrawal | Current policy wins on every path; no cache-based grant. |
| Mounted Living tabs, Event community, Place day, Shared Moments, Telegraph kinds, legacy Memories, ContentMedia, Memory video | 98 checks passed (`/tmp/content-media-all-final.log`). |
| API source and test-type checks | Source clean; existing 860 diagnostics/113-file test baseline unchanged (`/tmp/place-living-final-types.log`, `/tmp/place-living-test-types.log`). |
| Client source/import/mock checks | Clean at this lane's final implementation check; concurrent integration baseline reconciliation remains the root run's responsibility. |

The broad location-reader fixture was updated to model exact counts and canonical active place policy; the full existing suite passed. Its old assertion forbidding every fresh `published_at` read was replaced with proof of the required serving-time policy recheck, without broadening public location access.

## What remains outside organic feature implementation

The latest existing ledger is 188 rows: 117C, 69W, 2N. It labels 48 open rows production rollout, 18 owner approval, 3 observation-window and 2 runtime evidence. These are historical labels, not newly measured completion percentages. No census row was promoted by this pass.

| Area | Remaining concrete boundary |
| --- | --- |
| Deployment and flags | Apply the reviewed migrations/configuration and deploy the integrated server/client, then run signed-in live acceptance. Existing implementation alone cannot prove release state. |
| Ranking effectiveness / ecosystem reports | Real eligible content, exposures, outcomes and enough observation are needed to measure effectiveness. Synthetic checks cannot establish production impact. |
| Dwell / Trail-open / cross-user behavior | Default-OFF paths remain off pending the existing purpose, wording, retention and consent decisions. This pass does not invent or activate consent on users' behalf. |
| Optional people-derived projections | Traveler affinity, circle momentum and itinerary-derived co-occurrence remain outside the approved purpose; the existing Trail-derived place projection is built. These optional inferences are not required for organic place browsing or posting. |
| Commercial / creator controls | Earnings stay OFF as explicitly requested. Provider/payment onboarding, revenue policy and any sponsored placement rules require a concrete commercial scope; the historical sponsored-system row is not silently marked complete. |
| Retention and debug purging | Existing gated purge/scheduler code awaits the selected retention policy and release activation where the ledger explicitly requires it. |
| Legacy ranker removal / rollback window | Retain rollback paths until the required observation window and release evidence exist. Deleting them now would remove the recovery path rather than complete validation. |
| Native/device acceptance | Full viewport media, maps/location and integrated navigation still require the installed native client/device checks in the release plan. Browser resizing is not physical-device rotation evidence. |

The current organic Discovery work can be reviewed and tested locally without users supplying content. After release verification, empty community rails should be populated by users sharing eligible information; they must not be filled with fabricated activity or stale private data. The optional behavioral/commercial decisions above must be explicitly scoped or resolved before claiming every historical architecture requirement is complete.
