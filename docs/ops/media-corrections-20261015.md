# Media corrections and evidence — 2026-10-15

## Scope, snapshot and decision

**Main-app correction batch; not 100% Media acceptance. No census grades change.**
Integrated working tree: `codex/media-corrections-20261015`, based on main
`3279481e081cb75c29ace6b07b82126f8499bedf`. Its committed tree is byte-identical to
the previously reviewed #760 head `ebd5d7c9dea8aacddb8ba28a2cb073a1ad7f7c52`.
The uncommitted correction batch is additional work, not covered by #760's checks.
Parent reports #760 merged with 31 PR checks passing; its main runs
38744723180 / 38744723402 / 38744723168 were pending at handoff. No result for those
runs, or this new batch's CI, is inferred. Later parent handoff reports the #760 main
live-DB and unwired runs succeeded; main CI remains pending. This lane ran none of those jobs.

Canonical parser before this metadata pass: Media **450 = 415 C / 30 W / 5 N / 0 X**;
C share **92.22%**, constructed **98.89%**. Whole parsed app:
**3,518 = 2,504 C / 896 W / 94 N / 24 X**, C share **71.18%**.
The **163 unreconciled Discovery prose requirements** remain separately reported.
These are construction-census ratios, not a measured real-main-app acceptance percentage.

Only native JS boundaries, provider contracts, World/lens surfaces, Watch playback,
accessibility and the parent's moderation-generation repair are in this batch.
**Memory-source conversion, a future native encoder/service, and separate stage-24 work
are not integrated and are not described as complete.** Existing owner/privacy/vendor
holds remain. No beta work, DB action, provider invocation, flag activation, deployment
or dependency installation follows from this document.

## Integrated corrections and precise limits

### World/lens state and mode restoration

World state now belongs to city ID/label/coordinates; lens state belongs to its declared
dependency values. Changing scope hides old-subject data immediately and late aborted
responses cannot install it under a new subject. Same-scope refresh failure retains the
last good state. This is query-scope isolation, not newly established account isolation.
A successful empty base World response no longer prevents independent qualified Crowd
Flow from rendering; pairing, cohort floors, expiry and withholding are unchanged.
Delayed persisted-mode restoration respects current modes/defaults and explicit user choice.

Code: `travel-buddy-standalone/src/features/media/hooks/useMediaWorld.ts`,
`travel-buddy-standalone/src/features/media/hooks/useLensProjection.ts`,
`travel-buddy-standalone/src/features/media/components/CrowdFlowCard.tsx`,
`travel-buddy-standalone/src/features/media/screens/MediaWorldScreen.tsx`,
`travel-buddy-standalone/src/stores/mediaStore.ts`.
Mounted tests model transport/storage boundaries, not real world observations or device reach.
D8/D10/D26 decisions are already answered; do not invent new owner indecision or remove
the explicitly retained non-default full-screen Watch mode.

### Watch playback policy

`travel-buddy-standalone/src/components/media/WatchFeedList.tsx` stores current policy,
pause permission and pending hold restoration together. An active OFF-to-ON transition
requires a new tap before another playing child render. Stale hold/finalize/dismiss callbacks
cannot restore obsolete permission or undo a subsequent explicit pause; leave/background/scroll
invalidates pending restoration. Ordinary ON renders retain explicit play; OFF behavior is preserved.
The mounted feed/player-manager tests observe props and imperative calls, but native Video
and gestures are substituted. Physical playback cessation, OS lifecycle and gestures remain unproved.

### Accessibility acceptance failures corrected

The earlier acceptance worker demonstrated two actual structural failures, not merely an
absence of device evidence. The integrated contribution button now retains “Share this
perspective” as its accessible name and exposes busy/disabled state; World Search and
Compass actions now declare button roles. The new
`travel-buddy-standalone/src/features/media/__tests__/MediaAcceptance.accessibility.component.test.tsx`
is preserved, not skipped or softened. Its restrictive audience/precision reducer-state
and unoffered-control positive checks remain. MD403 still needs owner H8 visual acceptance
and actual assistive-technology/focus/font-size/target/motion/imagery-contrast evidence.
A rendered accessibility tree is not a VoiceOver or TalkBack witness.

