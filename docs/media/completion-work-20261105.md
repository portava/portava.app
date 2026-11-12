# Media completion work — November 5, 2026

This is a local engineering record, not a deployment or device certification. Production writes and feature activation have not been performed. Telegraph remained in scope alongside Media; root integration and final verification are complete as recorded below and in the Telegraph completion report. No census rows have been promoted from this record alone.

## Post sharing into Memories and Highlights

The share sheet now has a real destination panel (parent-owned orchestration) rather than a placeholder destination. It can select a paginated list of the owner's canonical Memory albums, create a named album, and publish a 24-hour Highlight. New Memories default to Only me. Highlight audience is explicitly displayed and selectable. Adding to an existing Memory does not alter that Memory's audience. A note is the sharer's text, not a snapshot of the source.

Migration `4007_post_reference_destinations.sql` creates service-only provenance and durable operation receipts. The stored item has explicit MIME `application/vnd.portava.post-reference+json` and opaque URI `portava-post-reference:<reference UUID>`. An ordinary image URL is never reinterpreted as a reference. Deferred database guards require matching provenance. Canonical Memory/Highlight command functions write the destination, events, outbox and receipts in the same transaction. Retry is exact by owner/operation/intent; an uncertain retry cannot recreate a subsequently deleted destination. The migration is **not applied**.

`GET /post-references/:id` first checks current destination ownership, audience, lifecycle, block state and Memory item privacy. It then reads current source state, public/published eligibility for other viewers, sharing/reposting restrictions, blocks, and canonical account restrictions. Real names are not substituted for a missing public handle. An inaccessible source is an unavailable card, not a broken image or a media copy. Archived Memories remain owner-addressable under the existing Memory policy; archived/expired Highlights remain unavailable under the existing Highlight policy until restored. No source body or media URL is retained in provenance, events or the operation receipt.

Memory item, album cover, profile album, trip Memory, Highlight viewer, ring and archived-cover paths recognize the explicit reference type. The Highlight reference viewer does not auto-advance before its card can be read; it has explicit Previous/Next controls and dismisses before opening the source. The main Passport Memories area now includes canonical albums, refreshed from the authoritative owner list on focus. Legacy travel memories remain alongside it. The existing own-post media-copy entry remains in the own post's overflow menu.

While auditing these paths, another bug was corrected: a video in someone else's shared Memory now uses the shared video player. Previously the non-owner branch sent the video URL to an image component. The owner's video-segment editor remains owner-only.

Verification completed in this batch:

- 11 mandatory real PostgreSQL tests with the actual 3911 Memory and 3677 Highlight kernels: canonical events/outbox, rollback, concurrency, retry identity, no resurrection, source restrictions, account restrictions, terminal/foreign destinations and client-role/provenance defenses. Registered in CI as `test:post-destinations-native` with an exact executed-test count and no skips.
- 14 current-source/destination authorization tests, including source withdrawal, item privacy, account restrictions, private ownership exception, and archive/expiry behavior.
- Client service, destination panel, reference card, owner album and media-kind tests; affected Highlight/Memory/cover regressions.
- API and client source types checked; API test registration and native mock lint checked. Test type diagnostics are checked separately against the repository's existing baseline.

Release prerequisites: apply the reviewed migration before the server/client change, deploy the server and compatible client, and verify iOS/Android sheet dismissal plus saved destination visibility on real devices. This record does not claim those checks occurred.

## Current place moderation and official publication

Media public eligibility (Watch, Grid, single items and the World/search families), protected projections, current place/live enrichment and near-place positioning now use the fresh canonical-place moderation guard. A withheld or missing canonical place suppresses its public media candidates; an unreadable policy is a retryable refusal. Owner-only historical libraries retain their existing content. Telegraph place/map-pin/meetup-point capabilities recheck even a previously loaded card, and live-reference delivery withholds its stored subject/prose after withdrawal. This batch passed 356 affected API tests, including withdrawal, merge ancestors, unreadable policy and cached cards. It requires Trust's reviewed migration4009 before release.

