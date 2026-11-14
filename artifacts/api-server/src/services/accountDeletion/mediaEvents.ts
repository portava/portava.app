/** Security erasure, independent of the disabled raw-retention proposal.
 * Fence first, bounded batches, and an explicit receipt. Failure leaves the
 * account deletion retryable, before canonical IDs can be destroyed. */
export async function eraseAccountMediaEvents(sc: any, actor: string): Promise<number> {
  let deleted = 0;
  for (let pass = 0; pass < 40; pass++) {
    const { data, error } = await sc.rpc('erase_media_events_for_actor', { p_actor: actor, p_limit: 500 });
    if (error || !data || !Number.isInteger(data.deleted) || data.deleted < 0 || data.deleted > 500 || typeof data.more !== 'boolean') throw new Error('Media event erasure unconfirmed');
    deleted += data.deleted;
    if (!data.more) return deleted;
    if (data.deleted === 0) throw new Error('Media event erasure made no progress');
  }
  throw new Error('Media event erasure backlog remains; retry required');
}
