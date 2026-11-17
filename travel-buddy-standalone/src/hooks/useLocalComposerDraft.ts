import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { composerDraftKey, readComposerDraft, writeComposerDraft, deleteComposerDraft } from '../services/localComposerDraft.ts';
/** Account/composer-keyed local recovery. One-shot saves; no network or polling.
 * Callers remount on account/composer changes, and keep this data out of telemetry.
 */
export function useLocalComposerDraft<T>({ accountId, composer, initial, validate, nonempty, active = true, onLeave }: {
    accountId: string | null | undefined;
    composer: string;
    initial: T;
    validate: (value: unknown) => value is T;
    nonempty: (value: T) => boolean;
    active?: boolean;
    onLeave?: () => void;
}) {
    const key = accountId ? composerDraftKey(accountId, composer) : null;
    const [value, setState] = useState(initial);
    const [ready, setReady] = useState(!key);
    const [error, setError] = useState<string | null>(null);
    const current = useRef(value), dirty = useRef(false), loaded = useRef(false), live = useRef(true);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const left = useRef(false);
    const latest = useRef({ nonempty, onLeave });
    useLayoutEffect(() => { latest.current = { nonempty, onLeave }; }, [nonempty, onLeave]);
    const stopTimer = useCallback(() => { if (timer.current)
        clearTimeout(timer.current); timer.current = null; }, []);
    const persist = useCallback(async () => {
        stopTimer();
        if (!key || !loaded.current)
            return false;
        if (!dirty.current)
            return true;
        const saving = current.current;
        try {
            await writeComposerDraft(AsyncStorage, key, saving);
            if (current.current === saving)
                dirty.current = false;
            if (live.current)
                setError(null);
            return true;
        }
        catch {
            if (live.current)
                setError('Draft could not be saved on this device. Keep this screen open and try again.');
            return false;
        }
    }, [key, stopTimer]);
    const leave = useCallback(() => {
        void persist();
        if (!left.current && latest.current.nonempty(current.current)) {
            left.current = true;
            latest.current.onLeave?.();
        }
    }, [persist]);
    useEffect(() => {
        live.current = true;
        let cancelled = false;
        if (!key) {
            loaded.current = false;
            return () => { live.current = false; stopTimer(); };
        }
        void readComposerDraft(AsyncStorage, key, validate).then(saved => {
            if (cancelled)
                return;
            loaded.current = true;
            if (!dirty.current && saved !== null) {
                current.current = saved;
                setState(saved);
            }
            if (saved === null && latest.current.nonempty(current.current))
                dirty.current = true;
            setReady(true);
            if (dirty.current)
                void persist();
        }).catch(() => { if (!cancelled) {
            setReady(true);
            setError('Draft could not be restored. Your saved copy has been kept.');
        } });
        return () => { cancelled = true; live.current = false; leave(); stopTimer(); };
    }, [key, validate, persist, leave, stopTimer]);
    useEffect(() => {
        if (!active) {
            // Visibility changes flush external storage; save errors arrive after asynchronous I/O.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            leave();
        } else {
            left.current = false;
        }
    }, [active, leave]);
    useEffect(() => {
        const sub = AppState.addEventListener('change', state => { if (state !== 'active')
            void persist(); });
        return () => sub.remove();
    }, [persist]);
    const setValue = useCallback((next: T | ((previous: T) => T)) => {
        const updated = typeof next === 'function' ? (next as (previous: T) => T)(current.current) : next;
        if (Object.is(updated, current.current))
            return;
        current.current = updated;
        dirty.current = true;
        left.current = false;
        setState(updated);
        stopTimer();
        // Local debounce avoids a disk write per keystroke. Background/leave flushes it.
        timer.current = setTimeout(() => { void persist(); }, 250);
    }, [persist, stopTimer]);
    const clear = useCallback(async (empty: T, expected?: T) => {
        // A successful old submission must not clear text entered since that request.
        if (expected !== undefined && JSON.stringify(current.current) !== JSON.stringify(expected))
            return false;
        stopTimer();
        if (key) {
            try {
                await deleteComposerDraft(AsyncStorage, key);
            }
            catch {
                if (live.current)
                    setError('Draft could not be cleared on this device. Try again.');
                return false;
            }
        }
        if (expected !== undefined && JSON.stringify(current.current) !== JSON.stringify(expected)) {
            void persist();
            return false;
        }
        current.current = empty;
        dirty.current = false;
        loaded.current = true;
        left.current = true;
        if (live.current) {
            setState(empty);
            setError(null);
        }
        return true;
    }, [key, persist, stopTimer]);
    return { value, setValue, ready, error, persist, leave, clear };
}
