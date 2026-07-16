---
name: Floating nav pill vs stack routes
description: Whether the floating tab pill overlays pushed stack routes in the mobile app (verified: it does not)
---

The floating nav pill is rendered only inside the tabs layout. Empirically verified (web, pushed navigation from a mounted tabs screen): react-native-screens hides the inactive tabs screen when a root-stack route is pushed, so the pill NEVER overlays stack routes. Fixed bottom CTAs on stack screens need no pill clearance.

**Why:** Task work assumed the pill might bleed over pushed screens because many stack routes carry `NavBarFiller`; those fillers are harmless but not required by the pill.

**How to apply:** Only tab screens (and surfaces rendered inside the tabs layout) need `NavBarFiller` / `NAV_BAR_FILLER_HEIGHT` clearance. To re-verify visually, add a temp route inside `(tabs)` that `router.push`es the target on mount (auth redirect must be temporarily disabled), screenshot it, then delete the temp route.
