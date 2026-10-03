import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getBlockList, getBlockerIds } from '../services/blocks.ts';
import { useSession } from './SessionContext.tsx';

interface BlockedIdsCtx {
  blockedIds: Set<string>;
  blockerIds: Set<string>;
  isLoading: boolean;
  /**
   * True when the last load for the signed-in account did not read one of the
   * two lists. The sets then hold the last list read for THIS account (empty
   * if none was), so an empty set with `loadFailed` means "not known", never
   * "you have blocked nobody".
   */
  loadFailed: boolean;
  addBlock: (id: string) => void;
  removeBlock: (id: string) => void;
  refresh: () => Promise<void>;
}

const BlockedIdsContext = createContext<BlockedIdsCtx>({
  blockedIds: new Set(),
  blockerIds: new Set(),
  isLoading: false,
  loadFailed: false,
  addBlock: () => {},
  removeBlock: () => {},
  refresh: async () => {},
});

/**
 * The block lists of the SIGNED-IN account (census-trust §31).
 *
 * The lists belong to one account. Signing out clears them; signing in as
 * anyone else clears them and loads that account's own. A response that
 * arrives after its request was superseded (a newer refresh, or a different
 * account) is dropped, so a slow load for the previous account cannot
 * overwrite the current one.
 */
export function BlockedIdsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthed, configured, userId } = useSession();
  const account = configured && isAuthed ? userId : null;
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [reverseIds, setReverseIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // The account whose lists are in state (null: none), and the number of the
  // newest request — a response carrying an older number is dropped.
  const listsFor = useRef<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    if (account === null) return;
    const seq = ++requestSeq.current;
    listsFor.current = account;
    setIsLoading(true);
    try {
      const [blockRes, blockerRes] = await Promise.all([getBlockList(), getBlockerIds()]);
      if (seq !== requestSeq.current) return;
      const blockRead = blockRes.ok && Array.isArray(blockRes.data);
      const blockerRead = blockerRes.ok && Array.isArray(blockerRes.data);
      if (blockRead) setIds(new Set(blockRes.data!.map((b) => b.id)));
      if (blockerRead) setReverseIds(new Set(blockerRes.data));
      setLoadFailed(!blockRead || !blockerRead);
    } catch {
      if (seq === requestSeq.current) setLoadFailed(true);
    } finally {
      // Always clear the loading flag even when a fetch hangs or throws,
      // so identity buttons are never permanently disabled.
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [account]);

  useEffect(() => {
    if (account !== null && listsFor.current === account) return;
    // A different account, or none: what is in memory is not this account's.
    requestSeq.current += 1;
    listsFor.current = null;
    setIds(new Set());
    setReverseIds(new Set());
    setLoadFailed(false);
    setIsLoading(false);
    if (account !== null) void load();
  }, [account, load]);

  const addBlock = useCallback((id: string) => {
    setIds((prev) => { const next = new Set(prev); next.add(id); return next; });
  }, []);

  const removeBlock = useCallback((id: string) => {
    setIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  const value = useMemo<BlockedIdsCtx>(
    () => ({ blockedIds: ids, blockerIds: reverseIds, isLoading, loadFailed, addBlock, removeBlock, refresh: load }),
    [ids, reverseIds, isLoading, loadFailed, addBlock, removeBlock, load],
  );

  return <BlockedIdsContext.Provider value={value}>{children}</BlockedIdsContext.Provider>;
}

export function useBlockedIds(): BlockedIdsCtx {
  return useContext(BlockedIdsContext);
}
