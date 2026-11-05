# Single-scene iOS bootstrap

The Expo SDK 54 template creates its window in `AppDelegate` and has no scene delegate. On the current iOS 27.1 simulator, the integrated app compiled but trapped at `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` before JavaScript. Apple's [scene lifecycle migration guidance](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle) requires scene adoption when building with the iOS 27 SDK.

`withPortavaSceneLifecycle` preserves the existing generated React Native factory and Expo subscriber initialization. For a foreground launch it starts them when the application scene connects, with a scene-owned window and the connection's URL, universal-link activity and notification launch options. A background launch without a scene still starts the existing bootstrap; a later scene adopts its window instead of constructing another React Native host. The manifest deliberately allows one application scene. Reconnection reuses the host.

Scene URL and activity callbacks forward through the existing AppDelegate so Expo Linking, React Native Linking and the development launcher retain their handlers. Lifecycle delegate callbacks forward to Expo's subscriber manager. UIKit's application-state notifications remain the source for React Native AppState; the adapter does not repost them and risk duplicate transitions. Notification delivery and background URL session handlers remain in ExpoAppDelegate.

The plugin appends the owned Swift adapter to the already compiled AppDelegate file, so no fragile Xcode source-list mutation is needed. It is idempotent. An incompatible future Expo template fails prebuild with an explicit error, requiring review rather than silently retaining a broken bootstrap. The Swift source is a plugin template, not a separately compiled app target.

Validation includes the plugin transform tests, a clean generated native project, an actual integrated Xcode simulator build, and installed-app runtime checks. Store-signed and physical-device acceptance remain separate.
