export type DubbingReleaseOutcome = 'released' | 'native_uncertain' | 'restoration_failed';

export interface DubbingPlaybackResource {
  controller: object;
  ownsMute(): boolean;
  cancel(): void;
  release(): Promise<DubbingReleaseOutcome>;
}

export interface DubbingPlaybackLease {
  retire(): Promise<DubbingReleaseOutcome>;
}

export function createDubbingPlaybackLifetime() {
  type Entry = {
    resource: DubbingPlaybackResource;
    state: 'active' | 'retiring' | DubbingReleaseOutcome;
    pending: Promise<DubbingReleaseOutcome> | null;
  };
  const entries = new Set<Entry>();
  const listeners = new Set<() => void>();
  let revision = 0;

  function notify() {
    revision += 1;
    for (const listener of listeners) {
      try { listener(); } catch {}
    }
  }

  function canAdmit(controller: object): boolean {
    return !Array.from(entries).some(entry => entry.state !== 'active' || entry.resource.controller === controller);
  }

  function retain(resource: DubbingPlaybackResource): DubbingPlaybackLease | null {
    if (!canAdmit(resource.controller)) return null;
    const entry: Entry = { resource, state: 'active', pending: null };
    entries.add(entry);
    return {
      retire() {
        if (entry.pending) return entry.pending;
        if (entry.state === 'released' || entry.state === 'native_uncertain') return Promise.resolve(entry.state);
        entry.state = 'retiring';
        let cancellationFailed = false;
        entry.pending = Promise.resolve().then(async (): Promise<DubbingReleaseOutcome> => {
          try {
            const outcome = await resource.release();
            if (cancellationFailed || !['released', 'native_uncertain', 'restoration_failed'].includes(outcome)) return 'native_uncertain';
            return outcome;
          } catch { return 'native_uncertain'; }
        }).then(outcome => {
          entry.state = outcome;
          entry.pending = null;
          if (outcome === 'released') entries.delete(entry);
          notify();
          return outcome;
        });
        const pending = entry.pending;
        try { resource.cancel(); } catch { cancellationFailed = true; }
        notify();
        return pending;
      },
    };
  }

  return {
    retain,
    canAdmit,
    inspect(controller: object | null) {
      const retained = Array.from(entries).filter(entry => entry.state !== 'active');
      return {
        blocked: retained.length > 0,
        pending: retained.some(entry => entry.state === 'retiring'),
        ownsMute: retained.some(entry => {
          if (entry.resource.controller !== controller) return false;
          try { return entry.resource.ownsMute(); } catch { return true; }
        }),
      };
    },
    getRevision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const dubbingPlaybackLifetime = createDubbingPlaybackLifetime();
