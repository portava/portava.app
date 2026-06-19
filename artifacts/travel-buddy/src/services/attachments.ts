/**
 * Attachment service — backend migration contract.
 *
 * THIS PASS: the AttachmentProvider (see context/AttachmentStore.tsx) implements
 * these against an in-memory session store. Persistence is 'session' only —
 * adds survive navigation but reset on full reload. This is NOT backend-persisted.
 *
 * TO MIGRATE TO BACKEND: implement this same interface against your API
 * (POST/GET/DELETE /attachments) and swap the provider. Callers don't change.
 */
import type { Attachment, AttachSource, AttachTarget } from '../types/models';

export interface AttachmentService {
  /** Attach a source item to a target. Returns the created attachment, or the
   *  existing one if already attached (no duplicate). */
  createAttachment(source: AttachSource, target: AttachTarget, notes?: string): Promise<Attachment>;

  /** All attachments on a given trip/plan. */
  listAttachmentsByTarget(targetId: string): Attachment[];

  /** All targets a given source item is attached to (for "Added" state). */
  listAttachmentsBySource(sourceItemId: string): Attachment[];

  /** Remove an attachment. */
  deleteAttachment(attachmentId: string): Promise<void>;

  /** Is this source already attached to this target? */
  isAttached(sourceItemId: string, targetId: string): boolean;
}

// TODO(backend): replace session store with API calls implementing AttachmentService.
//   createAttachment        -> POST   /attachments
//   listAttachmentsByTarget -> GET    /attachments?targetId=
//   listAttachmentsBySource -> GET    /attachments?sourceId=
//   deleteAttachment        -> DELETE /attachments/:id
