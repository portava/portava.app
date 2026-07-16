import { useCallback } from 'react';
import {
  postCompassFeedback,
  type CompassFeedbackAction,
} from '../../services/compass';

interface FeedbackOptions {
  recommendationId: string;
  itemType:         string;
  category?:        string;
  topic?:           string;
  targetUserId?:    string;
}

interface UseCompassFeedbackResult {
  sendFeedback: (action: CompassFeedbackAction, opts: FeedbackOptions) => Promise<boolean>;
}

/**
 * Submit a feedback action for a Compass recommendation.
 * All submissions are fire-and-forget from the caller's perspective — errors
 * are swallowed so the optimistic UI update is not blocked.
 */
export function useCompassFeedback(): UseCompassFeedbackResult {
  const sendFeedback = useCallback(async (
    action: CompassFeedbackAction,
    opts: FeedbackOptions,
  ): Promise<boolean> => {
    const r = await postCompassFeedback({
      action,
      recommendationId: opts.recommendationId,
      itemType:         opts.itemType,
      category:         opts.category,
      topic:            opts.topic,
      targetUserId:     opts.targetUserId,
    });
    return r.ok;
  }, []);

  return { sendFeedback };
}