Migration4010 adds a service-only official-post command that atomically writes the post, `post_media`, canonical `media_attachments` and an admin delegation receipt. It checks the admin role and current account restriction inside the transaction, resolves the official account itself, requires actual registered ready storage uploads owned by that admin, and preserves media moderation and original ownership. The original owner can still withdraw that media, which affects the official publication too. No media is copied or transferred. Retry identity is exact and retained after post deletion; an old request cannot resurrect a deleted post. Manually entered coordinates are no longer labeled verified. Storage URLs cannot be inserted through the external-reference edit path.

The official editor now picks and uploads photos/videos, labels external links separately, preserves a command ID after uncertain results, and discards pending picker/upload/submit answers after account replacement or unmount. Admin lists display canonical media counts. The default scheduling input now represents local time consistently with its parser. Verification: 12 real PostgreSQL tests, registered in the mandatory no-skip CI gate `test:official-media-native`; 14 client service/editor/upload regressions; affected existing publisher and storage tests; API and client source types. Migration4010 remains local and unapplied.

## Earlier Media integration queue (resolved below)

- The Android compressor is now implemented and compiled with the real Expo bridge in an isolated SDK36/JDK21 project. Android autolinking finds it; five JVM policy tests and three Android36 emulator codec tests pass. Actual decoded picture orientation/pixels, 440Hz audio energy/frequency, GPS removal, whole-file bitrate ceilings, silent input, source hashes and cancellation cleanup are checked. A previously ignored prototype was consolidated into this implementation (its earlier source is preserved in the temporary toolchain). Foreground upload execution is now implemented; see the Android foreground/background upload section below. The iOS core and Android compressor keep the existing JavaScript switch OFF pending integrated native/device acceptance.
- Caption and player recovery repairs are recorded below. Remaining entry/lifecycle paths and on-device accessibility still need review.
- Adaptive derivatives, ASR/translation/vision/model worker integrations have existing adapters and disabled production switches. Verify current code and independent local behavior before identifying concrete hosting, model/provider, privacy or device prerequisites. Do not turn on financial features or model processing in production.
- Trust owns canonical media moderation access/derivative denial and canonical-place governance migration4009. Media/Telegraph integration is implemented and tested as recorded above; deployment remains a separate prerequisite.


## Root integration: player lifetime and caption recovery

At this historical handoff the delegated agent reached its usage limit. Root preserved its changes and completed the integration and checks recorded in the following sections.

Shared video playback now retires native callbacks with the actual playback source generation, including signed-URL refresh, fallback and an A-to-B-to-A replacement. Account/source replacement creates a fresh player session. Old ready/error/end callbacks and failed mute commands cannot change a replacement video. A rejected native mute command restores the prior button state and exposes a retryable sound error.

Caption resolution and track/draft reads now have a visible Retry action. Retry resolves current access and source generation before reading the track, preserves the user's CC or draft-review intent, and rejects stale account responses. Editors and ASR actions abort outstanding transport when dismissed or replaced; no late receipt updates the retired UI. ASR/translation/caption and dubbing requests are bound to the observed account and login session, including logout/login back to the same account. Refresh cannot dispatch a prior intent using a replacement token. Dubbing's 15-second deadline now covers token acquisition, headers and body decoding, including transports that ignore cancellation. Caption and translation retain their existing full-response 10-second deadlines.

Verification: 238 checks across 19 Media/player/caption/translation/dubbing suites passed. Client source typecheck passed. Client test diagnostics remain at the existing 151/58 baseline, without raising it. These are local checks, not native codec, device accessibility, upload or deployment certification. Model-processing and earnings switches remain unchanged.

## Server worker and place-consumer integration

