import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

/** Only the topmost post modal owns playback. A covered feed stays mounted at its scroll position. */
export const PostPlaybackLayer = createContext<symbol | null>(null);
const stack: symbol[] = [];
const listeners = new Set<() => void>();
const top = () => stack.at(-1) ?? null;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => listeners.forEach(listener => listener());
export function enterPostPlaybackLayer(layer: symbol): () => void {
  stack.push(layer); notify();
  return () => {
    const index = stack.lastIndexOf(layer);
    if (index >= 0) { stack.splice(index, 1); notify(); }
  };
}
export function usePostPlaybackLayer() {
  const layer = useContext(PostPlaybackLayer);
  const current = useSyncExternalStore(subscribe, top, top);
  const isCurrent = useCallback(() => layer === top(), [layer]);
  return { allowed: current === layer, isCurrent };
}
