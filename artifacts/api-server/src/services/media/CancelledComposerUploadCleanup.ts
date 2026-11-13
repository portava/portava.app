import type { SupabaseClient } from '@supabase/supabase-js';
/** Called by the existing pending-upload maintenance pass, never a new timer.
 * Explicit discard is irreversible; rows preserve paths until every byte delete
 * acknowledges. The caller supplies the existing transport-expiry cutoff. */
export async function cleanupCancelledComposerUploads(sc: SupabaseClient, cutoff: string, limit: number): Promise<{
    cleaned: number;
    errors: number;
}> {
    try {
        const result = await sc.from('composer_upload_intents' as never).select('id,owner_id,storage_paths').eq('state', 'cancelled').eq('cleanup_pending', true).lt('updated_at', cutoff).order('updated_at', { ascending: true }).limit(limit);
        if (result.error) {
            if (['42P01', 'PGRST205'].includes(result.error.code))
                return { cleaned: 0, errors: 0 };
            return { cleaned: 0, errors: 1 };
        }
        let cleaned = 0, errors = 0;
        for (const row of (result.data ?? []) as unknown as Array<{
            id: string;
            owner_id: string;
            storage_paths: string[];
        }>) {
            try {
                if (!Array.isArray(row.storage_paths) || row.storage_paths.some(path => !path.startsWith(`${row.owner_id}/`) || path.includes('..'))) {
                    errors++;
                    continue;
                }
                if (row.storage_paths.length && (await sc.storage.from('post-media').remove(row.storage_paths)).error) {
                    errors++;
                    continue;
                }
                const updated = await sc.from('composer_upload_intents' as never).update({ cleanup_pending: false } as never).eq('id', row.id).eq('state', 'cancelled');
                if (updated.error)
                    errors++;
                else
                    cleaned++;
            }
            catch {
                errors++;
            }
        }
        return { cleaned, errors };
    }
    catch {
        return { cleaned: 0, errors: 1 };
    }
}
