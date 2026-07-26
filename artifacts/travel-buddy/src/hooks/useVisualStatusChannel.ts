/**
 * useVisualStatusChannel — Supabase realtime subscription for generated_visuals status.
 *
 * Subscribes to INSERT/UPDATE events on the generated_visuals table for a specific
 * entity. When a row transitions to status='ready', checks the mayApplyGenerated
 * priority guard and calls onReady(payload) if safe to apply.
 *
 * Channel lifecycle:
 * - Established once when entityId becomes non-null (if app is active).
 * - Torn down and re-created when entityId changes.
 * - Unsubscribed when the app goes to the background; resumed on foreground.
 * - Always torn down on unmount (no ghost callbacks).
 *
 * No generation prompts, signed URLs, or internal model metadata are logged.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import type { VisualEntityType } from './useVisualGeneration.ts';

// ── Client-side priority guard (mirrors server priority.ts) ───────────────────

const SOURCE_RANK: Record<string, number> = {
  user_upload: 6,
  official: 5,
  provider: 4,
  portava_media: 3,
  ai_generated: 2,
  category_fallback: 1,
};

/**
 * Returns false if a higher-priority source is already displayed, or if the
 * entity's image was updated after the generation job started (a newer user
 * upload arrived while we were generating). Matches the server-side logic in
 * api-server/src/lib/visuals/priority.ts.
 */
function mayApplyGenerated(
  current: { source?: string | null; updatedAt?: string | null },
  generatedAt: string,
): boolean {
  const rank = SOURCE_RANK[current.source ?? ''] ?? 0;
  if (rank > (SOURCE_RANK.ai_generated ?? 0)) return false;
  if (current.updatedAt && current.updatedAt > generatedAt) return false;
  return true;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VisualReadyPayload {
  id: string;
  imageUrl: string;
  style: string;
  generatedAt: string;
}

export interface UseVisualStatusChannelOptions {
  entityType: VisualEntityType;
  entityId: string | null;
  /**
   * Current image source of the entity — used for the priority guard.
   * Pass null/undefined when the source is unknown; the guard will only check
   * the timestamp in that case.
   */
  currentSource?: string | null;
  /**
   * ISO timestamp of the entity's last image update — used for the priority
   * guard to detect a newer user upload that arrived while generating.
   */
  currentImageUpdatedAt?: string | null;
  /**
   * Called when a ready generation passes the priority guard.
   * Guaranteed not to fire after the consuming component has unmounted.
   */
  onReady: (payload: VisualReadyPayload) => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useVisualStatusChannel({
  entityType,
  entityId,
  currentSource,
  currentImageUpdatedAt,
  onReady,
}: UseVisualStatusChannelOptions): void {
  const channelRef    = useRef<RealtimeChannel | null>(null);
  const mountedRef    = useRef(true);
  const appStateRef   = useRef<AppStateStatus>(AppState.currentState);

  // Keep callback refs fresh so closures inside the channel handler never
  // capture stale values.
  const onReadyRef             = useRef(onReady);
  onReadyRef.current           = onReady;
  const currentSourceRef       = useRef(currentSource);
  currentSourceRef.current     = currentSource;
  const currentUpdatedAtRef    = useRef(currentImageUpdatedAt);
  currentUpdatedAtRef.current  = currentImageUpdatedAt;

  // ── Teardown ─────────────────────────────────────────────────────────────

  const teardown = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current).catch(() => {});
      channelRef.current = null;
    }
  }, []);

  // ── Setup ─────────────────────────────────────────────────────────────────

  const setup = useCallback(
    (eid: string, etype: VisualEntityType) => {
      if (!isSupabaseConfigured) return;
      teardown();

      const channel = supabase
        .channel(`generated-visuals-${etype}-${eid}`)
        .on(
          // @ts-ignore — overload accepted by supabase-js but TS narrowing varies
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'generated_visuals',
            // Filter by entity_id at the DB level; entity_type is verified below.
            filter: `entity_id=eq.${eid}`,
          },
          (payload: { new?: Record<string, unknown> }) => {
            if (!mountedRef.current) return;
            const row = payload.new;
            if (!row) return;

            // Verify entity type (filter is single-condition at DB level).
            if (row.entity_type !== etype) return;
            if (row.status !== 'ready') return;

            // Extract the best available HTTP image URL.
            // Never log the URL itself — it may be a signed storage URL.
            const sourceImageUrl = row.source_image_url as string | null;
            const heroPath       = row.hero_path as string | null;
            const imageUrl =
              (sourceImageUrl?.startsWith('http') ? sourceImageUrl : null) ??
              (heroPath?.startsWith('http')       ? heroPath       : null) ??
              null;

            if (!imageUrl) return;

            const generatedAt =
              (row.updated_at as string | undefined) ?? new Date(0).toISOString();

            // Apply the client-side priority guard before notifying the consumer.
            if (
              !mayApplyGenerated(
                {
                  source:    currentSourceRef.current,
                  updatedAt: currentUpdatedAtRef.current,
                },
                generatedAt,
              )
            ) return;

            onReadyRef.current({
              id:          row.id as string,
              imageUrl,
              style:       (row.style as string) ?? 'portava_editorial',
              generatedAt,
            });
          },
        )
        .subscribe();

      channelRef.current = channel;
    },
    [teardown],
  );

  // ── Entity-change effect ──────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    if (entityId && appStateRef.current === 'active') {
      setup(entityId, entityType);
    }
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [entityId, entityType, setup, teardown]);

  // ── AppState background / foreground lifecycle ────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
      if (next === 'active') {
        if (entityId) setup(entityId, entityType);
      } else {
        teardown();
      }
    });
    return () => sub.remove();
  }, [entityId, entityType, setup, teardown]);
}
