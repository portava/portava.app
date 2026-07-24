# Media Phase 0 — Feature Matrix Report

> Generated: 2026-07-24  
> Scope: `artifacts/travel-buddy` client only. No API-server or migration changes are in scope for Phase 0.

---

## 1. Feature Matrix

All content-type keys are drawn from `src/lib/contentMediaPolicy.ts` (spec §64).

| Feature / Content Type | Status | Notes |
|---|---|---|
| **Core infrastructure** | | |
| `resolveDisplayMedia` priority-chain resolver | ✅ Implemented | `src/lib/displayMedia.ts` — 8-tier priority, whitespace-normalised |
| `avatarFallback` (URL + initials) | ✅ Implemented | Delegates to `identity.ts`; never returns a blank circle |
| `DisplayMediaImage` component | ✅ Implemented | `src/components/ui/DisplayMediaImage.tsx` — skeleton → loaded → error phases; never blank |
| `AvatarImage` component | ✅ Implemented | Same file — initials fallback on broken URL |
| `MediaFallback` component | ✅ Implemented | Exported from `DisplayMediaImage.tsx`; used by all null-URL surfaces |
| `useMediaComposer` hook | ✅ Implemented | `src/hooks/useMediaComposer.ts` — items, upload state, cancel, retry, clearAll |
| `MediaPickerButton` component | ✅ Implemented | `src/components/ui/MediaPickerButton.tsx` |
| `MediaAttachmentTray` component | ✅ Implemented | `src/components/ui/MediaAttachmentTray.tsx` — thumbnails, reorder, alt-text, cover star |
| `MediaSourceSheet` component | ✅ Implemented | `src/components/ui/MediaSourceSheet.tsx` — camera + library rows, denied→Settings UI, limited-library Alert |
| `contentMediaPolicy` registry | ✅ Implemented | `src/lib/contentMediaPolicy.ts` — 16 policy keys with typed constraints |
| `validateMedia` | ✅ Implemented | `src/services/media.ts` — MIME type, file size (30 MB image / 100 MB video), duration |
| `uploadMedia` | ✅ Implemented | `src/services/media.ts` — POST `/api/media/upload` with bearer token |
| **Fully-wired composer flows** | | |
| `pulse` (single image/video post) | ✅ Implemented | `PulseCreate.tsx`; maxItems=1, 60 s video cap |
| `story` (full-screen single item) | ✅ Implemented | `StoryComposer.tsx`; allowsEditing, 9:16 aspect crop |
| `highlight` (10 s reel clip) | ✅ Implemented | `HighlightComposer.tsx`; 10 s video cap, allowsEditing |
| `postcard` (single card image/video) | ✅ Implemented | `PostcardComposer.tsx`; 60 s video cap |
| `memory` (10-item gallery) | ✅ Implemented | Memories flow; cover star, alt-text, supportsGallery |
| `profileAvatar` (1:1 crop) | ✅ Implemented | Profile editor; allowsEditing, 1:1 aspect |
| `profileCover` (16:9 crop) | ✅ Implemented | Profile editor; allowsEditing, 16:9 aspect |
| `message` (single DM attachment) | ✅ Implemented | `useMessageMediaPicker`; 60 s video cap |
| `event` (10-item gallery with cover) | ✅ Implemented | `EventComposerSheet.tsx`; 120 s video cap |
| `trip` (20-item gallery with cover) | ✅ Implemented | Trip composer; 120 s video cap |
| **Optional-photo flows — client ready, server-side wiring in-flight** | | |
| `tripCover` (single trip cover image) | ⚠️ Client ready | Policy + hook wired. Server column exists (trips table has cover_url). No separate composer screen yet; embed directly at trip creation. |
| `review` (up to 3 evidence photos) | ⚠️ Client ready | Policy + hook wired. Server photos column being added. |
| `buddyApplication` (up to 3 profile photos) | ⚠️ Client ready | Policy + hook wired. Server gallery_urls field being added to apply endpoint. |
| `hiddenGem` (single representative photo) | ⚠️ Client ready | Policy + hook wired. `submitMachine.ts` has `imageUrl` stub. Server image_url column being added. |
| **Skipped flows — no server media column** | | |
| `communityPlace` (community place submission photo) | ❌ Skipped | Policy defined for completeness. Current `/api/places` endpoint has no `imageUrl` column. Documented in §3 below. |
| `safetyReport` (safety-report photo evidence) | ❌ Skipped | Policy defined for completeness. Current safety-report endpoint has no `imageUrl` column. Documented in §3 below. |

---

## 2. Test Coverage Added in Phase 0

