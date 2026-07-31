---
name: expo-router useFocusEffect mock gap
description: Adding useFocusEffect to a widely-shared component breaks any component test whose hand-written expo-router mock omits it.
---

Many travel-buddy component test files hand-write a minimal `jest.mock('expo-router', () => ({...}))`
covering only the exports the file currently needs (`router`, `useLocalSearchParams`, etc.).
Adding `useFocusEffect` to a component used across many test suites (e.g. `PulseFeedCard`,
rendered indirectly by feed/list tests) breaks every test file whose mock doesn't include it,
with the cryptic error `(0, _expoRouter.useFocusEffect) is not a function`.

**Why:** the per-file mock fully replaces the module rather than extending `requireActual`,
so any export the component newly needs must be added to every mock site by hand.

**How to apply:** after adding a new expo-router hook call to a shared component, run the full
`test:component` suite (not just the file you changed) and add a minimal
`useFocusEffect: (effect) => require('react').useEffect(effect, [])` stub to any mock that fails.
