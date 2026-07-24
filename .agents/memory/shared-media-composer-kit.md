---
name: Shared media composer kit
description: useMediaComposer hook + MediaPickerButton + MediaAttachmentTray — the single source of truth for all picker/permission/upload flows in travel-buddy.
---

# Shared media composer kit

## The rule
Any new composer that needs media picking must use:
- `useMediaComposer(policyKey)` — all state (items, sheet visibility, upload, retry)
- `MediaPickerButton` — trigger button (icon or `variant="area"`)
- `MediaAttachmentTray` — multi-item thumbnail strip with remove, cover, alt-text, progress

Do NOT copy-paste direct `ImagePicker.launchImageLibraryAsync` / permission calls.

**Why:** Copy-pasted picker code across 6+ composers had divergent permission-denied handling, missing iOS limited-library prompts, and no denied→Settings path. The kit centralises all of this.

## How to apply
1. Add a policy entry to `src/lib/contentMediaPolicy.ts` (if new content type).
2. `const composer = useMediaComposer('myPolicy')` in the component.
3. Render `<MediaPickerButton composer={composer} />` and optionally `<MediaAttachmentTray composer={composer} />`.
4. Single-item composers with custom preview UIs: use `useMediaComposer` for sheet state only (`sheetVisible`/`openSheet`/`closeSheet`); pass a custom `onResult` handler to `MediaSourceSheet` for your own validation/state flow.
5. Multi-item composers: call `composer.uploadAll()` before submit so the per-item progress bar actually animates.

## allowsEditing / aspect forwarding
`MediaSourceSheet` accepts `allowsEditing?: boolean` and `aspect?: [number, number]` props. `MediaPickerButton` forwards these automatically from `composer.policy.allowsEditing` and `composer.policy.editAspect`. When rendering `MediaSourceSheet` directly (e.g. `profile/edit/photos` uses the full tap area as the trigger), pass `allowsEditing={composer.policy.allowsEditing}` and `aspect={composer.policy.editAspect}` explicitly.

## Existing migration patterns
- **PulseCreate / PostcardComposer**: use `useMediaComposer` for sheet state only; custom `onResult` handlers preserve filter-editor and upload-validation flows.
- **profile/edit/photos**: two composer instances (`profileAvatar` / `profileCover`); `useEffect` on `primaryItem?.id` syncs picked URI to local save state.
- **useMessageMediaPicker**: uses `useMediaComposer('message')` internally; derives `media` from `primaryItem` via `useMemo`; retains its own upload/progress/cancel/retry logic.

## Key files
- `src/lib/contentMediaPolicy.ts` — registry of all content-type policies
- `src/hooks/useMediaComposer.ts` — hook with full lifecycle
- `src/components/ui/MediaPickerButton.tsx` — trigger button (forwards allowsEditing/aspect from policy)
- `src/components/ui/MediaAttachmentTray.tsx` — thumbnail strip
- `src/components/ui/MediaSourceSheet.tsx` — accepts allowsEditing + aspect props

## Known gaps (follow-up work)
- `uploadAll()` not yet wired in `memory/create` submit handler — progress bar renders but never animates.
- Reorder UX is tap-based buttons; real drag gesture still needed for gallery-heavy flows.
