---
name: Bottom inset tiers
description: Three-tier end-of-scroll clearance system for travel-buddy; which tier each surface type gets.
---

The shared module `src/hooks/useBottomInset.ts` defines three clearance tiers (docs in the file header):
- **Tab surfaces** (pill floats): `useBottomInset()` / `NavBarFiller` — 96 + safe area.
- **Sticky-bar stack screens**: `useStickyBarInset()` — measure the bar via `onLayout` on the bar view; inset = measured height + breathing room. The bar's own padding already includes `insets.bottom`, so never add it again.
- **Bar-less stack screens/forms/sheets**: `usePlainBottomInset()` / `PlainBottomFiller` — safe area + 24.

**Why:** the floating tab pill renders only inside the tabs layout and never overlays pushed stack routes (verified visually), so full pill clearance on stack screens creates oversized voids and hardcoded 90–160 paddings under sticky bars cover content.

**How to apply:** new scroll surfaces pick the tier by whether the pill or a screen-owned bar floats over them; RN `Modal` sheets render above the pill, so they only need the plain tier. Keyboard screens can suppress the inset via `useKeyboardVisible()`. Don't reintroduce hardcoded bottom paddings ≥90.

Side note: `livekit-client` is a peer dep of `@livekit/react-native` and had to be added explicitly to travel-buddy's package.json or Expo web bundling fails at `livekitBridge.ts`.