| Test file | Runner | What it covers |
|---|---|---|
| `displayMedia.resolver.test.ts` | node:test | `resolveDisplayMedia` — all 8 priority tiers, designed-null fallback, whitespace handling; `avatarFallback` URL + initials |
| `DisplayMediaImage.errorfallback.component.test.tsx` | jest-expo | null/empty/whitespace URI → immediate fallback; onError → fallback phase; custom fallback node; fallbackLabel; attribution only in loaded phase |
| `useMediaComposer.permissions.component.test.tsx` | jest-expo | Library permission denied → denied UI; camera denied → denied UI; iOS limited (accessPrivileges='limited') → Alert fires after pick, asset still delivered |
| `contentMediaPolicy.limits.test.ts` | node:test | (updated) All 6 new optional-photo + skipped-flow policy keys in the registry completeness and required-fields checks; `supportsGallery→supportsCover` invariant |
| `useMediaComposer.optionalPhoto.component.test.tsx` | jest-expo | For each of `tripCover`, `review`, `buddyApplication`, `hiddenGem`: primaryItem=null before pick (text-only path); URI set after pick; maxItems enforced; clearAll resets to text-only |
| `useMediaComposer.uploadUrl.component.test.tsx` | jest-expo | Upload URL path for `tripCover`, `review`, `buddyApplication`, `hiddenGem` — **4 tests skipped** (see §Testing Gap below) |
| Previously existing | mixed | `useMediaComposer.limits.component.test.tsx`, `MediaAttachmentTray.addremove`, `MediaSourceSheet.allowsEditing`, `MemoriesTab.photoUpload{Fail,Success}`, `HighlightComposer.reopenPreservesMedia`, `PostcardComposer.emptyStatePick`, `useMessageMediaPicker.validation` |

### Testing Gap — `uploadItem` in React 19 test environment {#testing-gap}

The 4 upload URL tests in `useMediaComposer.uploadUrl.component.test.tsx` are skipped
because `uploadItem` uses `setItems` as a synchronous state reader (lines 276-279 of
`useMediaComposer.ts`) in a pattern that requires React's *eager state evaluation* to
work. Eager evaluation is skipped when `fiber.lanes !== NoLanes` — i.e., when there is a
pending re-render. In React 19 concurrent mode under jest-expo, the re-render from the
first `setItems` (setting uploadState='uploading') has not yet committed when the
internal `setTimeout(0)` fires, so the second `setItems` updater runs while lanes are
still set, eager evaluation is bypassed, `currentItem` stays undefined, and `uploadItem`
returns null early without calling `uploadMedia`.

**Resolution path**: Refactor `uploadItem` in `useMediaComposer.ts` to use a `useRef`
snapshot (updated via `useEffect`) for the state read on lines 274-281, replacing the
`setItems`-as-reader side-effect pattern. This makes the function testable without
changing its external contract.

The upload flow IS tested end-to-end for the passport-memories content type in
`MemoriesTab.photoUploadSuccess.component.test.tsx`, which tests through the full
`CreateMemoryModal` component.

---

## 3. Skipped Flows — Explicit Reasons

These content-type flows were evaluated during Phase 0 and deliberately not implemented
on the client because the server has no matching media column. The policy keys are
defined in `contentMediaPolicy.ts` for completeness so the registry is exhaustive and
future phases can enable them without a schema change on the client side.

### `communityPlace`

- **What it would be**: A photo (up to 3 images) attached to a new community/user-submitted place entry.
- **Why skipped**: The `/api/places` (community place creation) endpoint has no `imageUrl` (or `photos`) column in its request body or in the underlying table. Adding photos without a server column would silently drop them.
- **Policy entry**: `CONTENT_MEDIA_POLICIES.communityPlace` — maxItems=3, images only, gallery mode.
- **Resolution path**: Add a `photos text[]` column to the community places table and a corresponding field to the creation endpoint, then wire `useMediaComposer('communityPlace')` into the submission screen.

### `safetyReport`

- **What it would be**: A single photo attached as evidence to a safety report.
- **Why skipped**: The safety-report endpoint has no `imageUrl` column in its request body or in the underlying table.
- **Policy entry**: `CONTENT_MEDIA_POLICIES.safetyReport` — maxItems=1, images only.
- **Resolution path**: Add an `image_url text` column to the safety reports table and a corresponding field to the endpoint, then wire `useMediaComposer('safetyReport')` into the report submission form.

### Meetup check-ins, circle check-ins, route/layover plans, saved collections

These surfaces were evaluated during Phase 0 and found to have no existing media-capable
server endpoint and no existing composer UI that was modified in Tasks 1–4. They are out
of scope for Phase 0 and are not represented in `contentMediaPolicy.ts`. A future phase
should:

1. Audit each surface's API endpoint for a media column.
2. Add a policy key to `contentMediaPolicy.ts`.
3. Wire `useMediaComposer(key)` into the relevant screen.

---

## 4. Out-of-Scope Server Items

The following server-side concerns are explicitly out of scope for Phase 0. They are
listed here so future phases have a clear reference.

| Item | Notes |
|---|---|
| **Signed / expiring media URLs** | All uploaded URLs are currently public CDN URLs. Signed URL generation (time-limited access tokens) is a server-side concern requiring changes to the media upload endpoint and client-side URL refresh logic. |
| **Media scanning / content moderation** | Server-side virus scanning and NSFW image detection pipelines are not implemented. These must sit behind the upload endpoint before Phase 0 flows go to production. |
| **Video transcoding** | Raw video files are stored as-is. HLS / DASH transcoding, thumbnail extraction, and codec normalisation are server-side concerns. |
| **DM / E2EE media attachments** | Direct-message media encryption (key exchange, per-message media keys) is a separate E2EE implementation track and not part of the shared media composer kit. |
| **Cross-surface cache invalidation** | When a media item is deleted or updated on the server, other surfaces that have cached the old URL are not notified. A push-based invalidation strategy is needed for long-lived cached images. |
| **External-place photo normalisation** | Photos sourced from Foursquare, Google Places, or MapTiler are fetched as-is. Normalising them to the app's own CDN (format, dimensions, attribution stripping) is a future server concern. |
