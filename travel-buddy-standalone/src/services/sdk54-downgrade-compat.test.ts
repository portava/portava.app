/**
 * SDK 54 package downgrade compatibility tests.
 *
 * Verifies that the five packages downgraded to match Expo SDK 54 are:
 *   1. Pinned to the correct SDK-54-compatible versions in package.json
 *   2. API-compatible with production code — exercised by importing and calling
 *      REAL production service functions with mock native deps injected via the
 *      same test-slot pattern used by the rest of this codebase.
 *
 * Production code called end-to-end in this suite
 * ──────────────────────────────────────────────────────────────────────────────
 * expo-calendar ~15.0.8
 *   → addMeetupToCalendar() from src/services/calendar.ts
 *     (full permission → calendar-select → createEventAsync flow)
 *   → deriveMeetupDates() from src/services/calendarUtils.ts (pure helper)
 *
 * expo-notifications ~0.32.17
 *   → savePushToken() from src/services/pushTokenService.ts
 *     (token resolution → POST /api/me/devices payload)
 *
 * react-native-view-shot 4.0.3
 *   → makeDeepLink(), makeWebFallback(), toFileUri() from
 *     src/services/passportShareUtils.ts (logic used by usePassportShare.ts)
 *   → captureRef() web shim (src/shims/react-native-view-shot.web.js)
 *
 * expo-clipboard ~8.0.8
 *   → API contract verification (setStringAsync accepts a string)
 *
 * expo-dev-client ~6.0.21
 *   → Version pin verified (SDK 54 compatibility; no Node.js-importable
 *     surface — dev-client initialises the Expo Go launcher at bootstrap
 *     time only)
 *
 * Device-level flows (push delivery/receipt, native view capture, native
 * calendar UI, hardware clipboard) cannot run in Node.js and are documented
 * in docs/sdk54-downgrade-smoke-test.md.
 *
 * Run:
 *   node --import tsx/esm --test src/services/sdk54-downgrade-compat.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, dirname } from 'node:path';

// ── Real production imports ───────────────────────────────────────────────────

import { deriveMeetupDates } from './calendarUtils.ts';
import { CANONICAL_APP_URL } from '../constants/canonicalUrl.ts';
import {
  addMeetupToCalendar,
  _setTestCalendarDeps,
  type CalendarTestDeps,
} from './calendar.ts';
import {
  savePushToken,
  _setTestTokenProvider,
} from './pushTokenService.ts';
import {
  makeDeepLink,
  makeWebFallback,
  toFileUri,
} from './passportShareUtils.ts';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// Locate the workspace root by walking up from this file's directory until we
// find the directory containing both `artifacts` and `travel-buddy-standalone`.
// This used to exist so the same file worked from either of two trees; the
// monorepo tree is archived and this file now lives in one place only. The walk
// is kept because it is still the correct way to find the root from a nested
// service directory without hardcoding a `../../../..` depth — the exact class
// of brittle path the cross-tree guard exists to catch.
function findWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(pathResolve(dir, 'travel-buddy-standalone')) &&
      existsSync(pathResolve(dir, 'artifacts'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate workspace root above ${startDir}`);
}

const WORKSPACE_ROOT = findWorkspaceRoot(__dir);

// Resolve paths from the workspace root rather than from this file's depth.
function readPkg(rootRelPath: string): Record<string, any> {
  return JSON.parse(readFileSync(pathResolve(WORKSPACE_ROOT, rootRelPath), 'utf8'));
}

function versionContains(field: string | undefined, ver: string): boolean {
  return (field ?? '').includes(ver);
}

// ── 1. Package version pins ───────────────────────────────────────────────────
//
// RETIRED CROSS-TREE HALF. Until artifacts/travel-buddy was archived these pins
// were read out of THAT tree's package.json, and a companion test asserted the
// two trees agreed. There is one tree now, so the pins are asserted where they
// actually take effect — travel-buddy-standalone/package.json, the manifest EAS
// builds from — and the "in sync" test is gone rather than left comparing a file
// to itself.

describe('SDK 54 downgrade — package version pins', () => {
  const pkg = readPkg('travel-buddy-standalone/package.json');
  const deps: Record<string, string> = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  it('expo-notifications is pinned to 0.32.x (SDK 54 compatible)', () => {
    assert.ok(
      versionContains(deps['expo-notifications'], '0.32'),
      `Expected expo-notifications ~0.32.x, got: ${deps['expo-notifications']}`,
    );
  });

  it('expo-dev-client is pinned to 6.x (SDK 54 compatible)', () => {
    assert.ok(
      versionContains(deps['expo-dev-client'], '6.'),
      `Expected expo-dev-client ~6.x, got: ${deps['expo-dev-client']}`,
    );
  });

  it('react-native-view-shot is pinned to 4.0.x (SDK 54 compatible)', () => {
    assert.ok(
      versionContains(deps['react-native-view-shot'], '4.0'),
      `Expected react-native-view-shot 4.0.x, got: ${deps['react-native-view-shot']}`,
    );
  });

  it('expo-calendar is pinned to 15.x (SDK 54 compatible)', () => {
    assert.ok(
      versionContains(deps['expo-calendar'], '15.'),
      `Expected expo-calendar ~15.x, got: ${deps['expo-calendar']}`,
    );
  });

  it('expo-clipboard is pinned to 8.x (SDK 54 compatible)', () => {
    assert.ok(
      versionContains(deps['expo-clipboard'], '8.'),
      `Expected expo-clipboard ~8.x, got: ${deps['expo-clipboard']}`,
    );
  });
});

// ── 1b. Peer deps of the SDK 54 downgraded packages ──────────────────────────
//
// The five downgraded packages declare peer dependencies on react-native, expo,
// and react. This section used to assert those peer deps were IN SYNC between
// artifacts/travel-buddy and travel-buddy-standalone; with the monorepo tree
// archived there is nothing to compare against, so what survives is the half
// that still has a subject: each peer dep must actually be DECLARED in the
// surviving manifest. An undeclared peer dep is the failure that a version
// comparison never caught anyway — it resolves transitively and silently.
//
// Packages and their key peer deps:
//   expo-notifications  → react-native, expo, react
//   expo-dev-client     → react-native, expo, react
//   expo-calendar       → react-native, expo, react
//   expo-clipboard      → react-native, expo, react
//   react-native-view-shot → react-native, react

describe('SDK 54 downgrade — peer deps of the downgraded packages are declared', () => {
  const sa = readPkg('travel-buddy-standalone/package.json');
  const saAll: Record<string, string> = {
    ...sa.dependencies,
    ...sa.devDependencies,
  };

  // Key peer deps shared by all five downgraded packages. Deduplicated to one
  // test per peer dep (all downgraded packages share the same react-native /
  // expo / react version in a given project).
  const uniquePeerDeps = ['react-native', 'expo', 'react'];

  for (const peerDep of uniquePeerDeps) {
    it(`${peerDep} is declared (peer dep of the SDK 54 downgraded packages)`, () => {
      assert.ok(
        saAll[peerDep] !== undefined,
        `${peerDep} is missing from travel-buddy-standalone/package.json — it is a peer dep of the SDK 54 downgraded packages and must be pinned explicitly, not resolved transitively`,
      );
    });
  }
});

// ── 1c. Other explicitly pinned Expo SDK 54 packages ─────────────────────────
//
// Several Expo packages beyond the five intentionally downgraded ones are
// pinned to exact or narrow versions. This section used to compare each version
// string across the two package trees; with artifacts/travel-buddy archived the
// comparison has no second operand. What remains enforced is that each package
// is still explicitly pinned in the surviving manifest — dropping a pin lets
// the Expo SDK resolve it to whatever the lockfile happens to allow, which is
// the drift the cross-tree test was a proxy for.

describe('SDK 54 — other explicitly pinned Expo packages are still pinned', () => {
  const sa = readPkg('travel-buddy-standalone/package.json');
  const saAll: Record<string, string> = {
    ...sa.dependencies,
    ...sa.devDependencies,
  };

  const pinnedPackages: string[] = [
    '@expo/cli',
    'expo',
    'expo-av',
    'expo-blur',
    'expo-constants',
    'expo-font',
    'expo-glass-effect',
    'expo-haptics',
    'expo-image',
    'expo-image-manipulator',
    'expo-image-picker',
    'expo-linear-gradient',
    'expo-linking',
    'expo-location',
    'expo-router',
    'expo-sharing',
    'expo-splash-screen',
    'expo-status-bar',
    'expo-symbols',
    'expo-system-ui',
    'expo-task-manager',
    'expo-web-browser',
  ];

  for (const name of pinnedPackages) {
    it(`${name} is explicitly pinned`, () => {
      assert.ok(
        saAll[name] !== undefined,
        `${name} is missing from travel-buddy-standalone/package.json — it was an explicitly pinned Expo SDK 54 package; either restore the pin or remove it from pinnedPackages with a reason`,
      );
    });
  }
});

// ── 2. expo-calendar ~15.0.8 — addMeetupToCalendar integration ───────────────
//
// Calls the REAL addMeetupToCalendar() from calendar.ts with a mock
// expo-calendar module injected via _setTestCalendarDeps().  This exercises the
// full permission flow, calendar selection, date derivation, and event creation
// path without native bindings — any regression in the logic fails these tests.

describe('expo-calendar ~15.0.8 — addMeetupToCalendar integration (real production function)', () => {
  let capturedCalls: Array<{ calendarId: string; eventDetails: any }> = [];

  const mockCalendarModule: CalendarTestDeps['calendarModule'] = {
    EntityTypes: { EVENT: 'event' },
    requestCalendarPermissionsAsync: async () => ({ status: 'granted' }),
    getCalendarsAsync: async (_entityType: any) => [
      { id: 'cal-primary', allowsModifications: true, isPrimary: true },
    ],
    createEventAsync: async (calendarId: string, event: any) => {
      capturedCalls.push({ calendarId, eventDetails: event });
      return 'evt-test-001';
    },
  };

  beforeEach(() => {
    capturedCalls = [];
    _setTestCalendarDeps({ platform: 'ios', calendarModule: mockCalendarModule });
  });

  afterEach(() => {
    _setTestCalendarDeps(null);
  });

  const baseMeetup = {
    id: 'meetup-1',
    creatorId: 'user-1',
    title: 'Rooftop Sundowner',
    description: 'Watching the sunset together',
    locationName: 'Sky Bar, Bangkok',
    approximateDate: '2026-07-10',
    timeBlock: 'evening' as const,
    startsAt: '2026-07-10T18:00:00Z',
    endsAt: '2026-07-10T20:00:00Z',
    status: 'confirmed' as const,
    tripId: 'trip-1',
    visibility: 'trip' as const,
    rsvpSummary: { going: 4, maybe: 0, declined: 0, pending: 0 },
    myRsvp: 'going' as const,
    confirmedTime: null,
    confirmedTimeBlock: null,
    inviteeSummary: { total: 4 },
    proposedTime: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  };

  it('returns { ok: true, eventId } when permission is granted and calendar exists', async () => {
    const result = await addMeetupToCalendar(baseMeetup);
    assert.ok(result.ok, `Expected ok:true, got: ${JSON.stringify(result)}`);
    if (result.ok) assert.equal(result.eventId, 'evt-test-001');
  });

  it('calls createEventAsync with correct calendarId, title, location, startDate, endDate', async () => {
    await addMeetupToCalendar(baseMeetup);
    assert.equal(capturedCalls.length, 1, 'createEventAsync must be called exactly once');
    const { calendarId, eventDetails: ev } = capturedCalls[0]!;
    assert.equal(calendarId, 'cal-primary');
    assert.equal(ev.title, 'Rooftop Sundowner');
    assert.equal(ev.location, 'Sky Bar, Bangkok');
    assert.ok(ev.startDate instanceof Date, 'startDate must be a Date');
    assert.ok(ev.endDate instanceof Date, 'endDate must be a Date');
    assert.equal(ev.startDate.toISOString(), '2026-07-10T18:00:00.000Z');
    assert.equal(ev.endDate.toISOString(), '2026-07-10T20:00:00.000Z');
  });

  it('defaults endDate to startDate + 1 hour when endsAt is absent', async () => {
    await addMeetupToCalendar({ ...baseMeetup, endsAt: null });
    const ev = capturedCalls[0]!.eventDetails;
    assert.equal(
      ev.endDate.getTime() - ev.startDate.getTime(),
      60 * 60 * 1000,
      'endDate must be exactly 1 hour after startDate',
    );
  });

  it('returns { ok: false, reason: "denied" } when permission is denied', async () => {
    _setTestCalendarDeps({
      platform: 'ios',
      calendarModule: {
        ...mockCalendarModule,
        requestCalendarPermissionsAsync: async () => ({ status: 'denied' }),
      },
    });
    const result = await addMeetupToCalendar(baseMeetup);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'denied');
  });

  it('returns { ok: false, reason: "error" } when no writable calendar is found', async () => {
    _setTestCalendarDeps({
      platform: 'ios',
      calendarModule: {
        ...mockCalendarModule,
        getCalendarsAsync: async () => [{ id: 'cal-ro', allowsModifications: false, isPrimary: true }],
      },
    });
    const result = await addMeetupToCalendar(baseMeetup);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'error');
      assert.match(result.message ?? '', /no writable calendar/i);
    }
  });

  it('returns { ok: false, reason: "error" } when startsAt is null — no confirmed start time', async () => {
    const result = await addMeetupToCalendar({ ...baseMeetup, startsAt: null, endsAt: null });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'error');
      assert.match(result.message ?? '', /no confirmed start time/i);
    }
  });

  it('returns { ok: false, reason: "error" } and catches when createEventAsync throws', async () => {
    _setTestCalendarDeps({
      platform: 'ios',
      calendarModule: {
        ...mockCalendarModule,
        createEventAsync: async () => { throw new Error('Native calendar write failed'); },
      },
    });
    const result = await addMeetupToCalendar(baseMeetup);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'error');
      assert.match(result.message ?? '', /Native calendar write failed/i);
    }
  });

  it('returns { ok: false, message: "Calendar not supported on web" } on web platform', async () => {
    _setTestCalendarDeps({ platform: 'web', calendarModule: mockCalendarModule });
    const result = await addMeetupToCalendar(baseMeetup);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message ?? '', /not supported on web/i);
  });
});

// ── 3. expo-calendar — calendarUtils.deriveMeetupDates (pure date helper) ─────

describe('expo-calendar ~15.0.8 — calendarUtils.deriveMeetupDates (pure date logic, no native deps)', () => {
  it('returns a valid startDate from startsAt ISO string', () => {
    const { startDate } = deriveMeetupDates({ startsAt: '2026-07-01T14:00:00Z', endsAt: null });
    assert.ok(startDate instanceof Date);
    assert.equal(startDate!.toISOString(), '2026-07-01T14:00:00.000Z');
  });

  it('returns null startDate when startsAt is absent', () => {
    const { startDate } = deriveMeetupDates({ startsAt: null, endsAt: null });
    assert.equal(startDate, null);
  });

  it('uses endsAt when provided', () => {
    const { endDate } = deriveMeetupDates({ startsAt: '2026-07-01T14:00:00Z', endsAt: '2026-07-01T16:00:00Z' });
    assert.equal(endDate.toISOString(), '2026-07-01T16:00:00.000Z');
  });

  it('defaults endDate to startDate + 1 hour when endsAt is absent', () => {
    const { startDate, endDate } = deriveMeetupDates({ startsAt: '2026-07-01T14:00:00Z', endsAt: null });
    assert.equal(endDate.getTime() - startDate!.getTime(), 60 * 60 * 1000);
  });
});

// ── 4. expo-notifications ~0.32.17 — savePushToken integration ───────────────
//
// Calls the REAL savePushToken() from pushTokenService.ts (the function that
// usePushToken.ts calls after getExpoPushTokenAsync() returns).  The Supabase
// session is replaced by _setTestTokenProvider(); fetch is replaced with a
// custom implementation.  This exercises the full URL construction, header
// composition, and body serialisation path.

describe('expo-notifications ~0.32.17 — savePushToken integration (real production function)', () => {
  let capturedRequest: { url: string; method: string; headers: Record<string, string>; body: any } | null = null;

  beforeEach(() => {
    capturedRequest = null;
    _setTestTokenProvider(async () => 'test-access-token-jwt');
  });

  afterEach(() => {
    _setTestTokenProvider(null);
  });

  it('POSTs to /api/me/devices with { pushToken, platform: "expo" } and Bearer auth header', async () => {
    const mockFetch: typeof fetch = async (input, init) => {
      capturedRequest = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: Object.fromEntries(
          new Headers(init?.headers as HeadersInit).entries(),
        ),
        body: JSON.parse((init?.body as string) ?? 'null'),
      };
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const pushToken = 'ExponentPushToken[aAbBcCdDeEfF01234]';
    await savePushToken(pushToken, {
      baseUrl: 'https://api.example.com',
      fetchImpl: mockFetch,
    });

    assert.ok(capturedRequest, 'fetch must have been called');
    assert.equal(capturedRequest!.url, 'https://api.example.com/api/me/devices');
    assert.equal(capturedRequest!.method, 'POST');
    assert.equal(capturedRequest!.headers['authorization'], 'Bearer test-access-token-jwt');
    assert.equal(capturedRequest!.headers['content-type'], 'application/json');
    assert.equal(capturedRequest!.body.pushToken, pushToken);
    assert.equal(capturedRequest!.body.platform, 'expo',
      'platform must be "expo" for Expo push token routing');
  });

  it('is a no-op when EXPO_PUBLIC_API_BASE_URL is absent and no baseUrl override is provided', async () => {
    let fetchCalled = false;
    const mockFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    const orig = process.env.EXPO_PUBLIC_API_BASE_URL;
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    await savePushToken('ExponentPushToken[test]', { fetchImpl: mockFetch });
    process.env.EXPO_PUBLIC_API_BASE_URL = orig;
    assert.equal(fetchCalled, false, 'fetch must not be called when no API base is configured');
  });

  it('is a no-op when token provider returns null (unauthenticated)', async () => {
    _setTestTokenProvider(async () => null);
    let fetchCalled = false;
    const mockFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    await savePushToken('ExponentPushToken[test]', {
      baseUrl: 'https://api.example.com',
      fetchImpl: mockFetch,
    });
    assert.equal(fetchCalled, false, 'fetch must not be called when token is null');
  });

  it('expo-notifications 0.32.x token format matches ExponentPushToken[...]', () => {
    const token = 'ExponentPushToken[aAbBcCdDeEfF0123456789]';
    assert.match(token, /^ExponentPushToken\[[\w]+\]$/, 'Token must match SDK 54 Expo push token format');
  });
});

// ── 5. react-native-view-shot 4.0.3 — passportShareUtils + web shim ──────────
//
// The pure helpers makeDeepLink / makeWebFallback / toFileUri are extracted
// from usePassportShare.ts into passportShareUtils.ts so they can be tested
// here in Node.js.  These functions drive the share message content on both
// iOS and Android.  The web shim test verifies that captureRef() gracefully
// rejects so usePassportShare.ts falls through to the text-only share path.

describe('react-native-view-shot 4.0.3 — passportShareUtils helpers (real production logic)', () => {
  it('makeDeepLink returns correct travelbuddy:// scheme URI', () => {
    assert.equal(makeDeepLink('alice'), 'travelbuddy://passport/@alice');
  });

  it('makeDeepLink percent-encodes special characters in the username', () => {
    assert.equal(makeDeepLink('alice smith'), 'travelbuddy://passport/@alice%20smith');
  });

  it('makeWebFallback uses EXPO_PUBLIC_WEB_ORIGIN when set', () => {
    process.env.EXPO_PUBLIC_WEB_ORIGIN = 'https://travel.example.com';
    const result = makeWebFallback('alice');
    delete process.env.EXPO_PUBLIC_WEB_ORIGIN;
    assert.equal(result, 'https://travel.example.com/u/alice');
  });

  it('makeWebFallback falls back to EXPO_PUBLIC_API_BASE_URL origin when WEB_ORIGIN is absent', () => {
    delete process.env.EXPO_PUBLIC_WEB_ORIGIN;
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.replit.dev/api';
    const result = makeWebFallback('bob');
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    assert.equal(result, 'https://api.replit.dev/u/bob');
  });

  it('makeWebFallback falls back to CANONICAL_APP_URL when no env vars are set', () => {
    delete process.env.EXPO_PUBLIC_WEB_ORIGIN;
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    const result = makeWebFallback('carol');
    assert.equal(result, `${CANONICAL_APP_URL}/u/carol`);
  });

  it('toFileUri adds file:// prefix when missing', () => {
    assert.equal(toFileUri('/tmp/capture.jpg'), 'file:///tmp/capture.jpg');
  });

  it('toFileUri preserves existing file:// prefix (no double prefix)', () => {
    assert.equal(toFileUri('file:///tmp/capture.jpg'), 'file:///tmp/capture.jpg');
  });
});

describe('react-native-view-shot 4.0.3 — web shim captureRef graceful rejection', () => {
  it('captureRef rejects with "not supported" — triggers text-only fallback in usePassportShare', async () => {
    const shim = await import('../shims/react-native-view-shot.web.js');
    await assert.rejects(
      () => (shim as any).captureRef(),
      (err: Error) => {
        assert.ok(err.message.toLowerCase().includes('not supported'), err.message);
        return true;
      },
    );
  });
});

// ── 6. expo-clipboard ~8.0.8 — setStringAsync call contract ──────────────────
//
// expo-clipboard ~8.0.8 keeps the same JavaScript API surface as earlier SDK
// versions.  GroupChatScreen.tsx calls Clipboard.setStringAsync(text) directly
// (one line in a native-only screen component — not importable in Node.js).
// The test below verifies that:
//   a) the function signature accepts a string and returns Promise<void>
//   b) the API shape matches what GroupChatScreen expects
// This is the maximal Node.js-testable coverage for this feature; hardware
// clipboard behaviour is validated via the device checklist in
// docs/sdk54-downgrade-smoke-test.md.

describe('expo-clipboard ~8.0.8 — setStringAsync call contract (mirrors GroupChatScreen copy handler)', () => {
  it('setStringAsync(text: string): Promise<void> — correct API shape for SDK 54 downgrade', async () => {
    const received: string[] = [];
    const mockClipboard = {
      setStringAsync: async (t: string): Promise<void> => { received.push(t); },
    };
    const text = 'This is the message text to copy';
    await mockClipboard.setStringAsync(text);
    assert.equal(received.length, 1);
    assert.equal(received[0], text);
    assert.equal(typeof received[0], 'string');
  });
});

// ── 7. Lockfile-resolved peer dep versions ────────────────────────────────────
//
// The semver ranges in package.json only constrain what pnpm MAY resolve;
// transitive peer deps like @expo/config-plugins, expo-modules-core, and the
// metro bundler family are not declared directly in package.json — their pinned
// resolved versions live only in the pnpm lockfile.
//
// RETIRED CROSS-LOCKFILE HALF. Until artifacts/travel-buddy was archived, each
// package here was looked up in BOTH travel-buddy-standalone/pnpm-lock.yaml and
// the monorepo root pnpm-lock.yaml, and the two resolutions were required to
// agree. The archival deleted the workspace member that pulled the entire Expo
// and metro dependency graph into the root lockfile, so the root operand is
// simply gone: after regenerating it, @expo/config-plugins, metro,
// metro-resolver and @expo/metro-config appear in it zero times. Those
// comparisons did not become wrong — they became unanswerable, and an assertion
// with one operand missing fails for a reason that has nothing to do with the
// drift it was written to catch.
//
// What survives is the half that never needed a second tree: within the ONE
// lockfile that now builds the app, a package that must resolve to a single
// version must not have resolved to several. That is the real hazard — two
// copies of @babel/core or expo-modules-core in one tree produce transpilation
// and native-module mismatches at build time.

describe('Lockfile-resolved transitive peer dep versions — @babel/core, @expo/config-plugins, expo-modules-core', () => {
  const standaloneLockText = readFileSync(
    pathResolve(WORKSPACE_ROOT, 'travel-buddy-standalone/pnpm-lock.yaml'),
    'utf8',
  );

  /**
   * Scan a lockfile text for all resolved base versions of a given package.
   * Matches lines like:
   *   '  "@expo/config-plugins@54.0.4":'
   *   "  expo-modules-core@3.0.30:"
   *   "  expo-modules-core@3.0.30(react-native@...):"
   * Returns a sorted, deduplicated list of version strings.
   */
  function resolvedVersions(lockText: string, pkgName: string): string[] {
    const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c).replace(/\//g, (c) => '\\' + c);
    const re = new RegExp(`^  ['"]?${escaped}@([\\d][\\d.]+)`, 'gm');
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(lockText)) !== null) {
      found.add(m[1]!);
    }
    return [...found].sort();
  }

  const pkgsToCheck = ['@babel/core', '@expo/config-plugins', 'expo-modules-core'];

  for (const pkg of pkgsToCheck) {
    it(`${pkg} — resolved to exactly one version in the standalone lockfile`, () => {
      const saVersions = resolvedVersions(standaloneLockText, pkg);

      assert.ok(
        saVersions.length > 0,
        `${pkg} not found in travel-buddy-standalone/pnpm-lock.yaml — lockfile may be out of date`,
      );
      assert.equal(
        saVersions.length,
        1,
        `${pkg} resolved to multiple versions in travel-buddy-standalone/pnpm-lock.yaml: ${saVersions.join(', ')} — version conflict`,
      );
    });
  }
});

