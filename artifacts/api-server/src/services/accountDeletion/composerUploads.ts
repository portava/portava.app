/** Operational draft uploads are outside canonical media when that dual-write
 * is off. Cancel first, erase bytes, then erase rows; any uncertainty is fatal. */
export async function eraseAccountComposerUploads(sc: SupabaseClient, actor: string): Promise<number> {
    const marked = await sc.from('composer_upload_intents').update({ state: 'cancelled', cleanup_pending: true }).eq('owner_id', actor);
    if (marked.error?.code === '42P01' || marked.error?.code === 'PGRST205')
        return 0;
    if (marked.error)
        throw new Error('Draft upload cancellation unconfirmed');
    let count = 0;
    for (;;) {
        const r = await sc.from('composer_upload_intents').select('id,storage_paths').eq('owner_id', actor).order('id', { ascending: true }).limit(200);
        if (r.error || !Array.isArray(r.data))
            throw new Error('Draft upload inventory unconfirmed');
        if (!r.data.length)
            return count;
        for (const row of r.data) {
            if (!Array.isArray(row.storage_paths) || row.storage_paths.some((p: unknown) => typeof p !== 'string' || !p.startsWith(`${actor}/`) || p.includes('..')))
                throw new Error('Draft upload ownership unconfirmed');
            if (row.storage_paths.length && (await sc.storage.from('post-media').remove(row.storage_paths)).error)
                throw new Error('Draft upload bytes unconfirmed');
            if ((await sc.from('posts').update({ composer_upload_operation_id: null }).eq('author_id', actor).eq('composer_upload_operation_id', row.id)).error)
                throw new Error('Draft publication association unconfirmed');
            if ((await sc.from('composer_upload_intents').delete().eq('id', row.id).eq('owner_id', actor)).error)
                throw new Error('Draft upload erasure unconfirmed');
            count++;
        }
    }
}
import type { SupabaseClient } from '@supabase/supabase-js';
