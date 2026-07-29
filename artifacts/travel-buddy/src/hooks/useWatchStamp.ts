/**
 * useWatchStamp — single shared stamp controller for a Watch/Roam feed cell.
 *
 * Bug fix (2026-07-28): the stamp icon in the right rail and the
 * double-tap-on-content gesture used to each own separate pieces of stamp
 * state (or none at all), so they could never agree on a single source of
 * truth and the rail button's press handler could be starved by the
 * full-screen gesture layer. This hook is now instantiated ONCE per cell
 * (in WatchFeedList's CellWrapper) and its `handleStampPress` /
 * `triggerAt(launchX, launchY)` entry points are shared by:
 *   - the rail's StampIcon button (press → measures its own position)
 *   - the double-tap gesture on the content (already has tap coordinates)
 *
 * Both entry points funnel into the same optimistic `useStamp` toggle and
 * the same screen-level `StampAnimationContext`, so count/isStamped state
 * always stays in sync regardless of which gesture triggered it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { View } from 'react-native';
import { Dimensions } from 'react-native';
import { useStamp } from './useStamp.ts';
import { useStampAnimation } from './useStampAnimation.ts';
import { useStampAnimationContext } from '../context/StampAnimationContext.tsx';
import type { MediaFeedItem } from '../types/media.ts';

export interface UseWatchStampReturn {
  /** Ref to attach to the rail's stamp-icon wrapper View (used for measure()). */
  stampGroupRef: React.RefObject<View | null>;
  visualIsStamped: boolean;
  visualCount: number;
  stampLoading: boolean;
  isAnimating: boolean;
  buttonStyle: unknown;
  /** Press handler for the rail's stamp button — measures its own position. */
  handleStampPress: () => void;
  /** Fire the same stamp toggle + animation, launching from explicit screen
   *  coordinates — used by the double-tap-on-content gesture. */
  triggerAt: (launchX: number, launchY: number) => void;
}

