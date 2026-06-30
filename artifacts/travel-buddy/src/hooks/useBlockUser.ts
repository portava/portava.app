import { useState } from 'react';
import { blockUser, unblockUser } from '../services/blocks';
import { useBlockedIds } from '../context/BlockedIdsContext';

export function useBlockUser() {
  const { addBlock, removeBlock } = useBlockedIds();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doBlock(userId: string): Promise<boolean> {
    setLoading(true); setError(null);
    const res = await blockUser(userId);
    setLoading(false);
    if (res.ok) { addBlock(userId); return true; }
    setError(res.error ?? 'Failed to block');
    return false;
  }

  async function doUnblock(userId: string): Promise<boolean> {
    setLoading(true); setError(null);
    const res = await unblockUser(userId);
    setLoading(false);
    if (res.ok) { removeBlock(userId); return true; }
    setError(res.error ?? 'Failed to unblock');
    return false;
  }

  return { doBlock, doUnblock, loading, error };
}