143 independent local worker/adapter checks passed after rerunning the two sandbox-constrained cases with local HTTP/subprocess access. This includes two real FFmpeg encoding/decoding tests with synthetic audio/video and silent inputs, plus adaptive access/revocation, ASR orchestration, subtitle translation and dubbing runtime contracts. This does not certify an ASR/vision model, production hosting or physical-device adaptive switching. Model-processing switches remain unchanged.

The public place guard now covers Pulse place cards, tag suggestions, hashtag places, nearby Trip suggestions and Trip admission. Canonical places no longer need a duplicate community listing to be added to a Trip. Cached Saved and Memory map pins recheck community/provider aliases as well as canonical IDs. 128 affected integration tests passed, and API source/test type checks remain clean relative to the existing baseline.

## Android compressor runtime verification

The approved SDK setup is isolated in `/tmp/portava-android-toolchain`. All source/build/media copies used for validation remain outside shared dependencies. The first real-codec run caught Media3 fast-start padding inflating short MP4s beyond the requested whole-file bitrate ceiling. The local upload-copy muxer now omits that reservation; the ceiling checks were retained. A fresh harness run passed five JVM policy tests and three actual Android codec instrumentation tests with no skips. Evidence and source hashes: `/tmp/portava-android-toolchain/codec-proof-3/evidence.json`. The final bridge compiled against the installed Expo54/ExpoModulesCore3.0.30 and Android36 SDK (`/tmp/portava-android-compile-final.log`). This is emulator/core and bridge evidence, not physical-device upload/playback acceptance. Compression stays OFF; foreground upload execution is now implemented and verified separately below.

## Media action lifetime and saved interest

Media-action reads, experience plans, interest mutations and event links now capture the observed account/session before SDK loading or token refresh. They reject replacement sessions and redirects, accept cancellation, and bound the complete request (including token and JSON) to ten seconds. The action hook retires reads/writes on item changes, dismissal, unmount and auth changes, blocks duplicate taps synchronously and shows a retryable mutation error. The list now has an actual Retry button. The server returns persisted interest, and the hook restores it without letting an older read overwrite a newer toggle.

Twenty new client lifecycle/transport checks pass. Broader owner-session integration exposed stale outbox fixtures from the delegated Telegraph changes: device storage now resets between cases, and expected retry/idempotency metadata matches the durable-send contract; all 93 owner-session checks pass. Sixty-three Media/Compass resolver and intent checks pass after extending the old query fixture to represent real exact counts, limits and canonical place moderation, including current-viewer intent HTTP checks. Full integrated device acceptance remains open.

## Saved collections and Media integration follow-up

Collections requests now bind to the observed initiating owner/session before refresh. A single ten-second deadline covers token acquisition, headers and JSON, including both stages of post saving. Redirects and non-HTTPS API origins are refused. Failed saved-status reads remain unknown, and malformed collection pages cannot become an empty collection or a repeating pagination cursor. The picker checks current ownership between collection creation and saving, and drops pending private state on account/session replacement.

The Saved screen remounts its private views on account/session/privacy-scope changes. Creation and renaming preserve retryable errors and lock duplicate submits, while deletion removes a row only after success. Suggested names prefill the creation form. Forms use keyboard avoidance. Open collection and saved-post lists refresh after organizing, reject superseded pages and deduplicate overlaps. Saved Memories open their existing detail route. Saved Highlights and Hidden Gem collection integration were completed in the follow-up sections below.

Watch bookmarks, full-screen post-media bookmarks and the action rail now open the shared collection picker. The rail embeds its contents in the existing native modal. A confirmed save, removal or status read updates the viewer's bookmark state; old feed seeds and failed old toggles cannot overwrite it. Media save state rejects retired account/session callbacks. Eight Media interaction methods (save/unsave/share/report/visibility/delete/hide/analytics) use the same bounded, owner-bound transport as action requests. Reports show failure and remain retryable. Rail state resets on item/session replacement and dismissal; pending plan/report reads are cancelled and stale callbacks cannot navigate or close a replacement item.

