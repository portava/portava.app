---
name: RNTL + React 19 renderer budget
description: Hard per-file limits of the jest-expo + RNTL v14 + React 19 renderer in both mobile trees — press budget, commit stalls, fake-timer poison, and the test-structure patterns that survive them.
---

# RNTL + React 19 renderer budget (both mobile trees)

Empirically proven limits of the component-test renderer (jest-expo, RNTL v14,
React 19) in `travel-buddy-standalone` (and formerly `artifacts/travel-buddy`,
archived at `bc1bef404`). These are
renderer facts, not flaky-test noise — tests must be STRUCTURED around them.

## The rules

1. **No trailing `await unmount()`** at the end of a test — poisons every later
   test in the file (dead presses, uncommitted trees).
2. **No fake timers in component files, ever.** Timer UI is verified with a real
   sleep inside act: `await act(async () => { await new Promise(r => setTimeout(r, DELAY + 400)); })`.
   Manually invoking a captured timer callback never commits.
3. **Press budget per FILE:** ~2 reliable `fireEvent.press` instances total, and
   only if no `await act(async () => {})` ran after any press. A post-press
   flush kills press dispatch AND commit for all later instances (key-swaps
   after it don't even commit — queries return the old tree).
4. **One press-derived visual commit per file.** Press-triggered setState/style
   changes render reliably only on the first mounted instance. Mock
   call-count/args assertions keep working wherever presses dispatch
   (dispatch is synchronous).
5. **Even a direct handler call can't dodge the wall**: after the file's
   press-commit is spent, calling the element's `onClick`/`onPress` prop
   directly inside act schedules state that never renders. (Host views carry
   `onClick` under RN-web-style hosts, NOT `onPress` — a
   `props.onPress?.()` optional chain is a silent no-op.)
6. **Prop-capture stubs see what queries can't**: renders still EXECUTE when
   visual commits stall, so a stub pushing its props into a `mockXyz` array
   observes new prop values (e.g. contextMode reaching the consumer tab) even
   when the query tree stays stale. Use for post-press assertions when style
   asserts are impossible — but only if a render actually runs (dead dispatch
   ⇒ no render either).
7. **Structure patterns:** ONE `it()` per file for press-heavy scenarios;
   sibling files (fresh renderer) for each extra press scenario; query-only
   scenarios can share a file via key-swap rerenders BEFORE any post-press
   flush. `const view = await render(...)` + `view.getBy*`; never `screen`
   after rerenders.
8. **Feature gated behind a press = its interaction may be untestable**: if
   reaching the UI needs press #1 (e.g. chips inside a collapsed filters
   panel), the revealed UI's own press-commit can never render. Cover render +
   default state + wiring, document the gap, and rely on the twin tree if it
   exposes the UI un-gated.
9. **First-test "Unable to find X" is never budget** — it's stale mocks or
   product drift. Check every symbol the product file imports from each mocked
   module: an incomplete object-literal factory (missing named export like
   `FilterStrip`/`SORT_LABELS`) crashes into SectionErrorBoundary — the dump
   shows the error card ("View error details").
10. **jest CLI:** never pass literal `(tabs)` paths to `--testPathPattern`
    (regex-mangled, silently skipped) — use basename fragments. Exit code 1
    with all suites passing is a known harmless quirk.

## Diagnosis order for a failing component file

Stale/incomplete mocks or product drift first (rule 9) → structure violations
(trailing unmounts, fake timers, post-press flushes) → budget placement (is the
failing scenario late in the file? split it out) → only then suspect the test's
assertions are stale vs. current product behavior.

**Why:** two full fix waves (9 mobile + 17 standalone files) all reduced to
these causes; nothing needed product changes or `.skip`.

## Modal-Proxy files: act-wrap presses (July 2026)
In files using the react-native Modal Proxy mock, a bare `fireEvent.press` can
dispatch without committing the state update (sheet never appears) even on the
FIRST press of the file. Wrapping each press in `await act(async () => {
fireEvent.press(...) })` commits reliably — two such act-wrapped presses in one
file (open + close) both rendered. The "post-press flush poison" applies to
standalone `await act(async () => {})` flushes after a press, not to the
act-wrapped press itself.
