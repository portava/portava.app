/**
 * sentry — shared lazy Sentry accessor for services and lib files.
 *
 * Direct `import * as Sentry from '@sentry/react-native'` in service/lib
 * files causes an esbuild "Unexpected typeof" TransformError when those files
 * are imported by node:test runners (react-native source is not valid for
 * esbuild's Node target). This wrapper defers the require() to call-time,
 * so node:test files can import service code without triggering the transform.
 *
 * Usage:
 *   import { getSentry } from '../lib/sentry.ts';
 *   const sentry = getSentry();
 *   sentry?.captureException(err);
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
export function getSentry(): typeof import('@sentry/react-native') | null {
  try {
    return require('@sentry/react-native') as typeof import('@sentry/react-native');
  } catch {
    return null;
  }
}
