/**
 * TripMapPreview "View map" — the ONE navigation that carries §11 trip context.
 *
 * ## The defect
 *
 * `app/map/index.tsx` reads `params.tripId` and gates three things on it: the
 * trip itinerary objects, the §11 Optimize Today chip, and the §12 Locate My
 * Friends group scope. No navigation in the app passed it. Every push to /map
 * either named a place (`lat`/`lng`/`focusId` from the three Compass links) or
 * a layer (`entityTypes=gems`, `=stamps&mode=passport`, `=friends&mode=circle`)
 * — and `TripMapPreview`, the one entry point that is looking at a trip when it
 * pushes, sent `entityTypes=trips` and nothing else. So the parameter was read
 * by the shell and written by nobody.
 *
 * ## Why the no-trip case is tested too
 *
 * The fix is not "add tripId everywhere". A gems or passport map has no trip to
 * name, and inventing one would be worse than omitting it. `tripId` is optional
 * for exactly that reason, and the second test pins that an absent trip
 * produces a URL with no `tripId` at all rather than an empty or placeholder
 * one — an empty `tripId=` would make the shell fetch a plan for "".
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// expo-router — the jest.fn() lives INSIDE the factory so it is valid at
// require time (module imports are hoisted above any const this file declares).
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    router: {
      push: jest.fn(), back: jest.fn(), replace: jest.fn(),
      navigate: jest.fn(), dismiss: jest.fn(),
    },
    useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: jest.fn(() => ({})),
    usePathname:          () => '/',
    useSegments:          () => [],
    useFocusEffect: (cb: () => (() => void) | void) => {
      React.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
    useNavigation: () => ({
      navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(),
      addListener: (_e: unknown, _cb: unknown) => () => {},
    }),
    Link:     ({ children }: { children: React.ReactNode }) => children as any,
    Redirect: () => null,
    Stack:    { Screen: () => null },
    Tabs:     { Screen: () => null },
  };
});

// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider:  ({ children }: { children: React.ReactNode }) => children,
}));

import { router } from 'expo-router';
import { TripMapPreview } from '../TripPage.tsx';

const mockPush = router.push as jest.Mock;

/** The href handed to router.push by the section header's action. */
function pushedHref(): string {
  expect(mockPush).toHaveBeenCalled();
  const arg = mockPush.mock.calls[mockPush.mock.calls.length - 1][0];
  return typeof arg === 'string' ? arg : JSON.stringify(arg);
}

beforeEach(() => {
  mockPush.mockClear();
});

describe('TripMapPreview — View map carries the trip', () => {
  it('passes tripId when it knows which trip it is showing', async () => {
    await render(<TripMapPreview tripId="trip-abc" />);

    fireEvent.press(screen.getByText('View map'));

    const href = pushedHref();
    expect(href).toContain('entityTypes=trips');
    expect(href).toContain('tripId=trip-abc');
  });

  it('percent-encodes the id rather than splicing it in raw', async () => {
    // A trip id is a uuid today, but the query string is built by hand and an
    // unescaped `&` would silently truncate every parameter after it.
    await render(<TripMapPreview tripId="a&b=c" />);

    fireEvent.press(screen.getByText('View map'));

    expect(pushedHref()).toContain('tripId=a%26b%3Dc');
  });

  it('omits the parameter entirely when there is no trip to name', async () => {
    await render(<TripMapPreview />);

    fireEvent.press(screen.getByText('View map'));

    const href = pushedHref();
    expect(href).toContain('entityTypes=trips');
    expect(href).not.toContain('tripId');
  });
});