Verification: 141 checks passed together across 17 mounted/service suites in `/tmp/portava-saved-media-acceptance.log`, followed by a 34-check targeted rerun including one added malformed-page test (142 distinct checks). Source typecheck passes; test diagnostics remain at 151 across 58 files without a baseline increase. Mock and keyboard-wrapper lint pass. The two pure Media action suites also pass all 48 checks; the final eight-check mounted rail rerun passes. This does not certify physical-device sheet/keyboard behavior. Direction/route and panel executor lifecycle review was completed in the root integration section below. Foreground uploads, remaining sharing paths, source-copy policies and integrated device acceptance remain open. No production configuration, migrations or earnings switches were changed.

## Saved Highlight detail

Saved Highlights now have an authenticated `/highlights/[id]` opening route backed by `GET /api/highlights/:id`. The read authorizes the full row through the existing Highlight gate, rather than authorizing one snapshot and fetching another payload. It enforces current lifecycle, audience, blocks, share consent, keep-private controls and canonical author account restrictions, applies selected location precision and real-name privacy, and returns exact engagement counts. A saved ID grants no read permission. Read failures remain retryable instead of being rendered as a missing Highlight.

The owner/session-bound client uses the shared ten-second transport and existing hydrated Highlight viewer, preserving video and explicit post-reference handling. Route/account/session replacement, blur, background and expiry retire the viewer or pending response; foreground/focus refresh rechecks access. Storage byte authorization remains in the existing hydration/relay path. The new read does not write view events; those remain the existing viewer's explicit-open behavior.

Verification: 203 API checks across detail, collection-preview privacy and Telegraph sharing; 49 client checks across detail/service lifecycle, Highlight engagement/archive/pin, reference cards and hydration. API/client source typechecks, mock lint and runner-flag check pass. Test-type checks introduce no errors in this lane; concurrent Android and Gem lane diagnostics were reported to their owners. No migration or production action was required for this detail route.

## Gem collections (2026-11-05)

Gem bookmarks now use the same private collection chooser on Gems feed and gem detail: existing collections, new collections, multiple filings and explicit unsave. Saved has a paginated gem entry, including old bookmarks; unreadable/deleted/private/moderated sources retain only an unavailable reference. The owner-bound transport and scope remount prevent previous-account responses from reappearing. The media item ID and gem entity ID remain distinct when syncing bookmark state.

Migrations4011–4012 add the enum value, import existing hidden_gem_saves idempotently and transactionally bridge legacy saves with collection membership. A single bookmark can appear in several collections; removing one filing keeps it, and an unsave clears every filing. Counts are maintained in the same database transaction, so application code no longer increments or overwrites them separately. Owner-only RLS remains; internal privileged trigger functions are not callable by clients. These migrations must precede the updated API on release. They have not been applied to production.

Verification: the focused API/SQL/regression run passed135 tests, including real SQL replay, RLS, exact count and rollback assertions; the new mounted list/chooser and owner-bound transport run passed28 tests, and existing gem UI checks passed4. Additional pagination regression and final source/test-typecheck checks are recorded in the completion report. No production data, settings or earnings switches changed.

## Android foreground/background upload execution

Added the local `portava-background-upload` Expo module and connected it to the durable postcard queue. Its non-exported Android dataSync foreground service streams signed Storage PUTs with progress and Cancel, three bounded native workers, exact HTTPS Storage-origin/path validation, no redirects, private-file checks, and finite request deadlines. Staging rejects oversized parts/batches before base64 materialization. Cancellation releases queued and active work; notification Cancel records bounded opaque job receipts so a later JS/process lifetime does not restart cancelled work. Native module destruction cancels its captured engine even when the React context has disappeared. Signed URLs and bytes are not journaled by the native module.

Each queued job captures its initiating account/session before async work, including shell creation, slot reservation, completion and cleanup. Account/session replacement aborts transfers and pauses recovery without issuing new-account writes. Explicit cancel interrupts in-flight work; cleanup remains bound to the original session. Jobs appended while another job runs now drain automatically. Android process death still interrupts requests: the persisted JS queue reconciles missing server parts on foreground relaunch. The service is START_NOT_STICKY and has no boot restart. iOS retains its existing background URLSession path.