### Native JS boundaries, not native delivery

`travel-buddy-standalone/src/services/media/backgroundTransfer.ts` rejects invalid sizes/ranges
and missing cache before reading, stats the written staged part before upload, cleans up
failed/successful staging, preserves complete neighboring batch parts, and bounds failed
delete attempts as well as successful sweep deletions. Owner/unknown-owner/age protections remain.
Disk-backed tests inspect actual temporary bytes and cache contents; upload tasks are test sinks.
Length equality does not prove native offset/content correctness or transfer during suspension.

`travel-buddy-standalone/src/services/media/videoCompression.ts` preserves OFF/absent/failed
fallback and accepts only distinct syntactically local output with safe positive integral
metadata and the 1920px bound; known-size output must be smaller. Unknown input size retains
its prior behavior and is not proof of size reduction. No encoder, native service or compiled
main-app binary is supplied. Real codec/bitrate/rotation/duration/metadata, output identity,
rejected-output cleanup, device upload and process-loss evidence remain mandatory.

### Provider boundaries and moderation generation

The six existing vendor modules reject malformed envelopes/acknowledgments/payloads, isolate
requested IDs and similarity seeds from adapter mutation, require declared private-playback
capability/protocol for transcoding, reject malformed/unrepresentable WebVTT and report thrown
caption writes honestly. Valid empty/negative answers remain distinct from refusal. Caption
retry preserves existing stored bytes; it is not exactly-once transcription or successful
lost-ack reconciliation. Adapter timeout is not cancellation. Registries remain empty.

The provider patch's reproduced stale/retried approval defect required a separate parent repair
in `artifacts/api-server/src/services/media/MediaModerationService.ts`.
Automation now claims a hold against the original asset ID **and source version**, then applies
a verdict only to that exact held ID/version/state. A human rehold increments version; rejected,
removed or deleted rows cannot be reclaimed by automation. Lost automated CAS is a conflict,
not authority to reread and rebase. Deliberate human reversal retains its separate authority.

The first lease repair was **not sufficient**: independent review reproduced a duplicate job
claiming a new lease after human rehold. The latest source-generation follow-up is present in
this combined tree. **Final independent review accepts the generation fix and the subsequent
test-only HTTP correction**, closing both reported findings. This acceptance is read from the
final MEDIA-MODERATION-REVIEW.md, not inherited from the earlier 68-pass review. Four permanent
HTTP cases verify original version 41, missing generation, pre-consumption human rehold and
human rehold plus duplicate ingestion. The same file retains exact payload keys and asserts
no separate duration update. Its 27 tests pass independently; traffic is local/fake, not a DB/provider.

The upload route now calls `recordMediaAssetDetailed` for the same original canonical write,
passes its returned `assetVersion` to ingestion as `sourceVersion`, and puts only server-probed
duration in that initial payload. Valid duration is a positive safe integer no greater than
2147483647 (the DB integer bound). There is no intervening duration-only version bump before
claim. No schema change, guessed camera/library attribution, or new source entitlement:
`MEDIA_SOURCE_UNDECLARED` and the exact-caller inventory remain authoritative.
A missing/degraded generation does not authorize automation.

This does not select a classifier or staff review, prove a durable hold when a write fails,
repair capability-style flag-read policy, remove the known degraded-schema moderation fallback,
or bring migration-era foreign HTTPS references inside D82's app-storage gate.
Those limitations remain explicit; no universal distribution-safety claim follows.

## Every unchanged non-C grade

