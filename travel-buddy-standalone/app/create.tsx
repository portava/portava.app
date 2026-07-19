import React from 'react';
import { router } from 'expo-router';
import { UnifiedPostComposer } from '../src/components/PulseCreate';

/**
 * /create — full-screen post composer page.
 *
 * Opened by the center POST stamp button in the tab bar, the desktop sidebar
 * compose button, and the various "Add Post" empty-state CTAs, so all
 * creation entry-points behave identically. The page
 * closes (router.back) when the user dismisses it or right after the
 * post/postcard is created; each navigation mounts a fresh composer.
 */
export default function Create() {
  // Once-guard: the composer may invoke both onSuccess and onClose for a
  // single post (see handleSubmitResult / HighlightComposer success path).
  // With the composer on a real route, dismissing twice would pop TWO
  // screens — the guard makes the second call a no-op.
  const dismissed = React.useRef(false);
  function dismiss() {
    if (dismissed.current) return;
    dismissed.current = true;
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)' as any);
    }
  }

  return <UnifiedPostComposer onClose={dismiss} onSuccess={dismiss} />;
}