Verification: 97 pure queue/transport/staging/lifetime checks, six owner-bound HTTP/cancellation/deadline checks, four JVM native policy tests and five Android 36 emulator instrumentation tests passed. The Android fixture used a throttled 16 MiB synthetic HTTPS transfer, proved bytes continued after Home, verified its foreground notification and exact received bytes, and tested account replacement, notification Cancel receipts, redirects and bounded pending work. Final source hashes/results: `/tmp/portava-android-toolchain/upload-proof-4/evidence.json`. Final Expo bridge compile: `/tmp/portava-android-upload-expo-final.log` (Expo54, Modules Core3.0.30, Android36). Client source types pass; test types remain at the existing 151 diagnostics/58-file baseline. Mock/import guards and changed-file whitespace checks pass.

The resumable upload flag remains OFF. These are core emulator, bridge compilation and JS contract checks; the integrated installed app still needs upload/background/kill-and-resume acceptance on actual devices and the normal release decision. No production operation, flag activation or native app deployment occurred. Source, fixture runner and exact reproduction commands are in `travel-buddy-standalone/modules/portava-background-upload/README.md`.

## Full-screen media and downstream action integration

The shared video player now opens a full-screen native modal with contain-fit video, seek progress, close/back and the existing playback, audio and caption controls. Moving between inline and full-screen preserves position and playback intent while mounting one native decoder. Retired callbacks cannot update the replacement player; the initial seek status is cleared after loading so mute/play changes cannot seek backward. Close does not wait indefinitely for a native pause. Background/account/source changes retire playback intent and private view state.

`FullscreenPhoto` opens the full original image with gallery navigation, pinch/double-tap/button zoom and panning. Gesture movement uses animated transforms rather than rerendering the image each move. Posts, postcards, Memory photos, Wall images and message photos use it. Pulse has an explicit expand action; the dedicated media viewer contains the whole image/video instead of cropping it. Specialized surfaces and Memory video integration are recorded by their owning lane.

Trip, invitation, event-link, directions and save-route operations now use a bounded transport that captures the observed account/session before any await and rejects cancellation, redirects and retired ownership at every boundary. Dismissal and account/item changes abort pending work. Duplicate writes are locked; partially applied trip plans expose an Open trip review action and cannot silently replay accepted steps. Malformed plan receipts remain failures. A full ten-second budget covers route coordinate resolution and creation.

Verification:164 checks passed together across20 player/caller/action/Saved suites; the final photo/panel rerun passed15 and final video suite14. The two pure Media action suites pass50 checks. Source typecheck, mock/keyboard/import guards and changed-file whitespace checks passed. Test diagnostics initially remained151/58; concurrent lane baseline reconciliation is tracked separately. Android JavaScript export succeeded at `/tmp/portava-native-ui-export-20261105`. These results do not certify a deployed client, physical-device playback or final native build.


## Specialized content media and Memory video completion

The remaining content-media inventory was checked against the actual rendering paths. Event community uploads, place-day posts, Shared Moment pending/approved media, Telegraph GIFs/albums, and legacy Memory photos now open full originals or play their actual video sources through `ContentMedia`, `FullscreenPhoto` and `SharedVideoPlayer`. Album expansion reveals every item after the first four. Thumbnail-only data remains a preview and cannot masquerade as an original. Existing post/detail navigation and author overlays remain intact. Living place timeline and Best Of tiles open their canonical post IDs; deduplicated community samples carry separately authorized originals and thumbnails.

Owner Memory video uses a specialized modal, preserving its stronger source-version, segment-range and short playback-lease rules. It retires the departing decoder before mounting the replacement, reauthorizes the exact source before resuming, restores the current segment/position/paused intent, and fences retired callbacks. Background, blur, account replacement, expiry and withdrawal retire playback. Closing remains possible during authorization or a stalled native unload. Inline and fullscreen video child dimensions are explicit for Expo AV Web.

