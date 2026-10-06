/**
 * Global Input Intelligence — dictation state for one field (§25, census G163,
 * flow GII-F09).
 *
 * Every state is a true statement about the device:
 *   checking    — asking whether this build can recognise speech at all;
 *   unavailable — it cannot, and `message` says why (never a silent no-op);
 *   idle        — it can; nothing is happening;
 *   listening   — the recognizer has the microphone (partials are display-only);
 *   heard       — a transcript passed the intake and was handed to the field;
 *   refused     — something was heard but not trusted (empty / low confidence);
 *   error       — the attempt failed (e.g. permission off); it can be retried.
 *
 * The transcript handed to `onTranscript` is the intake's `request.text` — the
 * typed path's own builder shaped it — and from there it is ordinary text in
 * the field's ordinary pipeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InputContext } from '../types/inputContext.ts';
import { dictateIntoField } from '../voice/voiceIntake.ts';
import type { SpeechRecognizerPort } from '../voice/speechRecognizer.ts';
import { resolveSpeechRecognizer } from '../voice/speechRecognizer.ts';
import type { VoiceRefusalReason } from '../voice/types.ts';

export type DictationState =
  | { phase: 'checking' }
  | { phase: 'unavailable'; message: string }
  | { phase: 'idle' }
  | { phase: 'listening'; partial: string | null }
  | { phase: 'heard'; text: string }
  | { phase: 'refused'; message: string }
  | { phase: 'error'; message: string };

const REFUSAL_COPY: Record<VoiceRefusalReason, string> = {
  empty_transcript: 'Didn’t hear anything — try again.',
  low_confidence: 'Didn’t catch that clearly — try again.',
  interim_transcript: 'That wasn’t finished — try again.',
  no_policy: 'Voice input isn’t set up for this field.',
};

export interface UseVoiceDictationOptions {
  fieldId: string;
  context: InputContext;
  onTranscript: (text: string) => void;
  language?: string | null;
  /** Injected in tests; defaults to `resolveSpeechRecognizer()` — on-device only (OD-INPUT-5). */
  recognizer?: SpeechRecognizerPort;
}

export function useVoiceDictation({ fieldId, context, onTranscript, language, recognizer }: UseVoiceDictationOptions) {
  const [state, setState] = useState<DictationState>({ phase: 'checking' });
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  // Resolved once per mount, so the availability check runs once. The resolver
  // returns an installed recognizer that declares on-device processing, or
  // none — never the browser's own engine (speechRecognizer.ts header).
  const port = useMemo(() => recognizer ?? resolveSpeechRecognizer(), [recognizer]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    port.isAvailable().then(
      (ok) => {
        if (cancelled) return;
        setState(ok
          ? { phase: 'idle' }
          : { phase: 'unavailable', message: 'Voice input isn’t available on this build yet — it needs a speech recognizer the app doesn’t include.' });
      },
      () => { if (!cancelled) setState({ phase: 'unavailable', message: 'Speech recognition isn’t available on this device right now.' }); },
    );
    return () => {
      cancelled = true;
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, [port]);

  const start = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ phase: 'listening', partial: null });
    const outcome = await dictateIntoField(
      { fieldId, context, language },
      {
        recognizer: port,
        signal: ctrl.signal,
        onPartial: (r) => { if (mounted.current) setState({ phase: 'listening', partial: r.text }); },
      },
    );
    if (!mounted.current) return;
    if (outcome.state === 'accepted') {
      onTranscript(outcome.request.text);
      setState({ phase: 'heard', text: outcome.request.text });
    } else if (outcome.state === 'refused') {
      setState({ phase: 'refused', message: REFUSAL_COPY[outcome.reason] });
    } else if (outcome.reason === 'on_device_unavailable') {
      setState({ phase: 'unavailable', message: outcome.error ?? 'Voice input needs on-device speech recognition here.' });
    } else if (outcome.reason === 'no_provider') {
      setState({ phase: 'unavailable', message: outcome.error ?? 'Voice input isn’t available on this build.' });
    } else if (outcome.reason === 'capture_failed') {
      setState({ phase: 'refused', message: 'Didn’t hear anything — try again.' });
    } else {
      setState({ phase: 'error', message: outcome.error ?? 'Voice input failed. Try again.' });
    }
  }, [fieldId, context, language, port, onTranscript]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  return { state, start, stop };
}
