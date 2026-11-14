import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const requireTool = createRequire(import.meta.url);
const { transformSync } = requireTool('esbuild');
const babel = requireTool('@babel/core');
const metroRuntime = readFileSync(requireTool.resolve('metro-runtime/src/polyfills/require.js'), 'utf8');
const sources = {
  upload: new URL('../media/backgroundTransfer.ts', import.meta.url),
  calendar: new URL('../calendar.ts', import.meta.url),
  navigation: new URL('../../features/trips/crew/tripNavigationHandoff.ts', import.meta.url),
};

/** Run the production module against the installed Metro runtime's real
 * importAll. Only the native/expo boundary is synthetic. Dynamic imports are
 * lowered to Metro's async namespace loader, rather than Node/Babel's different
 * namespace implementation, so the old iPhone-crashing code fails this test.
 */
function fixture(kind: keyof typeof sources, oldNamespaceImport = false) {
  const calls = { nativeLoads: 0, poisonReads: 0, uploads: 0, calendars: 0, opened: [] as string[], presence: 0 };
  const rn = { Platform: { OS: 'ios' }, Linking: { async openURL(url: string) { calls.opened.push(url); } } };
  Object.defineProperty(rn, 'PushNotificationIOS', { enumerable: true, get() {
    calls.poisonReads++;
    throw new Error('new NativeEventEmitter() requires a non-null argument');
  } });
  const modules: Record<string, unknown> = {
    'react-native': rn,
    'expo-file-system/legacy': {
      cacheDirectory: 'file:///cache/', FileSystemSessionType: { BACKGROUND: 1 },
      FileSystemUploadType: { BINARY_CONTENT: 0 }, EncodingType: { Base64: 'base64' },
      createUploadTask() { return { async uploadAsync() { calls.uploads++; return { status: 200 }; }, async cancelAsync() {} }; },
    },
    'expo-calendar': {
      EntityTypes: { EVENT: 'event' }, async requestCalendarPermissionsAsync() { return { status: 'granted' }; },
      async getCalendarsAsync() { return [{ id: 'primary', allowsModifications: true, isPrimary: true }]; },
      async createEventAsync() { calls.calendars++; return 'event-id'; },
    },
  };
  const context: any = { __DEV__: false, __METRO_GLOBAL_PREFIX__: '', process: { env: {} }, console };
  context.global = context;
  vm.createContext(context);
  vm.runInContext(metroRuntime, context);
  const ids = new Map(Object.keys(modules).map((name, index) => [name, index]));
  for (const [name, id] of ids) {
    context.__d((_global: unknown, _require: unknown, _default: unknown, _all: unknown, module: { exports: unknown }) => {
      if (name === 'react-native') calls.nativeLoads++;
      module.exports = modules[name];
    }, id, []);
  }
  function moduleId(name: string): number {
    const id = ids.get(name);
    assert.notEqual(id, undefined, `unexpected native dependency ${name}`);
    return id!;
  }
  context.require = (name: string) => context.__r(moduleId(name));
  context.__metroAsyncImport = async (name: string) => context.__r.importAll(moduleId(name));
  context.module = { exports: {} };
  context.exports = context.module.exports;
  let source = readFileSync(sources[kind], 'utf8');
  if (oldNamespaceImport) {
    const unsafe = source.replace("require('react-native') as typeof import('react-native')", "await import('react-native')");
    assert.notEqual(unsafe, source, 'negative control must restore the old namespace import');
    source = unsafe;
  }
  const js = transformSync(source, { loader: 'ts', format: 'cjs', target: 'esnext' }).code;
  const lowered = babel.transformSync(js, {
    babelrc: false, configFile: false,
    plugins: [() => ({ visitor: { CallExpression(path: any) {
      if (path.node.callee.type === 'Import') path.node.callee = { type: 'Identifier', name: '__metroAsyncImport' };
    } } })],
  }).code;
  vm.runInContext(lowered, context, { filename: fileURLToPath(sources[kind]) });
  assert.equal(calls.nativeLoads, 0, 'importing a pure service must not load React Native');
  return { service: context.module.exports as any, calls };
}

async function invoke(kind: keyof typeof sources, service: any, calls: ReturnType<typeof fixture>['calls']) {
  if (kind === 'upload') {
    const fs = await service.loadExpoFs();
    assert.ok(fs, 'native filesystem remains available');
    const result = await fs.createUploadTask('https://storage.test/upload', 'file:///cache/part', {
      httpMethod: 'PUT', uploadType: 0, sessionType: 1, headers: {},
    }).uploadAsync();
    assert.equal(result.status, 200);
    assert.equal(calls.uploads, 1);
  } else if (kind === 'calendar') {
    const result = await service.addMeetupToCalendar({ title: 'Meetup', startsAt: '2026-11-14T12:00:00Z' });
    assert.equal(result.ok, true);
    assert.equal(result.eventId, 'event-id');
    assert.equal(calls.calendars, 1);
  } else {
    const stored = new Map<string, string>();
    service._setStore({ async getItem(key: string) { return stored.get(key) ?? null; }, async setItem(key: string, value: string) { stored.set(key, value); }, async removeItem(key: string) { stored.delete(key); } });
    const result = await service.startNavigation('trip', { planItemId: 'plan', locationName: 'Museum' }, {
      async setPresence() { calls.presence++; return { ok: true, kind: 'applied', version: 1, applied: true }; },
    });
    assert.equal(result.state, 'started');
    assert.equal(calls.opened.length, 1);
    assert.equal(calls.presence, 1);
    assert.equal(stored.size, 1);
  }
}

for (const kind of Object.keys(sources) as Array<keyof typeof sources>) {
  test(`${kind}: real service reads only the required native properties, never PushNotificationIOS`, async () => {
    const { service, calls } = fixture(kind);
    await invoke(kind, service, calls);
    assert.equal(calls.nativeLoads, 1);
    assert.equal(calls.poisonReads, 0);
  });
  test(`${kind}: restoring the old import reproduces the Metro lazy-export failure`, async () => {
    const { service, calls } = fixture(kind, true);
    await assert.rejects(invoke(kind, service, calls));
    assert.equal(calls.poisonReads, 1, 'the installed Metro runtime evaluates the unrelated native getter');
    assert.equal(calls.uploads + calls.calendars + calls.opened.length + calls.presence, 0);
  });
}

test('native property loading preserves the upload account-lifetime refusal', async () => {
  const { service, calls } = fixture('upload');
  const controller = new AbortController();
  const fs = await service.loadExpoFs({ signal: controller.signal, isCurrent: () => false });
  assert.ok(fs);
  const task = fs.createUploadTask('https://storage.test/upload', 'file:///cache/part', {
    httpMethod: 'PUT', uploadType: 0, sessionType: 1, headers: {},
  });
  await assert.rejects(task.uploadAsync(), /Upload session changed/);
  assert.equal(calls.uploads, 0);
  assert.equal(calls.poisonReads, 0);
});
