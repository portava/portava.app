/**
 * useUniversalShare — the share controller.
 *
 * Owns exactly one thing: which entity is currently being shared, and from
 * where. It renders nothing and imports no UI. The sheet, when it exists, will
 * be a consumer of this hook, not the other way round — which is why this can
 * be unit-tested today with no sheet in the tree.
 *
 * ## Shape of the state
 *
 * A single nullable session object rather than parallel `isOpen` / `entity` /
 * `source` fields. Parallel fields drift: you get `isOpen === true` with a null
 * entity after a fast close-then-open, and every consumer has to defend against
 * a combination that should not exist. `activeSession === null` is closed;
 * anything else is open and guaranteed to have an entity.
 *
 * ## Replace-while-open
 *
 * openShare() on an already-open sheet swaps the entity in place. It does not
 * close and reopen, because that would unmount the sheet mid-animation. The
 * caller does not have to check whether something is already open.
 */
import { useCallback, useRef, useState } from 'react';
import type { ShareableEntity } from '../types/models.ts';

/**
 * Where the share was triggered from. Free-form on purpose — analytics wants
 * the specific surface ('post_detail_header', 'pulse_card', 'map_action_row'),
 * and constraining it to a union here would mean editing this file every time
 * a trigger is migrated.
 */
export type ShareSourceSurface = string;

export interface ShareSession {
  entity: ShareableEntity;
  sourceSurface: ShareSourceSurface;
  /**
   * Increments on every openShare, including a replace. Gives consumers a
   * stable key for resetting per-share UI state (a recipient selection, a
   * scroll position) when the entity changes underneath them.
   */
  sequence: number;
}

export interface OpenShareOptions {
  sourceSurface: ShareSourceSurface;
}

export interface UniversalShareController {
  /** Null when closed. Non-null implies an entity is present. */
  activeSession: ShareSession | null;
  /** Convenience accessor — the entity being shared, or null. */
  activeEntity: ShareableEntity | null;
  isOpen: boolean;
  /** Open, or swap the entity if already open. */
  openShare: (entity: ShareableEntity, options: OpenShareOptions) => void;
  /** Close and clear. Idempotent — closing a closed sheet is a no-op. */
  closeShare: () => void;
}

export function useUniversalShare(): UniversalShareController {
  const [activeSession, setActiveSession] = useState<ShareSession | null>(null);
  // A ref, not state: bumping the counter must not itself schedule a render,
  // and the value has to survive the same tick when open is called twice.
  const sequenceRef = useRef(0);

  const openShare = useCallback((entity: ShareableEntity, options: OpenShareOptions) => {
    sequenceRef.current += 1;
    setActiveSession({
      entity,
      sourceSurface: options.sourceSurface,
      sequence: sequenceRef.current,
    });
  }, []);

  const closeShare = useCallback(() => {
    // Clearing the whole session is what guarantees no stale entity is
    // readable after close — there is no second field to forget to reset.
    setActiveSession(null);
  }, []);

  return {
    activeSession,
    activeEntity: activeSession?.entity ?? null,
    isOpen: activeSession !== null,
    openShare,
    closeShare,
  };
}
