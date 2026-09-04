# Compiling the test suite

Recorded 2026-09-03.

## What was not being compiled

Both packages deliberately kept their tests out of the typechecked program:

| package | tsconfig.json | files it dropped |
| --- | --- | --- |
| `artifacts/api-server` | `"exclude": ["src/test"]` | 598 node:test files |
| `travel-buddy-standalone` | `"exclude": ["**/*.test.ts", "**/*.test.tsx", "__mocks__/**"]` | 670 test files + 10 mocks |

1,268 files, none of them ever seen by `tsc`. That is the mechanism behind the
defect class this repo keeps rediscovering: **a fixture describing a shape the
production code never emits compiles fine when nothing compiles it**, and the
green test it produces reads as coverage of behaviour that does not exist.

## What is compiled now

`tsconfig.test.json` in each package. Separate from `tsconfig.json` on purpose —
see the contamination note below.

| package | script | CI |
| --- | --- | --- |
| `artifacts/api-server` | `pnpm run typecheck:tests` | `ci.yml` → `api-server-static` |
| `travel-buddy-standalone` | `pnpm run typecheck:tests` | `run-all-checks.sh` → `standalone-checks` |

Both go through `scripts/check-test-typecheck.mjs`, which gates the result
against a per-file baseline that may only go **down**.

## Three runners, not one

`@types/jest` alone would have been the wrong instrument. The suite is mixed:

| environment | files | what it needs |
| --- | --- | --- |
| api-server node:test | 598 | `@types/node`; the runner is an explicit `import ... from "node:test"` |
| client node:test | 260 | same |
| client jest (jest-expo) | 410 | `@types/jest` — bare `describe`/`it`/`expect`/`jest` globals |

node:test and jest share one client program without conflict, because
`import { test } from "node:test"` shadows the ambient jest global of the same
name. Only `"jest"` contributes ambient names.

## The contamination that had to be prevented first

`travel-buddy-standalone/tsconfig.json` pinned no `types` array, so **installing
`@types/jest` made `describe`, `it`, `expect` and the `jest` namespace ambient
in application code**. Measured, not assumed: an app-scope file at
`src/__contamination_probe.ts` containing `describe(...)`/`jest.fn()` compiled
with zero errors under `pnpm run typecheck`.

The fix is the explicit `"types": ["node", "react", "react-dom"]` now on
`tsconfig.json`. The same probe against it errors TS2593 / TS2708, and the app
typecheck is still clean at 0. `tsconfig.test.json` adds `"jest"` and nothing
else.

`artifacts/api-server` needed no equivalent: its `tsconfig.json` already pinned
`"types": ["node"]`.

## Error counts

| | before config | after config | what the config layer removed |
| --- | ---: | ---: | --- |
| api-server tests | 925 | 913 | 12 × TS5097 — `./helpers/foo.ts` imports, legitimate under tsx, so `allowImportingTsExtensions` is set in the TEST config only |
| client tests | 16,384 | 248 | 16,116 missing jest globals, plus 12 × TS7016 from a missing `@types/react-test-renderer` |

Genuine remaining: **1,161** (913 + 248). Nothing was suppressed to reach it —
no skip patterns, no `any`, no `@ts-ignore`, and no production type was widened.

The largest single group is 554 × TS18046 `'body' is of type 'unknown'`: test
helpers return `await res.json()`, which is `unknown`, and the tests then read
`body.id` off it. Adding `"dom"` to `lib` would erase all 554 at a stroke,
because DOM's `Response.json()` returns `Promise<any>`. That is exactly the
weakening this exercise exists to avoid, so `lib` was left alone. The same
ruling covers the 5 × TS2304 `Cannot find name 'RequestInfo'` — a DOM type name
used in a Node program.

## The ratchet

Per-file, not per-total. A total-only ceiling lets an error added to file A hide
behind an error removed from file B.

A **stale** baseline is also a failure: if a file's real count drops below its
recorded ceiling, the check exits 1 and tells you to re-record with `--update`
in the same commit. A ceiling drifting above reality is a gate that has quietly
stopped gating.

That property doubles as the compiler-authenticity guard. The decoy npm package
named `tsc` prints a banner and exits 0 — against a non-zero baseline it reports
every file as improved and fails. Proven by substitution on 2026-09-03.

## The seven known fixture-fiction cases: none is caught

All six that live in test files are still present at `origin/main`, and all four
files holding them compile with **zero** errors under the new pass.

| # | case | where | caught? | why not |
| --- | --- | --- | --- | --- |
| 1 | `headline: 'Street food guide'` | `clientProjection.test.ts:43` | no | `projectBuddy(buddy: any)` |
| 2 | `displayName: 'Rui'` | `clientProjection.test.ts:60` | no | `projectBuddy(buddy: any)` |
| 3 | `destination: 'Chiang Mai'` | `clientProjection.test.ts:51` | no | `projectTrip(trip: any)` |
| 4 | `claimType: "crowd"` | `mapProjection.test.ts:88` | no | `LiveClaimLike.claimType: string` |
| 5 | singular search types (`'place'` for wire `'places'`) | `searchAdapter.test.ts:22,103,109,118` | no | `UnifiedSearchResultLike.type: string` |
| 6 | invented enum labels (the 22P02 class) | production queries | no | `supabase.ts:20` calls `createClient(...)` with no `<Database>` generic |
| 7 | gem-id fixture asserting `"g1"` | `mapProjection.test.ts:284` | no | `projectGem(g: any)`; and a wrong *value* in `assert.equal` is not a type error at all |

## The structural blocker this exposes

**The typecheck is only as strong as the type at the seam, and these seams have
had their contracts erased.** Six of the seven sit behind a parameter declared
`any` or a field declared `string`; the seventh is a value assertion no compiler
can see.

Census on 2026-09-03: **86** exported functions in `artifacts/api-server/src/lib/`
take an `any` parameter, 8 of them at the map projection seams, plus 5 more in
`travel-buddy-standalone/src/features/map/`.

So compiling the tests is necessary and not sufficient. It buys 1,161 real
diagnostics and a ratchet that stops the count rising. It does **not** close the
fixture-fiction class. Closing that needs, in rough order of leverage:

1. Type the projector inputs (`projectGem`, `projectBuddy`, `projectTrip`, …)
   against the real row types instead of `any`.
2. Narrow `LiveClaimLike.claimType` and `UnifiedSearchResultLike.type` to the
   unions the wire actually carries.
3. Give the api-server supabase client its `<Database>` generic, which is what
   would make an invented enum label or a column on the wrong table a compile
   error instead of a runtime 22P02/PGRST100.

Each of those turns a class of runtime-only defect into a compile error, and
each one makes this gate retroactively stronger over every test already written.