export function useWatchStamp(item: MediaFeedItem): UseWatchStampReturn {
  const { count: apiCount, isStamped: apiIsStamped, isLoading: stampLoading, toggle: toggleStamp } = useStamp({
    entityType: 'media',
    entityId: item.id,
    initialCount: item.stampCount ?? item.likeCount ?? 0,
    initialIsStamped: item.isStampedByViewer ?? item.likedByMe ?? false,
  });

  const { buttonStyle, playStamp, playUnstamp } = useStampAnimation();
  const { triggerStamp, isAnimating } = useStampAnimationContext();

  const [visualIsStamped, setVisualIsStamped] = useState(
    item.isStampedByViewer ?? item.likedByMe ?? false,
  );
  const [visualCount, setVisualCount] = useState(item.stampCount ?? item.likeCount ?? 0);

  const apiStateRef = useRef({ isStamped: apiIsStamped, count: apiCount });
  /** Resolved value of the toggle() call currently/most-recently in flight — see fireStampAt. */
  const latestToggleResultRef = useRef({ isStamped: apiIsStamped, count: apiCount });
  const animatingRef = useRef(false);
  const stampGroupRef = useRef<View | null>(null);

  useEffect(() => {
    apiStateRef.current = { isStamped: apiIsStamped, count: apiCount };
  }, [apiIsStamped, apiCount]);

  const prevApiIsStamped = useRef(apiIsStamped);
  const prevApiCount = useRef(apiCount);
  useEffect(() => {
    if (
      (apiIsStamped !== prevApiIsStamped.current || apiCount !== prevApiCount.current) &&
      !animatingRef.current
    ) {
      setVisualIsStamped(apiIsStamped);
      setVisualCount(apiCount);
    }
    prevApiIsStamped.current = apiIsStamped;
    prevApiCount.current = apiCount;
  }, [apiIsStamped, apiCount]);

  /** Core: toggle + launch the traveling-stamp animation from a launch point. */
  const fireStampAt = useCallback(
    (launchX: number, launchY: number) => {
      console.log('[STAMP_DEBUG] fireStampAt called', { launchX, launchY, itemId: item.id, stampLoading, animating: animatingRef.current, isAnimating, visualIsStamped });
      if (stampLoading || animatingRef.current || isAnimating) {
        console.log('[STAMP_DEBUG] fireStampAt BAILED');
        return;
      }

      const wasStamped = visualIsStamped;
      const nextStamped = !wasStamped;

      nextStamped ? playStamp() : playUnstamp();

      // Fix (2026-07-28): the animation's onComplete used to read a ref that
      // mirrored apiIsStamped/apiCount via a useEffect. If the toggle's
      // network round-trip hadn't resolved yet by the time onComplete fired
      // (~1.1s after press), that ref still held the STALE pre-toggle value,
      // so onComplete would silently revert the fill back to hollow right
      // after the animation even though the stamp had actually succeeded
      // (or was still in flight). Fixed by finalizing visual state only once
      // BOTH the animation has finished AND the toggle() call has resolved —
      // whichever happens later — using the toggle promise's own resolved
      // value directly, never a possibly-stale mirror ref.
      let animDone = false;
      let toggleResult: { isStamped: boolean; count: number } | null = null;
      const finalizeIfReady = () => {
        if (!animDone || !toggleResult) return;
        console.log('[STAMP_DEBUG] finalizing visual state', { itemId: item.id, toggleResult });
        setVisualIsStamped(toggleResult.isStamped);
        setVisualCount(toggleResult.count);
      };

      void toggleStamp().then((result) => {
        console.log('[STAMP_DEBUG] toggleStamp() settled', { itemId: item.id, result });
        latestToggleResultRef.current = result;
        toggleResult = result;
        finalizeIfReady();
      });

      animatingRef.current = true;
      const { height: H } = Dimensions.get('window');
      const { width: W } = Dimensions.get('window');

      triggerStamp({
        launchX,
        launchY,
        contentX: W / 2,
        contentY: H / 2,
        theme: 'Default',
        onImpact: () => {
          console.log('[STAMP_DEBUG] onImpact — setting visual state', { itemId: item.id, nextStamped });
          setVisualIsStamped(nextStamped);
          setVisualCount((prev) => (nextStamped ? prev + 1 : Math.max(0, prev - 1)));
        },
        onComplete: () => {
          animatingRef.current = false;
          animDone = true;
          finalizeIfReady();
        },
      });
    },
    [stampLoading, isAnimating, visualIsStamped, playStamp, playUnstamp, toggleStamp, triggerStamp],
  );

  /** Rail button entry point — measures its own screen position as the launch point. */
  const handleStampPress = useCallback(() => {
    console.log('[STAMP_DEBUG] handleStampPress fired', {
      itemId: item.id,
      stampLoading,
      animating: animatingRef.current,
      isAnimating,
      hasRef: !!stampGroupRef.current,
    });
    if (stampLoading || animatingRef.current || isAnimating) {
      console.log('[STAMP_DEBUG] handleStampPress BAILED (loading/animating)');
      return;
    }
    if (!stampGroupRef.current) {
      console.log('[STAMP_DEBUG] handleStampPress BAILED — stampGroupRef.current is null, measure() never called');
      return;
    }
    stampGroupRef.current.measure((_x, _y, width, height, pageX, pageY) => {
      console.log('[STAMP_DEBUG] measure() resolved', { width, height, pageX, pageY });
      fireStampAt(pageX + width / 2, pageY + height / 2);
    });
  }, [stampLoading, isAnimating, fireStampAt, item.id]);

  /** Double-tap-on-content entry point — launch point is the tap coordinates. */
  const triggerAt = useCallback(
    (launchX: number, launchY: number) => {
      fireStampAt(launchX, launchY);
    },
    [fireStampAt],
  );

  return {
    stampGroupRef,
    visualIsStamped,
    visualCount,
    stampLoading,
    isAnimating,
    buttonStyle,
    handleStampPress,
    triggerAt,
  };
}
