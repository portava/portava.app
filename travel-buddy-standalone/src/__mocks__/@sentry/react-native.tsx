/**
 * Jest stub for @sentry/react-native.
 *
 * @sentry/react-native uses ESM and native GL/camera modules unavailable in
 * jest-expo. This stub replaces every import of the package so component tests
 * that depend on crashReporter (which wraps Sentry) don't crash with
 * "unexpected token" or "native module not found" during the transform step.
 *
 * Only the surface used by crashReporter (captureException, withScope) is
 * stubbed; add entries here if other call sites are added in the future.
 */

import { jest } from '@jest/globals';

interface MockScope {
  setUser: ReturnType<typeof jest.fn>;
  setExtra: ReturnType<typeof jest.fn>;
  setTag: ReturnType<typeof jest.fn>;
  setContext: ReturnType<typeof jest.fn>;
}

const scope: MockScope = {
  setUser: jest.fn(),
  setExtra: jest.fn(),
  setTag: jest.fn(),
  setContext: jest.fn(),
};

export const captureException = jest.fn();
export const captureMessage = jest.fn();
export const withScope = jest.fn((cb: (scope: MockScope) => void) => cb(scope));
export const init = jest.fn();
export const wrap = jest.fn((component: unknown) => component);
export const setUser = jest.fn();
export const setTag = jest.fn();
export const setExtra = jest.fn();
export const addBreadcrumb = jest.fn();
export const configureScope = jest.fn();
export const getCurrentHub = jest.fn(() => ({ getScope: () => scope }));
