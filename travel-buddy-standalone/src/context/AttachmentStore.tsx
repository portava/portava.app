import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { Attachment, AttachSource, AttachTarget } from '../types/models.ts';
import type { AttachmentService } from '../services/attachments.ts';

/**
 * In-memory session attachment store. Implements AttachmentService.
 * Persistence: 'session' — survives navigation, resets on full reload.
 * NOT backend-persisted. Swap this provider for an API-backed one later
 * (same interface, callers unchanged).
 */

const ME = 'me';

interface AttachmentContextValue extends AttachmentService {
  attachments: Attachment[];
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

export function AttachmentProvider({ children }: { children: React.ReactNode }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const isAttached = useCallback(
    (sourceItemId: string, targetId: string) =>
      attachments.some((a) => a.sourceItemId === sourceItemId && a.targetId === targetId),
    [attachments],
  );

  const listAttachmentsByTarget = useCallback(
    (targetId: string) => attachments.filter((a) => a.targetId === targetId),
    [attachments],
  );

  const listAttachmentsBySource = useCallback(
    (sourceItemId: string) => attachments.filter((a) => a.sourceItemId === sourceItemId),
    [attachments],
  );

  const createAttachment = useCallback(
    async (source: AttachSource, target: AttachTarget, notes?: string): Promise<Attachment> => {
      // duplicate protection — return existing if already attached
      const existing = attachments.find((a) => a.sourceItemId === source.id && a.targetId === target.id);
      if (existing) return existing;

      const att: Attachment = {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: ME,
        sourceItemId: source.id,
        sourceItemType: source.type,
        sourceTitle: source.title,
        sourceSubtitle: source.subtitle,
        sourceImageUrl: source.imageUrl,
        sourceCity: source.city,
        sourceCategory: source.category,
        targetId: target.id,
        targetType: target.type,
        targetTitle: target.title,
        createdAt: new Date().toISOString(),
        notes,
        persistence: 'session',
      };
      setAttachments((prev) => [att, ...prev]);
      return att;
    },
    [attachments],
  );

  const deleteAttachment = useCallback(async (attachmentId: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
  }, []);

  const value = useMemo(
    () => ({ attachments, isAttached, listAttachmentsByTarget, listAttachmentsBySource, createAttachment, deleteAttachment }),
    [attachments, isAttached, listAttachmentsByTarget, listAttachmentsBySource, createAttachment, deleteAttachment],
  );

  return <AttachmentContext.Provider value={value}>{children}</AttachmentContext.Provider>;
}

export function useAttachments(): AttachmentContextValue {
  const ctx = useContext(AttachmentContext);
  if (!ctx) {
    // Safe fallback if provider missing — no-op store so UI never crashes.
    return {
      attachments: [],
      isAttached: () => false,
      listAttachmentsByTarget: () => [],
      listAttachmentsBySource: () => [],
      createAttachment: async () => { throw new Error('AttachmentProvider missing'); },
      deleteAttachment: async () => {},
    };
  }
  return ctx;
}
