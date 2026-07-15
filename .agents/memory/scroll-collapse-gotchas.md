---
name: Scroll-collapse animation gotchas
description: Rules for animated height-collapse of rows/labels in the Expo app (nav bar, Pulse header, filter rails)
---

# Scroll-collapse animation gotchas

All scroll-driven collapse UIs share the module-level `navBarProgress` SharedValue (0 = full, 1 = collapsed) from the nav-collapse hook. Two rules when sizing collapse animations:

**1. Token lineHeight survives local fontSize overrides.**
The theme type tokens (`t.small`, `t.bodyStrong`, …) set both fontSize and lineHeight. Spreading a token then overriding only `fontSize` keeps the token's larger lineHeight. Animated container heights must be computed from the *token lineHeight* + paddings + borders, not from the overridden fontSize.
**Why:** two collapse rows (mode toggle, header chip row) were sized from eyeballed fontSize math and clipped their content even at rest; a review round caught it.
**How to apply:** when adding a collapsing row with `overflow: 'hidden'`, sum lineHeight (from the token) + paddingVertical×2 + borderWidth×2 for the expanded height, and leave a comment showing the math.

**2. Never animate height directly on Text — use a View clip wrapper.**
RN web handles animated height on Views reliably, but not on Text. Wrap the static `<Text>` in an `Animated.View` with `overflow: 'hidden'` that carries the height/opacity animation.
**Why:** the floating nav bar's label collapse originally animated `Animated.Text` height; this is unreliable on Expo web (the platform the user primarily previews on).
**How to apply:** pattern is `<Animated.View style={[clipStyle, animatedHeight]}><Text …/></Animated.View>`; give the Text an explicit lineHeight equal to the wrapper's full height.
