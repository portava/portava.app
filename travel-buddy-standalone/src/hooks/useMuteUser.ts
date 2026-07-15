import { useState } from 'react';
import { muteUser, unmuteUser } from '../services/mutes';

export function useMuteUser() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doMute(userId: string): Promise<boolean> {
    setLoading(true); setError(null);
    const res = await muteUser(userId);
    setLoading(false);
    if (res.ok) return true;
    setError(res.error ?? 'Failed to mute');
    return false;
  }

  async function doUnmute(userId: string): Promise<boolean> {
    setLoading(true); setError(null);
    const res = await unmuteUser(userId);
    setLoading(false);
    if (res.ok) return true;
    setError(res.error ?? 'Failed to unmute');
    return false;
  }

  return { doMute, doUnmute, loading, error };
}
