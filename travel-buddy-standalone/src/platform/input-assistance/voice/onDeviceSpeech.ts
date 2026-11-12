import type { SpeechRecognizerPort } from './speechRecognizer.ts';
import type { TranscriptionOutcome } from './transcriptionPort.ts';
import type { TranscriptionResult, VoiceUnavailableReason } from './types.ts';

export interface OnDeviceSpeechModule {
  capabilities(language: string): Promise<{ available: boolean; onDeviceOnly: true }>;
  start(options: { requestId: string; language: string; expiresAtMs: number }): Promise<void>;
  stop(options: { requestId: string }): Promise<void>;
  addListener(name: 'onResult' | 'onEnd', listener: (event: unknown) => void): { remove(): void };
}

const busy = new WeakSet<OnDeviceSpeechModule>();
let sequence = 0;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,4}$/;
function defaultLanguage(): string {
  try { const locale = Intl.DateTimeFormat().resolvedOptions().locale; if (LANGUAGE.test(locale)) return locale; } catch { /* Locale unavailable on an older JS runtime. */ }
  return 'en-US';
}
function failure(reason: VoiceUnavailableReason): TranscriptionOutcome {
  return { ok: false, unavailable: reason === 'on_device_unavailable' || reason === 'permission_denied', reason,
    error: reason === 'permission_denied' ? 'Microphone and speech permissions are required.'
      : reason === 'on_device_unavailable' ? 'On-device speech is unavailable for this language.' : 'Speech input could not finish. Try again.' };
}
async function available(module: OnDeviceSpeechModule, language: string): Promise<boolean> {
  if (!LANGUAGE.test(language)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const capabilities = await Promise.race([module.capabilities(language), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 4000); })]);
    return capabilities?.available === true && capabilities.onDeviceOnly === true;
  } catch { return false; } finally { if (timer) clearTimeout(timer); }
}

/** The native engine owns microphone lifetime independently of JavaScript timers. */
export function createOnDeviceSpeech(module: OnDeviceSpeechModule): SpeechRecognizerPort {
  return {
    providerId: 'portava-on-device-speech', onDeviceOnly: true,
    isAvailable: () => available(module, defaultLanguage()),
    recognizeOnce(options = {}): Promise<TranscriptionOutcome> {
      if (busy.has(module)) return Promise.resolve(failure('capture_failed'));
      const language = options.language?.trim() || defaultLanguage();
      if (!LANGUAGE.test(language)) return Promise.resolve(failure('on_device_unavailable'));
      busy.add(module);
      return new Promise(resolve => {
        const requestId = `speech-${Date.now().toString(36)}-${++sequence}`;
        let done = false;
        let started = false;
        let stopping = false;
        let final: TranscriptionResult | undefined;
        const listeners: Array<{ remove(): void }> = [];
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
        const empty = (): TranscriptionOutcome => ({ ok: true, result: { text: '', confidence: 0, isFinal: true, language } });
        const finish = (outcome: TranscriptionOutcome) => {
          if (done) return;
          done = true;
          options.signal?.removeEventListener('abort', stop);
          if (stopTimer) clearTimeout(stopTimer);
          if (lifetimeTimer) clearTimeout(lifetimeTimer);
          listeners.forEach(listener => listener.remove());
          busy.delete(module);
          resolve(outcome);
        };
        const stop = () => {
          if (done || stopping) return;
          stopping = true;
          if (!started) { finish(empty()); return; }
          // Wait briefly for the OS's final result; a missing end event cannot lock all future dictation.
          stopTimer = setTimeout(() => finish(final ? { ok: true, result: final } : empty()), 2500);
          void module.stop({ requestId }).catch(() => finish(failure('capture_failed')));
        };
        options.signal?.addEventListener('abort', stop, { once: true });
        if (options.signal?.aborted) { stop(); return; }
        void (async () => {
          if (!await available(module, language)) { if (!done) finish(failure('on_device_unavailable')); return; }
          if (done || stopping || options.signal?.aborted) return;
          const validEvent = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).requestId === requestId);
          listeners.push(module.addListener('onResult', value => {
            if (done || !validEvent(value) || typeof value.text !== 'string' || typeof value.isFinal !== 'boolean') return;
            const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : 0;
            const result = { text: value.text.slice(0, 8000), confidence, isFinal: value.isFinal, language };
            if (result.isFinal) final = result;
            else if (!stopping) options.onPartial?.(result);
          }));
          listeners.push(module.addListener('onEnd', value => {
            if (done || !validEvent(value)) return;
            if (typeof value.error === 'string') {
              const reason = value.error === 'permission_denied' || value.error === 'on_device_unavailable' || value.error === 'capture_failed' ? value.error : 'provider_error';
              finish(failure(reason));
            } else finish(final ? { ok: true, result: final } : empty());
          }));
          started = true;
          lifetimeTimer = setTimeout(stop, 60_000);
          await module.start({ requestId, language, expiresAtMs: Date.now() + 60_000 });
        })().catch(() => {
          if (started && !done) void module.stop({ requestId }).catch(() => undefined);
          if (!stopping) finish(failure('provider_error'));
        });
      });
    },
  };
}
