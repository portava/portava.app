---
name: Metro _tmp watcher crash
description: Metro crashes with ENOENT when pnpm creates and deletes *_tmp_N temp directories during install. Must be blocked in metro.config.js.
---

## The rule
Any `pnpm add` in a workspace sibling can create `<package>_tmp_<N>` directories that Metro tries to watch. If the directory is deleted before Metro can set up the watcher, Metro crashes with ENOENT and the Expo workflow dies.

**Why:** Metro's FallbackWatcher walks all node_modules and registers watchers. Temp dirs from pnpm are transient and may vanish mid-walk.

**How to apply:**
Keep this pattern in `artifacts/travel-buddy/metro.config.js`:
```js
config.resolver.blockList = [
  /node_modules.*react-native-reanimated_tmp.*/,
  /node_modules.*_tmp_\d+/,  // catches all pnpm temp dirs
];
```
The second regex is the general catch-all. Add it after any new `pnpm add` in workspace siblings causes a crash.
