import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getBlockList, getBlockerIds } from '../services/blocks.ts';
import { useSession } from './SessionContext.tsx';

interface BlockedIdsCtx {
  blockedIds: Set<string>;
  blockerIds: Set<string>;
  isLoading: boolean;
  addBlock: (id: string) => void;
  removeBlock: (id: string) => void;
  refresh: () => Promise<void>;
}

const BlockedIdsContext = createContext<BlockedIdsCtx>({
  blockedIds: new Set(),
  blockerIds: new Set(),
  isLoading: false,
  addBlock: () => {},
  removeBlock: () => {},
  refresh: async () => {},
});

export function BlockedIdsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthed, configured } = useSession();
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [reverseIds, setReverseIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    if (!configured || !isAuthed) return;
    setIsLoading(true);
    try {
      const [blockRes, blockerRes] = await Promise.all([getBlockList(), getBlockerIds()]);
      if (blockRes.ok && blockRes.data) {
        setIds(new Set(blockRes.data.map((b) => b.id)));
      }
      if (blockerRes.ok && blockerRes.data) {
        setReverseIds(new Set(blockerRes.data));
      }
      loaded.current = true;
    } finally {
      // Always clear the loading flag even when a fetch hangs or throws,
      // so identity buttons are never permanently disabled.
      setIsLoading(false);
    }
  }, [configured, isAuthed]);

  useEffect(() => {
    if (!loaded.current) { load(); }
  }, [load]);

  const addBlock = useCallback((id: string) => {
    setIds((prev) => { const next = new Set(prev); next.add(id); return next; });
  }, []);

  const removeBlock = useCallback((id: string) => {
    setIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  const value = useMemo<BlockedIdsCtx>(
    () => ({ blockedIds: ids, blockerIds: reverseIds, isLoading, addBlock, removeBlock, refresh: load }),
    [ids, reverseIds, isLoading, addBlock, removeBlock, load],
  );

  return <BlockedIdsContext.Provider value={value}>{children}</BlockedIdsContext.Provider>;
}

export function useBlockedIds(): BlockedIdsCtx {
  return useContext(BlockedIdsContext);
}
