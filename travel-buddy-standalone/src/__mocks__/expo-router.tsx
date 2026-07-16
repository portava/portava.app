// Manual mock for expo-router used in component tests.
// Uses plain functions (not jest.fn()) so this file compiles cleanly
// under the app tsconfig. Tests that need to assert on navigation calls
// should re-mock individual exports inside the test file.

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
export const Link = ({ children }: { children: React.ReactNode }) => children as any;
export const Redirect = (_props: { href: unknown }) => null;
export const Stack = { Screen: (_props: unknown) => null };
export const Tabs = { Screen: (_props: unknown) => null };
