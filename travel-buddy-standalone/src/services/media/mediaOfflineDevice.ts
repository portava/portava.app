/**
 * mediaOfflineDevice — WHEN the offline media scopes are filled on a device.
 *
 * On launch and on each return to the foreground (at most every 30 minutes),
 * the signed-in user's saved places and their current or upcoming trips are
 * pre-cached through mediaOffline.prepareOfflineMedia, so the §39 content is on
 * the device BEFORE the user walks into a dead zone — a cache filled only by
 * what was last on screen is not an offline mode.
 *
 * The caller gates it: the offline surfaces are the Media World lenses, and
 * app/_layout.tsx only installs this while MEDIA_WORLD_SHELL_ENABLED is on, so
 * no request and no byte of storage is spent for a surface nobody can open.
 */
import { prepareOfflineMedia } from './mediaOffline.ts';

export const WARMUP_INTERVAL_MS = 30 * 60 * 1000;
const MAX_SAVED_PLACES = 30;
const MAX_TRIPS = 5;

export interface WarmupTrip {
  id: string;
  startDate: string | null;
  endDate: string | null;
  status?: string | null;
}

/** A trip worth having offline: not over (ended less than a day ago, or no end), not cancelled. */
export function tripsWorthCaching(trips: readonly WarmupTrip[], nowMs: number): string[] {
  const DAY = 24 * 60 * 60 * 1000;
  return trips
    .filter((t) => t.status !== 'cancelled' && t.status !== 'archived')
    .filter((t) => {
      const end = t.endDate ? Date.parse(t.endDate) : NaN;
      return !Number.isFinite(end) || end + DAY >= nowMs;
    })
    .slice(0, MAX_TRIPS)
    .map((t) => t.id);
}

export interface WarmupSources {
  savedPlaceIds(): Promise<string[]>;
  trips(): Promise<WarmupTrip[]>;
  now(): number;
  prepare: typeof prepareOfflineMedia;
}

async function deviceSources(): Promise<WarmupSources> {
  return {
    async savedPlaceIds() {
      const { listSaved } = await import('../discoveryBookmarks.ts');
      return (await listSaved()).map((p) => p.id);
    },
    async trips() {
      const { listMyTrips } = await import('../trips.ts');
      return listMyTrips();
    },
    now: () => Date.now(),
    prepare: prepareOfflineMedia,
  };
}

/** One warm-up pass. Never throws; a source that fails contributes nothing. */
export async function warmOfflineMedia(sources: WarmupSources): Promise<{ stored: number; skipped: number }> {
  const saved = await sources.savedPlaceIds().catch(() => [] as string[]);
  const trips = await sources.trips().catch(() => [] as WarmupTrip[]);
  return sources
    .prepare({ savedPlaceIds: saved.slice(0, MAX_SAVED_PLACES), tripIds: tripsWorthCaching(trips, sources.now()) })
    .catch(() => ({ stored: 0, skipped: 0 }));
}

/** Warm on install and on every foreground, throttled. Returns an unsubscribe. */
export function installMediaOfflineWarmup(
  appState: { addEventListener(type: 'change', listener: (state: string) => void): { remove(): void } },
  sources?: WarmupSources,
): () => void {
  let lastRun = -Infinity;
  let running = false;
  const run = async () => {
    const src = sources ?? (await deviceSources());
    const now = src.now();
    if (running || now - lastRun < WARMUP_INTERVAL_MS) return;
    running = true;
    lastRun = now;
    try {
      await warmOfflineMedia(src);
    } finally {
      running = false;
    }
  };
  void run().catch(() => {});
  const sub = appState.addEventListener('change', (state) => {
    if (state === 'active') void run().catch(() => {});
  });
  return () => sub.remove();
}
