/**
 * mediaEvents — lightweight event emitter for cross-component media signals.
 *
 * Currently used to pause all active players when the Media tab loses focus
 * (MEDIA_PAUSE_ALL). Future player instances subscribe to this emitter rather
 * than requiring prop drilling or a shared store update cycle.
 *
 * Usage:
 *   // Subscribe (e.g. inside a player component):
 *   useEffect(() => mediaEvents.on('MEDIA_PAUSE_ALL', handlePause), []);
 *
 *   // Emit (e.g. from the Media screen's useFocusEffect blur):
 *   mediaEvents.emit('MEDIA_PAUSE_ALL');
 */

type MediaEventName = 'MEDIA_PAUSE_ALL';
type Listener = () => void;

class MediaEventEmitter {
  private listeners: Map<MediaEventName, Set<Listener>> = new Map();

  on(event: MediaEventName, listener: Listener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    // Return an unsubscribe function for use in useEffect cleanup.
    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  emit(event: MediaEventName): void {
    this.listeners.get(event)?.forEach((fn) => {
      try { fn(); } catch { /* never crash the emitter */ }
    });
  }
}

export const mediaEvents = new MediaEventEmitter();