Finite surface inventory:

| Surface | Full-original behavior |
| --- | --- |
| Posts/postcards, Wall, message photos, Memory items, Pulse | Root-integrated `FullscreenPhoto`/shared player or explicit media-viewer entry. |
| Event community, place day, Shared Moments, Telegraph GIF/album, legacy Memory photo | This lane integrated `ContentMedia` or the existing original-aware photo viewer. |
| Living destination timeline/Best Of/dedup | Canonical post detail navigation or authorized original gallery; no array-index or raw media-ID URL fallback. |
| Owner Memory video segments | Specialized one-player modal with renewed source authorization and preserved segment bounds. |
| Promotion/Trip/legacy Memory/Telegraph compact video | Existing shared-player callers inherit its fullscreen implementation. |
| Saved Highlights | Authenticated Highlight detail route opens the existing full-screen Highlight viewer. |
| Roam/Stories/Highlight viewer | Already full-screen content surfaces; existing playback/lifecycle behavior retained. |
| Profile/Postcards/Trip post tiles | Retain navigation to the full-screen-capable detail surface. |
| Avatars, stamp artwork, canonical provider covers, composer/edit previews | Decorative, cover, or editing surfaces; they were not converted into content-gallery actions. |

Verification: 98 checks across eight mounted suites passed together (`/tmp/content-media-all-final.log`), including 36 specialized Memory-video checks. The explicit Web child-size follow-up passed the same 36 Memory checks (`/tmp/memory-fullscreen-web-sizing.log`). The suites cover open/close, source selection, multi-item expansion, navigation, one-player transfer, paused intent, stale callbacks, account/background retirement, revoked source and stalled operations. Source typechecks, import/mock guards and existing test-type baseline are checked separately in the integration evidence.

Fullscreen means the full available viewport. Current app configuration is portrait-locked; modal orientation declarations do not establish physical-device landscape behavior. Browser resize evidence is recorded separately and must not be described as native rotation acceptance.


## Browser fullscreen review

A local harness mounted the actual `FullscreenPhoto` and `SharedVideoPlayer` with React Native Web and actual Expo AV Web, using local original-image fixtures and a browser-recorded synthetic video. Only authentication, private-URL hydration and optional caption/dubbing boundaries were stubbed. Expo AV was compiled with the application's Babel preset; an early raw-esbuild run incorrectly retained uninitialized mixin fields, and that harness-only error was corrected before evaluating playback behavior.

The review found and root corrected two actual Web defects: the inner video needed explicit width/height to stay inside its viewport, and Expo AV Web does not honor the initial `status.positionMillis` property, requiring a guarded explicit seek after load. After those changes, paused seeking retained 1.039919 seconds across close and reopen; playing transfers retained approximately 1.1 and 1.4 seconds with normal playback-status sampling. Only one video element remained mounted. Play/pause, seek, mute/unmute, close, gallery boundaries and zoom reset on image change worked with zero console errors.

Visual inspection confirmed full image/video frames at 440×956, 956×440 and 1280×800. Evidence: `/tmp/portava-fullscreen-browser/photo-phone.png`, `photo-portrait-phone.png`, `photo-desktop-final.png`, `video-phone-final.png`, `video-landscape-final.png` and `video-desktop-final.png`. The reproducible local harness is `/tmp/portava-fullscreen-browser/build.cjs`. These are browser viewport checks, not an installed-app or physical-device orientation claim. No dependency installation or shared node_modules mutation was needed.

Final client source check is clean (`/tmp/content-media-final-source-types.log`), and import/mock guards pass. Client test types improved to 150 diagnostics/57 files; the old 151/58 baseline is stale solely because the existing composer-upload diagnostic was fixed by root. The root combined pass must record that earned reduction rather than increase the ceiling.


