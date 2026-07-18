# Component-test gotchas (React 19 + RNTL v14)

Two non-obvious rules apply to every component test file in this app. Both
were discovered the hard way while stabilising
`FailedJobsScreen.component.test.tsx` — breaking either one produces
cascading, hard-to-attribute failures in *later* tests, not the test that
violated the rule.

## 1. `IS_REACT_ACT_ENVIRONMENT` is set globally — don't unset it

`src/jest.setup.ts` (registered via `setupFilesAfterEnv` in `jest.config.js`)
sets `globalThis.IS_REACT_ACT_ENVIRONMENT = true` before any test runs.

Why: RNTL's `act()` saves the previous value of the global and restores it
afterwards. If the global starts as `undefined`, every `act()` call ends by
restoring `undefined`, so async continuations (a screen's `load()` promise
resolving, etc.) commit state updates outside act() context between tests.
That yields "not configured to support act()" warnings and "overlapping
act()" errors that corrupt `actScopeDepth` for all subsequent tests.

Do **not** set this global to `false`/`undefined` in a test, and don't rely
on per-file module-level assignments — the shared setup file already covers
every file.

## 2. Never wrap an Alert button's `onPress` in `act()`

When testing a flow that goes through `Alert.alert` (spy on it, grab the
buttons array, invoke a button's handler), call the handler **bare** — no
`act()` / `await act(async () => ...)` wrapper:

```ts
const buttons = alertSpy.mock.calls.at(-1)![2];
buttons.find((b) => b.text === 'Confirm')!.onPress?.();   // ✅ bare call
await waitFor(() => /* assert the resulting state */);
```

Why: RNTL's `act(callback)` always wraps the callback as
`async () => await callback()`. An async function always returns a thenable,
so RNTL always takes the async path and defers restoring
`IS_REACT_ACT_ENVIRONMENT` to a floating thenable. When the button handler is
itself async, its continuations race against that restore and against RNTL's
`flushMicroTasks` in the next `afterEach`, producing "overlapping act()"
errors that poison every later test in the file.

The bare call is safe because the global setup (rule 1) keeps
`IS_REACT_ACT_ENVIRONMENT = true`: synchronous state updates go to the act
queue, and the `await waitFor(...)` that follows drains that queue inside its
own well-scoped act().

**Always finish the test by `waitFor`-ing until every state update from the
handler's async continuation has committed** (e.g. wait for the row to
disappear or a button to re-enable). Otherwise the uncommitted update fires
outside act() during cleanup and corrupts the next test.

Reference implementation: `pressAlertButton` in
`FailedJobsScreen.component.test.tsx`.

## 3. Always use `makePassportMock` when mocking `usePassport`

Any test that mocks `usePassport` **must** include `lastLoadedAt` in the
returned object.  Omitting it causes the focus-TTL guard inside `passport.tsx`
to compare `Date.now()` against `undefined`, which produces `NaN`.  Because
`NaN` is never less than the TTL, every focus fires `reload()` unconditionally,
creating an infinite re-render loop that OOMs the jest-expo runner.

Use the shared factory from `testUtils.ts` — it enforces the full
`PassportState` shape at the TypeScript level so a missing field is caught at
compile time, not at runtime:

```ts
import { makePassportMock, MINIMAL_OWN_PROFILE } from './testUtils.ts';

const mockReload = jest.fn();

// Stable ref — do NOT create a new { current: … } object inside
// mockReturnValue(); a new reference on every render fires the
// `useEffect(() => setLocalPostcards(postcards), [postcards])` loop.
const mockLastLoadedAt = { current: 0 };

mockUsePassport.mockReturnValue(
  makePassportMock({
    profile:      MINIMAL_OWN_PROFILE,  // or your own OwnProfile object
    reload:       mockReload,
    lastLoadedAt: mockLastLoadedAt,
  }),
);
```

Tests that exercise focus-TTL logic should also install a `Date.now` spy and
stamp the ref **after** the spy is installed so the initial render sees
`Date.now() - lastLoadedAt.current === 0` (within TTL):

```ts
const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(BASE_TIME);
mockLastLoadedAt.current = BASE_TIME;   // within TTL on first render
```

Reference implementation: `PassportContent.focusTTL.component.test.tsx`.
