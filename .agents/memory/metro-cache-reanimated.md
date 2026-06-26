---
name: Metro cold cache + Reanimated plugin
description: Behavior of Metro bundler cache when babel.config.js changes; cold vs warm build times with react-native-reanimated/plugin on Expo SDK 54.
---

## Rule
After clearing the Metro cache (`/tmp/metro-cache`, `/tmp/metro-file-map-*`), the first bundle is a **cold rebuild** that takes ~68s for 3485 modules. Subsequent builds reuse the warm cache and complete in 2-4s. Changing `babel.config.js` with a **compatible** plugin (e.g. adding `react-native-reanimated/plugin` when Reanimated transforms are already cached) does NOT cause a full cold rebuild — Metro reuses cached transforms and completes normally.

**Why:** Metro's transform cache key is per-file (source + babel options). When `api.cache(true)` is set, the babel config hash is stable. Adding the Reanimated plugin only re-transforms files that actually contain worklets; pure React/RN modules stay cached.

**How to apply:**
- Never `rm -rf /tmp/metro-cache` unless Metro is truly broken (stale transforms / crashes). A slow first build is usually just a cold cache, not a hang.
- To speed up a cold rebuild: do NOT clear the cache — just wait ~70s.
- When diagnosing "Metro stuck": wait a full 90s before concluding it's hanging. Check `refresh_all_logs` (not static `cat` on the log file) for the final `Web Bundled Xms` line.
- `react-native-reanimated/plugin` must be the LAST entry in `plugins` in `babel.config.js`. Required for worklet transforms on native (without it, `useAnimatedStyle`/`useAnimatedProps` callbacks run on JS thread causing jank).
