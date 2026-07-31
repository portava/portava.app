---
name: Overlay header height mismatch (visual overlap + swallowed taps)
description: AppHeader's overlay/detail/modal variants floor top padding at 54px; consumers computing "below the header" offsets must use that floor, not insets.top + bar height.
---

`AppHeader`'s `overlay`/`detail`/`modal` variants render with
`paddingTop: Math.max(insets.top, 54)` above a fixed-height bar
(`OVERLAY_HEADER_HEIGHT`). Any consumer that needs to position content
*below* the header must account for that 54px floor.

**Why:** two call sites (media mode selector, gems filter bar) computed their
"top" offset as `insets.top + OVERLAY_HEADER_HEIGHT` directly, skipping the
floor. On devices/web where `insets.top < 54` (e.g. web, some Android), the
header renders taller than that formula assumes, so the header's title text
visually overlapped the content below it. Because the header is a higher
z-index absolutely-positioned view without `pointerEvents="box-none"`, the
overlap also silently swallowed taps intended for the content underneath —
two very different-looking bug reports (duplicate/overlapping labels, AND a
button that "does nothing") from one root cause.

**How to apply:** `AppHeader.tsx` now exports
`getOverlayHeaderTotalHeight(insetsTop)`; always use it (not manual
`insets.top + OVERLAY_HEADER_HEIGHT` arithmetic) when positioning anything
below an overlay/detail/modal header. If a new overlay-adjacent bug looks like
"overlapping text" + "taps not registering" at the same time, suspect a
z-index stacking / geometry mismatch between two independently-positioned
absolute layers before looking at business logic.
