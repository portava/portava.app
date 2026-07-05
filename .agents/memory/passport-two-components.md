---
name: passport.tsx two-component structure
description: passport.tsx has two distinct components — state/effects that drive visible UI must go in PassportContent, not PassportScreen
---

## Rule

`app/(tabs)/passport.tsx` contains two React components:

- **`PassportScreen`** (line ~48) — the exported default; owns data fetching, loading/error guards, and passes fully-loaded data as props to `PassportContent`.
- **`PassportContent`** (~line 302) — the inner rendering component; owns all UI state, focus effects, and the JSX return.

Any `useState` or `useFocusEffect` that touches the rendered UI must be declared inside `PassportContent`. Declaring them in `PassportScreen` will cause "Cannot find name 'X'" errors at the render site.

**Why:** The component was split so `PassportScreen` can short-circuit early (loading/error) before `PassportContent` mounts, keeping render logic clean.

**How to apply:** When adding a new UI-driven state (buddy profile, pending count, cover error, etc.) to the passport screen, open `PassportContent` (search for `function PassportContent`) and add state there alongside the existing `useState` calls.
