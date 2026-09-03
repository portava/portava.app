/**
 * Ambient test-runner globals, for the fixture-shape guard ONLY.
 *
 * `tsconfig.json` excludes every `*.test.ts` / `*.test.tsx` from the typecheck,
 * so test files get no compiler help at all — which is precisely how fixtures
 * kept inventing fields their DTOs never had (`headline`, `destination`,
 * `handle`, `thumbnail_url`, …) and passing.
 *
 * `tsconfig.tests.json` puts them back in, but the repo has neither `@types/jest`
 * nor node:test type declarations installed, so a naive include drowns the real
 * findings in ~15,000 "Cannot find name 'describe'" errors.
 *
 * These declarations exist to silence exactly that noise and nothing else. They
 * are deliberately `any`: this file is NOT trying to typecheck test BEHAVIOUR —
 * `scripts/check-test-fixture-shapes.mjs` reports only object-literal shape
 * mismatches. Making these precise would start failing on matcher signatures,
 * which is a different (and much larger) project.
 *
 * Not referenced by tsconfig.json, so it cannot affect the app typecheck.
 */

declare const describe: any;
declare const it: any;
declare const test: any;
declare const expect: any;
declare const beforeEach: any;
declare const afterEach: any;
declare const beforeAll: any;
declare const afterAll: any;
declare const suite: any;
declare const mock: any;

/**
 * `jest` is used both as a VALUE (`jest.fn()`, `jest.mock(...)`) and as a
 * TYPE NAMESPACE (`jest.Mock`, `jest.SpyInstance`). A `declare const` covers
 * only the first, so the namespace is declared alongside it — every member
 * `any`, and generic so `jest.Mock<T>` parses too.
 */
declare const jest: any;
declare namespace jest {
  type Mock<T = any, Y extends any[] = any> = any;
  type Mocked<T = any> = any;
  type MockedFunction<T = any> = any;
  type MockedClass<T = any> = any;
  type MockedObject<T = any> = any;
  type SpyInstance<T = any, Y extends any[] = any> = any;
  type MockInstance<T = any, Y extends any[] = any> = any;
  type Matchers<R = any, T = any> = any;
  type CustomMatcherResult = any;
}