| Existing IDs | Grade unchanged | Why this batch cannot close the requirement |
| --- | --- | --- |
| MD1, MD2, MD3, MD29, MD427, MD286, MD419, MD446 | W (8) | State/restore defects fixed; actual reachable World/default and device proof still required. Full-screen remains a permitted non-default choice. |
| MD87, MD408, MD412, MD424 | W (4) | Context-first overlay implementation exists; owner visual/action hierarchy and real reach remain unverified. |
| MD11, MD215, MD435 | W (3) | Existing stage-24 path is not newly implemented or certified here; actual served order/outcomes and applicable World/overlay reach still needed. Separate stage-24 work excluded. |
| MD425, MD402 | W (2) | Mounted policy/restore defects fixed, but actual-device playback and reach are not proved; MD402 also retains ranking/outcome conditions. |
| MD162 | W (1) | Empty World no longer hides qualified flow, but consented above-floor producer inputs, reachable consumer and real device/served-path witness are missing. |
| MD53, MD58, MD65, MD66, MD370, MD445 | W (6) | D25 own-photo crowd.level design is constrained but unbuilt: approved photo-naming disclosure first; separate revocable consent, random-key reencoded copy, token erasure/account deletion, <=180 days, no public photo-backed hint or pre-moderation confidence lift. |
| MD269, MD283 | W (2) | Canonical automation hardening and final review are code proof only; approved classifier or actually staffed whole-video review, durable hold/schema and real nondistribution proof remain. |
| MD289 | W (1) | Real vision provider absent; busy/social confidence >=0.6 still requires owner ratification/replacement. |
| MD284 | W (1) | JS staging/cleanup is not an Android foreground service or iOS suspension/relaunch witness. |
| MD385 | W (1) | Own-media Memory conversion not integrated: source attachment schema/linkage, ownership, action/attribution and withdrawal/narrowing semantics remain. D26j already approves own-source scope; parent implementation coordination is not a new owner-consent hold. |
| MD403 | W (1) | Two structural failures repaired; owner/device accessibility acceptance remains. |
| MD63 | N | No approved real image-understanding/extraction provider, consented data flow or measured inference quality (D27a). |
| MD277 | N | No funded real transcoder/jobs, authorized private manifests AND segments, playback consumer or observed adaptive switch (D27b). |
| MD280 | N | ASR versus authored captions unresolved; real source, private serving/erasure and timed cue renderer missing (D28); separate audio-export consent/terms apply. |
| MD282 | N | No native encoder implementation/build/real output evidence; future encoder work excluded. |
| MD293 | N | No real approved embedding/index, ID mapping or deletion/retention lifecycle (D27c). |
| No IDs | X (0) | Zero canonical X does not mean no unverified runtime behavior. |

All 415 C grades also remain unchanged, not blanket-recertified. In particular MD37's unknown
source is preserved; MD163's flow privacy limits remain; canonical lifecycle/attachment C
claims still depend on schema, reader/writer gates and actual state; render/contrast C claims
are not device pixels. The complete external `MEDIA-BOARD.json` is the original 450-ID census
inventory, not a newly refreshed runtime certificate. Its former MD403 defects are corrected
only to the local extent recorded here; its Memory/native/provider and other C proof gates remain.

