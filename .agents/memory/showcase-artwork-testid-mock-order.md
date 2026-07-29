---
name: Showcase artwork rendering — duplicate labels and mock prop order
description: Two pitfalls hit when unifying stamp showcase cards onto UniversalStampArtwork — duplicate label text and testID clobbering in per-file expo-image mocks.
---

When a caller wraps `UniversalStampArtwork`/`StampArtwork` and also renders its own
caption `<Text>{label}</Text>` below the artwork frame, this duplicates a label:
the procedural fallback path (`StampCard`, used for the 56-119px size range)
already renders `stamp.label` as its own internal `<Text>`. RNTL's `getByText`
then fails with "Found multiple elements with text: X". Do not add an outer
caption Text alongside `UniversalStampArtwork` — let the fallback own the label,
and rely on `accessibilityLabel` on the Pressable for the image-present case.

Separately: `UniversalStampArtwork`'s real `<Image>` now sets
`testID="stamp-artwork-image"`. Per-file jest mocks of `expo-image` that build
a hardcoded testID and then `...rest` spread AFTER it (to forward other props)
will have that testID clobbered by the real component's own testID hidden
inside `rest`. Any such per-file mock must spread `...rest` FIRST, then set the
mock's own `testID`/`accessibilityLabel` overrides last, or the marker testID
silently disappears and `findByTestId`/`findAllByProps` returns zero results.
