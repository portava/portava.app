import { createOnDeviceSpeech, type OnDeviceSpeechModule } from '../onDeviceSpeech.ts';
function native() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const module: OnDeviceSpeechModule = {
    capabilities: jest.fn(async () => ({ available: true, onDeviceOnly: true as const })),
    start: jest.fn(async () => undefined), stop: jest.fn(async () => undefined),
    addListener: (name, listener) => {
      const bucket = listeners.get(name) ?? new Set(); bucket.add(listener); listeners.set(name, bucket);
      return { remove: () => { bucket.delete(listener); } };
    },
  };
  const emit = (name: string, value: unknown) => listeners.get(name)?.forEach(fn => fn(value));
  const id = () => (module.start as jest.Mock).mock.calls.at(-1)![0].requestId;
  return { module, emit, id, listeners };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('checks selected model and preserves final OS transcript after release', async () => {
  const { module, emit, id, listeners } = native(); const controller = new AbortController(); const partial = jest.fn();
  const outcome = createOnDeviceSpeech(module).recognizeOnce({ language: 'fr-FR', signal: controller.signal, onPartial: partial }); await settle();
  expect(module.capabilities).toHaveBeenCalledWith('fr-FR');
  expect(module.start).toHaveBeenCalledWith(expect.objectContaining({ language: 'fr-FR', expiresAtMs: Date.now() + 60000 }));
  emit('onResult', { requestId: id(), text: 'bonjour', isFinal: false, confidence: 0.8 }); expect(partial).toHaveBeenCalledTimes(1);
  controller.abort(); expect(module.stop).toHaveBeenCalledWith({ requestId: id() });
  emit('onResult', { requestId: id(), text: 'bonjour monde', isFinal: true, confidence: 0.95 }); emit('onEnd', { requestId: id() });
  expect(await outcome).toEqual({ ok: true, result: { text: 'bonjour monde', confidence: 0.95, isFinal: true, language: 'fr-FR' } });
  expect([...listeners.values()].every(bucket => bucket.size === 0)).toBe(true);
});
it('release during a deferred model check never starts a late microphone', async () => {
  const { module } = native(); let ready!: (value: { available: boolean; onDeviceOnly: true }) => void;
  module.capabilities = () => new Promise(resolve => { ready = resolve; }); const controller = new AbortController();
  const outcome = createOnDeviceSpeech(module).recognizeOnce({ signal: controller.signal }); controller.abort();
  expect(await outcome).toMatchObject({ ok: true, result: { text: '' } });
  ready({ available: true, onDeviceOnly: true }); await settle(); expect(module.start).not.toHaveBeenCalled();
});
it('release while permission is pending stops and bounds a missing end event', async () => {
  const { module } = native(); let started!: () => void;
  module.start = jest.fn(() => new Promise(resolve => { started = resolve; }));
  const controller = new AbortController(); const recognizer = createOnDeviceSpeech(module);
  const first = recognizer.recognizeOnce({ signal: controller.signal }); await settle(); controller.abort(); expect(module.stop).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(2500); await settle(); expect(await first).toMatchObject({ ok: true, result: { text: '' } }); started(); await settle();
  const next = new AbortController(); const second = recognizer.recognizeOnce({ signal: next.signal }); await settle();
  expect(module.start).toHaveBeenCalledTimes(2); next.abort(); jest.advanceTimersByTime(2500); await second;
});
it('uninstalled models and dishonest capabilities cannot open capture', async () => {
  const { module } = native(); (module.capabilities as jest.Mock).mockResolvedValue({ available: false, onDeviceOnly: true });
  expect(await createOnDeviceSpeech(module).recognizeOnce({ language: 'vi-VN' })).toMatchObject({ ok: false, reason: 'on_device_unavailable' });
  (module.capabilities as jest.Mock).mockResolvedValue({ available: true, onDeviceOnly: false });
  expect(await createOnDeviceSpeech(module).recognizeOnce()).toMatchObject({ ok: false, reason: 'on_device_unavailable' }); expect(module.start).not.toHaveBeenCalled();
});
it('permission denial settles and stale request events cannot populate another capture', async () => {
  const { module, emit, id } = native(); const recognizer = createOnDeviceSpeech(module);
  const first = recognizer.recognizeOnce(); await settle(); const old = id(); emit('onEnd', { requestId: old, error: 'permission_denied' });
  expect(await first).toMatchObject({ ok: false, reason: 'permission_denied' });
  const second = recognizer.recognizeOnce(); await settle();
  emit('onResult', { requestId: old, text: 'stale secret', isFinal: true }); emit('onEnd', { requestId: old });
  emit('onResult', { requestId: id(), text: 'new words', confidence: 0.9, isFinal: true }); emit('onEnd', { requestId: id() });
  expect(await second).toMatchObject({ ok: true, result: { text: 'new words' } });
});
it('serializes surfaces and expires a hold without an OS end callback', async () => {
  const { module } = native(); const first = createOnDeviceSpeech(module).recognizeOnce(); await settle();
  expect(await createOnDeviceSpeech(module).recognizeOnce()).toMatchObject({ ok: false, reason: 'capture_failed' });
  jest.advanceTimersByTime(60000); await settle(); expect(module.stop).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(2500); expect(await first).toMatchObject({ ok: true, result: { text: '' } });
});
it('capability timeout and native start rejection recover without a stale capture lock', async () => {
  const { module } = native(); module.capabilities = jest.fn(() => new Promise(() => undefined));
  const unavailable = createOnDeviceSpeech(module).recognizeOnce(); jest.advanceTimersByTime(4000); await settle();
  expect(await unavailable).toMatchObject({ ok: false, reason: 'on_device_unavailable' });
  module.capabilities = jest.fn(async () => ({ available: true, onDeviceOnly: true as const }));
  module.start = jest.fn(async () => { throw new Error('OS failed to start'); });
  expect(await createOnDeviceSpeech(module).recognizeOnce()).toMatchObject({ ok: false, reason: 'provider_error' }); expect(module.stop).toHaveBeenCalledTimes(1);
});
