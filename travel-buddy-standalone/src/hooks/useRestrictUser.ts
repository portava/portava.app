import { useState } from 'react';
import { restrictUser, unrestrictUser } from '../services/restrict';

export function useRestrictUser() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doRestrict(userId: string): Promise<boolean> {
    setLoading(true); setError(null);
    const res = await restrictUser(userId);
    setLoading(false);
    if (res.ok) return true;
    setError(res.error ?? 'Failed to restrict');
    return false;
  }

  async function doUnrestrict(userId: string): Promise<boolean> {
    setLoading(true); setError(null);
    const res = await unrestrictUser(userId);
    setLoading(false);
    if (res.ok) return true;
    setError(res.error ?? 'Failed to unrestrict');
    return false;
  }

  return { doRestrict, doUnrestrict, loading, error };
}
