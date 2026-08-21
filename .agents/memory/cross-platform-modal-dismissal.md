---
name: Cross-platform React Native Modal dismissal
description: Why route-after-close sheets use a component-owned exit instead of relying on Modal onDismiss.
---

For cross-platform route-after-close sheets, use a component-owned exit animation with the core React Native `Modal` native animation disabled. Invoke the parent close callback only from the owned animation's completion, then route after the `visible=false` commit.

**Why:** React Native's core `Modal.onDismiss` is implemented only on iOS in the installed runtime. Android/web cannot use it as a universal dismissal-complete signal, while timers and `InteractionManager` can race the native overlay and leave a blocking or ghost sheet.

**How to apply:** Use this pattern when navigation must follow a modal close on every supported platform. Deduplicate close/navigation requests, keep `onDismiss` as an additional completion signal where available, and test rapid presses plus the pre-route close state.