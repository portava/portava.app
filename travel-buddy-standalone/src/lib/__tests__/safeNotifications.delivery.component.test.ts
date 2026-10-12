/**
 * safeNotifications carries a return alert's delivery to expo-notifications —
 * wave W, census-layover L18 / L41 (recon cluster A1).
 *
 * `scheduleLocalNotificationAt` used to send `{ content, trigger: {type, date} }`
 * and nothing else, so no caller could name a channel or a priority. These
 * cases assert the exact request that reaches the native module, and that a
 * caller who passes no delivery still sends the request it always sent.
 */

type Mod = {
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  scheduleNotificationAsync: jest.Mock;
  setNotificationChannelAsync: jest.Mock;
};

function load(os: 'ios' | 'android', opts: { entitlements?: Record<string, unknown>; channelThrows?: boolean; noModule?: boolean } = {}) {
  const mod: Mod = {
    getPermissionsAsync: jest.fn(async () => ({ granted: true })),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
    scheduleNotificationAsync: jest.fn(async () => 'id-1'),
    setNotificationChannelAsync: jest.fn(async () => {
      if (opts.channelThrows) throw new Error('refused');
      return {};
    }),
  };
  // A fresh registry per load, NOT isolateModules: the wrapper requires
  // expo-notifications and expo-constants lazily, at call time, so the mocks
  // must still be the registered ones when the case calls it. Each case uses a
  // load before taking the next one.
  jest.resetModules();
  {
    // NOTE: intentional stub — the real react-native module needs a native
    // runtime; the wrapper reads only Platform.OS and NativeModules.
    jest.doMock('react-native', () => ({
      Platform: { OS: os },
      NativeModules: opts.noModule ? {} : { ExpoNotifications: {} },
    }));
    // NOTE: intentional stub — the native module itself, recorded.
    jest.doMock('expo-notifications', () => mod);
    // NOTE: intentional stub — the build's app config, as expo-constants exposes it.
    jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { ios: { entitlements: opts.entitlements } } } }));
  }
  const lib = require('../safeNotifications.ts') as typeof import('../safeNotifications.ts');
  return { lib, mod };
}

const AT = new Date(Date.now() + 60 * 60_000);
const CONTENT = { title: 'Head back to TPE now', body: 'Go', data: { rung: 'RETURN_NOW' } };

describe('scheduleLocalNotificationAt — delivery reaches the native request', () => {
  it('with no delivery, the request is exactly the one it always was', async () => {
    const { lib, mod } = load('android');
    expect(await lib.scheduleLocalNotificationAt(AT, CONTENT)).toBe('id-1');
    expect(mod.scheduleNotificationAsync).toHaveBeenCalledWith({ content: CONTENT, trigger: { type: 'date', date: AT } });
  });

  it('the channel goes on the TRIGGER, priority and interruption level on the CONTENT', async () => {
    const { lib, mod } = load('android');
    await lib.scheduleLocalNotificationAt(AT, CONTENT, { channelId: 'layover_return', priority: 'max', interruptionLevel: 'timeSensitive' });
    expect(mod.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { ...CONTENT, priority: 'max', interruptionLevel: 'timeSensitive' },
      trigger: { type: 'date', date: AT, channelId: 'layover_return' },
    });
  });
});

describe('setNotificationChannelAsync — says whether the channel may be named', () => {
  it('Android: true once created, false when the OS refuses or there is no module', async () => {
    const ok = load('android');
    expect(await ok.lib.setNotificationChannelAsync('layover_return', { name: 'x', importance: 6 })).toBe(true);
    expect(ok.mod.setNotificationChannelAsync).toHaveBeenCalledWith('layover_return', { name: 'x', importance: 6 });
    expect(await load('android', { channelThrows: true }).lib.setNotificationChannelAsync('layover_return', { name: 'x', importance: 6 })).toBe(false);
    expect(await load('android', { noModule: true }).lib.setNotificationChannelAsync('layover_return', { name: 'x', importance: 6 })).toBe(false);
  });

  it('iOS has no channels: nothing is created and nothing is in the way', async () => {
    const { lib, mod } = load('ios');
    expect(await lib.setNotificationChannelAsync('layover_return', { name: 'x', importance: 6 })).toBe(true);
    expect(mod.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('iosTimeSensitiveAvailable — only a build that carries the Apple entitlement', () => {
  it('false today (no entitlement in the app config), on Android, and for anything but a literal true', () => {
    expect(load('ios').lib.iosTimeSensitiveAvailable()).toBe(false);
    expect(load('ios', { entitlements: { 'com.apple.developer.usernotifications.time-sensitive': 'true' } }).lib.iosTimeSensitiveAvailable()).toBe(false);
    expect(load('android', { entitlements: { 'com.apple.developer.usernotifications.time-sensitive': true } }).lib.iosTimeSensitiveAvailable()).toBe(false);
  });
  it('true once the build is signed with it', () => {
    expect(load('ios', { entitlements: { 'com.apple.developer.usernotifications.time-sensitive': true } }).lib.iosTimeSensitiveAvailable()).toBe(true);
  });
});

describe('getScheduledNotificationIds — what the OS still holds, or "cannot say" (OD-1012-LAY-1)', () => {
  it('answers the identifiers the native module lists', async () => {
    const { lib, mod } = load('ios');
    (mod as any).getAllScheduledNotificationsAsync = jest.fn(async () => [{ identifier: 'a' }, { identifier: 'b' }, { identifier: 7 }]);
    expect(await lib.getScheduledNotificationIds()).toEqual(new Set(['a', 'b']));
  });

  it('answers NULL — unknown, never "none" — with no module, no listing API, a throw, or a non-list', async () => {
    expect(await load('ios', { noModule: true }).lib.getScheduledNotificationIds()).toBeNull();
    expect(await load('android').lib.getScheduledNotificationIds()).toBeNull();
    const t = load('android');
    (t.mod as any).getAllScheduledNotificationsAsync = jest.fn(async () => { throw new Error('native'); });
    expect(await t.lib.getScheduledNotificationIds()).toBeNull();
    const n = load('android');
    (n.mod as any).getAllScheduledNotificationsAsync = jest.fn(async () => null);
    expect(await n.lib.getScheduledNotificationIds()).toBeNull();
  });
});
