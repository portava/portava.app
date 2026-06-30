import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getBlockList } from '../services/blocks';
import { useSession } from './SessionContext';

interface BlockedIdsCtx {
  blockedIds: Set<string>;
  isLoading: boolean;
  addBlock: (id: string) => void;
  removeBlock: (id: string) => void;
  refresh: () => Promise<void>;
}

const BlockedIdsContext = createContext<BlockedIdsCtx>({
  blockedIds: new Set(),
  isLoading: false,
  addBlock: () => {},
  removeBlock: () => {},
  refresh: async () => {},
});

export function BlockedIdsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthed, configured } = useSession();
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    if (!configured || !isAuthed) return;
    setIsLoading(true);
    const res = await getBlockList();
    setIsLoading(false);
    if (res.ok && res.data) {
      setIds(new Set(res.data.map((b) => b.id)));
    }
    loaded.current = true;
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
    () => ({ blockedIds: ids, isLoading, addBlock, removeBlock, refresh: load }),
    [ids, isLoading, addBlock, removeBlock, load],
  );

  return <BlockedIdsContext.Provider value={value}>{children}</BlockedIdsContext.Provider>;
}

export function useBlockedIds(): BlockedIdsCtx {
  return useContext(BlockedIdsContext);
}