## Final navigation lifetime and screenshot follow-up

`useMediaSurfaceActivity` uses an optional NavigationContext plus application foreground state. A covered screen can remain mounted, but its fullscreen photo closes and its video decoder is paused and removed. Retirement happens synchronously before a pending native command settles; an epoch also rejects late callbacks after a blur/refocus pair batched into one render. Refocus restores an inline paused video, without reopening private fullscreen content. Standalone and embedded previews continue to work without a navigator. Five new mounted cases cover initial blur, photo dismissal, retired native callbacks, pending fullscreen entry and background/foreground cleanup. The six photo/video suites pass 57 checks, including the existing Web restore and private-source races.

The six-item floating navigation now gives each label a bounded slot and removes the redundant horizontal padding that clipped Discovery. At 320px ordinary text all six full labels fit; larger text gets an adequate line/pill height and deliberate ellipsis while the full accessible name remains. Tab targets have a minimum 44pt height. `useBottomInset`, `NavBarFiller` and the active Layover pill offset use the same added height, so scaled labels do not cover the end of the feed.

A shared path normalizer now selects mobile/desktop tabs from Expo's actual ungrouped pathname, with grouped-path compatibility. Pulse matches only the root; nested Passport paths match Passport, and `passportx` does not. The swipe current-tab lookup uses that same matcher, preserves existing destinations and boundaries, and retains Roam's gesture ownership. The adjacent-tab Discovery prefetch also now recognizes the real `/` and `/trips` paths; the earlier grouped-only comparison silently missed those warmups.

Verification: 183 combined mounted checks across 17 suites passed (`/tmp/media-navigation-tabs-final.log`), then 26 focused tab/selection/swipe/prefetch checks passed (`/tmp/tab-selection-swipe-final.log`), including 13 added checks after the combined run. Browser review of the extracted, unchanged FloatingTabBar markup/style at 320px and 440px confirms readable normal-size labels and selected Passport styling. A native-style 2× text-scaling fixture confirms 26px label lines inside a 77px pill without vertical text clipping; this is a browser simulation, not physical-device text-size certification. Evidence: `/tmp/portava-fullscreen-browser/tabs-320-passport.png`, `tabs-440-passport.png`, `tabs-320-large-final.png`; reproduction harness `build-tabs.cjs`. The standalone photo/video browser flow was repeated after the navigation guard and retained a paused 1.038686-second seek on close with one decoder and zero console errors.

## Hosted4000 Memory guard compatibility

A second read-only catalog inspection on November5 captured the hosted `memory_items_source_post_guard` function and trigger. The exact observed definition is now a test-only snapshot at `src/test/fixtures/hosted4000MemorySourceGuard.sql`; it is not a reconstructed migration or a claim about4000's original checksum. The existing canonical destination fixture now installs that guard before4007. All13 mandatory PostgreSQL tests pass, including new proof that post references retain NULL source_post_id, another author's byte-copy remains refused, the owner's registered ready media remains admissible, and rejected legacy media cannot be newly copied. The mandatory runner expects13 executions without skips. Log: `/tmp/portava-postdest-hosted4000.log`. No production data, schema or flag was changed.


## Final integration disposition

The earlier queue above is superseded by the completed upload/compressor, caption/player recovery, sharing/collections, source-policy, fullscreen and navigation work in this record. Full Android and iOS builds plus installed-app native encryption checks now pass; see `../telegraph/native-validation-20261105/evidence.json`. These native checks certify the exercised Hermes/Expo/JSI paths, not every media screen or a signed release on a physical phone. The final source typecheck is clean; the client test-type baseline is reduced to144 diagnostics across54 files without new allowances.

Optional model processing, hosted derivatives and native feature switches stay OFF until configured and accepted through release. The retained-source Memory policy decision remains owner-controlled. Physical-phone share sheets, long-running background behavior, accessibility and observed performance remain release checks. All local changes and migrations remain unapplied to production. Earnings remain OFF.