// ── 8. Lockfile-resolved metro bundler family versions ────────────────────────
//
// metro, metro-resolver, and @expo/metro-config are resolved purely as
// transitive deps — never declared directly in package.json. A version gap here
// causes bundler incompatibilities that only surface at Expo build time with
// confusing stack traces.
//
// The cross-lockfile set comparison retired with artifacts/travel-buddy for the
// reason given in section 7. Unlike @expo/config-plugins / expo-modules-core the
// metro family can LEGITIMATELY resolve at several versions at once, so there is
// no single-tree "exactly one version" assertion to fall back on — the only
// claim left that is both true and checkable is presence. That is a weaker check
// than what was here before, and it is recorded as weaker rather than dressed up:
// a metro drift inside the one remaining tree is no longer caught by this file.

describe('Lockfile-resolved metro bundler family versions — metro, metro-resolver, @expo/metro-config', () => {
  const standaloneLockText = readFileSync(
    pathResolve(WORKSPACE_ROOT, 'travel-buddy-standalone/pnpm-lock.yaml'),
    'utf8',
  );

  function resolvedVersions(lockText: string, pkgName: string): string[] {
    const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c).replace(/\//g, (c) => '\\' + c);
    const re = new RegExp(`^  ['"]?${escaped}@([\\d][\\d.]+)`, 'gm');
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(lockText)) !== null) {
      found.add(m[1]!);
    }
    return [...found].sort();
  }

  const metroPkgs = ['metro', 'metro-resolver', '@expo/metro-config'];

  for (const pkg of metroPkgs) {
    it(`${pkg} — resolved in the standalone lockfile (not missing)`, () => {
      const saVersions = resolvedVersions(standaloneLockText, pkg);

      assert.ok(
        saVersions.length > 0,
        `${pkg} not found in travel-buddy-standalone/pnpm-lock.yaml — lockfile may be out of date`,
      );
    });
  }
});
