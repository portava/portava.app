/**
 * Avatar URLs for the members a receipt says have read a message — the reader
 * chips under one of the caller's own messages. The receipt itself (who read
 * it) comes from the server; this only resolves faces for those ids.
 *
 * DECORATIVE BY DESIGN, and the failure says so: a profile read that fails
 * draws no chips. It never changes what the receipt claims — "Seen by N" is
 * the server's count and is rendered whether or not a face could be found.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { supabase } from '../../../lib/supabase.ts';

export function useReaderAvatars(readerIds: readonly string[]): (userId: string) => string | null {
  const key = useMemo(() => [...new Set(readerIds)].sort().join(','), [readerIds]);
  const [byId, setById] = useState<Map<string, string | null>>(() => new Map());

  useEffect(() => {
    if (!key) return;
    const missing = key.split(',').filter((id) => !byId.has(id));
    if (missing.length === 0 || !supabase) return;
    let active = true;
    void supabase
      .from('profiles')
      .select('id, avatar_url')
      .in('id', missing)
      .then(({ data, error }) => {
        // A failed read draws no faces; the receipt's own words are unaffected.
        if (!active || error || !data) return;
        setById((prev) => {
          const next = new Map(prev);
          for (const p of data as Array<{ id: string; avatar_url: string | null }>) next.set(p.id, p.avatar_url ?? null);
          return next;
        });
      });
    return () => { active = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return useCallback((userId: string) => byId.get(userId) ?? null, [byId]);
}