Historical PR dependency snapshots (#745 EXIF, #758 likers, #747 place merges, #740 delivery,
#748 avatars) in that board are not newly integrated by this batch. Preserve OQ-PRIV2-1,
OQ-POSTLIKERS-1, Q-PML-4, Q-TM2-1/Q-TM2-2 and Q-AV-2; neither provider test fixtures nor this
metadata pass resolve those independent privacy/owner holds.

## Evidence provenance — do not add overlapping counts

Reports/logs below are retained externally in `/Users/areyouok/portava-sandbox/codex-corrections-20261015/`.
Each is evidence for its stated snapshot and boundary; names alone do not prove the latest tree.

| Evidence source | Actual reported result | Qualification |
| --- | --- | --- |
| Acceptance report | New test 2 fail / 2 pass before source fixes; separate 37 contrast/contribution +46 privacy parity/lifetime +114 post visibility pass | Original baseline, not current accessibility failure or current full-app result |
| Accessibility integration log `MEDIA-surfaces-review-accessibility.log` | 13 pass across acceptance/contribution/neighborhood/vantage suites | Includes the four acceptance cases; not four additional tests to add again |
| Surfaces author | 10 new red failures among 16 additions; final 72 component +4 web +50 pure passes | Local mounted/pure evidence; overlaps independent review |
| `MEDIA-surfaces-REVIEW.md` | Independently 58 component +50 pure pass; production mobile typecheck | Subset/repeat of author evidence, not another 108 unique behaviors |
| Playback author / review | Author 56 distinct focused passes; independent 27 pass, baseline 11 fail/1 pass, extra run 16 pass (12 original +4 probes) | Review has 31 distinct green cases, not 43; shares suites with surfaces/acceptance |
| Native author / independent review in `MEDIA-native-RESULT.md` | 28 red failures/60 controls; 96 Node +24 mounted pass, independently repeated | Same 120 cases, not 240; native adapters substituted; mounted teardown warning disclosed |
| Provider author / `MEDIA-PROVIDER-REVIEW.md` | 19 new red failures; stronger hold mutation 4 failures; author 256 pass, independent 58-pass subset | Before parent's generation follow-up; no real provider or DB |
| Initial moderation lease review | 68 pass but duplicate-after-human-rehold probe still failed its safety claim | Not acceptance of complete retry authority; latest generation follow-up requires fresh review |
| Final moderation generation/HTTP re-review | Generation regressions 3 red / 9 controls before fix; 12/12 after; 85 seam/inventory pass; final upload-route 27/27 pass | Final ACCEPT closes both findings; 85 includes the 12. Four HTTP cases exercise actual loopback upload route with versioned in-memory clients, not real DB/provider |
| Parent integration handoff, latest source-generation snapshot | **304 API tests in 8 files pass; API and mobile full production typechecks pass** | Parent-reported, not independently rerun by this metadata worker; production configs do not typecheck all tests |
| Parent final HTTP increment | **27/27 pass; 331 distinct API tests across the 8-file run plus this separate file** | /tmp/codex-media-upload-route.log; independent final review repeats the same 27, not 27 additional behaviors |
| Parent disjoint canonical/processing increment | **148/148 pass across four foundation/layers/store/worker files; 479 distinct focused API cases total (304+27+148)** | /tmp/codex-media-adjacent-regressions.log; do not add overlapping provider/reviewer runs again |
| Parent full test-typecheck ratchets | API: **862 diagnostics / 115 files**, baseline exactly matched; mobile: **173 / 60**, baseline exactly matched | Both PASS, zero increase and zero stale baseline; not zero-diagnostic test programs. /tmp/codex-media-api-test-ratchet.log and /tmp/codex-media-mobile-test-ratchet.log; no baseline/config changed |
| Earlier parent subsets | 266 API focused, 53 native boundary subset, 12 playback integration pass | Not added to 304 or full worker logs; not a fresh run after every subsequent source change |

No grand test total or “100%” inference is valid across these overlapping runs. This metadata
lane runs citation/freshness/integrity and their targeted metadata tests, not product, DB,
device or provider suites. The earlier custom focused typecheck harness omitted ambient
declarations and is superseded by the unchanged full ratchets above, not treated as a
production error or clean focused pass. Final metadata results follow below.

## Bookkeeping discipline

Census §52 records these corrections without changing grades or measurement base declarations.
Displaced citations are repaired against this combined tree, including removed call/state anchors;
historical claims remain historical. The new mode-restore test is added explicitly to Media's
freshness scope because its path lies outside the existing media directories.

Acknowledgment reasons are extended with a narrow dated suffix, including paths already named
when this batch corrects a new defect. Existing reason prefixes, old path order, since values
and retired entries must survive. Shared mediaAssets/posts changes receive specific companion
arguments for affected censuses, not a blanket “unrelated” waiver. No checker logic, floor,
ceiling, test exclusion or product/test/package source is owned by this metadata lane.
