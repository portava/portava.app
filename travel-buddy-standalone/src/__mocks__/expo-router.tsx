// Manual mock for expo-router used in component tests.
// Uses plain functions (not jest.fn()) so this file compiles cleanly
// under the app tsconfig. Tests that need to assert on navigation calls
// should re-mock individual exports inside the test file.

import React from 'react';

export const router = {
  push:     (_href: unknown) => {},
  replace:  (_href: unknown) => {},
  back:     () => {},
  navigate: (_href: unknown) => {},
  dismiss:  () => {},
};

export const useRouter = () => router;
export const useLocalSearchParams = () => ({} as Record<string, string>);
export const usePathname = () => '/';
export const useSegments = () => [] as string[];

/**
 * useFocusEffect — behaves like useEffect for testing purposes.
 * The real hook only fires on screen focus; here we use useEffect so
 * components that call useFocusEffect work without crashing when no
 * test-level jest.mock override is provided.
 */
export const useFocusEffect = (cb: () => (() => void) | void) => {
  React.useEffect(() => {
    const cleanup = cb();
    return typeof cleanup === 'function' ? cleanup : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};

export const useNavigation = () => ({
  navigate:    (_name: unknown, _params?: unknown) => {},
  goBack:      () => {},
  setOptions:  (_options: unknown) => {},
  addListener: (_event: unknown, _cb: unknown) => () => {},
});

export const Link = ({ children }: { children: React.ReactNode }) => children as any;
export const Redirect = (_props: { href: unknown }) => null;
export const Stack = { Screen: (_props: unknown) => null };
export const Tabs = { Screen: (_props: unknown) => null };
