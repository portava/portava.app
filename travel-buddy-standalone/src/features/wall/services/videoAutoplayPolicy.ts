/**
 * videoAutoplayPolicy — the Wall's explicit inline-video autoplay policy (§11/§36).
 *
 * Autoplay on the Wall is a CLIENT policy, never a server command. The spec is
 * emphatic (§11): "Autoplay only under product policy and user/device
 * conditions … the [ranker] must not become the Wall's primary optimization
 * target", and (§36): "Autoplay respects reduced motion and user settings."
 *
 * This is the single place that decides. It is a pure function so it is unit
 * testable and cannot drift between the renderer and its tests.
 *
 * Inputs and how each gates the decision:
 *   - `visible`         viewport visibility (FlatList viewability). Off-screen ⇒
 *                       never autoplay (scrolling away pauses playback, §11).
 *   - `reduceMotion`    the device/user accessibility setting (AccessibilityInfo).
 *                       On ⇒ never autoplay; the renderer falls back to the
 *                       poster (§36).
 *   - `userAutoplayEnabled` the user's autoplay preference. There is no per-user
 *                       autoplay toggle in Settings yet, so the product default is
 *                       autoplay-on; when a Settings toggle lands it feeds this
 *                       input with no change to call sites. Reduced motion remains
 *                       the always-honored accessibility gate regardless.
 *
 * ## Why the server's `autoplayEligible` is NOT an input
 *
 * `DisplayMedia.autoplayEligible` is an advisory note from the projection, not a
 * command: `true` says only "this media is a ready, playable video", and
 * `false`/absent means the server has NO opinion. It was read here as a hard
 * VETO while every server loader stamped `false` on every video — so the inline
 * Wall autoplay this module exists for could never run on any item. Autoplay
 * belongs to the device, so the decision is made from device/user conditions
 * alone and no server field can turn it on OR off.
 *
 * Autoplay is ALWAYS muted (`muted: true`): the Wall never autoplays with sound.
 */

export interface VideoAutoplayInput {
  /** True when the item is in the viewport (FlatList viewability, §11). */
  visible: boolean;
  /** True when the OS "reduce motion" accessibility setting is on (§36). */
  reduceMotion: boolean;
  /** The user/product autoplay preference. Defaults to enabled. */
  userAutoplayEnabled?: boolean;
}

export interface VideoAutoplayDecision {
  /** Whether the inline player should be playing right now. */
  autoplay: boolean;
  /** The Wall never autoplays with sound — autoplay is always muted (§11). */
  muted: true;
}

/**
 * Decide whether an inline Wall video may autoplay. Pure and total.
 *
 * Autoplay requires ALL of: in-viewport, reduce-motion OFF, and the user
 * preference on. Every one of these is a device-side condition — the server has
 * no vote.
 */
export function resolveVideoAutoplay(input: VideoAutoplayInput): VideoAutoplayDecision {
  const userEnabled = input.userAutoplayEnabled ?? true;
  const autoplay = input.visible && !input.reduceMotion && userEnabled;
  return { autoplay, muted: true };
}
